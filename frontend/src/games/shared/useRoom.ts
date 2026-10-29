import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, errorMessage } from '../../api'

/**
 * 線上對戰：後端只負責「轉送」，不懂遊戲規則。
 *
 * - 每個房間最多兩個座位：建立房間的人是 seat 0，加入的人是 seat 1。
 * - 任何一方送出的訊息，伺服器加上 seat 後依序廣播給「兩邊」（包含送出者），
 *   並存進房間的歷史。所以兩邊看到的事件順序完全一樣，送出者也要等伺服器回傳才套用。
 * - 斷線重連（手機切到背景很常見）時，伺服器會把完整歷史重送一次，
 *   遊戲只要把 events 從頭重播一遍就能還原局面。
 * - 遊戲規則由各遊戲的 reducer 在兩端各自執行：不合法或不是輪到該 seat 的訊息就忽略。
 *
 * 協定（JSON over WebSocket，`/api/games/rooms/{code}/ws?game=<id>&player=<id>`）：
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
  busy: boolean
  create: () => Promise<void>
  join: (code: string) => void
  leave: () => void
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

/** 每個分頁一個玩家 id，用來在重連時拿回同一個座位 */
function playerId(): string {
  const key = 'games:player'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
  } catch {
    // 讀不到就每次產生新的，只是重新整理後拿不回座位
  }
  const id = crypto.randomUUID()
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
  // 連線狀態都標上是哪個房間的，換房間時舊的自動作廢，不用在 effect 裡手動清空
  const key = code && enabled ? `${game}:${code}` : null
  const [live, setLive] = useState<Live<T> | null>(null)
  const current = live && live.key === key ? live : null
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
            setError(msg.message)
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
  }, [game, code, key])

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
      setError(errorMessage(e))
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
    error,
    busy,
    create,
    join,
    leave,
    send,
    inviteUrl,
  }
}
