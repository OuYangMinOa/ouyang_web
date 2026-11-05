import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ApiError, errorMessage } from '../../api'
import AiStatusNotice from '../AiStatusNotice'
import { streamChat, useAiStatus } from '../api'
import {
  applyEvent,
  chatApi,
  prettyArguments,
  quotaLabel,
  toTurns,
  type AssistantTurn,
  type ChatEvent,
  type ChatSummary,
  type Quota,
  type TextBlock,
  type ToolBlock,
  type Turn,
} from './chat'
import Markdown from './Markdown'
import '../ai.css'
import './chat.css'

const THINKING_KEY = 'ai-thinking'

function readThinking() {
  try {
    return localStorage.getItem(THINKING_KEY) !== '0'
  } catch {
    return true
  }
}

function saveThinking(on: boolean) {
  try {
    if (on) localStorage.removeItem(THINKING_KEY)
    else localStorage.setItem(THINKING_KEY, '0')
  } catch {
    // 存不了就只在這次有效
  }
}

const SUGGESTIONS = [
  '今天台北天氣如何？要帶傘嗎？',
  '最近有颱風嗎？',
  '幫我記下下週三晚上七點跟阿明吃飯',
  '今年農曆八月十五是國曆幾月幾號？',
  '最近台灣有什麼比較大的地震？',
  '統一發票最新一期的特別獎號碼是多少？',
]

const TOOL_STATUS: Record<ToolBlock['status'], string> = {
  pending: '等你確認',
  running: '執行中…',
  done: '完成',
  error: '失敗',
  denied: '沒有執行',
}

function relativeTime(value: string) {
  const date = new Date(value)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString(undefined, { ...(sameYear ? {} : { year: 'numeric' }), month: 'numeric', day: 'numeric' })
}

/** 觸控裝置上 Enter 是換行（手機鍵盤的 Enter 很容易誤按），用送出鈕送出 */
const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

// ---- 一段回答裡的區塊 ----

function TextView({ block, streaming }: { block: TextBlock; streaming: boolean }) {
  const thinkingNow = streaming && !block.content
  return (
    <>
      {block.reasoning && (
        <details className="ai-reasoning" open={thinkingNow}>
          <summary>{thinkingNow ? '思考中…' : '思考過程'}</summary>
          <div>{block.reasoning}</div>
        </details>
      )}
      {block.content && <Markdown text={block.content} />}
      {block.status === 'stopped' && <p className="muted ai-note">（已停止）</p>}
      {block.status === 'error' && <p className="muted ai-note">（回答到一半中斷了）</p>}
    </>
  )
}

function ToolView({
  block,
  decision,
  onDecide,
  busy,
}: {
  block: ToolBlock
  decision: boolean | undefined
  onDecide: (approve: boolean) => void
  busy: boolean
}) {
  const args = prettyArguments(block.arguments)
  const waiting = block.status === 'pending'
  return (
    <div className={`ai-tool is-${block.status}`}>
      <div className="ai-tool-head">
        <span className="ai-tool-icon" aria-hidden="true">
          {block.status === 'running' ? '⏳' : waiting ? '✋' : block.status === 'done' ? '✓' : '✕'}
        </span>
        <strong>{block.title}</strong>
        <span className="ai-tool-status">{TOOL_STATUS[block.status] ?? block.status}</span>
      </div>
      {block.summary && <p className="ai-tool-summary">{block.summary}</p>}
      {(args || block.result) && (
        <details className="ai-tool-detail">
          <summary>{waiting ? '看詳細內容' : '參數與結果'}</summary>
          {args && (
            <>
              <span className="muted">參數</span>
              <pre>{args}</pre>
            </>
          )}
          {block.result && (
            <>
              <span className="muted">結果</span>
              <pre>{block.result}</pre>
            </>
          )}
          <span className="muted">
            工具：<code>{block.name}</code>
          </span>
        </details>
      )}
      {waiting && (
        <div className="ai-tool-actions">
          <button
            type="button"
            aria-pressed={decision === true}
            className={decision === false ? 'secondary' : undefined}
            disabled={busy}
            onClick={() => onDecide(true)}
          >
            {decision === true ? '✓ 允許' : '允許'}
          </button>
          <button
            type="button"
            aria-pressed={decision === false}
            className={decision === false ? 'danger is-chosen' : 'secondary'}
            disabled={busy}
            onClick={() => onDecide(false)}
          >
            {decision === false ? '✓ 拒絕' : '拒絕'}
          </button>
        </div>
      )}
    </div>
  )
}

function AssistantView({
  turn,
  decisions,
  onDecide,
  busy,
}: {
  turn: AssistantTurn
  decisions: Record<string, boolean>
  onDecide: (id: string, approve: boolean) => void
  busy: boolean
}) {
  const last = turn.blocks[turn.blocks.length - 1]
  // 還沒收到任何東西，或工具剛做完、AI 還沒開始講下一段
  const waiting = turn.streaming && (!last || (last.type === 'tool' && last.status !== 'pending'))
  return (
    <div className="ai-turn is-assistant">
      {turn.blocks.map((block, i) =>
        block.type === 'text' ? (
          <TextView key={i} block={block} streaming={!!turn.streaming && i === turn.blocks.length - 1} />
        ) : (
          <ToolView
            key={block.id}
            block={block}
            decision={decisions[block.id]}
            onDecide={(approve) => onDecide(block.id, approve)}
            busy={busy}
          />
        ),
      )}
      {waiting && <span className="ai-typing">…</span>}
      {turn.error && <p className="error">{turn.error}</p>}
      {!turn.streaming && turn.usage && (
        <p className="muted ai-meta">
          輸入 {turn.usage.prompt_tokens.toLocaleString()} / 輸出 {turn.usage.completion_tokens.toLocaleString()} tokens
        </p>
      )}
    </div>
  )
}

// ---- 對話清單 ----

function ChatList({
  chats,
  current,
  onPick,
  onNew,
}: {
  chats: ChatSummary[] | null
  current: number | null
  onPick: (id: number) => void
  onNew: () => void
}) {
  return (
    <nav className="ai-chat-list" aria-label="對話紀錄">
      <button type="button" className="ai-new-chat" onClick={onNew}>
        ＋ 新對話
      </button>
      {chats === null ? (
        <p className="muted">載入中…</p>
      ) : chats.length === 0 ? (
        <p className="muted">還沒有對話。</p>
      ) : (
        <ul>
          {chats.map((chat) => (
            <li key={chat.id}>
              <button
                type="button"
                className={`ai-chat-item ${chat.id === current ? 'is-current' : ''}`}
                aria-current={chat.id === current ? 'page' : undefined}
                onClick={() => onPick(chat.id)}
              >
                <span className="ai-chat-item-title">{chat.title || '新對話'}</span>
                <span className="ai-chat-item-meta">
                  {chat.pending && (
                    <span className="ai-pending-dot" title="有動作等你確認">
                      ●
                    </span>
                  )}
                  {relativeTime(chat.updated_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

// ---- 頁面 ----

export default function ChatPage() {
  const [params] = useSearchParams()
  const idParam = params.get('c')
  const chatId = idParam && /^\d+$/.test(idParam) ? Number(idParam) : null
  const navigate = useNavigate()
  const status = useAiStatus()

  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [title, setTitle] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(chatId !== null)
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(readThinking)
  const [controller, setController] = useState<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [quota, setQuota] = useState<Quota | null>(null)
  const [decisions, setDecisions] = useState<Record<string, boolean>>({})
  const [listOpen, setListOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  // 畫面上顯示的是哪個對話；網址換了就重設
  const [shown, setShown] = useState(chatId)
  // 自己剛建立、正在串流的對話：換到它的網址時不要清空，不然會蓋掉正在出現的回答
  const [liveId, setLiveId] = useState<number | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 使用者往上捲去看前面的內容時，不要一直把畫面拉回最下面
  const stickRef = useRef(true)
  // 給非同步的程式看的最新值（串流結束時使用者可能已經換到別的對話）
  const liveRef = useRef<number | null>(null)
  const viewingRef = useRef(chatId)

  function setLive(id: number | null) {
    liveRef.current = id
    setLiveId(id)
  }

  if (shown !== chatId) {
    setShown(chatId)
    setListOpen(false)
    setRenaming(null)
    if (chatId === null || chatId !== liveId) {
      setError(null)
      setDecisions({})
      setTurns([])
      setTitle('')
      setLoadError(null)
      setLoading(chatId !== null)
    }
  }

  const loadChats = useCallback(() => {
    chatApi
      .list()
      .then(setChats)
      .catch(() => setChats((prev) => prev ?? []))
  }, [])
  const loadQuota = useCallback(() => {
    chatApi
      .quota()
      .then(setQuota)
      .catch(() => {})
  }, [])

  /** 從後端載入整段對話；載好時使用者已經換到別的對話就不套用 */
  const loadChat = useCallback(async (id: number) => {
    try {
      const chat = await chatApi.get(id)
      if (viewingRef.current !== id) return
      setTurns(toTurns(chat.messages))
      setTitle(chat.title)
      setLoadError(null)
    } catch (e) {
      if (viewingRef.current !== id) return
      setLoadError(e instanceof ApiError && e.status === 404 ? '找不到這個對話，可能已經刪掉了。' : errorMessage(e))
    } finally {
      if (viewingRef.current === id) setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadChats()
    loadQuota()
  }, [loadChats, loadQuota])

  // 換對話：載入那個對話（自己正在串流的除外）
  useEffect(() => {
    viewingRef.current = chatId
    stickRef.current = true
    if (chatId === null) {
      inputRef.current?.focus()
      return
    }
    if (chatId !== liveRef.current) loadChat(chatId)
  }, [chatId, loadChat])

  // 離開頁面時停掉還在跑的回答（後端會留下已經產生的部分）
  useEffect(() => () => controller?.abort(), [controller])

  useEffect(() => {
    const list = listRef.current
    if (list && stickRef.current) list.scrollTop = list.scrollHeight
  }, [turns])

  function onEvent(id: number, event: ChatEvent) {
    if (viewingRef.current !== id) return
    if (event.type === 'title') {
      setTitle(event.title)
      setChats((prev) => prev?.map((c) => (c.id === id ? { ...c, title: event.title } : c)) ?? prev)
      return
    }
    if (event.type === 'error') setError(event.message)
    setTurns((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role !== 'assistant') return prev
      return [...prev.slice(0, -1), applyEvent(last, event)]
    })
  }

  /** 串流一次（送出訊息或確認動作），結束後從後端重新載入整段對話 */
  async function run(id: number, path: string, body: unknown, onStartFailed: (message: string) => void) {
    const abort = new AbortController()
    setController(abort)
    setError(null)
    setLive(id)
    stickRef.current = true
    let started = false
    try {
      await streamChat<ChatEvent>(
        path,
        body,
        (event) => {
          started = true
          onEvent(id, event)
        },
        abort.signal,
      )
    } catch (e) {
      if (!abort.signal.aborted && viewingRef.current === id) {
        if (!started && e instanceof ApiError) onStartFailed(e.message)
        else setError(errorMessage(e))
      }
    } finally {
      setController(null)
      setDecisions({})
      await loadChat(id)
      setLive(null)
      loadChats()
      loadQuota()
    }
  }

  async function send(text: string) {
    const content = text.trim()
    if (!content || controller) return
    setError(null)
    let id = chatId
    if (id === null) {
      try {
        const chat = await chatApi.create()
        id = chat.id
        setLive(id)
        setChats((prev) => [chat, ...(prev ?? [])])
        navigate(`/ai?c=${id}`)
      } catch (e) {
        setError(errorMessage(e))
        return
      }
    }
    setInput('')
    setTurns((prev) => [
      ...prev,
      { role: 'user', key: `live-user-${Date.now()}`, text: content },
      { role: 'assistant', key: `live-${Date.now()}`, blocks: [], usage: null, streaming: true },
    ])
    await run(id, `/ai/chats/${id}/messages`, { content, thinking: thinking ? null : false }, (message) => {
      // 還沒開始就被拒絕（額度用完、AI 掛了…）：訊息沒有存，放回輸入框
      setError(message)
      setInput(content)
    })
  }

  function pendingIds(): string[] {
    const last = turns[turns.length - 1]
    if (last?.role !== 'assistant') return []
    return last.blocks.filter((b): b is ToolBlock => b.type === 'tool' && b.status === 'pending').map((b) => b.id)
  }

  /** 記下允許／拒絕；每個等確認的動作都選好了才送出 */
  async function choose(next: Record<string, boolean>) {
    if (controller || chatId === null) return
    setDecisions(next)
    const ids = pendingIds()
    if (!ids.every((id) => id in next)) return
    setTurns((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role !== 'assistant') return prev
      const blocks = last.blocks.map((b) =>
        b.type === 'tool' && b.status === 'pending' ? { ...b, status: next[b.id] ? ('running' as const) : ('denied' as const) } : b,
      )
      return [...prev.slice(0, -1), { ...last, blocks, streaming: true, error: undefined }]
    })
    const body = { decisions: ids.map((id) => ({ id, approve: next[id] })), thinking: thinking ? null : false }
    await run(chatId, `/ai/chats/${chatId}/approve`, body, setError)
  }

  const decide = (id: string, approve: boolean) => choose({ ...decisions, [id]: approve })

  async function rename(e: FormEvent) {
    e.preventDefault()
    if (chatId === null || renaming === null) return
    try {
      const chat = await chatApi.rename(chatId, renaming)
      setTitle(chat.title)
      setChats((prev) => prev?.map((c) => (c.id === chat.id ? { ...c, title: chat.title } : c)) ?? prev)
      setRenaming(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function remove() {
    if (chatId === null || controller) return
    if (!confirm(`刪除「${title || '新對話'}」？刪掉就找不回來了。`)) return
    try {
      await chatApi.remove(chatId)
      setChats((prev) => prev?.filter((c) => c.id !== chatId) ?? prev)
      navigate('/ai')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文輸入法選字時按的 Enter 不算送出
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !coarsePointer) {
      e.preventDefault()
      send(input)
    }
  }

  const blocked = quota?.blocked ?? false
  const unavailable = status !== null && (!status.configured || !status.available)
  const waitingIds = controller ? [] : pendingIds()
  const usageText = quota ? quotaLabel(quota) : null

  return (
    <div className={`ai-page ${listOpen ? 'list-open' : ''}`}>
      <aside className="ai-side">
        <ChatList chats={chats} current={chatId} onPick={(id) => navigate(`/ai?c=${id}`)} onNew={() => navigate('/ai')} />
      </aside>
      {listOpen && <button type="button" className="ai-scrim" aria-label="關閉對話紀錄" onClick={() => setListOpen(false)} />}

      <section className="ai-main">
        <header className="ai-main-head">
          <button
            type="button"
            className="secondary ai-list-toggle"
            aria-expanded={listOpen}
            onClick={() => setListOpen(!listOpen)}
          >
            ☰ <span className="ai-list-toggle-label">對話紀錄</span>
          </button>
          {renaming !== null ? (
            <form className="ai-rename" onSubmit={rename}>
              <input
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                maxLength={60}
                aria-label="對話名稱"
                autoFocus
              />
              <button type="submit">儲存</button>
              <button type="button" className="secondary" onClick={() => setRenaming(null)}>
                取消
              </button>
            </form>
          ) : (
            <>
              <h1 className="ai-title">{chatId === null ? '新對話' : title || '新對話'}</h1>
              {chatId !== null && (
                <div className="ai-head-actions">
                  <button type="button" className="secondary" onClick={() => setRenaming(title)} disabled={!!controller}>
                    改名
                  </button>
                  <button type="button" className="danger" onClick={remove} disabled={!!controller}>
                    刪除
                  </button>
                </div>
              )}
            </>
          )}
        </header>

        <AiStatusNotice />
        {blocked && (
          <p className="error ai-banner">管理員停用了你的 AI 功能，有問題請到「回報 / 許願」詢問。</p>
        )}

        <div
          className="ai-scroll"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          {loading && <p className="muted ai-center">載入中…</p>}
          {loadError && <p className="error ai-center">{loadError}</p>}
          {!loading && !loadError && turns.length === 0 && (
            <div className="ai-welcome">
              <p className="ai-welcome-title">有什麼想問的？</p>
              <p className="muted">
                AI 會自己查天氣、地震、颱風、發票，也能幫你管理日曆事項和短網址；會改資料的動作都要你按「允許」才會做。
                <Link to="/ai/tools">看看能用哪些工具</Link>
              </p>
              <div className="ai-suggestions">
                {SUGGESTIONS.map((text) => (
                  <button
                    type="button"
                    key={text}
                    className="secondary"
                    disabled={!!controller || blocked || unavailable}
                    onClick={() => send(text)}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="ai-turns-list" aria-live="polite">
            {turns.map((turn) =>
              turn.role === 'user' ? (
                <div key={turn.key} className="ai-turn is-user">
                  <div className="ai-bubble">{turn.text}</div>
                </div>
              ) : (
                <AssistantView
                  key={turn.key}
                  turn={turn}
                  decisions={decisions}
                  onDecide={decide}
                  busy={!!controller}
                />
              ),
            )}
          </div>
          {waitingIds.length > 1 && (
            <div className="ai-approve-all">
              <span className="muted">有 {waitingIds.length} 個動作等你確認</span>
              <button type="button" onClick={() => choose(Object.fromEntries(waitingIds.map((id) => [id, true])))}>
                全部允許
              </button>
            </div>
          )}
          {error && <p className="error ai-error">{error}</p>}
        </div>

        <form
          className="ai-composer ai-chat-composer"
          onSubmit={(e) => {
            e.preventDefault()
            send(input)
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              waitingIds.length > 0
                ? '先在上面按「允許」或「拒絕」，或直接問別的'
                : coarsePointer
                  ? '輸入訊息'
                  : '輸入訊息，Enter 送出、Shift+Enter 換行'
            }
            rows={2}
            maxLength={20000}
            disabled={blocked}
            aria-label="訊息"
          />
          {controller ? (
            <button type="button" className="danger" onClick={() => controller.abort()}>
              停止
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() || blocked || unavailable}>
              送出
            </button>
          )}
        </form>
        <div className="ai-composer-foot">
          <div className="checks">
            <label title="關掉會回答得比較快，但複雜的問題可能比較不準">
              <input
                type="checkbox"
                checked={thinking}
                onChange={(e) => {
                  setThinking(e.target.checked)
                  saveThinking(e.target.checked)
                }}
              />
              思考模式
            </label>
          </div>
          {usageText && <span className="muted">{usageText}</span>}
        </div>
      </section>
    </div>
  )
}
