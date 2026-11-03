import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, errorMessage } from '../../api'
import { useAuth } from '../../auth'
import { loadPartyName, savePartyName, type ChatLine } from '../shared/useParty'
import { normalizeCode, playerId } from '../shared/useRoom'

/**
 * 遊戲室（後端見 `backend/src/lobby.rs`）：一群人先待在同一個房間，房主選遊戲，伺服器替大家開好那款遊戲的房間，
 * 收到新的 `playing` 而且自己在名單裡就自動跳到 `/games/<game>?room=<code>`。換遊戲時不用重開房間、重新邀請。
 *
 * 整個小遊戲區（`GamesLayout`）共用一條連線，玩遊戲的時候也連著，房主換遊戲時大家才跟得過去。
 * 遊戲室代碼存在 sessionStorage（和訪客的 player id 一樣只認這個分頁），重新整理後接著連。
 *
 * 協定（JSON over WebSocket，`/api/games/lobby/{code}/ws?player=<id>&name=<暱稱>`，認人的方式和派對房間一樣）：
 *   client → server  { type: 'chat', text }
 *                    { type: 'name', name }
 *                    房主才能做：
 *                    { type: 'play', game, players? }   開一間 `game`（網址上的遊戲 id）；兩人的棋類要帶上場的兩個 pid（照座位順序）
 *                    { type: 'kick', pid }              請人離開（之後不能再進來）
 *   server → client  { type: 'welcome', you }
 *                    { type: 'lobby', host, players, playing }   見 LobbyState
 *                    { type: 'chats', lines } / { type: 'chat', line }   格式和派對房間的聊天一樣
 *                    { type: 'notice', message }        自己的操作被拒絕
 *                    { type: 'error', code, message }   之後伺服器會關閉連線（not_found、full、replaced、kicked…）
 */

export type LobbyPlayer = { pid: number; name: string; online: boolean }

export type LobbyPlaying = {
  /** 每開一間加一 */
  id: number
  game: string
  room: string
  /** 兩人的棋類：上場的兩個人（照座位順序）；其他遊戲是 null，所有人都去 */
  players: number[] | null
}

export type LobbyState = {
  host: number | null
  /** 照進來的順序；斷線的人會留一分鐘 */
  players: LobbyPlayer[]
  /** 現在在玩的那一間 */
  playing: LobbyPlaying | null
}

type ServerMessage =
  | { type: 'welcome'; you: number }
  | ({ type: 'lobby' } & LobbyState)
  | { type: 'chats'; lines: ChatLine[] }
  | { type: 'chat'; line: ChatLine }
  | { type: 'notice'; message: string }
  | { type: 'error'; code: string; message: string }

type Live = { key: string; you: number | null; connected: boolean; state: LobbyState | null; chat: ChatLine[] }

type RoomError = { code: string | null; message: string }

const CODE_KEY = 'games:lobby'
const CHAT_KEEP = 200
const NO_CHAT: ChatLine[] = []

function loadCode(): string | null {
  try {
    return sessionStorage.getItem(CODE_KEY)
  } catch {
    return null
  }
}

function saveCode(code: string | null) {
  try {
    if (code) sessionStorage.setItem(CODE_KEY, code)
    else sessionStorage.removeItem(CODE_KEY)
  } catch {
    // 存不了就只在這一頁有效
  }
}

export function lobbyPath(code: string): string {
  return `/games/room/${encodeURIComponent(code)}`
}

export function playingPath(playing: LobbyPlaying): string {
  return `/games/${playing.game}?room=${encodeURIComponent(playing.room)}`
}

/** 這一間有沒有我（不是棋類就是所有人） */
export function includes(playing: LobbyPlaying, you: number | null): boolean {
  return playing.players === null || (you !== null && playing.players.includes(you))
}

export type Lobby = ReturnType<typeof useLobbyConnection>

export const LobbyContext = createContext<Lobby | null>(null)

/** 小遊戲區裡（`GamesLayout` 底下）任何地方都拿得到 */
export function useLobby(): Lobby {
  const lobby = useContext(LobbyContext)
  if (!lobby) throw new Error('useLobby must be used inside GamesLayout')
  return lobby
}

/** 只給 `GamesLayout` 用一次，其他地方用 `useLobby` */
export function useLobbyConnection() {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  })
  const [code, setCodeState] = useState<string | null>(loadCode)
  const { user, loading } = useAuth()
  // 登入狀態確定前不連線，否則會先用訪客身分進去
  const key = code && !loading ? `${code}:${user?.id ?? 'guest'}` : null
  const [live, setLive] = useState<Live | null>(null)
  const current = live && live.key === key ? live : null
  const [error, setError] = useState<RoomError | null>(null)
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  /** 跟著遊戲室換過幾次遊戲；遊戲頁拿來當 key，同一款遊戲換了房間也會整個重來 */
  const [follow, setFollow] = useState(0)
  const socket = useRef<WebSocket | null>(null)
  /** 每個遊戲室最後看到的 `playing.id`：連上時已經在玩的不跳過去，之後換了才跳 */
  const seen = useRef(new Map<string, number>())

  const setCode = useCallback((next: string | null) => {
    saveCode(next)
    setCodeState(next)
    setError(null)
  }, [])

  useEffect(() => {
    if (!code || !key) return
    const lobbyCode = code
    const roomKey = key
    const update = (fn: (prev: Live) => Live) => setLive((prev) => (prev && prev.key === roomKey ? fn(prev) : prev))

    let stopped = false
    let welcomed = false
    let you: number | null = null
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null

    function follow(playing: LobbyPlaying | null) {
      const last = seen.current.get(lobbyCode)
      seen.current.set(lobbyCode, playing?.id ?? 0)
      if (!playing || last === undefined || last === playing.id || !includes(playing, you)) return
      setFollow((n) => n + 1)
      navigateRef.current(playingPath(playing))
    }

    function connect() {
      const url = new URL(`/api/games/lobby/${encodeURIComponent(lobbyCode)}/ws`, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('player', playerId())
      const name = loadPartyName()
      if (name) url.searchParams.set('name', name)
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
            you = msg.you
            setLive((prev) => ({
              key: roomKey,
              you: msg.you,
              connected: true,
              state: prev && prev.key === roomKey ? prev.state : null,
              chat: prev && prev.key === roomKey ? prev.chat : NO_CHAT,
            }))
            setError(null)
            break
          case 'lobby': {
            const { type: _, ...state } = msg
            update((prev) => ({ ...prev, state }))
            follow(state.playing)
            break
          }
          case 'chats':
            update((prev) => ({ ...prev, chat: msg.lines.slice(-CHAT_KEEP) }))
            break
          case 'chat':
            update((prev) => ({ ...prev, chat: [...prev.chat, msg.line].slice(-CHAT_KEEP) }))
            break
          case 'notice':
            setNotice((prev) => ({ id: (prev?.id ?? 0) + 1, message: msg.message }))
            break
          case 'error':
            stopped = true
            setError({
              code: msg.code,
              message:
                msg.code === 'not_found' && welcomed
                  ? '這個遊戲室已經關閉了（可能是伺服器更新），請開新的遊戲室'
                  : msg.message,
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
  }, [code, key, attempt])

  const create = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const lobby = await api<{ code: string }>('/games/lobby', { method: 'POST' })
      setCode(lobby.code)
      navigateRef.current(lobbyPath(lobby.code))
    } catch (e) {
      setError({ code: null, message: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }, [setCode])

  const enter = useCallback(
    (next: string) => {
      const normalized = normalizeCode(next)
      if (normalized) setCode(normalized)
    },
    [setCode],
  )

  const leave = useCallback(() => {
    if (code) seen.current.delete(code)
    setCode(null)
  }, [code, setCode])

  const reconnect = useCallback(() => {
    setError(null)
    setAttempt((n) => n + 1)
  }, [])

  const raw = useCallback((message: object) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }, [])

  const say = useCallback((text: string) => raw({ type: 'chat', text }), [raw])
  const play = useCallback((game: string, players?: number[]) => raw({ type: 'play', game, players }), [raw])
  const kick = useCallback((pid: number) => raw({ type: 'kick', pid }), [raw])
  const rename = useCallback(
    (name: string) => {
      savePartyName(name)
      if (name) raw({ type: 'name', name })
    },
    [raw],
  )

  const state = current?.state ?? null
  const you = current?.you ?? null
  return {
    code,
    you,
    me: state?.players.find((p) => p.pid === you) ?? null,
    isHost: state !== null && you !== null && state.host === you,
    connected: current?.connected ?? false,
    state,
    playing: state?.playing ?? null,
    chat: current?.chat ?? NO_CHAT,
    notice,
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
    busy,
    follow,
    inviteUrl: code ? new URL(lobbyPath(code), window.location.href).toString() : null,
    create,
    enter,
    leave,
    reconnect,
    say,
    play,
    kick,
    rename,
  }
}
