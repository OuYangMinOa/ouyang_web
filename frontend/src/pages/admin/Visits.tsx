import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api, errorMessage } from '../../api'
import type { VisitEvent, VisitReport, VisitSession } from './types'

/** 有在記錄的隱藏頁面，跟後端 visits.rs 的 PAGES 對應 */
const PAGE = { id: 'bcs', name: 'Data Matrix 生成器', path: '/bcs' }

const ACTION_LABELS: Record<VisitEvent['action'], string> = {
  open: '開啟',
  click: '點擊',
  scan: '掃描',
  error: '錯誤',
}

function formatTime(value: string) {
  return new Date(value).toLocaleString()
}

/** User-Agent 太長，表格裡只顯示「裝置 · 瀏覽器」，完整的放在 title */
function describeAgent(ua: string) {
  if (!ua) return '—'
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : ''
  const browser = /\bLine\//.test(ua)
    ? 'LINE'
    : /FBAN|FBAV/.test(ua)
      ? 'Facebook'
      : /Edg\//.test(ua)
        ? 'Edge'
        : /SamsungBrowser/.test(ua)
          ? 'Samsung'
          : /OPR\//.test(ua)
            ? 'Opera'
            : /Firefox|FxiOS/.test(ua)
              ? 'Firefox'
              : /CriOS|Chrome\//.test(ua)
                ? 'Chrome'
                : /Safari\//.test(ua)
                  ? 'Safari'
                  : ''
  return [os, browser].filter(Boolean).join(' · ') || ua.slice(0, 40)
}

function Counts({ session }: { session: VisitSession }) {
  const counts = [
    ['開啟', session.opens],
    ['點擊', session.clicks],
    ['掃描', session.scans],
  ] as const
  return (
    <span className="visit-counts">
      {counts
        .filter(([, n]) => n > 0)
        .map(([label, n]) => (
          <span key={label}>
            {label} {n}
          </span>
        ))}
      {session.errors > 0 && <span className="error">錯誤 {session.errors}</span>}
    </span>
  )
}

/** `multi`：這次瀏覽換過 IP 或帳號，每一筆都標出來 */
function Events({ session, multi }: { session: string; multi: boolean }) {
  const [events, setEvents] = useState<VisitEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<VisitEvent[]>(`/admin/visits/${PAGE.id}/${encodeURIComponent(session)}`)
      .then(setEvents)
      .catch((e) => setError(errorMessage(e)))
  }, [session])

  if (error) return <p className="error">{error}</p>
  if (!events) return <p className="muted">載入中…</p>
  return (
    <ol className="visit-events">
      {events.map((event) => (
        <li key={event.id} className={event.action === 'error' ? 'is-error' : undefined}>
          <time>{new Date(event.created_at).toLocaleTimeString()}</time>
          <span className="chip subtle">{ACTION_LABELS[event.action] ?? event.action}</span>
          <span className="visit-detail">{event.detail}</span>
          {multi && (
            <span className="muted">
              {event.username ?? '訪客'} · {event.ip}
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}

export default function AdminVisits() {
  const [report, setReport] = useState<VisitReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const load = useCallback(() => {
    api<VisitReport>(`/admin/visits/${PAGE.id}`)
      .then((r) => {
        setReport(r)
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])

  useEffect(load, [load])

  const keyword = filter.trim().toLowerCase()
  const sessions = (report?.sessions ?? []).filter(
    (s) =>
      !keyword ||
      s.ips.some((ip) => ip.includes(keyword)) ||
      s.users.some((u) => u.toLowerCase().includes(keyword)) ||
      s.user_agent.toLowerCase().includes(keyword),
  )
  const stats = report && [
    ['瀏覽次數', report.summary.sessions],
    ['最近 24 小時', report.summary.last_day],
    ['不同 IP', report.summary.ips],
    ['登入的帳號', report.summary.users],
  ]

  return (
    <>
      <h1>頁面訪客</h1>
      <p className="muted">
        隱藏頁面 <Link to={PAGE.path} className="visit-link">{PAGE.path}</Link>（{PAGE.name}）的瀏覽紀錄，保留 180
        天。每個瀏覽器分頁算一次瀏覽，帳號是當時有登入的人。
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

      <div className="inline-form visit-toolbar">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="篩選 IP、帳號或裝置"
          aria-label="篩選"
        />
        <button type="button" className="secondary" onClick={load}>
          重新整理
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {report && sessions.length === 0 && <p className="muted">{keyword ? '沒有符合的紀錄。' : '還沒有人來過。'}</p>}
      {sessions.length > 0 && (
        <div className="table-wrap">
          <table className="responsive">
            <thead>
              <tr>
                <th>最後活動</th>
                <th>帳號</th>
                <th>IP</th>
                <th>裝置</th>
                <th>動作</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <Fragment key={s.session}>
                  <tr>
                    <td data-label="最後活動" className="primary">
                      <time title={`第一次：${formatTime(s.first_at)}`}>{formatTime(s.last_at)}</time>
                    </td>
                    <td data-label="帳號">
                      {s.users.length ? (
                        s.users.map((u) => (
                          <span key={u} className="chip">
                            {u}
                          </span>
                        ))
                      ) : (
                        <span className="muted">訪客</span>
                      )}
                    </td>
                    <td data-label="IP">
                      <code className="visit-ips">{s.ips.join('\n')}</code>
                    </td>
                    <td data-label="裝置" title={s.user_agent}>
                      {describeAgent(s.user_agent)}
                    </td>
                    <td data-label="動作">
                      <Counts session={s} />
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="secondary"
                        aria-expanded={open === s.session}
                        onClick={() => setOpen(open === s.session ? null : s.session)}
                      >
                        {open === s.session ? '收起' : '明細'}
                      </button>
                    </td>
                  </tr>
                  {open === s.session && (
                    <tr className="visit-open">
                      <td colSpan={6}>
                        <Events session={s.session} multi={s.ips.length > 1 || s.users.length > 1} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
