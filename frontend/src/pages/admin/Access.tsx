import { Fragment, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api'
import { describeAgent } from './agent'
import type { AccessIp, AccessReport, AccessRequest } from './types'

const RANGES = [
  { hours: 1, label: '1 小時' },
  { hours: 24, label: '24 小時' },
  { hours: 24 * 7, label: '7 天' },
  { hours: 24 * 30, label: '30 天' },
]

const VIEWS = [
  { id: 'ips', label: '依 IP' },
  { id: 'requests', label: '所有請求' },
] as const

type View = (typeof VIEWS)[number]['id']

function formatTime(value: string) {
  return new Date(value).toLocaleString()
}

/** 網址裡的中文（例如音樂檔名）是編碼過的，解得開就顯示原字 */
function decode(text: string) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function fullPath(r: Pick<AccessRequest, 'path' | 'query'>) {
  return decode(r.query ? `${r.path}?${r.query}` : r.path)
}

function statusClass(status: number) {
  return status >= 500 ? 'chip access-status is-5xx' : status >= 400 ? 'chip access-status is-4xx' : 'chip access-status'
}

/** 本機開發沒有 X-Forwarded-For，IP 會是 local */
function IpLink({ ip }: { ip: string }) {
  if (ip === 'local') return <code>{ip}</code>
  return (
    <a href={`https://ipinfo.io/${encodeURIComponent(ip)}`} target="_blank" rel="noreferrer" title="在 ipinfo.io 查詢">
      <code>{ip}</code>
    </a>
  )
}

/** `showIp`：所有請求混在一起時才需要標出 IP；點 IP 用它篩選 */
function RequestList({
  requests,
  showIp,
  onPickIp,
}: {
  requests: AccessRequest[]
  showIp?: boolean
  onPickIp?: (ip: string) => void
}) {
  return (
    <ol className="visit-events access-requests">
      {requests.map((r) => (
        <li key={r.id} title={r.user_agent}>
          <time title={formatTime(r.created_at)}>{new Date(r.created_at).toLocaleTimeString()}</time>
          <span className={statusClass(r.status)}>{r.status}</span>
          <span className="access-method">{r.method}</span>
          <span className="visit-detail">{fullPath(r)}</span>
          <span className="muted">
            {r.duration_ms} ms · {r.username ?? '訪客'}
          </span>
          {showIp && (
            <button type="button" className="link access-ip" onClick={() => onPickIp?.(r.ip)}>
              <code>{r.ip}</code>
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}

function IpRequests({ ip, hours }: { ip: string; hours: number }) {
  const [requests, setRequests] = useState<AccessRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<AccessRequest[]>(`/admin/access/requests?hours=${hours}&ip=${encodeURIComponent(ip)}`)
      .then(setRequests)
      .catch((e) => setError(errorMessage(e)))
  }, [ip, hours])

  if (error) return <p className="error">{error}</p>
  if (!requests) return <p className="muted">載入中…</p>
  return <RequestList requests={requests} />
}

function IpTable({ ips, hours }: { ips: AccessIp[]; hours: number }) {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="table-wrap">
      <table className="responsive">
        <thead>
          <tr>
            <th>IP</th>
            <th>帳號</th>
            <th>請求</th>
            <th>最後活動</th>
            <th>最後的路徑</th>
            <th>裝置</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ips.map((row) => (
            <Fragment key={row.ip}>
              <tr>
                <td data-label="IP" className="primary">
                  <IpLink ip={row.ip} />
                </td>
                <td data-label="帳號">
                  {row.users.length ? (
                    row.users.map((u) => (
                      <span key={u} className="chip">
                        {u}
                      </span>
                    ))
                  ) : (
                    <span className="muted">訪客</span>
                  )}
                </td>
                <td data-label="請求">
                  <span className="visit-counts">
                    <span>{row.requests}</span>
                    {row.errors > 0 && <span className="error">錯誤 {row.errors}</span>}
                  </span>
                </td>
                <td data-label="最後活動">
                  <time title={`第一次：${formatTime(row.first_at)}`}>{formatTime(row.last_at)}</time>
                </td>
                <td data-label="最後的路徑" className="access-path">
                  <span className="access-method">{row.last_method}</span> {decode(row.last_path)}
                </td>
                <td data-label="裝置" title={row.user_agent}>
                  {describeAgent(row.user_agent)}
                </td>
                <td className="actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-expanded={open === row.ip}
                    onClick={() => setOpen(open === row.ip ? null : row.ip)}
                  >
                    {open === row.ip ? '收起' : '明細'}
                  </button>
                </td>
              </tr>
              {open === row.ip && (
                <tr className="visit-open">
                  <td colSpan={7}>
                    <IpRequests ip={row.ip} hours={hours} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AdminAccess() {
  const [hours, setHours] = useState(24)
  const [sort, setSort] = useState<'recent' | 'requests'>('recent')
  const [view, setView] = useState<View>('ips')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [filter, setFilter] = useState('')
  // 按「重新整理」時加一，讓下面的 effect 重抓
  const [reload, setReload] = useState(0)
  const [report, setReport] = useState<AccessReport | null>(null)
  const [requests, setRequests] = useState<AccessRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<AccessReport>(`/admin/access?hours=${hours}&sort=${sort}`)
      .then((r) => {
        setReport(r)
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [hours, sort, reload])

  useEffect(() => {
    if (view !== 'requests') return
    api<AccessRequest[]>(`/admin/access/requests?hours=${hours}${errorsOnly ? '&errors=true' : ''}`)
      .then((r) => {
        setRequests(r)
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [view, hours, errorsOnly, reload])

  const keyword = filter.trim().toLowerCase()
  const ips = (report?.ips ?? []).filter(
    (row) =>
      !keyword ||
      row.ip.includes(keyword) ||
      row.users.some((u) => u.toLowerCase().includes(keyword)) ||
      decode(row.last_path).toLowerCase().includes(keyword) ||
      row.user_agent.toLowerCase().includes(keyword),
  )
  const shownRequests = (requests ?? []).filter(
    (r) =>
      !keyword ||
      r.ip.includes(keyword) ||
      fullPath(r).toLowerCase().includes(keyword) ||
      (r.username ?? '').toLowerCase().includes(keyword) ||
      String(r.status) === keyword,
  )
  const stats = report && [
    ['請求數', report.summary.requests],
    ['不同 IP', report.summary.ips],
    ['登入的帳號', report.summary.users],
    ['錯誤（4xx / 5xx）', report.summary.errors],
  ]

  return (
    <>
      <h1>IP 訪問紀錄</h1>
      <p className="muted">
        全站每個請求的來源 IP、路徑和狀態碼，保留 30 天。前端的程式和圖片等靜態檔、health check 不記；同一個 IP 10
        分鐘超過 1000 筆的部分也不記。紀錄每 2 秒寫進資料庫一次，剛發生的要稍等一下才看得到。
      </p>

      <div className="access-toolbar">
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="時間範圍">
          {RANGES.map((r) => (
            <option key={r.hours} value={r.hours}>
              最近 {r.label}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="篩選 IP、帳號、路徑或裝置"
          aria-label="篩選"
        />
        <button type="button" className="secondary" onClick={() => setReload((n) => n + 1)}>
          重新整理
        </button>
      </div>

      {stats && (
        <div className="visit-stats">
          {stats.map(([label, value]) => (
            <div key={label} className="card">
              <span className="muted">{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      )}

      {report && report.paths.length > 0 && (
        <details className="card access-paths">
          <summary>請求最多的路徑</summary>
          <ol>
            {report.paths.map((p) => (
              <li key={p.path}>
                <button type="button" className="link visit-detail" onClick={() => setFilter(decode(p.path))}>
                  {decode(p.path)}
                </button>
                <span className="muted">
                  {p.requests} 次 · {p.ips} 個 IP
                </span>
                {p.errors > 0 && <span className="error">錯誤 {p.errors}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}

      <div className="access-views">
        <div className="access-tabs">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={view === v.id ? undefined : 'secondary'}
              aria-pressed={view === v.id}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === 'ips' ? (
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="排序">
            <option value="recent">依最後活動</option>
            <option value="requests">依請求數</option>
          </select>
        ) : (
          <div className="checks">
            <label>
              <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
              只看錯誤
            </label>
          </div>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {view === 'ips' &&
        report &&
        (ips.length ? (
          <>
            <IpTable ips={ips} hours={hours} />
            {report.ips.length < report.summary.ips && (
              <p className="muted">只列出前 {report.ips.length} 個 IP。</p>
            )}
          </>
        ) : (
          <p className="muted">{keyword ? '沒有符合的 IP。' : '這段時間沒有紀錄。'}</p>
        ))}

      {view === 'requests' &&
        requests &&
        (shownRequests.length ? (
          <div className="card access-all">
            <RequestList requests={shownRequests} showIp onPickIp={setFilter} />
            {requests.length >= 500 && <p className="muted">只列出最近 500 筆。</p>}
          </div>
        ) : (
          <p className="muted">{keyword || errorsOnly ? '沒有符合的請求。' : '這段時間沒有紀錄。'}</p>
        ))}
    </>
  )
}
