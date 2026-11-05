import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../../api'
import { usePolling } from '../../feedback/util'
import type { AiUsageDay, AiUsageDefaults, AiUsageReport, AiUsageUser } from './types'
import '../../ai/ai.css'
import '../../ai/admin.css'

const PERIODS = [7, 30, 90]
const REFRESH_MS = 30_000

const KIND_LABELS: Record<string, string> = {
  chat: '對話',
  chat_continue: '確認後繼續',
  calendar: '一句話新增事項',
  title: '取標題',
}

const fmt = (n: number) => n.toLocaleString()

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

/** 輸入框的字（空的是不限）→ 數字或 null；格式不對回傳 undefined */
function parseLimit(text: string): number | null | undefined {
  const value = text.trim()
  if (!value) return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

const limitText = (value: number | null) => (value === null ? '' : String(value))

// ---- 全站預設 ----

function DefaultsForm({
  defaults,
  running,
  onSaved,
}: {
  defaults: AiUsageDefaults
  running: number
  onSaved: () => void
}) {
  const [requests, setRequests] = useState(limitText(defaults.daily_requests))
  const [tokens, setTokens] = useState(limitText(defaults.daily_tokens))
  const [maxRunning, setMaxRunning] = useState(String(defaults.max_running))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const dailyRequests = parseLimit(requests)
    const dailyTokens = parseLimit(tokens)
    const max = Number(maxRunning)
    if (dailyRequests === undefined || dailyTokens === undefined) {
      setMessage({ ok: false, text: '次數和 token 要是 0 以上的整數，空的是不限' })
      return
    }
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      setMessage({ ok: false, text: '同時最多幾個要是 1 到 100' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await api('/admin/ai/usage/defaults', {
        method: 'PUT',
        body: JSON.stringify({ daily_requests: dailyRequests, daily_tokens: dailyTokens, max_running: max }),
      })
      setMessage({ ok: true, text: '已儲存' })
      onSaved()
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>全站預設</h2>
      <p className="muted">
        每個人每天的額度以台灣時間的日期算，有個別設定的人用自己的。「對話」和「一句話新增事項」各算一次，
        確認工具後接著做、取標題不算次數，但 token 照算。管理員不受限。
      </p>
      <div className="row">
        <label>
          每人每天幾次
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={requests}
            onChange={(e) => setRequests(e.target.value)}
            placeholder="不限"
          />
        </label>
        <label>
          每人每天幾個 token
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1000}
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
            placeholder="不限"
          />
        </label>
        <label>
          全站同時最多幾個請求
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={maxRunning}
            onChange={(e) => setMaxRunning(e.target.value)}
            required
          />
        </label>
      </div>
      <p className="muted">
        現在有 <strong className="ai-usage-strong">{running}</strong> 個 AI 請求在跑。滿了的時候新的請求會請使用者稍後再試，不排隊；
        每個人同時只能有一個。
      </p>
      {message && <p className={message.ok ? 'success' : 'error'}>{message.text}</p>}
      <button type="submit" disabled={busy}>
        {busy ? '儲存中…' : '儲存'}
      </button>
    </form>
  )
}

// ---- 每日用量 ----

/** 台灣時間的今天往前 `days` 天（含今天），YYYY-MM-DD */
function taipeiDays(days: number): string[] {
  const today = Date.now() + 8 * 3600_000
  return Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  )
}

function shortDay(day: string) {
  const [, month, date] = day.split('-').map(Number)
  return `${month}/${date}`
}

function DailyChart({ daily, days }: { daily: AiUsageDay[]; days: number }) {
  const [metric, setMetric] = useState<'requests' | 'tokens'>('requests')
  const byDay = new Map(daily.map((d) => [d.day, d]))
  const points = taipeiDays(days).map((day) => ({ day, data: byDay.get(day) }))
  const value = (p: (typeof points)[number]) => (p.data ? p.data[metric] : 0)
  const max = Math.max(1, ...points.map(value))
  const total = points.reduce((sum, p) => sum + value(p), 0)
  const unit = metric === 'requests' ? '次' : 'tokens'

  return (
    <div className="card ai-usage-chart-card">
      <div className="ai-usage-chart-head">
        <h3>每日用量</h3>
        <div className="ai-segmented" role="group" aria-label="看次數還是 token">
          <button
            type="button"
            className={metric === 'requests' ? '' : 'secondary'}
            aria-pressed={metric === 'requests'}
            onClick={() => setMetric('requests')}
          >
            次數
          </button>
          <button
            type="button"
            className={metric === 'tokens' ? '' : 'secondary'}
            aria-pressed={metric === 'tokens'}
            onClick={() => setMetric('tokens')}
          >
            Token
          </button>
        </div>
      </div>
      <p className="muted">
        {days} 天共 {fmt(total)} {unit}，最多的一天 {fmt(max === 1 && total === 0 ? 0 : max)} {unit}
      </p>
      <div
        className={`ai-usage-chart ${days > 30 ? 'is-dense' : ''}`}
        role="img"
        aria-label={`最近 ${days} 天每天的 AI ${metric === 'requests' ? '使用次數' : 'token 用量'}，共 ${fmt(total)} ${unit}`}
      >
        {points.map((p) => (
          <div
            key={p.day}
            className="ai-usage-bar-slot"
            title={`${p.day}：${fmt(value(p))} ${unit}${p.data ? `，${p.data.users} 人` : ''}`}
          >
            <div className="ai-usage-bar" style={{ height: `${(value(p) / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="ai-usage-axis muted">
        <span>{shortDay(points[0].day)}</span>
        <span>今天</span>
      </div>
    </div>
  )
}

// ---- 使用者 ----

function LimitForm({
  user,
  defaults,
  onSaved,
  onCancel,
}: {
  user: AiUsageUser
  defaults: AiUsageDefaults
  onSaved: () => void
  onCancel: () => void
}) {
  const [requests, setRequests] = useState(limitText(user.daily_requests))
  const [tokens, setTokens] = useState(limitText(user.daily_tokens))
  const [blocked, setBlocked] = useState(user.blocked)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const dailyRequests = parseLimit(requests)
    const dailyTokens = parseLimit(tokens)
    if (dailyRequests === undefined || dailyTokens === undefined) {
      setError('要是 0 以上的整數，空的是用預設')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api(`/admin/ai/usage/users/${user.user_id}`, {
        method: 'PUT',
        body: JSON.stringify({ daily_requests: dailyRequests, daily_tokens: dailyTokens, blocked }),
      })
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const defaultText = (value: number | null) => `預設（${value === null ? '不限' : fmt(value)}）`

  return (
    <form className="stack edit ai-limit-form" onSubmit={submit}>
      <label>
        每天幾次
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={requests}
          onChange={(e) => setRequests(e.target.value)}
          placeholder={defaultText(defaults.daily_requests)}
        />
      </label>
      <label>
        每天幾個 token
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1000}
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
          placeholder={defaultText(defaults.daily_tokens)}
        />
      </label>
      <div className="checks">
        <label>
          <input type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} />
          停用這個人的 AI 功能
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy}>
          儲存
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </form>
  )
}

/** 「3 / 50」：有上限時才顯示上限 */
function withLimit(used: number, limit: number | null, unlimited: boolean) {
  if (unlimited || limit === null) return fmt(used)
  return (
    <>
      <span className={used >= limit ? 'error' : undefined}>{fmt(used)}</span>
      <span className="muted"> / {fmt(limit)}</span>
    </>
  )
}

function UserRow({
  user,
  defaults,
  days,
  editing,
  onEdit,
  onSaved,
  onCancel,
}: {
  user: AiUsageUser
  defaults: AiUsageDefaults
  days: number
  editing: boolean
  onEdit: () => void
  onSaved: () => void
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestLimit = user.daily_requests ?? defaults.daily_requests
  const tokenLimit = user.daily_tokens ?? defaults.daily_tokens
  const custom = user.daily_requests !== null || user.daily_tokens !== null
  const tokens = user.prompt_tokens + user.completion_tokens

  async function toggleBlocked() {
    if (!user.blocked && !confirm(`停用 ${user.username} 的 AI 功能？`)) return
    setBusy(true)
    setError(null)
    try {
      await api(`/admin/ai/usage/users/${user.user_id}`, {
        method: 'PUT',
        body: JSON.stringify({ daily_requests: user.daily_requests, daily_tokens: user.daily_tokens, blocked: !user.blocked }),
      })
      onSaved()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className={user.blocked ? 'ai-usage-blocked' : undefined}>
      <td data-label="帳號" className="primary">
        <span className="ai-usage-user">
          <span>{user.username}</span>
          {user.is_admin && <span className="chip subtle">不受限</span>}
          {user.blocked && <span className="chip ai-chip-danger">已停用</span>}
        </span>
      </td>
      <td data-label="今天">
        <span className="ai-usage-stack">
          <span>{withLimit(user.today_requests, requestLimit, user.is_admin)} 次</span>
          <span className="muted">
            {withLimit(user.today_tokens, tokenLimit, user.is_admin)} tokens
          </span>
        </span>
      </td>
      <td data-label={`${days} 天`}>
        <span className="ai-usage-stack">
          <span>{fmt(user.requests)} 次</span>
          <span className="muted" title={`輸入 ${fmt(user.prompt_tokens)}、輸出 ${fmt(user.completion_tokens)}`}>
            {fmt(tokens)} tokens
          </span>
        </span>
      </td>
      <td data-label="工具／錯誤">
        <span>
          {fmt(user.tool_calls)}
          <span className="muted"> / </span>
          <span className={user.errors > 0 ? 'error' : 'muted'}>{fmt(user.errors)}</span>
        </span>
      </td>
      <td data-label="最後使用">
        <time>{formatTime(user.last_used_at)}</time>
      </td>
      <td data-label="額度">
        {editing ? (
          <LimitForm user={user} defaults={defaults} onSaved={onSaved} onCancel={onCancel} />
        ) : user.is_admin ? (
          <span className="muted">不受限</span>
        ) : custom ? (
          <span className="ai-usage-stack">
            <span>自訂</span>
            <span className="muted">
              {requestLimit === null ? '不限' : `${fmt(requestLimit)} 次`}、
              {tokenLimit === null ? '不限' : `${fmt(tokenLimit)} tokens`}
            </span>
          </span>
        ) : (
          <span className="muted">預設</span>
        )}
      </td>
      <td className="actions">
        {error && <p className="error">{error}</p>}
        {!editing && (
          <>
            <button type="button" className="secondary" onClick={onEdit} disabled={busy}>
              額度
            </button>
            <button type="button" className={user.blocked ? 'secondary' : 'danger'} onClick={toggleBlocked} disabled={busy}>
              {user.blocked ? '恢復' : '停用'}
            </button>
          </>
        )}
      </td>
    </tr>
  )
}

// ---- 頁面 ----

export default function AdminAiUsage() {
  const [days, setDays] = useState(7)
  const [report, setReport] = useState<AiUsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | null>(null)

  const load = useCallback(() => {
    api<AiUsageReport>(`/admin/ai/usage?days=${days}`)
      .then((next) => {
        setReport(next)
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [days])
  useEffect(load, [load])
  usePolling(load, REFRESH_MS)

  if (!report) return error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>

  const { defaults } = report
  const active = report.users.filter((u) => u.requests > 0 || u.prompt_tokens + u.completion_tokens > 0)
  const totalRequests = report.users.reduce((sum, u) => sum + u.requests, 0)
  const totalTokens = report.users.reduce((sum, u) => sum + u.prompt_tokens + u.completion_tokens, 0)
  const totalErrors = report.users.reduce((sum, u) => sum + u.errors, 0)

  return (
    <>
      <h1>AI 用量</h1>
      <p className="muted ai-intro">每個人用了多少 AI、每天的額度，以及最近的呼叫。每 30 秒自動更新。</p>
      {error && <p className="error">{error}</p>}

      <DefaultsForm
        // 存檔或別人改了預設值後，表單換成新的值
        key={JSON.stringify(defaults)}
        defaults={defaults}
        running={report.running}
        onSaved={load}
      />

      <div className="ai-section-head">
        <h2>最近 {report.days} 天</h2>
        <div className="ai-segmented" role="group" aria-label="期間">
          {PERIODS.map((n) => (
            <button
              key={n}
              type="button"
              className={n === days ? '' : 'secondary'}
              aria-pressed={n === days}
              onClick={() => setDays(n)}
            >
              {n} 天
            </button>
          ))}
        </div>
      </div>

      <div className="ai-usage-stats">
        <div className="card">
          <span className="muted">次數</span>
          <strong>{fmt(totalRequests)}</strong>
        </div>
        <div className="card">
          <span className="muted">Token</span>
          <strong>{fmt(totalTokens)}</strong>
        </div>
        <div className="card">
          <span className="muted">用過的人</span>
          <strong>{fmt(active.length)}</strong>
        </div>
        <div className="card">
          <span className="muted">錯誤</span>
          <strong className={totalErrors > 0 ? 'error' : undefined}>{fmt(totalErrors)}</strong>
        </div>
      </div>

      <DailyChart daily={report.daily} days={report.days} />

      <h2 className="ai-usage-h2">使用者（{report.users.length}）</h2>
      <p className="muted">所有啟用中的帳號都列出來，還沒用過的也可以先設定額度。「今天」是台灣時間的今天。</p>
      <div className="table-wrap">
        <table className="responsive ai-usage-table">
          <thead>
            <tr>
              <th>帳號</th>
              <th>今天</th>
              <th>{report.days} 天</th>
              <th>工具／錯誤</th>
              <th>最後使用</th>
              <th>額度</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {report.users.map((user) => (
              <UserRow
                key={user.user_id}
                user={user}
                defaults={defaults}
                days={report.days}
                editing={editing === user.user_id}
                onEdit={() => setEditing(user.user_id)}
                onSaved={() => {
                  setEditing(null)
                  load()
                }}
                onCancel={() => setEditing(null)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="ai-usage-h2">最近的呼叫</h2>
      {report.recent.length === 0 ? (
        <p className="muted">還沒有人用過 AI。</p>
      ) : (
        <div className="table-wrap">
          <table className="responsive ai-usage-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>帳號</th>
                <th>種類</th>
                <th>Token（輸入／輸出）</th>
                <th>工具</th>
                <th>結果</th>
                <th>秒數</th>
              </tr>
            </thead>
            <tbody>
              {report.recent.map((r) => (
                <tr key={r.id}>
                  <td data-label="時間">
                    <time>{formatTime(r.created_at)}</time>
                  </td>
                  <td data-label="帳號" className="primary">
                    {r.username}
                  </td>
                  <td data-label="種類">{KIND_LABELS[r.kind] ?? r.kind}</td>
                  <td data-label="Token">
                    <span>
                      {fmt(r.prompt_tokens)}
                      <span className="muted"> / </span>
                      {fmt(r.completion_tokens)}
                    </span>
                  </td>
                  <td data-label="工具">{r.tool_calls}</td>
                  <td data-label="結果">{r.ok ? <span className="success">成功</span> : <span className="error">失敗</span>}</td>
                  <td data-label="秒數">{(r.ms / 1000).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
