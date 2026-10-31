import { useEffect, useRef, type ReactNode } from 'react'
import { imageUrl, KIND_ICONS, KIND_LABELS, STATUS_LABELS, type Message, type Thread } from './api'
import { formatTime } from './util'
import './feedback.css'

export function StatusChip({ thread }: { thread: Thread }) {
  return <span className={`fb-status ${thread.status}`}>{STATUS_LABELS[thread.status]}</span>
}

/** 左邊的對話清單；`meta` 是每一列額外的資訊（管理頁放發問者） */
export function ThreadList<T extends Thread>({
  threads,
  selected,
  onSelect,
  meta,
}: {
  threads: T[]
  selected: number | null
  onSelect: (id: number) => void
  meta?: (thread: T) => ReactNode
}) {
  return (
    <ul className="fb-list">
      {threads.map((thread) => (
        <li key={thread.id}>
          <button
            type="button"
            className={`fb-list-item ${thread.id === selected ? 'active' : ''}`}
            aria-current={thread.id === selected ? 'true' : undefined}
            onClick={() => onSelect(thread.id)}
          >
            <span className="fb-list-title">
              <span aria-hidden="true">{KIND_ICONS[thread.kind]}</span>
              <span className="fb-list-text">{thread.title}</span>
              {thread.unread && <span className="fb-unread" aria-label="有新留言" />}
            </span>
            <span className="fb-list-meta">
              <StatusChip thread={thread} />
              {meta?.(thread)}
              <span>{thread.messages} 則</span>
              <time>{formatTime(thread.updated_at)}</time>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 對話的標題列；`children` 放右邊的按鈕 */
export function ThreadHeader({ thread, info, children }: { thread: Thread; info?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fb-thread-head">
      <div className="fb-thread-title">
        <h2>{thread.title}</h2>
        <p className="muted">
          <span className={`fb-kind ${thread.kind}`}>
            {KIND_ICONS[thread.kind]} {KIND_LABELS[thread.kind]}
          </span>{' '}
          <StatusChip thread={thread} /> · {formatTime(thread.created_at)}
          {info}
        </p>
      </div>
      {children && <div className="fb-thread-actions">{children}</div>}
    </div>
  )
}

/**
 * 一來一往的留言。`adminView` 決定哪一邊是「我」：管理頁裡管理員的留言靠右，使用者頁裡自己的留言靠右。
 * 有新留言時捲到最後一則。
 */
export function MessageList({ messages, adminView }: { messages: Message[]; adminView: boolean }) {
  const end = useRef<HTMLLIElement>(null)
  const lastId = messages.at(-1)?.id
  const shown = useRef<number | undefined>(undefined)
  useEffect(() => {
    // 第一次打開不捲，免得手機上一進來就跳到很下面；之後有新留言才捲
    if (shown.current !== undefined && lastId !== shown.current) {
      end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    shown.current = lastId
  }, [lastId])

  function name(message: Message) {
    if (message.from_admin) return adminView ? `${message.author ?? '管理員'}（管理員）` : '管理員'
    return adminView ? (message.author ?? '訪客') : '我'
  }

  return (
    <ol className="fb-messages">
      {messages.map((message, i) => {
        const mine = message.from_admin === adminView
        return (
          <li
            key={message.id}
            ref={i === messages.length - 1 ? end : undefined}
            className={`fb-message ${mine ? 'mine' : ''} ${message.from_admin ? 'admin' : ''}`}
          >
            <div className="fb-message-head">
              <strong>{name(message)}</strong>
              <time>{formatTime(message.created_at)}</time>
            </div>
            {message.body && <p className="fb-message-body">{message.body}</p>}
            {message.images.length > 0 && (
              <div className="fb-images">
                {message.images.map((id) => (
                  <a key={id} href={imageUrl(id)} target="_blank" rel="noreferrer" title="開啟原圖">
                    <img src={imageUrl(id)} alt="附加的圖片" loading="lazy" />
                  </a>
                ))}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
