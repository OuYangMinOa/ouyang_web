import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { errorMessage } from '../api'
import { useAuth } from '../auth'
import {
  createThread,
  getMine,
  KIND_ICONS,
  KIND_LABELS,
  listMine,
  notifyChanged,
  onChanged,
  replyMine,
  type Conversation,
  type FeedbackKind,
  type Thread,
} from './api'
import Composer from './Composer'
import { MessageList, ThreadHeader, ThreadList } from './Conversation'
import { usePolling } from './util'

const KINDS: { value: FeedbackKind; hint: string }[] = [
  { value: 'bug', hint: '哪裡壞掉、怪怪的、不好用' },
  { value: 'wish', hint: '想要的新功能、新遊戲、新工具' },
]

function NewThread({ onCreated }: { onCreated: (conversation: Conversation) => void }) {
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [title, setTitle] = useState('')

  return (
    <div className="fb-pane">
      <h2>新增{KIND_LABELS[kind]}</h2>
      <Composer
        placeholder={kind === 'bug' ? '發生了什麼事？在哪一頁、做了什麼操作？有截圖的話直接貼上。' : '想要什麼？越具體越好。'}
        onSubmit={async (draft) => {
          if (!title.trim()) throw new Error('請輸入標題')
          onCreated(await createThread(kind, title, draft))
          setTitle('')
        }}
      >
        <div className="fb-kinds" role="radiogroup" aria-label="種類">
          {KINDS.map((k) => (
            <label key={k.value} className={`fb-kind-option ${kind === k.value ? 'active' : ''}`}>
              <input
                type="radio"
                name="kind"
                value={k.value}
                checked={kind === k.value}
                onChange={() => setKind(k.value)}
              />
              <strong>
                {KIND_ICONS[k.value]} {KIND_LABELS[k.value]}
              </strong>
              <span className="muted">{k.hint}</span>
            </label>
          ))}
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="標題" maxLength={100} aria-label="標題" />
      </Composer>
    </div>
  )
}

function ThreadPane({ id, onChange }: { id: number; onChange: () => void }) {
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    () =>
      getMine(id)
        .then((c) => {
          setConversation(c)
          setError(null)
          notifyChanged()
        })
        .catch((e) => setError(errorMessage(e))),
    [id],
  )
  useEffect(() => {
    load()
  }, [load])
  usePolling(load, 20_000)

  if (!conversation || conversation.thread.id !== id)
    return <div className="fb-pane">{error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>}</div>
  const { thread, messages } = conversation

  return (
    <div className="fb-pane">
      <ThreadHeader thread={thread} />
      <MessageList key={thread.id} messages={messages} adminView={false} />
      {thread.status === 'closed' && <p className="muted fb-closed-hint">這串已經結案了；再留言會重新打開。</p>}
      <Composer
        placeholder="補充說明或回覆管理員…"
        submitLabel="留言"
        onSubmit={async (draft) => {
          setConversation(await replyMine(thread.id, draft))
          onChange()
        }}
      />
    </div>
  )
}

/** /feedback：自己送出的回報與許願，以及跟管理員的對話 */
export default function FeedbackPage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selected = Number(params.get('id')) || null

  const refresh = useCallback(
    () =>
      listMine()
        .then((list) => {
          setThreads(list)
          setError(null)
        })
        .catch((e) => setError(errorMessage(e))),
    [],
  )
  // 登入、登出後清單不一樣
  useEffect(() => {
    refresh()
  }, [refresh, user])
  // 打開一串之後它就變成已讀，清單上的紅點跟著拿掉
  useEffect(() => onChanged(refresh), [refresh])
  usePolling(refresh, 30_000)

  function select(id: number | null) {
    setParams(id ? { id: String(id) } : {})
  }

  return (
    <>
      <h1>回報與許願</h1>
      <p className="muted fb-intro">
        遇到問題或想要新功能都可以告訴我，可以直接貼上截圖。管理員回覆後，右上角的「回報 / 許願」會出現紅點。
        {!user && ' 沒登入也能送，但只有這個瀏覽器看得到你送出的內容。'}
      </p>
      {error && <p className="error">{error}</p>}
      <div className={`fb-layout ${selected ? 'has-selection' : ''}`}>
        <aside className="fb-side">
          <button type="button" className="fb-new" onClick={() => select(null)} aria-pressed={!selected}>
            ＋ 新增回報或許願
          </button>
          {threads === null ? (
            <p className="muted">載入中…</p>
          ) : threads.length === 0 ? (
            <p className="muted">還沒有送出過。</p>
          ) : (
            <ThreadList threads={threads} selected={selected} onSelect={select} />
          )}
        </aside>
        <section className="fb-main">
          {selected && (
            <button type="button" className="link fb-back" onClick={() => select(null)}>
              ← 返回
            </button>
          )}
          {selected ? (
            <ThreadPane key={selected} id={selected} onChange={refresh} />
          ) : (
            <NewThread
              onCreated={(c) => {
                refresh()
                select(c.thread.id)
              }}
            />
          )}
        </section>
      </div>
    </>
  )
}
