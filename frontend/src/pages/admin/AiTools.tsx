import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../../api'
import type { AiToolsView, AiToolView, McpServer } from './types'
import '../../ai/ai.css'
import '../../ai/admin.css'

function formatTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  const sameDay = date.toDateString() === new Date().toDateString()
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---- 使用中的 AI 能不能呼叫工具 ----

function ProviderTools({ value }: { value: boolean | null }) {
  if (value === true) {
    return (
      <p className="ai-health is-ok ai-tools-provider">
        <span className="ai-dot" aria-hidden="true" />
        使用中的 AI 支援工具呼叫
      </p>
    )
  }
  if (value === null) {
    return (
      <p className="muted ai-tools-provider">
        還不知道使用中的 AI 能不能呼叫工具，第一次有人用 AI 助手時就會知道。
      </p>
    )
  }
  return (
    <div className="ai-notice" role="status">
      <span className="ai-notice-icon" aria-hidden="true">
        ⚠
      </span>
      <div>
        <strong>使用中的 AI 不接受工具呼叫</strong>
        <p>
          AI 助手現在只能一般聊天，查天氣、新增事項這些工具都用不了。vLLM 啟動時要加上{' '}
          <code>--enable-auto-tool-choice --tool-call-parser hermes</code>（Qwen3 這類模型）。
          改好後到「AI 設定」重新儲存那一組（或重新部署），就會重新偵測。
        </p>
      </div>
    </div>
  )
}

// ---- MCP 伺服器 ----

type HeaderRow = {
  key: number
  name: string
  value: string
  /** 編輯時原本就有的 header：值留空就沿用 */
  hint?: string
}

let nextRowKey = 1

function ServerForm({
  server,
  onSaved,
  onCancel,
}: {
  server?: McpServer
  onSaved: (view: AiToolsView) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(server?.name ?? '')
  const [prefix, setPrefix] = useState(server?.prefix ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [headers, setHeaders] = useState<HeaderRow[]>(
    () => server?.headers.map((h) => ({ key: nextRowKey++, name: h.name, value: '', hint: h.hint })) ?? [],
  )
  const [enabled, setEnabled] = useState(server?.enabled ?? true)
  const [isPublic, setIsPublic] = useState(server?.public ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 換了網址就不沿用舊的 header 值（後端也一樣），免得把金鑰送到新的地方
  const urlChanged = !!server && url.trim() !== server.url

  function updateHeader(key: number, patch: Partial<HeaderRow>) {
    setHeaders((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = JSON.stringify({
        name,
        prefix,
        url,
        enabled,
        public: isPublic,
        headers: headers
          .filter((h) => h.name.trim())
          .map((h) => ({
            name: h.name.trim(),
            value: h.hint && !urlChanged && !h.value.trim() ? null : h.value.trim(),
          })),
      })
      const view = server
        ? await api<AiToolsView>(`/admin/ai/mcp/${server.id}`, { method: 'PUT', body })
        : await api<AiToolsView>('/admin/ai/mcp', { method: 'POST', body })
      onSaved(view)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="stack ai-form" onSubmit={submit}>
      <div className="row">
        <label>
          名稱
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：Notion"
            maxLength={50}
            autoComplete="off"
            required
          />
        </label>
        <label>
          前綴
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toLowerCase())}
            placeholder="例如：notion"
            maxLength={20}
            pattern="[a-z][a-z0-9_]*"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <small className="muted">給 AI 的工具名稱會是「前綴__工具名稱」，小寫英文開頭，可以有數字和 _</small>
        </label>
      </div>
      <label>
        網址
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://host/mcp"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <small className="muted">Streamable HTTP 的端點（通常結尾是 /mcp）</small>
      </label>

      <fieldset className="ai-headers">
        <legend>Header</legend>
        <p className="muted">
          例如 <code>Authorization</code>：<code>Bearer 金鑰</code>。值只存在伺服器，頁面上只顯示最後 4 碼。
          {urlChanged && headers.some((h) => h.hint) && ' 換了網址，原本的值不會沿用，要重新填。'}
        </p>
        {headers.map((header) => (
          <div className="ai-header-row" key={header.key}>
            <input
              aria-label="Header 名稱"
              value={header.name}
              onChange={(e) => updateHeader(header.key, { name: e.target.value })}
              placeholder="名稱"
              autoComplete="off"
              spellCheck={false}
            />
            <input
              aria-label={`${header.name || 'Header'} 的值`}
              type="password"
              value={header.value}
              onChange={(e) => updateHeader(header.key, { value: e.target.value })}
              placeholder={header.hint && !urlChanged ? `已設定（${header.hint}），留空不變更` : '值'}
              // 不要讓瀏覽器把記住的登入密碼填進來
              autoComplete="new-password"
              spellCheck={false}
              required={!!header.name.trim() && (!header.hint || urlChanged)}
            />
            <button
              type="button"
              className="secondary ai-header-remove"
              aria-label={`刪除 ${header.name || '這個'} header`}
              onClick={() => setHeaders((rows) => rows.filter((row) => row.key !== header.key))}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary ai-header-add"
          onClick={() => setHeaders((rows) => [...rows, { key: nextRowKey++, name: '', value: '' }])}
        >
          ＋ 加一個 header
        </button>
      </fieldset>

      <div className="checks ai-form-checks">
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          啟用
        </label>
        <label>
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          開放給所有登入的人
        </label>
      </div>
      <p className="muted">
        沒勾「開放給所有登入的人」時，只有管理員的對話能用這台伺服器的工具：上面的金鑰是管理員的，
        開放之後每個登入的人都能透過 AI 用這把金鑰做事。
      </p>
      {error && <p className="error">{error}</p>}
      <div className="ai-form-actions">
        <button type="submit" disabled={busy}>
          {busy ? '儲存並讀取工具中…' : server ? '儲存' : '新增'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </form>
  )
}

function ServerCard({
  server,
  onChange,
  onEdit,
}: {
  server: McpServer
  onChange: (view: AiToolsView) => void
  onEdit: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<AiToolsView>) {
    setBusy(true)
    setError(null)
    try {
      onChange(await action())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function remove() {
    if (!confirm(`刪除「${server.name}」？它的工具和工具設定會一起刪掉。`)) return
    run(() => api<AiToolsView>(`/admin/ai/mcp/${server.id}`, { method: 'DELETE' }))
  }

  return (
    <article className={`card ai-mcp ${server.enabled ? '' : 'is-off'}`}>
      <header className="ai-provider-head">
        <h3>{server.name}</h3>
        <code className="ai-mcp-prefix">{server.prefix}__</code>
        {!server.enabled && <span className="chip subtle">已停用</span>}
        <span className={`chip ${server.public ? '' : 'subtle'}`}>{server.public ? '開放給所有人' : '只有管理員'}</span>
      </header>
      <dl className="ai-provider-info">
        <div>
          <dt>網址</dt>
          <dd>
            <code>{server.url}</code>
          </dd>
        </div>
        <div>
          <dt>Header</dt>
          <dd>
            {server.headers.length === 0 ? (
              <span className="muted">無</span>
            ) : (
              server.headers.map((h) => (
                <span key={h.name} className="ai-header-hint">
                  <code>{h.name}</code> {h.hint}
                </span>
              ))
            )}
          </dd>
        </div>
        <div>
          <dt>工具</dt>
          <dd>
            {server.tool_count} 個
            <span className="muted">
              {' · '}
              {server.tools_fetched_at ? `${formatTime(server.tools_fetched_at)} 讀取` : '還沒讀到'}
            </span>
          </dd>
        </div>
      </dl>
      {server.last_error && <p className="error ai-status-line">連線失敗：{server.last_error}</p>}
      {error && <p className="error">{error}</p>}
      <div className="ai-provider-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => run(() => api<AiToolsView>(`/admin/ai/mcp/${server.id}/refresh`, { method: 'POST' }))}
        >
          {busy ? '處理中…' : '重新讀取工具'}
        </button>
        <button type="button" className="secondary" onClick={onEdit} disabled={busy}>
          編輯
        </button>
        <button type="button" className="danger" onClick={remove} disabled={busy}>
          刪除
        </button>
      </div>
    </article>
  )
}

// ---- 工具 ----

type ToolGroup = { key: string; title: string; note?: string; tools: AiToolView[] }

function groupTools(view: AiToolsView): ToolGroup[] {
  const groups: ToolGroup[] = [{ key: 'builtin', title: '本站', tools: view.tools.filter((t) => t.kind === 'builtin') }]
  for (const server of view.servers) {
    const notes = [!server.enabled && '伺服器已停用', !server.public && '只有管理員能用'].filter(Boolean)
    groups.push({
      key: `mcp-${server.id}`,
      title: server.name,
      note: notes.join('、') || undefined,
      tools: view.tools.filter((t) => t.server_id === server.id),
    })
  }
  return groups
}

function ToolRow({ tool, onChange }: { tool: AiToolView; onChange: (view: AiToolsView) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = !tool.enabled || tool.approval !== tool.default_approval

  async function save(patch: { enabled?: boolean; approval?: boolean }) {
    setBusy(true)
    setError(null)
    try {
      const body = JSON.stringify({ enabled: tool.enabled, approval: tool.approval, ...patch })
      onChange(await api<AiToolsView>(`/admin/ai/tools/${encodeURIComponent(tool.name)}`, { method: 'PUT', body }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className={tool.enabled ? undefined : 'ai-tool-off'}>
      <td data-label="工具" className="primary">
        <div className="ai-tool-cell">
          <span className="ai-tool-title">
            <strong>{tool.title}</strong>
            {changed && <span className="chip subtle">已改過</span>}
          </span>
          <code className="ai-tool-code">{tool.name}</code>
          {tool.description && (
            <span className="ai-tool-desc" title={tool.description}>
              {tool.description}
            </span>
          )}
          {error && <span className="error">{error}</span>}
        </div>
      </td>
      <td data-label="啟用">
        <label className="ai-switch">
          <input
            type="checkbox"
            checked={tool.enabled}
            disabled={busy}
            onChange={(e) => save({ enabled: e.target.checked })}
          />
          {tool.enabled ? '啟用' : '關閉'}
        </label>
      </td>
      <td data-label="執行前">
        <label className="ai-switch" title={`預設：${tool.default_approval ? '要使用者確認' : '直接執行'}`}>
          <input
            type="checkbox"
            checked={tool.approval}
            disabled={busy || !tool.enabled}
            onChange={(e) => save({ approval: e.target.checked })}
          />
          要使用者確認
        </label>
      </td>
    </tr>
  )
}

// ---- 頁面 ----

export default function AdminAiTools() {
  const [view, setView] = useState<AiToolsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)

  const load = useCallback(() => {
    api<AiToolsView>('/admin/ai/tools')
      .then((next) => {
        setView(next)
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])
  useEffect(load, [load])

  function saved(next: AiToolsView) {
    setView(next)
    setEditing(null)
  }

  if (!view) return error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>

  const groups = groupTools(view)

  return (
    <>
      <h1>AI 工具</h1>
      <p className="muted ai-intro">
        AI 助手對話時可以呼叫這些工具：本站內建的（日曆、天氣、地震…），以及在下面接上的 MCP 伺服器。
        可以關掉不想給 AI 用的工具；會改資料的工具建議保留「要使用者確認」，使用者在對話裡按允許後才會執行。
      </p>
      <ProviderTools value={view.provider_tools} />
      {error && <p className="error">{error}</p>}

      <div className="ai-section-head">
        <h2>MCP 伺服器（{view.servers.length}）</h2>
        {editing !== 'new' && (
          <button type="button" onClick={() => setEditing('new')}>
            ＋ 新增伺服器
          </button>
        )}
      </div>
      <p className="muted ai-intro ai-mcp-intro">
        只支援 Streamable HTTP 的 MCP 伺服器。網站的容器是 distroless，跑不了 stdio 的伺服器（npx、uvx 那種）；
        要用的話可以在別台主機用 supergateway 之類的工具轉成 HTTP 再接進來。
      </p>
      {editing === 'new' && (
        <div className="card">
          <h3>新增 MCP 伺服器</h3>
          <ServerForm onSaved={saved} onCancel={() => setEditing(null)} />
        </div>
      )}
      {view.servers.length === 0 && editing !== 'new' && <p className="muted ai-mcp-empty">還沒有接任何 MCP 伺服器。</p>}
      <div className="ai-mcp-grid">
        {view.servers.map((server) =>
          editing === server.id ? (
            <div key={server.id} className="card">
              <h3>編輯「{server.name}」</h3>
              <ServerForm server={server} onSaved={saved} onCancel={() => setEditing(null)} />
            </div>
          ) : (
            <ServerCard key={server.id} server={server} onChange={setView} onEdit={() => setEditing(server.id)} />
          ),
        )}
      </div>

      <div className="ai-section-head">
        <h2>工具（{view.tools.length}）</h2>
      </div>
      {groups.map((group) => (
        <section key={group.key} className="ai-tool-group">
          <h3>
            {group.title}
            <span className="muted">
              {' · '}
              {group.tools.length} 個{group.note && ` · ${group.note}`}
            </span>
          </h3>
          {group.tools.length === 0 ? (
            <p className="muted">沒有工具。按伺服器的「重新讀取工具」再試一次。</p>
          ) : (
            <div className="table-wrap">
              <table className="responsive ai-tool-table">
                <thead>
                  <tr>
                    <th>工具</th>
                    <th>啟用</th>
                    <th>執行前</th>
                  </tr>
                </thead>
                <tbody>
                  {group.tools.map((tool) => (
                    <ToolRow key={tool.name} tool={tool} onChange={setView} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </>
  )
}
