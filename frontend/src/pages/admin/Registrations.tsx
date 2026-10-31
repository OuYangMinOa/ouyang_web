import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api'
import type { Registration, RegistrationReport } from './types'

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—'
}

const STATUS_LABELS: Record<Registration['status'], string> = {
  pending: '待審核',
  approved: '已核准',
  rejected: '已拒絕',
}

function Note({ text }: { text: string }) {
  return text ? <span className="registration-note">{text}</span> : <span className="muted">—</span>
}

export default function AdminRegistrations() {
  const [report, setReport] = useState<RegistrationReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<RegistrationReport>('/admin/registrations')
      .then(setReport)
      .catch((e) => setError(errorMessage(e)))
  }, [])

  async function toggle(open: boolean) {
    setBusy(true)
    try {
      const result = await api<{ open: boolean }>('/admin/registrations/open', {
        method: 'PUT',
        body: JSON.stringify({ open }),
      })
      setReport((prev) => prev && { ...prev, open: result.open })
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function review(item: Registration, action: 'approve' | 'reject') {
    if (action === 'reject' && !confirm(`拒絕 ${item.username} 的註冊申請？`)) return
    setBusy(true)
    try {
      const updated = await api<Registration>(`/admin/registrations/${item.id}/${action}`, { method: 'POST' })
      setReport(
        (prev) =>
          prev && {
            ...prev,
            pending: prev.pending.filter((r) => r.id !== item.id),
            reviewed: [updated, ...prev.reviewed],
          },
      )
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!report) return error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>

  return (
    <>
      <h1>註冊審核</h1>
      <div className="card registration-switch">
        <div className="stack">
          <h3>開放註冊</h3>
          <p className="muted">
            {report.open
              ? '登入頁會出現「註冊」按鈕，訪客可以送出申請，核准後才能登入。'
              : '已關閉：登入頁不顯示註冊按鈕，也不接受新的申請。已送出的申請仍可審核。'}
          </p>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={report.open}
            disabled={busy}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span>{report.open ? '開放中' : '已關閉'}</span>
        </label>
      </div>

      {error && <p className="error">{error}</p>}

      <h2>待審核（{report.pending.length}）</h2>
      {report.pending.length === 0 ? (
        <p className="muted">目前沒有待審核的申請。</p>
      ) : (
        <div className="table-wrap">
          <table className="responsive">
            <thead>
              <tr>
                <th>帳號</th>
                <th>備註</th>
                <th>IP</th>
                <th>申請時間</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {report.pending.map((item) => (
                <tr key={item.id}>
                  <td data-label="帳號" className="primary">
                    <span className="username">{item.username}</span>
                  </td>
                  <td data-label="備註">
                    <Note text={item.note} />
                  </td>
                  <td data-label="IP">
                    <code>{item.ip}</code>
                  </td>
                  <td data-label="申請時間">
                    <time>{formatTime(item.created_at)}</time>
                  </td>
                  <td className="actions">
                    <button type="button" disabled={busy} onClick={() => review(item, 'approve')}>
                      核准
                    </button>
                    <button type="button" className="danger" disabled={busy} onClick={() => review(item, 'reject')}>
                      拒絕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted registration-hint">核准後帳號沒有任何角色，需要的話到「使用者」指派。</p>

      {report.reviewed.length > 0 && (
        <>
          <h2>最近審核</h2>
          <div className="table-wrap">
            <table className="responsive">
              <thead>
                <tr>
                  <th>帳號</th>
                  <th>結果</th>
                  <th>備註</th>
                  <th>審核者</th>
                  <th>審核時間</th>
                </tr>
              </thead>
              <tbody>
                {report.reviewed.map((item) => (
                  <tr key={item.id}>
                    <td data-label="帳號" className="primary">
                      <span className="username">{item.username}</span>
                    </td>
                    <td data-label="結果">
                      <span className={item.status === 'approved' ? 'success' : 'error'}>
                        {STATUS_LABELS[item.status]}
                      </span>
                    </td>
                    <td data-label="備註">
                      <Note text={item.note} />
                    </td>
                    <td data-label="審核者">{item.reviewer ?? '—'}</td>
                    <td data-label="審核時間">
                      <time>{formatTime(item.reviewed_at)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
