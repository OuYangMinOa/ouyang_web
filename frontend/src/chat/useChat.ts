import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { RoomId } from './rooms'

/** 跟後端 chat.rs 對應 */
export type ChatMessage = {
  id: number
  /** 哪一間：null 是大廳 */
  room: RoomId
  user_id: number
  username: string
  text: string
  nonce: string | null
  created_at: string
}

export type OnlineUser = { id: number; username: string; active: boolean }

/** 自己送出、還沒等到伺服器回來的訊息；failed 是伺服器不收（太長、太快…）的原因 */
export type Pending = { nonce: string; room: RoomId; text: string; failed?: string }

export type ChatStatus = 'connecting' | 'open' | 'reconnecting' | 'unauthorized'

type History = { room: RoomId; messages: ChatMessage[]; more: boolean }

type ServerMessage =
  | ({ type: 'welcome'; you: number } & History)
  | ({ type: 'history' } & History)
  | { type: 'message'; message: ChatMessage }
  | { type: 'deleted'; id: number; room: RoomId }
  | { type: 'presence'; users: OnlineUser[] }
  | { type: 'rooms' }
  | { type: 'error'; code: string; message: string; nonce?: string | null; room?: RoomId }

/** 正在看的那間：loaded 是最近的 50 則拿到了沒 */
type View = { room: RoomId; messages: ChatMessage[]; more: boolean; loaded: boolean }

export type ChatEvents = {
  /** 收到任何一間的新訊息（包括自己送的；連線會收到自己所有房間的訊息，不只正在看的這間） */
  onIncoming: (message: ChatMessage) => void
  /** 私人房間的列表可能變了（連上、重連、有人加入或離開、改名…）：重新讀一次 */
  onRoomsChanged: () => void
  /** 正在看的私人房間不在了（被移出、房間被刪掉），已經換回大廳 */
  onRoomGone: (room: number) => void
}

export const MAX_TEXT = 2000

/** 視窗看得到而且在前景：有人在看，有新訊息就不用推播 */
export function isWatching() {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function newNonce() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

/** 依 id 排好、去掉重複 */
function insert(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (list.some((m) => m.id === message.id)) return list
  const next = [...list, message]
  next.sort((a, b) => a.id - b.id)
  return next
}

function emptyView(room: RoomId): View {
  return { room, messages: [], more: false, loaded: false }
}

/**
 * 聊天室的連線：斷線自動重連，重連後拿正在看的那間最近 50 則補上漏掉的；沒等到回音的訊息用同一個 nonce 重送（伺服器不會存兩次）。
 * `room` 是正在看的那間，換房間不用重連，跟伺服器要那間的最近 50 則就好。
 * `endpoint` 是這個瀏覽器的推播 endpoint，和「有沒有在看」一起回報給伺服器，決定要不要推播。
 */
export function useChat(room: RoomId, endpoint: string | null, events: ChatEvents) {
  const [view, setView] = useState<View>(() => emptyView(room))
  const [me, setMe] = useState<number | null>(null)
  const [online, setOnline] = useState<OnlineUser[]>([])
  const [status, setStatus] = useState<ChatStatus>('connecting')
  const [pending, setPending] = useState<Pending[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [watching, setWatching] = useState(isWatching)

  const socketRef = useRef<WebSocket | null>(null)
  /** 正在看（或正在換過去）的那間；收到的歷史不是這間的就丟掉 */
  const roomRef = useRef(room)
  // 連線的事件處理器要讀最新的值，但不能因為這些值改變就重連
  const pendingRef = useRef(pending)
  const reportRef = useRef({ active: watching, endpoint })
  const eventsRef = useRef(events)
  useLayoutEffect(() => {
    pendingRef.current = pending
    reportRef.current = { active: watching, endpoint }
    eventsRef.current = events
  })

  const sendRaw = useCallback((payload: object) => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(payload))
    return true
  }, [])

  // 換房間：跟伺服器要那間的最近 50 則。沒連上的話，重連時的 welcome 就是那間的。
  // 用 layout effect：畫面換過去之前 roomRef 就要改好，不然換完馬上送出的訊息會送到上一間
  useLayoutEffect(() => {
    if (room === roomRef.current) return
    roomRef.current = room
    setView(emptyView(room))
    sendRaw({ type: 'open', room })
  }, [room, sendRaw])

  // 視窗切到前景、背景、縮小
  useEffect(() => {
    const update = () => setWatching(isWatching())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  useEffect(() => {
    sendRaw({ type: 'state', active: watching, endpoint })
  }, [watching, endpoint, sendRaw])

  useEffect(() => {
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    /** 一間的最近 50 則：剛換過來就連同載入時收到的新訊息一起放；重連的話補上斷線時漏掉的 */
    function applyHistory(data: History) {
      if (data.room !== roomRef.current) return
      const latest = data.messages
      setView((prev) => {
        if (prev.room !== data.room || !prev.loaded) {
          const live = prev.room === data.room ? prev.messages : []
          return { room: data.room, messages: live.reduce(insert, latest), more: data.more, loaded: true }
        }
        const newest = prev.messages.at(-1)?.id ?? 0
        // 斷線太久中間有缺：直接換成最近這 50 則
        if (latest.length === 0 || prev.messages.length === 0 || latest[0].id > newest) {
          return { ...prev, messages: latest, more: data.more }
        }
        // 保留更早載入的，最近這段以伺服器為準（斷線時被刪掉的也會跟著消失）
        return { ...prev, messages: [...prev.messages.filter((m) => m.id < latest[0].id), ...latest] }
      })
    }

    /** 正在看的房間不在了：回到大廳 */
    function leaveGoneRoom(socket: WebSocket, gone: number) {
      roomRef.current = null
      setView(emptyView(null))
      socket.send(JSON.stringify({ type: 'open', room: null }))
      eventsRef.current.onRoomGone(gone)
    }

    function connect() {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const query = roomRef.current === null ? '' : `?room=${roomRef.current}`
      const socket = new WebSocket(`${scheme}://${location.host}/api/chat/ws${query}`)
      socketRef.current = socket
      let fatal = false

      socket.onopen = () => {
        attempt = 0
        socket.send(JSON.stringify({ type: 'state', ...reportRef.current }))
      }
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data) as ServerMessage
        switch (data.type) {
          case 'welcome': {
            setStatus('open')
            setMe(data.you)
            const room = data.room ?? null
            // 要看的房間已經不在了（被移出、刪掉）：伺服器給的是大廳
            const wanted = roomRef.current
            if (room !== wanted) {
              roomRef.current = room
              setView(emptyView(room))
              if (wanted !== null) eventsRef.current.onRoomGone(wanted)
            }
            applyHistory({ room, messages: data.messages, more: data.more })
            // 斷線前送出、沒等到回音的：已經在這 50 則裡就算送到了，其他的用同一個 nonce 重送
            const delivered = new Set(data.messages.filter((m) => m.user_id === data.you).map((m) => m.nonce))
            const resend = pendingRef.current.filter((p) => !p.failed && !delivered.has(p.nonce))
            setPending((prev) => prev.filter((p) => !delivered.has(p.nonce)))
            for (const p of resend) {
              socket.send(JSON.stringify({ type: 'send', room: p.room, text: p.text, nonce: p.nonce }))
            }
            eventsRef.current.onRoomsChanged()
            break
          }
          case 'history':
            applyHistory({ room: data.room ?? null, messages: data.messages, more: data.more })
            break
          case 'message': {
            const message = { ...data.message, room: data.message.room ?? null }
            if (message.room === roomRef.current) {
              setView((prev) => (prev.room === message.room ? { ...prev, messages: insert(prev.messages, message) } : prev))
            }
            if (message.nonce) setPending((prev) => prev.filter((p) => p.nonce !== message.nonce))
            eventsRef.current.onIncoming(message)
            break
          }
          case 'deleted':
            setView((prev) => ({ ...prev, messages: prev.messages.filter((m) => m.id !== data.id) }))
            break
          case 'presence':
            setOnline(data.users)
            break
          case 'rooms':
            eventsRef.current.onRoomsChanged()
            break
          case 'error':
            if (data.code === 'unauthorized') {
              fatal = true
              setStatus('unauthorized')
            } else if (data.nonce) {
              const failed = data.message
              setPending((prev) => prev.map((p) => (p.nonce === data.nonce ? { ...p, failed } : p)))
            } else if (data.code === 'room_not_found' && typeof data.room === 'number') {
              if (data.room === roomRef.current) leaveGoneRoom(socket, data.room)
            } else {
              setNotice(data.message)
            }
            break
        }
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        if (stopped || fatal) return
        setStatus('reconnecting')
        // 1、2、4、8 秒…最多 15 秒
        retry = setTimeout(connect, Math.min(15_000, 1000 * 2 ** attempt++))
      }
    }

    // 網路恢復、回到分頁時不用等倒數，馬上重連
    function reconnectNow() {
      if (stopped || socketRef.current || retry === undefined) return
      clearTimeout(retry)
      retry = undefined
      connect()
    }

    connect()
    window.addEventListener('online', reconnectNow)
    document.addEventListener('visibilitychange', reconnectNow)
    return () => {
      stopped = true
      clearTimeout(retry)
      window.removeEventListener('online', reconnectNow)
      document.removeEventListener('visibilitychange', reconnectNow)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [])

  const send = useCallback(
    (text: string) => {
      const nonce = newNonce()
      const room = roomRef.current
      setPending((prev) => [...prev, { nonce, room, text }])
      // 沒連上的話先留著，重連後一起送
      sendRaw({ type: 'send', room, text, nonce })
    },
    [sendRaw],
  )

  const retrySend = useCallback(
    (nonce: string) => {
      const item = pendingRef.current.find((p) => p.nonce === nonce)
      if (!item) return
      setPending((prev) => prev.map((p) => (p.nonce === nonce ? { nonce, room: p.room, text: p.text } : p)))
      sendRaw({ type: 'send', room: item.room, text: item.text, nonce })
    },
    [sendRaw],
  )

  const discard = useCallback((nonce: string) => {
    setPending((prev) => prev.filter((p) => p.nonce !== nonce))
  }, [])

  const remove = useCallback((id: number) => sendRaw({ type: 'delete', id }), [sendRaw])

  /** 私人房間看到哪一則了，伺服器用來算未讀數 */
  const markRead = useCallback((room: number, id: number) => sendRaw({ type: 'read', room, id }), [sendRaw])

  const loadOlder = useCallback(async () => {
    const before = view.messages[0]?.id
    if (before === undefined) return
    const loading = view.room
    const query = new URLSearchParams({ before: String(before) })
    if (loading !== null) query.set('room', String(loading))
    const page = await api<{ messages: ChatMessage[]; more: boolean }>(`/chat/messages?${query}`)
    setView((prev) =>
      prev.room === loading ? { ...prev, messages: page.messages.reduce(insert, prev.messages), more: page.more } : prev,
    )
  }, [view])

  // 換房間的那一下 view 還是上一間的，先不要顯示
  const current = view.room === room

  return {
    messages: current ? view.messages : [],
    more: current && view.more,
    loaded: current && view.loaded,
    me,
    online,
    status,
    pending: pending.filter((p) => p.room === room),
    watching,
    notice,
    clearNotice: () => setNotice(null),
    send,
    retrySend,
    discard,
    remove,
    markRead,
    loadOlder,
  }
}
