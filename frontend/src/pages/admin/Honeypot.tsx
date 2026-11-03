import { Fragment, useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api'
import { describeAgent } from './agent'
import { IpLink } from './IpLink'
import type { HoneypotHit, HoneypotIp, HoneypotReport } from './types'

/** 表格裡每個 IP 最多列出幾個路徑，其他的看明細 */
const MAX_SHOWN_PATHS = 5

function formatTime(value: string) {
  return new Date(value).toLocaleString()
}

function Hits({ ip }: { ip: string }) {
  const [hits, setHits] = useState<HoneypotHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<HoneypotHit[]>(`/admin/honeypot/hits?ip=${encodeURIComponent(ip)}`)
      .then(setHits)
      .catch((e) => setError(errorMessage(e)))
  }, [ip])

  if (error) return <p className="error">{error}</p>
  if (!hits) return <p className="muted">載入中…</p>
  return (
    <ol className="visit-events access-requests">
      {hits.map((h) => (
        <li key={h.id} title={h.user_agent}>
          <time>{formatTime(h.created_at)}</time>
          <span className="access-method">{h.method}</span>
          <span className="visit-detail">{h.query ? `${h.path}?${h.query}` : h.path}</span>
          <span className="muted">{h.username ?? '訪客'}</span>
        </li>
      ))}
    </ol>
  )
}

function Paths({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, MAX_SHOWN_PATHS)
  const more = paths.length - shown.length
  return (
    <span className="visit-ips">
      {shown.join('\n')}
      {more > 0 && <span className="muted" title={`還有 ${more} 個路徑，看明細`}>{`\n+${more}`}</span>}
    </span>
  )
}

function IpTable({ ips }: { ips: HoneypotIp[] }) {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="table-wrap">
      <table className="responsive">
        <thead>
          <tr>
            <th>IP</th>
            <th>次數</th>
            <th>最後一次</th>
            <th>找過的路徑</th>
            <th>帳號</th>
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
                <td data-label="次數">{row.hits}</td>
                <td data-label="最後一次">
                  <time title={`第一次：${formatTime(row.first_at)}`}>{formatTime(row.last_at)}</time>
                </td>
                <td data-label="找過的路徑" className="access-path">
                  <Paths paths={row.paths} />
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
                    <Hits ip={row.ip} />
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

export default function AdminHoneypot() {
  const [report, setReport] = useState<HoneypotReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const load = useCallback(() => {
    api<HoneypotReport>('/admin/honeypot')
      .then((r) => {
        setReport(r)
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])

  useEffect(load, [load])

  const keyword = filter.trim().toLowerCase()
  const ips = (report?.ips ?? []).filter(
    (row) =>
      !keyword ||
      row.ip.includes(keyword) ||
      row.paths.some((p) => p.toLowerCase().includes(keyword)) ||
      row.users.some((u) => u.toLowerCase().includes(keyword)) ||
      row.user_agent.toLowerCase().includes(keyword),
  )
  const stats = report && [
    ['被拿走的次數', report.summary.hits],
    ['不同 IP', report.summary.ips],
    ['最近 24 小時', report.summary.last_day],
    ['最近 24 小時的 IP', report.summary.last_day_ips],
  ]

  return (
    <>
      <h1>.env 蜜罐</h1>
      <p className="muted">
        掃描器常來找{' '}
        <a href="/.env" target="_blank" rel="noreferrer" className="visit-link">
          /.env
        </a>
        、<code>/.env.local</code>、<code>/api/.env</code> 這類設定檔想偷密碼。這些網址會回一份假的設定檔（主機是連不到的內網
        IP，密碼是隨機產生的），並記下是誰拿走的，保留 180 天。正常使用者不會打開這些網址，來過的幾乎都是掃描器；
        自己點開來看也會記一筆，帳號會是你。
      </p>

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
          <summary>被找最多次的路徑</summary>
          <ol>
            {report.paths.map((p) => (
              <li key={p.path}>
                <button type="button" className="link visit-detail" onClick={() => setFilter(p.path)}>
                  {p.path}
                </button>
                <span className="muted">
                  {p.hits} 次 · {p.ips} 個 IP
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <div className="access-toolbar visit-toolbar">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="篩選 IP、路徑、帳號或裝置"
          aria-label="篩選"
        />
        <button type="button" className="secondary" onClick={load}>
          重新整理
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {report &&
        (ips.length ? (
          <>
            <IpTable ips={ips} />
            {report.ips.length < report.summary.ips && (
              <p className="muted">只列出最近的 {report.ips.length} 個 IP。</p>
            )}
          </>
        ) : (
          <p className="muted">{keyword ? '沒有符合的 IP。' : '還沒有人來拿過。'}</p>
        ))}
    </>
  )
}
