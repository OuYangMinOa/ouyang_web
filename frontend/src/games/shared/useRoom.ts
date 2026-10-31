import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, errorMessage } from '../../api'
import { useAuth } from '../../auth'

/**
 * 線上對戰：後端只負責「轉送」，不懂遊戲規則。
 *
 * - 每個房間最多兩個座位：先進房間的人是 seat 0，第二個是 seat 1。
 * - 任何一方送出的訊息，伺服器加上 seat 後依序廣播給「兩邊」（包含送出者），
 *   並存進房間的歷史。所以兩邊看到的事件順序完全一樣，送出者也要等伺服器回傳才套用。
 * - 斷線重連（手機切到背景、伺服器換版都很常見）時，伺服器會把完整歷史重送一次，
 *   遊戲只要把 events 從頭重播一遍就能還原局面。房間存在資料庫，換版後也還在。
 * - 座位認人：登入的人認帳號（換分頁、換裝置都拿得回座位），訪客認這個分頁的 player id。
 *   同一個人從別處連進來，舊的連線會收到 `replaced` 錯誤。
 * - 遊戲規則由各遊戲的 reducer 在兩端各自執行：不合法或不是輪到該 seat 的訊息就忽略。
 *
 * 協定（JSON over WebSocket，`/api/games/rooms/{code}/ws?game=<id>&player=<id>`，登入時 player 會被忽略）：
 *   client → server  { type: 'msg', data }
 *   server → client  { type: 'welcome', seat, peer, history: [{ seat, data }] }
 *                    { type: 'peer', online }
 *                    { type: 'msg', seat, data }
 *                    { type: 'error', code, message }   之後伺服器會關閉連線，不要再重連
 */

export type Seat = 0 | 1
export type RoomEvent<T> = { seat: Seat; data: T }

type ServerMessage<T> =
  | { type: 'welcome'; seat: Seat; peer: boolean; history: RoomEvent<T>[] }
  | { type: 'peer'; online: boolean }
  | { type: 'msg'; seat: Seat; data: T }
  | { type: 'error'; code: string; message: string }

export type Room<T> = {
  /** 房間代碼；null 表示還沒建立或加入 */
  code: string | null
  /** 我的座位；連上之前是 null */
  seat: Seat | null
  /** WebSocket 目前是否連著 */
  connected: boolean
  peerOnline: boolean
  /** 房間裡所有遊戲事件（依伺服器順序） */
  events: RoomEvent<T>[]
  error: string | null
  /** 伺服器的錯誤代碼，例如 `replaced`、`not_found`；建立房間失敗這類 HTTP 錯誤是 null */
  errorCode: string | null
  busy: boolean
  create: () => Promise<void>
  join: (code: string) => void
  leave: () => void
  /** 收到錯誤停止重連後，再連一次（例如 `replaced` 時在這個分頁繼續） */
  reconnect: () => void
  send: (data: T) => void
  /** 邀請連結：打開就會直接加入這個房間 */
  inviteUrl: string | null
}

type Live<T> = {
  key: string
  seat: Seat
  connected: boolean
  peerOnline: boolean
  events: RoomEvent<T>[]
}

// 固定的空陣列，讓沒連線時 events 的參照保持不變，useMemo 才不會每次重算
const NO_EVENTS: never[] = []

type RoomError = { code: string | null; message: string }

/** 訪客用的玩家 id：每個分頁一個，用來在重連時拿回同一個座位（登入的人由伺服器改用帳號） */
export function playerId(): string {
  const key = 'games:player'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
  } catch {
    // 讀不到就每次產生新的，只是重新整理後拿不回座位
  }
  // crypto.randomUUID 只在 HTTPS 能用（staging 是 http），getRandomValues 沒有這個限制
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  try {
    sessionStorage.setItem(key, id)
  } catch {
    // 同上
  }
  return id
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

/**
 * `enabled` 為 false 時不連線（例如目前不是線上模式），但網址上的 ?room= 會保留，
 * 讓遊戲可以「有 ?room= 就自動切到線上模式」。
 */
export function useRoom<T>(game: string, enabled = true): Room<T> {
  const [params, setParams] = useSearchParams()
  const code = params.get('room')
  const { user, loading } = useAuth()
  // 連線狀態都標上是哪個房間、用哪個身分的，換房間或登入登出時舊的自動作廢並重連，不用在 effect 裡手動清空。
  // 登入狀態確定前不連線，否則會先用訪客身分佔掉座位。
  const key = code && enabled && !loading ? `${game}:${code}:${user?.id ?? 'guest'}` : null
  const [live, setLive] = useState<Live<T> | null>(null)
  const current = live && live.key === key ? live : null
  const [error, setError] = useState<RoomError | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const socket = useRef<WebSocket | null>(null)

  const setCode = useCallback(
    (next: string | null) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          if (next) p.set('room', next)
          else p.delete('room')
          return p
        },
        { replace: true },
      )
    },
    [setParams],
  )

  useEffect(() => {
    if (!code || !key) return
    const roomKey = key
    const update = (fn: (prev: Live<T>) => Live<T>) =>
      setLive((prev) => (prev && prev.key === roomKey ? fn(prev) : prev))

    let stopped = false
    let welcomed = false
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null

    function connect() {
      const url = new URL(`/api/games/rooms/${encodeURIComponent(code!)}/ws`, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('game', game)
      url.searchParams.set('player', playerId())
      ws = new WebSocket(url)
      socket.current = ws

      ws.onmessage = (e) => {
        let msg: ServerMessage<T>
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        switch (msg.type) {
          case 'welcome':
            retries = 0
            welcomed = true
            setLive({ key: roomKey, seat: msg.seat, connected: true, peerOnline: msg.peer, events: msg.history })
            setError(null)
            break
          case 'peer':
            update((prev) => ({ ...prev, peerOnline: msg.online }))
            break
          case 'msg':
            update((prev) => ({ ...prev, events: [...prev.events, { seat: msg.seat, data: msg.data }] }))
            break
          case 'error':
            stopped = true
            // 玩到一半重連時才找不到，多半是太久沒人下被清掉了
            setError({
              code: msg.code,
              message:
                msg.code === 'not_found' && welcomed ? '這個房間已經失效（太久沒有動靜），請建立新房間' : msg.message,
            })
            break
        }
      }
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null
        update((prev) => ({ ...prev, connected: false }))
        if (stopped) return
        // 斷線就自動重連：1s、2s、4s… 最多 10s
        timer = setTimeout(connect, Math.min(1000 * 2 ** retries++, 10_000))
      }
    }

    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [game, code, key, attempt])

  const create = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const room = await api<{ code: string }>('/games/rooms', {
        method: 'POST',
        body: JSON.stringify({ game }),
      })
      setCode(room.code)
    } catch (e) {
      setError({ code: null, message: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }, [game, setCode])

  const join = useCallback(
    (next: string) => {
      setError(null)
      setCode(normalizeCode(next) || null)
    },
    [setCode],
  )

  const leave = useCallback(() => {
    setError(null)
    setCode(null)
  }, [setCode])

  const reconnect = useCallback(() => {
    setError(null)
    setAttempt((n) => n + 1)
  }, [])

  const send = useCallback((data: T) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'msg', data }))
  }, [])

  let inviteUrl: string | null = null
  if (code) {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('room', code)
    inviteUrl = url.toString()
  }

  return {
    code,
    seat: current?.seat ?? null,
    connected: current?.connected ?? false,
    peerOnline: current?.peerOnline ?? false,
    events: current?.events ?? NO_EVENTS,
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
    busy,
    create,
    join,
    leave,
    reconnect,
    send,
    inviteUrl,
  }
}
