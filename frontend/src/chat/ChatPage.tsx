import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { errorMessage, PERMISSIONS } from '../api'
import { useAuth } from '../auth'
import {
  clearNotifications,
  disablePush,
  enablePush,
  permissionState,
  restorePush,
  testPush,
  type PushState,
} from './push'
import { isWatching, MAX_TEXT, useChat, type ChatMessage, type OnlineUser } from './useChat'
import './chat.css'

const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
/** 同一個人 5 分鐘內連續的訊息合在一起，不重複顯示名字 */
const GROUP_GAP_MS = 5 * 60 * 1000
const URL_PATTERN = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}，。！？）」』])/g

function toDate(iso: string) {
  return new Date(iso)
}

function timeLabel(date: Date) {
  return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayLabel(date: Date) {
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(date) === dayKey(today)) return '今天'
  if (dayKey(date) === dayKey(yesterday)) return '昨天'
  const sameYear = date.getFullYear() === today.getFullYear()
  return date.toLocaleDateString('zh-TW', {
    year: sameYear ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

/** 訊息裡的網址變成連結 */
function Linkified({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    if (start > last) parts.push(text.slice(last, start))
    parts.push(
      <a key={start} href={match[0]} target="_blank" rel="noopener noreferrer">
        {match[0]}
      </a>,
    )
    last = start + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** 沒在看的時候收到的訊息數放在分頁標題前面 */
function useUnreadTitle() {
  const [unread, setUnread] = useState(0)
  const originalRef = useRef<string | null>(null)

  useEffect(() => {
    originalRef.current ??= document.title
    const original = originalRef.current
    document.title = unread > 0 ? `(${unread}) 聊天室｜${original}` : original
  }, [unread])

  useEffect(
    () => () => {
      if (originalRef.current !== null) document.title = originalRef.current
    },
    [],
  )

  const bump = useCallback(() => setUnread((n) => n + 1), [])
  const reset = useCallback(() => setUnread(0), [])
  return { bump, reset }
}

export default function ChatPage() {
  const { user, can } = useAuth()
  const isAdmin = can(PERMISSIONS.adminUsers)

  // ---- 通知 ----
  const [push, setPush] = useState<PushState>(permissionState)
  const [subscription, setSubscription] = useState<PushSubscription | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushNote, setPushNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    restorePush()
      .then((restored) => {
        if (!restored) return
        setSubscription(restored)
        setPush('on')
      })
      .catch(() => {})
  }, [])

  async function runPush(action: () => Promise<void>) {
    setPushBusy(true)
    setPushNote(null)
    try {
      await action()
    } catch (e) {
      setPushNote({ ok: false, text: errorMessage(e) })
      setPush(permissionState() === 'denied' ? 'denied' : subscription ? 'on' : 'off')
    } finally {
      setPushBusy(false)
    }
  }

  const turnOn = () =>
    runPush(async () => {
      const created = await enablePush()
      setSubscription(created)
      setPush('on')
      setPushNote({ ok: true, text: '已開啟。可以按「測試通知」確認 Windows 會跳出來。' })
    })
  const turnOff = () =>
    runPush(async () => {
      if (subscription) await disablePush(subscription)
      setSubscription(null)
      setPush('off')
    })
  const sendTest = () =>
    runPush(async () => {
      if (!subscription) return
      await testPush(subscription)
      setPushNote({ ok: true, text: '送出了。沒看到的話，檢查 Windows 的「通知」設定和「專注」模式。' })
    })

  // ---- 訊息 ----
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const prependRef = useRef<number | null>(null)
  const [newBelow, setNewBelow] = useState(false)
  const { bump: bumpUnread, reset: resetUnread } = useUnreadTitle()

  const onIncoming = useCallback(
    (message: ChatMessage) => {
      if (message.user_id === user?.id) {
        // 自己送的一律捲到底
        stickRef.current = true
        return
      }
      if (!isWatching()) bumpUnread()
      if (!stickRef.current) setNewBelow(true)
    },
    [user?.id, bumpUnread],
  )

  const chat = useChat(subscription?.endpoint ?? null, onIncoming)
  const { messages, pending, watching } = chat
  // 回到視窗：清掉未讀數和通知中心裡的聊天通知
  useEffect(() => {
    if (!watching) return
    resetUnread()
    clearNotifications('chat').catch(() => {})
  }, [watching, resetUnread])

  useLayoutEffect(() => {
    const list = scrollRef.current
    if (!list) return
    if (prependRef.current !== null) {
      // 載入更早的訊息：維持原本看的位置
      list.scrollTop += list.scrollHeight - prependRef.current
      prependRef.current = null
    } else if (stickRef.current) {
      list.scrollTop = list.scrollHeight
    }
  }, [messages, pending])

  function scrollToBottom() {
    const list = scrollRef.current
    if (list) list.scrollTop = list.scrollHeight
    stickRef.current = true
    setNewBelow(false)
  }

  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  async function loadOlder() {
    setLoadingOlder(true)
    setOlderError(null)
    prependRef.current = scrollRef.current?.scrollHeight ?? null
    try {
      await chat.loadOlder()
    } catch (e) {
      prependRef.current = null
      setOlderError(errorMessage(e))
    } finally {
      setLoadingOlder(false)
    }
  }

  // ---- 輸入 ----
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    // 依內容長高，最多約 6 行
    const box = inputRef.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(box.scrollHeight, 168)}px`
  }, [input])

  function submit() {
    const text = input.trim()
    if (!text || text.length > MAX_TEXT || chat.status === 'unauthorized') return
    chat.send(text)
    setInput('')
    stickRef.current = true
    inputRef.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文輸入法選字時按的 Enter 不算送出；手機的 Enter 是換行，用按鈕送出
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarsePointer) {
      e.preventDefault()
      submit()
    }
  }

  function remove(message: ChatMessage) {
    if (confirm('刪除這則訊息？大家都會看不到。')) chat.remove(message.id)
  }

  const [panelOpen, setPanelOpen] = useState(false)
  const tooLong = input.length > MAX_TEXT

  return (
    <div className={`chat-page ${panelOpen ? 'panel-open' : ''}`}>
      <section className="chat-main">
        <header className="chat-head">
          <h1 className="chat-title">聊天室</h1>
          <ConnectionBadge status={chat.status} />
          <button
            type="button"
            className="secondary chat-panel-toggle"
            aria-expanded={panelOpen}
            aria-controls="chat-panel"
            onClick={() => setPanelOpen((open) => !open)}
          >
            👥 {chat.online.length}
            <span aria-hidden="true">{push === 'on' ? ' · 🔔' : ''}</span>
          </button>
        </header>

        {chat.status === 'unauthorized' && (
          <p className="chat-banner error">
            登入已經失效，<Link to="/login">請重新登入</Link>。
          </p>
        )}
        {chat.notice && (
          <p className="chat-banner error" role="alert">
            {chat.notice}
            <button type="button" className="link" onClick={chat.clearNotice}>
              知道了
            </button>
          </p>
        )}

        <div
          className="chat-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            if (stickRef.current) setNewBelow(false)
          }}
        >
          {chat.more && (
            <button type="button" className="secondary chat-older" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? '載入中…' : '載入更早的訊息'}
            </button>
          )}
          {olderError && <p className="error chat-empty">{olderError}</p>}
          {chat.status !== 'connecting' && messages.length === 0 && pending.length === 0 && (
            <p className="muted chat-empty">還沒有人說話，打個招呼吧。</p>
          )}
          <MessageList messages={messages} me={user?.id ?? null} canDeleteAll={isAdmin} onDelete={remove} />
          {pending.map((p) => (
            <div key={p.nonce} className={`chat-msg mine pending ${p.failed ? 'failed' : ''}`}>
              <div className="chat-bubble">{p.text}</div>
              <div className="chat-pending-state">
                {p.failed ? (
                  <>
                    <span className="error">沒送出：{p.failed}</span>
                    <button type="button" className="link" onClick={() => chat.retrySend(p.nonce)}>
                      重送
                    </button>
                    <button type="button" className="link" onClick={() => chat.discard(p.nonce)}>
                      不要了
                    </button>
                  </>
                ) : (
                  <span className="muted">{chat.status === 'open' ? '傳送中…' : '等連線恢復後送出'}</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {newBelow && (
          <button type="button" className="chat-new-below" onClick={scrollToBottom}>
            有新訊息 ↓
          </button>
        )}

        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={coarsePointer ? '輸入訊息' : '輸入訊息，Enter 送出、Shift+Enter 換行'}
            rows={1}
            aria-label="訊息"
            disabled={chat.status === 'unauthorized'}
          />
          <button type="submit" disabled={!input.trim() || tooLong || chat.status === 'unauthorized'}>
            送出
          </button>
        </form>
        {tooLong && (
          <p className="error chat-count">
            {input.length} / {MAX_TEXT} 字，太長了
          </p>
        )}
      </section>

      {panelOpen && <button type="button" className="chat-scrim" aria-label="關閉" onClick={() => setPanelOpen(false)} />}
      <aside id="chat-panel" className="chat-side">
        <NotifyCard
          state={push}
          busy={pushBusy}
          note={pushNote}
          onEnable={turnOn}
          onDisable={turnOff}
          onTest={sendTest}
        />
        <OnlineList users={chat.online} me={user?.id ?? null} />
      </aside>
    </div>
  )
}

function ConnectionBadge({ status }: { status: string }) {
  if (status === 'open' || status === 'unauthorized') return null
  return <span className="badge chat-status">{status === 'connecting' ? '連線中…' : '重新連線中…'}</span>
}

function MessageList({
  messages,
  me,
  canDeleteAll,
  onDelete,
}: {
  messages: ChatMessage[]
  me: number | null
  canDeleteAll: boolean
  onDelete: (message: ChatMessage) => void
}) {
  const rows: ReactNode[] = []
  let previous: ChatMessage | null = null
  for (const message of messages) {
    const date = toDate(message.created_at)
    const previousDate = previous ? toDate(previous.created_at) : null
    const newDay = !previousDate || dayKey(previousDate) !== dayKey(date)
    if (newDay) {
      rows.push(
        <div key={`day-${message.id}`} className="chat-day" role="separator">
          <span>{dayLabel(date)}</span>
        </div>,
      )
    }
    const continued =
      !newDay &&
      previous?.user_id === message.user_id &&
      date.getTime() - (previousDate?.getTime() ?? 0) < GROUP_GAP_MS
    const mine = message.user_id === me
    rows.push(
      <div key={message.id} className={`chat-msg ${mine ? 'mine' : ''} ${continued ? 'continued' : ''}`}>
        {!continued && (
          <div className="chat-meta">
            {!mine && <span className="chat-name">{message.username}</span>}
            <time dateTime={message.created_at}>{timeLabel(date)}</time>
          </div>
        )}
        <div className="chat-line">
          <div className="chat-bubble" title={continued ? timeLabel(date) : undefined}>
            <Linkified text={message.text} />
          </div>
          {(mine || canDeleteAll) && (
            <button
              type="button"
              className="chat-delete"
              aria-label="刪除這則訊息"
              title="刪除"
              onClick={() => onDelete(message)}
            >
              ×
            </button>
          )}
        </div>
      </div>,
    )
    previous = message
  }
  return <>{rows}</>
}

function NotifyCard({
  state,
  busy,
  note,
  onEnable,
  onDisable,
  onTest,
}: {
  state: PushState
  busy: boolean
  note: { ok: boolean; text: string } | null
  onEnable: () => void
  onDisable: () => void
  onTest: () => void
}) {
  return (
    <section className="chat-card">
      <h2 className="chat-card-title">🔔 通知</h2>
      <p className="muted">聊天室開著、但你沒在看（視窗在背景或縮小）時，有新訊息會跳出系統通知。</p>
      {state === 'unsupported' && (
        <p className="muted">這個瀏覽器不支援通知。iPhone 要先用 Safari「加入主畫面」，從主畫面打開才收得到。</p>
      )}
      {state === 'denied' && (
        <p className="error">通知被瀏覽器封鎖了：點網址列左邊的圖示，把「通知」改成允許後重新整理。</p>
      )}
      {state === 'off' && (
        <button type="button" onClick={onEnable} disabled={busy}>
          開啟通知
        </button>
      )}
      {state === 'on' && (
        <div className="chat-card-actions">
          <span className="badge ok">已開啟</span>
          <button type="button" className="secondary" onClick={onTest} disabled={busy}>
            測試通知
          </button>
          <button type="button" className="secondary" onClick={onDisable} disabled={busy}>
            關閉
          </button>
        </div>
      )}
      {note && <p className={note.ok ? 'success' : 'error'}>{note.text}</p>}
    </section>
  )
}

function OnlineList({ users, me }: { users: OnlineUser[]; me: number | null }) {
  return (
    <section className="chat-card">
      <h2 className="chat-card-title">線上 {users.length} 人</h2>
      <ul className="chat-online">
        {users.map((u) => (
          <li key={u.id}>
            <span className={`chat-dot ${u.active ? 'on' : ''}`} aria-hidden="true" />
            <span className="chat-online-name">
              {u.username}
              {u.id === me && <span className="muted">（你）</span>}
            </span>
            <span className="muted chat-online-state">{u.active ? '在看' : '離開視窗'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
