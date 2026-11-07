import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, errorMessage } from '../../api'
import { useAuth } from '../../auth'
import { load, save } from './storage'
import { normalizeCode, playerId } from './useRoom'

/**
 * 派對房間的連線（誰是臥底、大老二、你畫我猜…共用，後端見 `backend/src/party.rs`）。
 *
 * 規則全部在伺服器：用戶端只送「我想做什麼」，伺服器驗證後改狀態，再把每個座位各自的視角（view）送回來。
 * 別人的牌、別人的詞根本不會送到你的瀏覽器。房間只在記憶體裡，伺服器重啟或換版時房間會消失。
 *
 * 協定（JSON over WebSocket，`/api/games/<game>/party/{code}/ws?player=<id>&name=<暱稱>`；
 * 登入時用帳號認人、player 會被忽略，name 沒填就用帳號名稱）：
 *   client → server  { type: 'action', action }    遊戲動作（格式由各遊戲定義）
 *                    { type: 'chat', text }          聊天（最多 200 字），對局中會先交給遊戲決定誰看得到
 *                    { type: 'name', name }          改名字（對局中有座位時不行）
                    { type: 'watch', watch }        選觀戰（true，開局時不入座）或上場（false）；對局中改的話下一局才生效
 *                    房主才能做（其他人送了會被忽略）：
 *                    { type: 'start' }               開始／再來一局
 *                    { type: 'options', options }    改選項（不在對局中時）
 *                    { type: 'addBot' }              加一個電腦玩家（遊戲允許的話）
 *                    { type: 'kick', pid }           移除電腦或請人離開（被請走的人不能再進來）
 *                    { type: 'abort' }               中止這局，回到大廳
 *   server → client  { type: 'welcome', you }        you 是自己的 pid
 *                    { type: 'room', ... }            名單、房主、階段、選項，見 PartyRoom
 *                    { type: 'chats', lines }         連上時的聊天紀錄（只有自己看得到的）
 *                    { type: 'chat', line }
 *                    { type: 'view', view }           自己的視角；大廳裡是 null，內容和上次一樣就不會送
 *                    { type: 'event', event }         遊戲的即時事件（例如筆畫），不會重送，重連要靠 view
 *                    { type: 'notice', message }      自己的動作被拒絕（不會斷線）
 *                    { type: 'error', code, message } 之後伺服器會關閉連線，不要再重連
 *                                                     （not_found、full、replaced、kicked、rate_limited…）
 */

export type PartyPhase = 'lobby' | 'playing' | 'results'

export type PartyPlayer = {
  /** 房間內公開的編號，同一個人重連也不變 */
  pid: number
  name: string
  bot: boolean
  online: boolean
  /** 這局的座位；大廳裡、觀戰的人是 null */
  seat: number | null
  /** 自己選了觀戰（下一局開局時不入座）；電腦一定是 false */
  watching: boolean
}

export type PartyRoom<O> = {
  phase: PartyPhase
  /** 開過幾局 */
  round: number
  host: number | null
  options: O
  /** 最少、最多幾個座位 */
  min: number
  max: number
  /** 最多幾個電腦玩家，0 表示這個遊戲不能加電腦 */
  maxBots: number
  /** 人照進來的順序排，電腦在最後；開局時照這個順序入座 */
  players: PartyPlayer[]
}

export type ChatLine = {
  id: number
  /** 系統訊息是 null */
  pid: number | null
  name: string | null
  text: string
  tone: 'ok' | 'danger' | 'accent' | null
  /** 只有部分人看得到 */
  private: boolean
}

/** 每個遊戲的型別：`view` 是伺服器送的視角、`action` 是送出的動作、`options` 是房主的選項、`event` 是即時事件 */
export type PartyTypes = { view: unknown; action: unknown; options: unknown; event?: unknown }

type ServerMessage<T extends PartyTypes> =
  | { type: 'welcome'; you: number }
  | ({ type: 'room' } & PartyRoom<T['options']>)
  | { type: 'chats'; lines: ChatLine[] }
  | { type: 'chat'; line: ChatLine }
  | { type: 'view'; view: T['view'] | null }
  | { type: 'event'; event: T['event'] }
  | { type: 'notice'; message: string }
  | { type: 'error'; code: string; message: string }

type Live<T extends PartyTypes> = {
  key: string
  you: number | null
  connected: boolean
  room: PartyRoom<T['options']> | null
  view: T['view'] | null
  /** 收到這份 view 的時間（performance.now()）：view 裡的倒數從這個時間起算，不受畫面忙碌延遲影響 */
  viewAt: number
  chat: ChatLine[]
}

type RoomError = { code: string | null; message: string }

export const MAX_NAME = 12
export const MAX_CHAT = 200
/** 用戶端最多留幾則聊天 */
const CHAT_KEEP = 200
const NAME_KEY = 'party:name'

/** 派對遊戲共用的暱稱（沒填時登入的人用帳號名稱，訪客叫「訪客」） */
export function loadPartyName(): string {
  return load<string>(NAME_KEY, '')
}

export function savePartyName(name: string) {
  save(NAME_KEY, name)
}

const NO_CHAT: ChatLine[] = []

export type Party<T extends PartyTypes> = ReturnType<typeof useParty<T>>
/** 和遊戲無關的部分：共用的大廳、聊天元件只用這些，任何遊戲的 party 都能直接傳進去 */
export type AnyParty = Omit<Party<PartyTypes>, 'act' | 'setOptions' | 'subscribe' | 'view'>

/**
 * `game` 是網址上的遊戲 id（`/api/games/<game>/party`）。`enabled` 為 false 時不連線，但 ?room= 會保留。
 * `onEvent` 收即時事件；元件深處也可以用回傳的 `subscribe` 自己訂。
 */
export function useParty<T extends PartyTypes>(
  game: string,
  { enabled = true, onEvent }: { enabled?: boolean; onEvent?: (event: T['event']) => void } = {},
) {
  const [params, setParams] = useSearchParams()
  const code = params.get('room')
  const { user, loading } = useAuth()
  // 登入狀態確定前不連線，否則會先用訪客身分佔掉座位
  const key = code && enabled && !loading ? `${game}:${code}:${user?.id ?? 'guest'}` : null
  const [live, setLive] = useState<Live<T> | null>(null)
  const current = live && live.key === key ? live : null
  const [error, setError] = useState<RoomError | null>(null)
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const socket = useRef<WebSocket | null>(null)
  const onEventRef = useRef(onEvent)
  useEffect(() => {
    onEventRef.current = onEvent
  })
  const [listeners] = useState(() => new Set<(event: T['event']) => void>())

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
    const update = (fn: (prev: Live<T>) => Live<T>) => setLive((prev) => (prev && prev.key === roomKey ? fn(prev) : prev))

    let stopped = false
    let welcomed = false
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null

    function connect() {
      const url = new URL(`/api/games/${game}/party/${encodeURIComponent(code!)}/ws`, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('player', playerId())
      const name = loadPartyName()
      if (name) url.searchParams.set('name', name)
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
            // 接著會收到 room、chats、view；重連時先留著舊的畫面，不要閃一下
            setLive((prev) => ({
              key: roomKey,
              you: msg.you,
              connected: true,
              room: prev && prev.key === roomKey ? prev.room : null,
              view: prev && prev.key === roomKey ? prev.view : null,
              viewAt: prev && prev.key === roomKey ? prev.viewAt : 0,
              chat: prev && prev.key === roomKey ? prev.chat : NO_CHAT,
            }))
            setError(null)
            break
          case 'room': {
            const { type: _, ...room } = msg
            update((prev) => ({ ...prev, room }))
            break
          }
          case 'chats':
            update((prev) => ({ ...prev, chat: msg.lines.slice(-CHAT_KEEP) }))
            break
          case 'chat':
            update((prev) => ({ ...prev, chat: [...prev.chat, msg.line].slice(-CHAT_KEEP) }))
            break
          case 'view': {
            // 時間要在這裡記：更新函式要等到下一次 render 才會執行，畫面忙的時候會晚很多
            const viewAt = performance.now()
            update((prev) => ({ ...prev, view: msg.view, viewAt }))
            break
          }
          case 'event':
            onEventRef.current?.(msg.event)
            for (const listener of listeners) listener(msg.event)
            break
          case 'notice':
            setNotice((prev) => ({ id: (prev?.id ?? 0) + 1, message: msg.message }))
            break
          case 'error':
            stopped = true
            setError({
              code: msg.code,
              message: msg.code === 'not_found' && welcomed ? '這個房間已經關閉了（可能是伺服器更新），請建立新房間' : msg.message,
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
  }, [game, code, key, attempt, listeners])

  const create = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const room = await api<{ code: string }>(`/games/${game}/party`, { method: 'POST' })
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

  const raw = useCallback((message: object) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }, [])

  const act = useCallback((action: T['action']) => raw({ type: 'action', action }), [raw])
  const say = useCallback((text: string) => raw({ type: 'chat', text }), [raw])
  const start = useCallback(() => raw({ type: 'start' }), [raw])
  const setOptions = useCallback((options: T['options']) => raw({ type: 'options', options }), [raw])
  const addBot = useCallback(() => raw({ type: 'addBot' }), [raw])
  const kick = useCallback((pid: number) => raw({ type: 'kick', pid }), [raw])
  const watch = useCallback((on: boolean) => raw({ type: 'watch', watch: on }), [raw])
  const abort = useCallback(() => raw({ type: 'abort' }), [raw])
  const rename = useCallback(
    (name: string) => {
      savePartyName(name)
      if (name) raw({ type: 'name', name })
    },
    [raw],
  )
  const subscribe = useCallback(
    (listener: (event: T['event']) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    [listeners],
  )

  let inviteUrl: string | null = null
  if (code) {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.set('room', code)
    inviteUrl = url.toString()
  }

  const room = current?.room ?? null
  const you = current?.you ?? null
  const me = room?.players.find((p) => p.pid === you) ?? null

  return {
    code,
    you,
    me,
    /** 我這局的座位；大廳、觀戰時是 null */
    seat: me?.seat ?? null,
    isHost: room !== null && you !== null && room.host === you,
    connected: current?.connected ?? false,
    room,
    view: (current?.view ?? null) as T['view'] | null,
    /** 收到目前這份 view 的時間（performance.now()），即時遊戲拿來對時 */
    viewAt: current?.viewAt ?? 0,
    chat: current?.chat ?? NO_CHAT,
    /** 自己的動作被拒絕時的訊息；`id` 每次都不一樣，用來重新顯示 */
    notice,
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
    busy,
    create,
    join,
    leave,
    reconnect,
    act,
    say,
    start,
    setOptions,
    addBot,
    kick,
    watch,
    abort,
    rename,
    subscribe,
    inviteUrl,
    /** 座位上的人；被請走的人在這局結束前也還在名單裡 */
    playerAt: (seat: number) => room?.players.find((p) => p.seat === seat) ?? null,
  }
}
