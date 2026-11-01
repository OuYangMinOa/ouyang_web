import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { errorMessage } from '../../api'
import {
  adminDelete,
  adminGet,
  adminList,
  adminReply,
  adminSetStatus,
  KIND_LABELS,
  notifyChanged,
  onChanged,
  type AdminThread,
  type Conversation,
  type FeedbackKind,
  type FeedbackStatus,
} from '../../feedback/api'
import Composer from '../../feedback/Composer'
import { MessageList, ThreadHeader, ThreadList } from '../../feedback/Conversation'
import { usePolling } from '../../feedback/util'

const STATUS_FILTERS: { value: FeedbackStatus | ''; label: string }[] = [
  { value: 'open', label: '處理中' },
  { value: 'closed', label: '已結案' },
  { value: '', label: '全部' },
]

function reporterName(thread: AdminThread) {
  return thread.reporter ?? '訪客'
}

function ThreadPane({ id, onChange, onDeleted }: { id: number; onChange: () => void; onDeleted: () => void }) {
  const [conversation, setConversation] = useState<Conversation<AdminThread> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    () =>
      adminGet(id)
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

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleStatus = () =>
    run(async () => {
      setConversation(await adminSetStatus(thread.id, thread.status === 'open' ? 'closed' : 'open'))
      onChange()
    })

  const remove = () => {
    if (!confirm(`刪除「${thread.title}」？所有留言和圖片都會一起刪掉，無法復原。`)) return
    run(async () => {
      await adminDelete(thread.id)
      onDeleted()
    })
  }

  return (
    <div className="fb-pane">
      <ThreadHeader
        thread={thread}
        info={
          <>
            {' '}
            · {reporterName(thread)} · <code>{thread.ip}</code>
          </>
        }
      >
        <button type="button" className="secondary" disabled={busy} onClick={toggleStatus}>
          {thread.status === 'open' ? '結案' : '重新打開'}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={remove}>
          刪除
        </button>
      </ThreadHeader>
      {error && <p className="error">{error}</p>}
      <MessageList key={thread.id} messages={messages} adminView />
      <Composer
        placeholder={`回覆 ${reporterName(thread)}…`}
        submitLabel="回覆"
        onSubmit={async (draft) => {
          setConversation(await adminReply(thread.id, draft))
          onChange()
        }}
      />
    </div>
  )
}

/** 系統管理 › 回報與許願：所有人送來的對話，可以回覆、結案 */
export default function AdminFeedback() {
  const [params, setParams] = useSearchParams()
  const [threads, setThreads] = useState<AdminThread[] | null>(null)
  const [kind, setKind] = useState<FeedbackKind | ''>('')
  const [error, setError] = useState<string | null>(null)
  const selected = Number(params.get('id')) || null
  const status = (params.get('status') ?? 'open') as FeedbackStatus | ''

  const refresh = useCallback(
    () =>
      adminList(status)
        .then((list) => {
          setThreads(list)
          setError(null)
        })
        .catch((e) => setError(errorMessage(e))),
    [status],
  )
  useEffect(() => {
    refresh()
  }, [refresh])
  // 打開一串之後它就變成已讀，清單上的紅點跟著拿掉
  useEffect(() => onChanged(refresh), [refresh])
  usePolling(refresh, 30_000)

  function update(next: { id?: number | null; status?: FeedbackStatus | '' }) {
    const id = next.id === undefined ? selected : next.id
    const s = next.status ?? status
    const query: Record<string, string> = {}
    if (s !== 'open') query.status = s
    if (id) query.id = String(id)
    setParams(query)
  }

  const shown = threads?.filter((t) => !kind || t.kind === kind) ?? null
  const unread = threads?.filter((t) => t.unread).length ?? 0

  return (
    <>
      <h1>回報與許願</h1>
      <div className="fb-filters">
        <div className="access-tabs" role="tablist">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={status === f.value}
              className={status === f.value ? '' : 'secondary'}
              onClick={() => update({ status: f.value, id: null })}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value as FeedbackKind | '')} aria-label="種類">
          <option value="">回報與許願</option>
          <option value="bug">只看{KIND_LABELS.bug}</option>
          <option value="wish">只看{KIND_LABELS.wish}</option>
        </select>
        {unread > 0 && <span className="muted">{unread} 串有新留言</span>}
      </div>
      {error && <p className="error">{error}</p>}
      <div className={`fb-layout ${selected ? 'has-selection' : ''}`}>
        <aside className="fb-side">
          {shown === null ? (
            <p className="muted">載入中…</p>
          ) : shown.length === 0 ? (
            <p className="muted">沒有{STATUS_FILTERS.find((f) => f.value === status)?.label}的回報或許願。</p>
          ) : (
            <ThreadList
              threads={shown}
              selected={selected}
              onSelect={(id) => update({ id })}
              meta={(t) => <span>{reporterName(t)}</span>}
            />
          )}
        </aside>
        <section className="fb-main">
          {selected ? (
            <>
              <button type="button" className="link fb-back" onClick={() => update({ id: null })}>
                ← 返回
              </button>
              <ThreadPane
                key={selected}
                id={selected}
                onChange={refresh}
                onDeleted={() => {
                  update({ id: null })
                  refresh()
                }}
              />
            </>
          ) : (
            <p className="muted fb-empty">從左邊選一串來看。</p>
          )}
        </section>
      </div>
    </>
  )
}
