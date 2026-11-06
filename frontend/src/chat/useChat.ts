import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'

/** 跟後端 chat.rs 對應 */
export type ChatMessage = {
  id: number
  user_id: number
  username: string
  text: string
  nonce: string | null
  created_at: string
}

export type OnlineUser = { id: number; username: string; active: boolean }

/** 自己送出、還沒等到伺服器回來的訊息；failed 是伺服器不收（太長、太快…）的原因 */
export type Pending = { nonce: string; text: string; failed?: string }

export type ChatStatus = 'connecting' | 'open' | 'reconnecting' | 'unauthorized'

type ServerMessage =
  | { type: 'welcome'; you: number; messages: ChatMessage[]; more: boolean }
  | { type: 'message'; message: ChatMessage }
  | { type: 'deleted'; id: number }
  | { type: 'presence'; users: OnlineUser[] }
  | { type: 'error'; code: string; message: string; nonce?: string | null }

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

/**
 * 聊天室的連線：斷線自動重連，重連後拿最近 50 則補上漏掉的；沒等到回音的訊息用同一個 nonce 重送（伺服器不會存兩次）。
 * `endpoint` 是這個瀏覽器的推播 endpoint，和「有沒有在看」一起回報給伺服器，決定要不要推播。
 */
export function useChat(endpoint: string | null, onIncoming: (message: ChatMessage) => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [more, setMore] = useState(false)
  const [me, setMe] = useState<number | null>(null)
  const [online, setOnline] = useState<OnlineUser[]>([])
  const [status, setStatus] = useState<ChatStatus>('connecting')
  const [pending, setPending] = useState<Pending[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [watching, setWatching] = useState(isWatching)

  const socketRef = useRef<WebSocket | null>(null)
  // 連線的事件處理器要讀最新的值，但不能因為這些值改變就重連
  const pendingRef = useRef(pending)
  const reportRef = useRef({ active: watching, endpoint })
  const onIncomingRef = useRef(onIncoming)
  useLayoutEffect(() => {
    pendingRef.current = pending
    reportRef.current = { active: watching, endpoint }
    onIncomingRef.current = onIncoming
  })

  const sendRaw = useCallback((payload: object) => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(payload))
    return true
  }, [])

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

    function connect() {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${scheme}://${location.host}/api/chat/ws`)
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
            const latest = data.messages
            setMessages((prev) => {
              const newest = prev.at(-1)?.id ?? 0
              // 第一次連上，或斷線太久中間有缺：直接換成最近這 50 則
              if (latest.length === 0 || prev.length === 0 || latest[0].id > newest) {
                setMore(data.more)
                return latest
              }
              // 保留更早載入的，最近這段以伺服器為準（斷線時被刪掉的也會跟著消失）
              return [...prev.filter((m) => m.id < latest[0].id), ...latest]
            })
            // 斷線前送出、沒等到回音的：已經在這 50 則裡就算送到了，其他的用同一個 nonce 重送
            const delivered = new Set(latest.filter((m) => m.user_id === data.you).map((m) => m.nonce))
            const resend = pendingRef.current.filter((p) => !p.failed && !delivered.has(p.nonce))
            setPending((prev) => prev.filter((p) => !delivered.has(p.nonce)))
            for (const p of resend) socket.send(JSON.stringify({ type: 'send', text: p.text, nonce: p.nonce }))
            break
          }
          case 'message': {
            const message = data.message
            setMessages((prev) => insert(prev, message))
            if (message.nonce) setPending((prev) => prev.filter((p) => p.nonce !== message.nonce))
            onIncomingRef.current(message)
            break
          }
          case 'deleted':
            setMessages((prev) => prev.filter((m) => m.id !== data.id))
            break
          case 'presence':
            setOnline(data.users)
            break
          case 'error':
            if (data.code === 'unauthorized') {
              fatal = true
              setStatus('unauthorized')
            } else if (data.nonce) {
              const failed = data.message
              setPending((prev) => prev.map((p) => (p.nonce === data.nonce ? { ...p, failed } : p)))
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
      setPending((prev) => [...prev, { nonce, text }])
      // 沒連上的話先留著，重連後一起送
      sendRaw({ type: 'send', text, nonce })
    },
    [sendRaw],
  )

  const retrySend = useCallback(
    (nonce: string) => {
      const item = pendingRef.current.find((p) => p.nonce === nonce)
      if (!item) return
      setPending((prev) => prev.map((p) => (p.nonce === nonce ? { nonce, text: p.text } : p)))
      sendRaw({ type: 'send', text: item.text, nonce })
    },
    [sendRaw],
  )

  const discard = useCallback((nonce: string) => {
    setPending((prev) => prev.filter((p) => p.nonce !== nonce))
  }, [])

  const remove = useCallback((id: number) => sendRaw({ type: 'delete', id }), [sendRaw])

  const loadOlder = useCallback(async () => {
    const before = messages[0]?.id
    if (before === undefined) return
    const page = await api<{ messages: ChatMessage[]; more: boolean }>(`/chat/messages?before=${before}`)
    setMessages((prev) => page.messages.reduce(insert, prev))
    setMore(page.more)
  }, [messages])

  return {
    messages,
    more,
    me,
    online,
    status,
    pending,
    watching,
    notice,
    clearNotice: () => setNotice(null),
    send,
    retrySend,
    discard,
    remove,
    loadOlder,
  }
}
