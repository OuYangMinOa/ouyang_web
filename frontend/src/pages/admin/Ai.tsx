import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { api, errorMessage } from '../../api'
import AiStatusNotice from '../../ai/AiStatusNotice'
import { refreshAiStatus, streamChat, type AiUsage, type ChatMessage } from '../../ai/api'
import { usePolling } from '../../feedback/util'
import type { AiAdminView, AiModel, AiProvider, AiProviderStatus } from './types'
import '../../ai/ai.css'

/** 跟後端檢查的間隔一樣 */
const REFRESH_MS = 15_000

const HEALTH_LABELS: Record<AiProviderStatus['health'], string> = {
  unknown: '檢查中',
  ok: '正常',
  down: '異常',
}

function formatTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  const sameDay = date.toDateString() === new Date().toDateString()
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function HealthBadge({ status }: { status: AiProviderStatus }) {
  return (
    <span className={`ai-health is-${status.health}`}>
      <span className="ai-dot" aria-hidden="true" />
      {HEALTH_LABELS[status.health]}
    </span>
  )
}

/** 一行說明目前的狀態：正常時是回應時間，異常時是原因 */
function StatusLine({ status }: { status: AiProviderStatus }) {
  if (status.health === 'down') {
    return (
      <p className="error ai-status-line">
        {status.error ?? '無法使用'}
        <span className="muted">（從{formatTime(status.since)}起）</span>
      </p>
    )
  }
  if (status.health === 'ok') {
    return (
      <p className="muted ai-status-line">
        回應 {status.latency_ms ?? '—'} ms · {formatTime(status.checked_at)} 確認
      </p>
    )
  }
  return <p className="muted ai-status-line">還沒檢查完，等幾秒…</p>
}

// ---- 新增／編輯一組 ----

function ProviderForm({
  provider,
  onSaved,
  onCancel,
}: {
  provider?: AiProvider
  onSaved: (view: AiAdminView) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [model, setModel] = useState(provider?.model ?? '')
  const [models, setModels] = useState<AiModel[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formId = provider ? `ai-form-${provider.id}` : 'ai-form-new'

  /** 編輯時沒重填金鑰就不送，後端沿用存著的；新增時沒填就是沒有金鑰 */
  function keyToSend(): string | undefined {
    if (clearKey) return ''
    if (apiKey.trim()) return apiKey.trim()
    return provider ? undefined : ''
  }

  async function loadModels() {
    setLoadingModels(true)
    setError(null)
    try {
      const result = await api<{ models: AiModel[] }>('/admin/ai/models', {
        method: 'POST',
        body: JSON.stringify({ base_url: baseUrl, api_key: keyToSend(), provider_id: provider?.id }),
      })
      setModels(result.models)
      if (result.models.length > 0 && !result.models.some((m) => m.id === model)) setModel(result.models[0].id)
    } catch (e) {
      setModels(null)
      setError(errorMessage(e))
    } finally {
      setLoadingModels(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = JSON.stringify({ name, base_url: baseUrl, model, api_key: keyToSend() ?? null })
      const view = provider
        ? await api<AiAdminView>(`/admin/ai/providers/${provider.id}`, { method: 'PUT', body })
        : await api<AiAdminView>('/admin/ai/providers', { method: 'POST', body })
      onSaved(view)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const keyPlaceholder = provider?.key_hint
    ? `已設定（${provider.key_hint}），留空不變更`
    : '伺服器不需要金鑰就留空'

  return (
    <form className="stack ai-form" onSubmit={submit} id={formId}>
      <label>
        名稱
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：實驗室 Qwen"
          maxLength={50}
          autoComplete="off"
          required
        />
      </label>
      <label>
        API 網址
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://host:port/v1"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <small className="muted">OpenAI 相容的網址，通常結尾是 /v1</small>
      </label>
      <label>
        API 金鑰
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={keyPlaceholder}
          disabled={clearKey}
          // 不要讓瀏覽器把記住的登入密碼填進來
          autoComplete="new-password"
          spellCheck={false}
        />
      </label>
      {provider?.key_hint && (
        <div className="checks">
          <label>
            <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
            清除金鑰
          </label>
        </div>
      )}
      <label>
        模型
        <span className="inline-form ai-model-row">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="先按「讀取模型」"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <button type="button" className="secondary" disabled={!baseUrl.trim() || loadingModels} onClick={loadModels}>
            {loadingModels ? '讀取中…' : '讀取模型'}
          </button>
        </span>
      </label>
      {models && (
        <div className="ai-models">
          {models.length === 0 ? (
            <span className="muted">伺服器上沒有模型</span>
          ) : (
            <>
              <span className="muted">伺服器上的模型：</span>
              {models.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className={`ai-model-chip ${m.id === model ? 'is-selected' : ''}`}
                  aria-pressed={m.id === model}
                  onClick={() => setModel(m.id)}
                  title={m.max_model_len ? `上下文 ${m.max_model_len.toLocaleString()} tokens` : undefined}
                >
                  {m.id}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="ai-form-actions">
        <button type="submit" disabled={busy}>
          {busy ? '儲存並檢查中…' : provider ? '儲存' : '新增'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </form>
  )
}

// ---- 每一組 ----

function ProviderCard({
  provider,
  active,
  onChange,
  onEdit,
  onTest,
}: {
  provider: AiProvider
  active: boolean
  onChange: (view: AiAdminView | null) => void
  onEdit: () => void
  onTest: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<AiAdminView | null>) {
    setBusy(true)
    setError(null)
    try {
      onChange(await action())
      refreshAiStatus()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function activate() {
    if (provider.status.health === 'down' && !confirm(`「${provider.name}」目前異常，切換後使用者會看到 AI 無法使用。確定要切換嗎？`))
      return
    run(() => api<AiAdminView>('/admin/ai/active', { method: 'PUT', body: JSON.stringify({ id: provider.id }) }))
  }

  function remove() {
    if (!confirm(`刪除「${provider.name}」這組設定？`)) return
    run(async () => {
      await api(`/admin/ai/providers/${provider.id}`, { method: 'DELETE' })
      return null
    })
  }

  return (
    <article className={`card ai-provider ${active ? 'is-active' : ''}`}>
      <header className="ai-provider-head">
        <h3>{provider.name}</h3>
        {active && <span className="chip">使用中</span>}
        <HealthBadge status={provider.status} />
      </header>
      <dl className="ai-provider-info">
        <div>
          <dt>網址</dt>
          <dd>
            <code>{provider.base_url}</code>
          </dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>
            <code>{provider.model}</code>
          </dd>
        </div>
        <div>
          <dt>金鑰</dt>
          <dd>{provider.key_hint ? <code>{provider.key_hint}</code> : <span className="muted">無</span>}</dd>
        </div>
      </dl>
      <StatusLine status={provider.status} />
      {error && <p className="error">{error}</p>}
      <div className="ai-provider-actions">
        {!active && (
          <button type="button" disabled={busy} onClick={activate}>
            設為使用中
          </button>
        )}
        <button type="button" className="secondary" onClick={onTest}>
          測試對話
        </button>
        <button type="button" className="secondary" onClick={onEdit}>
          編輯
        </button>
        {!active && (
          <button type="button" className="danger" disabled={busy} onClick={remove}>
            刪除
          </button>
        )}
      </div>
      {provider.events.length > 0 && (
        <details className="ai-events">
          <summary>狀態紀錄（{provider.events.length}）</summary>
          <ol>
            {provider.events.map((event, i) => (
              <li key={`${event.at}-${i}`}>
                <time>{formatTime(event.at)}</time>
                <span className={`ai-health is-${event.health}`}>
                  <span className="ai-dot" aria-hidden="true" />
                  {HEALTH_LABELS[event.health]}
                </span>
                {event.error && <span className="ai-event-error">{event.error}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  )
}

// ---- 測試對話 ----

type Turn = {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  pending?: boolean
  error?: string
  usage?: AiUsage | null
  /** 從送出到回答完的時間 */
  ms?: number
  /** 哪一組回答的 */
  provider?: string
}

function TestChat({
  providers,
  selected,
  onSelect,
  onFinished,
}: {
  providers: AiProvider[]
  selected: number | null
  onSelect: (id: number) => void
  onFinished: () => void
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [system, setSystem] = useState('')
  const [thinking, setThinking] = useState(true)
  const [controller, setController] = useState<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 使用者往上捲去看前面的內容時，不要一直把畫面拉回最下面
  const stickRef = useRef(true)
  const provider = providers.find((p) => p.id === selected)

  useEffect(() => {
    const list = listRef.current
    if (list && stickRef.current) list.scrollTop = list.scrollHeight
  }, [turns])

  // 離開頁面時停掉還在跑的回答
  useEffect(() => () => controller?.abort(), [controller])

  function updateLast(update: (turn: Turn) => Turn) {
    setTurns((prev) => [...prev.slice(0, -1), update(prev[prev.length - 1])])
  }

  async function send() {
    const text = input.trim()
    if (!text || controller || !provider) return
    const history: ChatMessage[] = [
      ...(system.trim() ? [{ role: 'system' as const, content: system.trim() }] : []),
      ...turns.filter((t) => t.content).map(({ role, content }) => ({ role, content })),
      { role: 'user', content: text },
    ]
    const abort = new AbortController()
    setController(abort)
    setInput('')
    stickRef.current = true
    setTurns((prev) => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '', reasoning: '', pending: true, provider: provider.name },
    ])
    const started = performance.now()
    try {
      await streamChat(
        '/admin/ai/chat',
        // 思考模式開著就照伺服器預設，不送這個欄位
        { provider_id: provider.id, messages: history, thinking: thinking ? null : false },
        (event) => {
          if (event.type === 'reasoning') updateLast((t) => ({ ...t, reasoning: (t.reasoning ?? '') + event.text }))
          else if (event.type === 'content') updateLast((t) => ({ ...t, content: t.content + event.text }))
          else if (event.type === 'done') updateLast((t) => ({ ...t, usage: event.usage }))
          else updateLast((t) => ({ ...t, error: event.message }))
        },
        abort.signal,
      )
    } catch (e) {
      const message = abort.signal.aborted ? '已停止' : errorMessage(e)
      updateLast((t) => ({ ...t, error: message }))
    } finally {
      updateLast((t) => ({ ...t, pending: false, ms: performance.now() - started }))
      setController(null)
      onFinished()
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文輸入法選字時按的 Enter 不算送出
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    send()
  }

  if (providers.length === 0) return <p className="muted">先新增一組設定才能測試。</p>

  return (
    <div className="card ai-chat" id="ai-chat">
      <div className="ai-chat-toolbar">
        <label className="ai-chat-provider">
          <span className="muted">用哪一組</span>
          <select value={selected ?? ''} onChange={(e) => onSelect(Number(e.target.value))} disabled={!!controller}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.model}）{p.status.health === 'down' ? ' ⚠ 異常' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="checks">
          <label title="vLLM 上的 Qwen3 這類模型才有作用">
            <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} />
            思考模式
          </label>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={turns.length === 0 || !!controller}
          onClick={() => setTurns([])}
        >
          清除對話
        </button>
      </div>
      <details className="ai-system">
        <summary>系統提示詞{system.trim() ? '（已設定）' : ''}</summary>
        <textarea
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          placeholder="例如：你是一個用繁體中文回答的助理"
          rows={3}
        />
      </details>

      <div
        className="ai-turns"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        aria-live="polite"
      >
        {turns.length === 0 && <p className="muted ai-empty">打個招呼試試看，回答會一個字一個字出來。</p>}
        {turns.map((turn, i) =>
          turn.role === 'user' ? (
            <div key={i} className="ai-turn is-user">
              <div className="ai-bubble">{turn.content}</div>
            </div>
          ) : (
            <div key={i} className="ai-turn is-assistant">
              {turn.reasoning && (
                <details className="ai-reasoning" open={!!turn.pending && !turn.content}>
                  <summary>思考過程{turn.pending && !turn.content ? '…' : ''}</summary>
                  <div>{turn.reasoning}</div>
                </details>
              )}
              {(turn.content || (turn.pending && !turn.reasoning)) && (
                <div className="ai-bubble">{turn.content || <span className="ai-typing">…</span>}</div>
              )}
              {turn.error && <p className="error">{turn.error}</p>}
              {!turn.pending && (
                <p className="muted ai-meta">
                  {turn.provider}
                  {turn.ms !== undefined && ` · ${(turn.ms / 1000).toFixed(1)} 秒`}
                  {turn.usage && ` · 輸入 ${turn.usage.prompt_tokens} / 輸出 ${turn.usage.completion_tokens} tokens`}
                </p>
              )}
            </div>
          ),
        )}
      </div>

      <form className="ai-composer" onSubmit={submit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="輸入訊息，Enter 送出、Shift+Enter 換行"
          rows={2}
        />
        {controller ? (
          <button type="button" className="danger" onClick={() => controller.abort()}>
            停止
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() || !provider}>
            送出
          </button>
        )}
      </form>
    </div>
  )
}

// ---- 頁面 ----

export default function AdminAi() {
  const [view, setView] = useState<AiAdminView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [chatWith, setChatWith] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api<AiAdminView>('/admin/ai')
      .then((next) => {
        setView(next)
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])
  useEffect(load, [load])
  usePolling(load, REFRESH_MS)

  function applyView(next: AiAdminView | null) {
    if (next) setView(next)
    else load()
  }

  async function checkAll() {
    setBusy(true)
    try {
      setView(await api<AiAdminView>('/admin/ai/check', { method: 'POST' }))
      refreshAiStatus()
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    if (!confirm('停用後全站的 AI 功能都不能用，使用者會看到「AI 功能尚未開放」。確定嗎？')) return
    setBusy(true)
    try {
      setView(await api<AiAdminView>('/admin/ai/active', { method: 'PUT', body: JSON.stringify({ id: null }) }))
      refreshAiStatus()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function test(id: number) {
    setChatWith(id)
    document.getElementById('ai-chat')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (!view) return error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>

  const active = view.providers.find((p) => p.id === view.active_id)
  // 測試對話預設用使用中的那一組
  const chatProvider = view.providers.some((p) => p.id === chatWith) ? chatWith : (active?.id ?? view.providers[0]?.id ?? null)

  return (
    <>
      <h1>AI 設定</h1>
      <p className="muted ai-intro">
        可以設定好幾組 OpenAI 相容的 API（vLLM、Ollama、OpenAI…），選一組給全站的 AI 功能使用。
        每一組每 15 秒自動檢查一次；使用中的那組掛掉時，AI 功能的頁面上會馬上告訴使用者。
      </p>

      <section className="card ai-summary">
        {active ? (
          <>
            <div className="ai-summary-head">
              <span className="muted">全站使用中</span>
              <strong>{active.name}</strong>
              <code>{active.model}</code>
              <HealthBadge status={active.status} />
            </div>
            <StatusLine status={active.status} />
          </>
        ) : (
          <p className="ai-summary-head">
            <strong>目前沒有開放 AI 功能</strong>
            {view.providers.length > 0 && <span className="muted">在下面選一組「設為使用中」。</span>}
          </p>
        )}
        <AiStatusNotice />
        <div className="ai-provider-actions">
          <button type="button" className="secondary" disabled={busy || view.providers.length === 0} onClick={checkAll}>
            立即檢查全部
          </button>
          {active && (
            <button type="button" className="danger" disabled={busy} onClick={disable}>
              停用 AI 功能
            </button>
          )}
        </div>
      </section>
      {error && <p className="error">{error}</p>}

      <div className="ai-section-head">
        <h2>設定（{view.providers.length}）</h2>
        {editing !== 'new' && (
          <button type="button" onClick={() => setEditing('new')}>
            ＋ 新增一組
          </button>
        )}
      </div>
      {editing === 'new' && (
        <div className="card">
          <h3>新增一組</h3>
          <ProviderForm
            onSaved={(next) => {
              setView(next)
              setEditing(null)
              refreshAiStatus()
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}
      {view.providers.length === 0 && editing !== 'new' && <p className="muted">還沒有任何設定。</p>}
      <div className="ai-providers">
        {view.providers.map((provider) =>
          editing === provider.id ? (
            <div key={provider.id} className="card">
              <h3>編輯「{provider.name}」</h3>
              <ProviderForm
                provider={provider}
                onSaved={(next) => {
                  setView(next)
                  setEditing(null)
                  refreshAiStatus()
                }}
                onCancel={() => setEditing(null)}
              />
            </div>
          ) : (
            <ProviderCard
              key={provider.id}
              provider={provider}
              active={provider.id === view.active_id}
              onChange={applyView}
              onEdit={() => setEditing(provider.id)}
              onTest={() => test(provider.id)}
            />
          ),
        )}
      </div>

      <h2>測試對話</h2>
      <p className="muted ai-intro">直接跟任一組對話，確認沒問題再設為使用中。對話只存在這個頁面，重新整理就不見了。</p>
      <TestChat providers={view.providers} selected={chatProvider} onSelect={setChatWith} onFinished={load} />
    </>
  )
}
