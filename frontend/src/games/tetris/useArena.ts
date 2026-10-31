import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, errorMessage } from '../../api'
import { useAuth } from '../../auth'
import { load, save } from '../shared/storage'
import { normalizeCode } from '../shared/useRoom'

/**
 * 俄羅斯方塊大逃殺的連線（後端見 `backend/src/tetris.rs`）。
 *
 * 和棋類的 useRoom 不同，伺服器懂規則：負責開局、選目標、轉送攻擊、算 KO 與名次，還有電腦玩家。
 * 每個人的盤面在自己的瀏覽器裡跑，只把結果告訴伺服器。房間只在記憶體裡，換版時對局會中斷。
 *
 * 協定（JSON over WebSocket，`/api/games/tetris/rooms/{code}/ws?player=<id>&name=<暱稱>`，
 * 登入時 player 和 name 會被忽略，改用帳號）：
 *   client → server  { type: 'bots', count }            房主在開局前調整電腦人數
 *                    { type: 'start' }                   房主開局
 *                    { type: 'strategy', strategy }      自動選目標的方式
 *                    { type: 'target', pid }             手動指定目標
 *                    { type: 'attack', lines }           抵銷完自己的垃圾後要送出的行數
 *                    { type: 'board', rows, pending }    盤面（200 個 0～8）與待升的垃圾行數
 *                    { type: 'topout' }                  我輸了
 *   server → client  { type: 'welcome', you, round }
 *                    { type: 'state', ... }               見 ArenaState，有變化時最多每 250ms 一則
 *                    { type: 'boards', boards }           有變化的盤面 { pid: rows }
 *                    { type: 'garbage', lines, from }     被攻擊
 *                    { type: 'ko', victim, killer, place }
 *                    { type: 'error', code, message }     之後伺服器會關閉連線，不要再重連
 */

export type Phase = 'lobby' | 'countdown' | 'playing' | 'results'
export type Strategy = 'random' | 'ko' | 'badges' | 'attackers'

export type ArenaPlayer = {
  pid: number
  name: string
  bot: boolean
  online: boolean
  /** 參加這一局；中途進來的人要等下一局 */
  inRound: boolean
  alive: boolean
  place: number | null
  /** 徽章點數，用 badgeCount 換成徽章數 */
  badges: number
  kos: number
  target: number | null
  strategy: Strategy
  manual: boolean
}

export type ArenaState = {
  phase: Phase
  round: number
  level: number
  host: number | null
  public: boolean
  bots: number
  /** 倒數或自動開局剩下的毫秒數 */
  endsIn: number | null
  players: ArenaPlayer[]
}

export type ClientMessage =
  | { type: 'bots'; count: number }
  | { type: 'start' }
  | { type: 'strategy'; strategy: Strategy }
  | { type: 'target'; pid: number }
  | { type: 'attack'; lines: number }
  | { type: 'board'; rows: string; pending: number }
  | { type: 'topout' }

export type KoEvent = { victim: number; killer: number | null; place: number }

type ServerMessage =
  | { type: 'welcome'; you: number; round: number }
  | ({ type: 'state' } & ArenaState)
  | { type: 'boards'; boards: Record<string, string> }
  | { type: 'garbage'; lines: number; from: number }
  | ({ type: 'ko' } & KoEvent)
  | { type: 'error'; code: string; message: string }

export type ArenaHandlers = {
  /** 連上（含重連）時：伺服器上的局數，用來判斷手上的這局還能不能接著玩 */
  onWelcome?: (you: number, round: number) => void
  onGarbage?: (lines: number, from: number) => void
  onKo?: (event: KoEvent) => void
}

type RoomError = { code: string | null; message: string }

export const MAX_NAME = 12

/** 訪客的暱稱（登入的人用帳號名稱） */
export function loadName(): string {
  return load<string>('tetris:name', '')
}

export function saveName(name: string) {
  save('tetris:name', name)
}

/** 訪客的玩家 id：和棋類共用同一把 key，每個分頁一個 */
function playerId(): string {
  const key = 'games:player'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
  } catch {
    // 讀不到就每次產生新的，只是重新整理後拿不回位置
  }
  const id = crypto.randomUUID()
  try {
    sessionStorage.setItem(key, id)
  } catch {
    // 同上
  }
  return id
}

export function useArena(handlers: ArenaHandlers) {
  const [params, setParams] = useSearchParams()
  const code = params.get('room')
  const { user, loading } = useAuth()
  const key = code && !loading ? `${code}:${user?.id ?? 'guest'}` : null
  const [live, setLive] = useState<{ key: string; you: number | null; connected: boolean; state: ArenaState | null } | null>(
    null,
  )
  const current = live && live.key === key ? live : null
  const [error, setError] = useState<RoomError | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  /** 盤面變化很頻繁：同一個 Map 直接改，用版本號通知重畫 */
  const [boards] = useState(() => new Map<number, string>())
  const [boardsVersion, setBoardsVersion] = useState(0)
  const socket = useRef<WebSocket | null>(null)
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

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
    const update = (fn: (prev: NonNullable<typeof live>) => NonNullable<typeof live>) =>
      setLive((prev) => (prev && prev.key === roomKey ? fn(prev) : prev))

    let stopped = false
    let welcomed = false
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null

    function connect() {
      const url = new URL(`/api/games/tetris/rooms/${encodeURIComponent(code!)}/ws`, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('player', playerId())
      url.searchParams.set('name', loadName())
      ws = new WebSocket(url)
      socket.current = ws

      ws.onmessage = (e) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        switch (msg.type) {
          case 'welcome':
            retries = 0
            welcomed = true
            // 連上後伺服器會接著送完整的狀態和所有盤面
            boards.clear()
            setLive((prev) => ({
              key: roomKey,
              you: msg.you,
              connected: true,
              state: prev && prev.key === roomKey ? prev.state : null,
            }))
            setError(null)
            handlersRef.current.onWelcome?.(msg.you, msg.round)
            break
          case 'state': {
            const { type: _, ...state } = msg
            update((prev) => ({ ...prev, state }))
            break
          }
          case 'boards':
            for (const [pid, rows] of Object.entries(msg.boards)) boards.set(Number(pid), rows)
            setBoardsVersion((v) => v + 1)
            break
          case 'garbage':
            handlersRef.current.onGarbage?.(msg.lines, msg.from)
            break
          case 'ko':
            handlersRef.current.onKo?.(msg)
            break
          case 'error':
            stopped = true
            setError({
              code: msg.code,
              message: msg.code === 'not_found' && welcomed ? '這個房間已經關閉了，請重新配對或建立房間' : msg.message,
            })
            break
        }
      }
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null
        update((prev) => ({ ...prev, connected: false }))
        if (stopped) return
        timer = setTimeout(connect, Math.min(1000 * 2 ** retries++, 10_000))
      }
    }

    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [code, key, attempt, boards])

  /** public：快速配對（加入正在等人的公開房間，沒有就開一間） */
  const create = useCallback(
    async (isPublic: boolean) => {
      setBusy(true)
      setError(null)
      try {
        const room = await api<{ code: string }>('/games/tetris/rooms', {
          method: 'POST',
          body: JSON.stringify({ public: isPublic }),
        })
        setCode(room.code)
      } catch (e) {
        setError({ code: null, message: errorMessage(e) })
      } finally {
        setBusy(false)
      }
    },
    [setCode],
  )

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

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
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
    you: current?.you ?? null,
    connected: current?.connected ?? false,
    state: current?.state ?? null,
    boards,
    boardsVersion,
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

export type Arena = ReturnType<typeof useArena>
