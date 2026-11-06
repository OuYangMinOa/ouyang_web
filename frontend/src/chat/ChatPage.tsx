import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
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
import {
  createRoom,
  deleteRoom,
  formatCode,
  joinRoom,
  listRooms,
  MAX_ROOM_NAME,
  newRoomCode,
  removeMember,
  renameRoom,
  roomKey,
  type Room,
  type RoomId,
} from './rooms'
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

/** 網址的 ?room=：不是數字就當作大廳 */
function parseRoom(value: string | null): RoomId {
  return value && /^\d+$/.test(value) ? Number(value) : null
}

/** 通知的 tag，跟後端 chat.rs 一樣：每間各自合成一則 */
function notificationTag(room: RoomId) {
  return room === null ? 'chat' : `chat-room-${room}`
}

function countLabel(n: number) {
  return n > 99 ? '99+' : String(n)
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
  const navigate = useNavigate()

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

  // ---- 房間 ----
  const [params] = useSearchParams()
  const room = parseRoom(params.get('room'))
  /** 正在看的那間；換房間時馬上改，不用等重新 render（列表讀回來時要知道現在在哪間） */
  const roomRef = useRef(room)
  useLayoutEffect(() => {
    roomRef.current = room
  }, [room])

  const [rooms, setRooms] = useState<Room[] | null>(null)
  const roomsRef = useRef(rooms)
  useLayoutEffect(() => {
    roomsRef.current = rooms
  }, [rooms])
  /** 各間的未讀數（key 是 roomKey）：私人房間以伺服器算的為準，大廳只算這次打開後的 */
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [roomNotice, setRoomNotice] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const roomsSeq = useRef(0)

  const selectRoom = useCallback(
    (next: RoomId, options: { keepPanel?: boolean; replace?: boolean } = {}) => {
      roomRef.current = next
      navigate(next === null ? '/chat' : `/chat?room=${next}`, { replace: options.replace })
      setUnread((prev) => ({ ...prev, [roomKey(next)]: 0 }))
      setRoomNotice(null)
      if (!options.keepPanel) setPanelOpen(false)
    },
    [navigate],
  )

  /** 正在看的房間不在了（被移出、刪掉）：回大廳並說一聲 */
  const leaveGoneRoom = useCallback(
    (gone: number) => {
      const name = roomsRef.current?.find((r) => r.id === gone)?.name
      selectRoom(null, { keepPanel: true, replace: true })
      setRoomNotice(
        name ? `你已經不在「${name}」裡了：房間被刪掉，或你被移出了。` : '找不到這個房間，可能已經被刪掉，或你被移出了。',
      )
    },
    [selectRoom],
  )

  const refreshRooms = useCallback(async () => {
    // 比較晚開始讀的為準：中間有變動的話，先讀完的舊列表丟掉
    const seq = ++roomsSeq.current
    let list: Room[]
    try {
      list = await listRooms()
    } catch {
      return
    }
    if (seq !== roomsSeq.current) return
    setRooms(list)
    const current = roomRef.current
    setUnread((prev) => {
      const next: Record<string, number> = { lobby: prev.lobby ?? 0 }
      for (const r of list) next[roomKey(r.id)] = r.id === current ? 0 : r.unread
      return next
    })
    if (current !== null && !list.some((r) => r.id === current)) leaveGoneRoom(current)
  }, [leaveGoneRoom])

  // 列表平常是連上聊天室時讀；連不上的話也要有
  useEffect(() => {
    void refreshRooms()
  }, [refreshRooms])

  /** 自己改了房間：畫面先改，再讀一次列表對齊伺服器 */
  function changeRooms(update: (list: Room[]) => Room[]) {
    setRooms((prev) => update(prev ?? []))
    void refreshRooms()
  }
  function upsert(updated: Room) {
    changeRooms((list) =>
      list.some((r) => r.id === updated.id) ? list.map((r) => (r.id === updated.id ? updated : r)) : [...list, updated],
    )
  }

  // 點了通知：service worker 叫已經開著的聊天室換到那一間
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null
      if (data?.type !== 'open' || typeof data.url !== 'string') return
      const url = new URL(data.url, location.origin)
      if (url.pathname === '/chat') navigate(url.pathname + url.search)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [navigate])

  // ---- 訊息 ----
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const prependRef = useRef<number | null>(null)
  /** 「有新訊息 ↓」是哪一間的（換了房間就不算） */
  const [newBelowIn, setNewBelowIn] = useState<string | null>(null)
  const newBelow = newBelowIn === roomKey(room)
  const { bump: bumpUnread, reset: resetUnread } = useUnreadTitle()

  const onIncoming = useCallback(
    (message: ChatMessage) => {
      const here = message.room === roomRef.current
      if (message.user_id === user?.id) {
        // 自己送的一律捲到底
        if (here) stickRef.current = true
        return
      }
      if (!isWatching()) bumpUnread()
      if (here) {
        if (!stickRef.current) setNewBelowIn(roomKey(message.room))
      } else {
        const key = roomKey(message.room)
        setUnread((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }))
      }
    },
    [user?.id, bumpUnread],
  )

  const chat = useChat(room, subscription?.endpoint ?? null, {
    onIncoming,
    onRoomsChanged: () => void refreshRooms(),
    onRoomGone: (gone) => {
      leaveGoneRoom(gone)
      void refreshRooms()
    },
  })
  const { messages, pending, watching, markRead } = chat

  // 換房間：捲到最下面
  useLayoutEffect(() => {
    stickRef.current = true
  }, [room])

  // 回到視窗：清掉未讀數和通知中心裡這間的通知
  useEffect(() => {
    if (!watching) return
    resetUnread()
    clearNotifications(notificationTag(room)).catch(() => {})
  }, [watching, room, resetUnread])

  // 私人房間看到最新一則了：告訴伺服器，下次打開才不會算成未讀
  const latestId = messages.at(-1)?.id
  useEffect(() => {
    if (room === null || !watching || latestId === undefined || chat.status !== 'open') return
    markRead(room, latestId)
  }, [room, watching, latestId, chat.status, markRead])

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
    setNewBelowIn(null)
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

  const currentRoom = room === null ? null : (rooms?.find((r) => r.id === room) ?? null)
  const isOwner = currentRoom !== null && currentRoom.owner_id === user?.id
  const tooLong = input.length > MAX_TEXT
  const otherUnread = Object.entries(unread)
    .filter(([key]) => key !== roomKey(room))
    .reduce((sum, [, n]) => sum + n, 0)

  // ---- 房間的動作（錯誤丟給卡片顯示） ----
  const roomActions = {
    create: async (name: string) => {
      const created = await createRoom(name)
      upsert(created)
      // 面板留著，讓房主看到代碼
      selectRoom(created.id, { keepPanel: true })
    },
    join: async (code: string) => {
      const joined = await joinRoom(code)
      upsert(joined)
      selectRoom(joined.id)
    },
    rename: async (target: Room, name: string) => upsert(await renameRoom(target.id, name)),
    newCode: async (target: Room) => upsert(await newRoomCode(target.id)),
    kick: async (target: Room, member: number) => {
      await removeMember(target.id, member)
      void refreshRooms()
    },
    leave: async (target: Room) => {
      if (user) await removeMember(target.id, user.id)
      selectRoom(null, { keepPanel: true, replace: true })
      changeRooms((list) => list.filter((r) => r.id !== target.id))
    },
    remove: async (target: Room) => {
      await deleteRoom(target.id)
      selectRoom(null, { keepPanel: true, replace: true })
      changeRooms((list) => list.filter((r) => r.id !== target.id))
    },
  }

  return (
    <div className={`chat-page ${panelOpen ? 'panel-open' : ''}`}>
      <section className="chat-main">
        <header className="chat-head">
          <h1 className="chat-title">{room === null ? '大廳' : `🔒 ${currentRoom?.name ?? '私人房間'}`}</h1>
          <ConnectionBadge status={chat.status} />
          <button
            type="button"
            className="secondary chat-panel-toggle"
            aria-expanded={panelOpen}
            aria-controls="chat-panel"
            onClick={() => setPanelOpen((open) => !open)}
          >
            房間
            {otherUnread > 0 && (
              <span className="chat-unread" aria-label={`其他房間有 ${otherUnread} 則未讀`}>
                {countLabel(otherUnread)}
              </span>
            )}
            <span aria-hidden="true">
              {' '}
              · 👥 {chat.online.length}
              {push === 'on' ? ' · 🔔' : ''}
            </span>
          </button>
        </header>

        {chat.status === 'unauthorized' && (
          <p className="chat-banner error">
            登入已經失效，<Link to="/login">請重新登入</Link>。
          </p>
        )}
        {roomNotice && (
          <p className="chat-banner error" role="alert">
            {roomNotice}
            <button type="button" className="link" onClick={() => setRoomNotice(null)}>
              知道了
            </button>
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
            if (stickRef.current) setNewBelowIn(null)
          }}
        >
          {chat.more && (
            <button type="button" className="secondary chat-older" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? '載入中…' : '載入更早的訊息'}
            </button>
          )}
          {olderError && <p className="error chat-empty">{olderError}</p>}
          {!chat.loaded && chat.status === 'open' && <p className="muted chat-empty">載入中…</p>}
          {chat.loaded && messages.length === 0 && pending.length === 0 && (
            <p className="muted chat-empty">
              {room === null
                ? '還沒有人說話，打個招呼吧。'
                : '這間只有成員看得到。還沒有人說話，把代碼給朋友，他們輸入代碼就能加入。'}
            </p>
          )}
          <MessageList messages={messages} me={user?.id ?? null} canDeleteAll={isAdmin || isOwner} onDelete={remove} />
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
        <RoomsCard
          rooms={rooms}
          current={room}
          unread={unread}
          onSelect={(id) => selectRoom(id)}
          onCreate={roomActions.create}
          onJoin={roomActions.join}
        />
        {currentRoom && (
          <RoomCard
            key={currentRoom.id}
            room={currentRoom}
            me={user?.id ?? null}
            online={chat.online}
            onRename={(name) => roomActions.rename(currentRoom, name)}
            onNewCode={() => roomActions.newCode(currentRoom)}
            onKick={(member) => roomActions.kick(currentRoom, member)}
            onLeave={() => roomActions.leave(currentRoom)}
            onDelete={() => roomActions.remove(currentRoom)}
          />
        )}
        <NotifyCard
          state={push}
          busy={pushBusy}
          note={pushNote}
          onEnable={turnOn}
          onDisable={turnOff}
          onTest={sendTest}
        />
        {room === null && <OnlineList users={chat.online} me={user?.id ?? null} />}
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

/** 送出表單時的「處理中」和錯誤訊息 */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      await action()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

/** 房間列表：大廳和自己加入的私人房間，加上建立、輸入代碼 */
function RoomsCard({
  rooms,
  current,
  unread,
  onSelect,
  onCreate,
  onJoin,
}: {
  rooms: Room[] | null
  current: RoomId
  unread: Record<string, number>
  onSelect: (room: RoomId) => void
  onCreate: (name: string) => Promise<void>
  onJoin: (code: string) => Promise<void>
}) {
  const [mode, setMode] = useState<'create' | 'join' | null>(null)
  const [value, setValue] = useState('')
  const { busy, error, setError, run } = useAction()

  function open(next: 'create' | 'join' | null) {
    setMode(next)
    setValue('')
    setError(null)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const text = value.trim()
    if (!text || !mode) return
    const done = await run(() => (mode === 'create' ? onCreate(text) : onJoin(text)))
    if (done) open(null)
  }

  const entries: { id: RoomId; name: string }[] = [{ id: null, name: '大廳' }, ...(rooms ?? [])]
  return (
    <section className="chat-card">
      <h2 className="chat-card-title">房間</h2>
      <ul className="chat-rooms">
        {entries.map((entry) => {
          const count = unread[roomKey(entry.id)] ?? 0
          const here = entry.id === current
          return (
            <li key={roomKey(entry.id)}>
              <button
                type="button"
                className={`chat-room ${here ? 'current' : ''}`}
                aria-current={here ? 'true' : undefined}
                onClick={() => onSelect(entry.id)}
              >
                <span className="chat-room-icon" aria-hidden="true">
                  {entry.id === null ? '#' : '🔒'}
                </span>
                <span className="chat-room-name">{entry.name}</span>
                {count > 0 && !here && (
                  <span className="chat-unread" aria-label={`${count} 則未讀`}>
                    {countLabel(count)}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      {mode === null ? (
        <div className="chat-card-actions">
          <button type="button" className="secondary" onClick={() => open('create')}>
            ＋ 建立私人房間
          </button>
          <button type="button" className="secondary" onClick={() => open('join')}>
            🔑 輸入代碼
          </button>
        </div>
      ) : (
        <form className="chat-room-form" onSubmit={submit}>
          <label className="muted" htmlFor="chat-room-input">
            {mode === 'create' ? '房間名稱（建立後會拿到一組代碼，有代碼的人才進得來）' : '朋友給你的 8 碼代碼'}
          </label>
          <input
            id="chat-room-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={mode === 'create' ? '例如：週末爬山' : 'ABCD-EFGH'}
            maxLength={mode === 'create' ? MAX_ROOM_NAME : 20}
            autoComplete="off"
            autoCapitalize={mode === 'join' ? 'characters' : undefined}
            spellCheck={false}
            autoFocus
          />
          <div className="chat-card-actions">
            <button type="submit" disabled={busy || !value.trim()}>
              {mode === 'create' ? '建立' : '加入'}
            </button>
            <button type="button" className="secondary" onClick={() => open(null)} disabled={busy}>
              取消
            </button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

/** 正在看的私人房間：代碼、成員和房主的管理 */
function RoomCard({
  room,
  me,
  online,
  onRename,
  onNewCode,
  onKick,
  onLeave,
  onDelete,
}: {
  room: Room
  me: number | null
  online: OnlineUser[]
  onRename: (name: string) => Promise<void>
  onNewCode: () => Promise<void>
  onKick: (member: number) => Promise<void>
  onLeave: () => Promise<void>
  onDelete: () => Promise<void>
}) {
  const isOwner = room.owner_id === me
  const [copied, setCopied] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(room.name)
  const { busy, error, setError, run } = useAction()

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatCode(room.code))
      setCopied(true)
    } catch {
      setError('沒辦法自動複製，請直接選取上面的代碼')
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault()
    if (await run(() => onRename(name.trim()))) setRenaming(false)
  }

  function kick(member: { id: number; username: string }) {
    if (confirm(`把 ${member.username} 移出「${room.name}」？\n代碼會換一組新的，舊代碼就不能用了。`)) {
      void run(() => onKick(member.id))
    }
  }

  function newCode() {
    if (confirm('換一組新代碼？舊代碼馬上就不能用了，已經在裡面的人不受影響。')) void run(onNewCode)
  }

  function leave() {
    const others = room.members.filter((m) => m.id !== me)
    const message = !isOwner
      ? `離開「${room.name}」？之後要有代碼才能再進來。`
      : others.length > 0
        ? `離開「${room.name}」？房主會交給 ${others[0].username}。`
        : `離開「${room.name}」？你是最後一個人，房間和裡面的訊息會一起刪掉。`
    if (confirm(message)) void run(onLeave)
  }

  function remove() {
    if (confirm(`刪除「${room.name}」？裡面的訊息會全部刪掉，所有人都會被移出。`)) void run(onDelete)
  }

  const presence = new Map(online.map((u) => [u.id, u.active]))
  return (
    <section className="chat-card">
      {renaming ? (
        <form className="chat-room-form" onSubmit={rename}>
          <label className="muted" htmlFor="chat-room-name">
            房間名稱
          </label>
          <input
            id="chat-room-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_ROOM_NAME}
            autoComplete="off"
            autoFocus
          />
          <div className="chat-card-actions">
            <button type="submit" disabled={busy || !name.trim()}>
              儲存
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setRenaming(false)
                setName(room.name)
              }}
              disabled={busy}
            >
              取消
            </button>
          </div>
        </form>
      ) : (
        <h2 className="chat-card-title chat-room-title">🔒 {room.name}</h2>
      )}
      <p className="muted">只有成員看得到這間和裡面的訊息。把代碼給朋友，他們按「輸入代碼」就能加入。</p>
      <div className="chat-code">
        <code className="chat-code-value">{formatCode(room.code)}</code>
        <button type="button" className="secondary" onClick={copy}>
          {copied ? '已複製' : '複製代碼'}
        </button>
      </div>

      <h3 className="chat-card-sub">成員 {room.members.length} 人</h3>
      <ul className="chat-online">
        {room.members.map((member) => {
          const active = presence.get(member.id)
          return (
            <li key={member.id}>
              <span className={`chat-dot ${active ? 'on' : ''} ${active === undefined ? 'off' : ''}`} aria-hidden="true" />
              <span className="chat-online-name">
                {member.username}
                {member.id === room.owner_id && <span className="muted">（房主）</span>}
                {member.id === me && <span className="muted">（你）</span>}
              </span>
              <span className="muted chat-online-state">
                {active === undefined ? '離線' : active ? '在看' : '離開視窗'}
              </span>
              {isOwner && member.id !== me && (
                <button type="button" className="link chat-kick" onClick={() => kick(member)} disabled={busy}>
                  移出
                </button>
              )}
            </li>
          )
        })}
      </ul>

      <div className="chat-card-actions">
        {isOwner && !renaming && (
          <>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setName(room.name)
                setRenaming(true)
              }}
              disabled={busy}
            >
              改名
            </button>
            <button type="button" className="secondary" onClick={newCode} disabled={busy}>
              換代碼
            </button>
          </>
        )}
        <button type="button" className="secondary" onClick={leave} disabled={busy}>
          離開房間
        </button>
        {isOwner && (
          <button type="button" className="danger" onClick={remove} disabled={busy}>
            刪除房間
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  )
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
