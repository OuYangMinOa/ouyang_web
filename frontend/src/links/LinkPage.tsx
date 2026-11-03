import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { errorMessage } from '../api'
import { copyToClipboard } from '../clipboard'
import { describeAgent } from '../pages/admin/agent'
import { IpLink } from '../pages/admin/IpLink'
import { drawQr, encodeQr, qrSvg, type Style } from '../tools/qrcode/matrix'
import { deleteLink, getStats, shortUrl, updateLink, type ShortLink, type Stats } from './api'
import './links.css'

const DAYS = 30
const QR_SIZE = 1024
// QR Code 本身一律白底黑字，深色主題也一樣，掃描器才讀得到
const QR_STYLE: Style = { fg: '#000000', bg: '#ffffff', margin: 4 }

function formatTime(value: string) {
  return new Date(value).toLocaleString()
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function QrCard({ link }: { link: ShortLink }) {
  const url = shortUrl(link.code)
  const matrix = useMemo(() => encodeQr(url, 'M'), [url])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [copied, setCopied] = useState(false)
  const fileBase = `qrcode_${link.code}`

  useEffect(() => {
    if (canvasRef.current) drawQr(canvasRef.current, matrix, QR_SIZE, QR_STYLE)
  }, [matrix])

  const pngBlob = () =>
    new Promise<Blob>((resolve, reject) =>
      canvasRef.current?.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('無法產生圖片'))), 'image/png'),
    )

  async function copy() {
    await copyToClipboard(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function share() {
    const file = new File([await pngBlob()], `${fileBase}.png`, { type: 'image/png' })
    const data: ShareData = { title: link.title || url, url }
    try {
      await navigator.share(navigator.canShare?.({ files: [file] }) ? { ...data, files: [file] } : data)
    } catch {
      // 使用者取消分享
    }
  }

  return (
    <section className="card links-qr">
      <canvas ref={canvasRef} className="links-qr-canvas" aria-label={`${url} 的 QR Code`} />
      <div className="stack links-qr-side">
        <a className="links-short" href={url} target="_blank" rel="noreferrer">
          {url.replace(/^https?:\/\//, '')}
        </a>
        <div className="links-buttons">
          <button type="button" onClick={copy}>
            {copied ? '已複製' : '複製網址'}
          </button>
          {'share' in navigator && (
            <button type="button" className="secondary" onClick={share}>
              分享
            </button>
          )}
          <button type="button" className="secondary" onClick={async () => downloadBlob(await pngBlob(), `${fileBase}.png`)}>
            下載 PNG
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => downloadBlob(new Blob([qrSvg(matrix, QR_SIZE, QR_STYLE)], { type: 'image/svg+xml' }), `${fileBase}.svg`)}
          >
            下載 SVG
          </button>
        </div>
      </div>
    </section>
  )
}

function EditForm({ link, onSaved }: { link: ShortLink; onSaved: (link: ShortLink) => void }) {
  const navigate = useNavigate()
  const [url, setUrl] = useState(link.url)
  const [title, setTitle] = useState(link.title)
  const [requireLogin, setRequireLogin] = useState(link.require_login)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const dirty = url !== link.url || title !== link.title || requireLogin !== link.require_login

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const updated = await updateLink(link.id, { url, title, require_login: requireLogin })
      onSaved(updated)
      setUrl(updated.url)
      setError(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!confirm(`刪除 /s/${link.code}？已經分享出去的連結和 QR Code 都會失效，點擊紀錄也會一起刪掉。`)) return
    try {
      await deleteLink(link.id)
      navigate('/links')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>設定</h2>
      <label>
        目的網址
        <input
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </label>
      <label>
        名稱（只有你看得到）
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
      </label>
      <label className="switch">
        <input type="checkbox" role="switch" checked={requireLogin} onChange={(e) => setRequireLogin(e.target.checked)} />
        要登入本站才能開啟
      </label>
      <p className="muted links-note">代碼建立後不能改，已經印出去的 QR Code 才不會失效。</p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="success">已儲存</p>}
      <div className="links-buttons">
        <button type="submit" disabled={busy || !dirty}>
          {busy ? '儲存中…' : '儲存'}
        </button>
        <button type="button" className="danger" onClick={remove}>
          刪除短網址
        </button>
      </div>
    </form>
  )
}

/** 最近 30 天每天的點擊次數；後端給的是 UTC 的日期，沒有點擊的日子補 0 */
function DailyChart({ days, today }: { days: Stats['days']; today: Date }) {
  const counts = new Map(days.map((d) => [d.day, d.clicks]))
  const series = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (DAYS - 1 - i)))
    const day = d.toISOString().slice(0, 10)
    return { day, clicks: counts.get(day) ?? 0 }
  })
  const max = Math.max(1, ...series.map((d) => d.clicks))

  return (
    <section className="card stack">
      <h2>最近 30 天</h2>
      <div className="links-chart" role="img" aria-label="最近 30 天每天的點擊次數">
        {series.map((d) => (
          <div key={d.day} className="links-bar" title={`${d.day.slice(5)}：${d.clicks} 次`}>
            <span style={{ height: `${(d.clicks / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="links-chart-axis muted">
        <span>{series[0].day.slice(5)}</span>
        <span>最多 {max} 次</span>
        <span>{series[DAYS - 1].day.slice(5)}</span>
      </div>
    </section>
  )
}

export default function LinkPage() {
  const id = Number(useParams().id)
  const [stats, setStats] = useState<Stats | null>(null)
  /** 載入的時間，圖表從這天往回算 */
  const [loadedAt, setLoadedAt] = useState(() => new Date(0))
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'ips' | 'clicks'>('ips')

  useEffect(() => {
    getStats(id)
      .then((loaded) => {
        setStats(loaded)
        setLoadedAt(new Date())
      })
      .catch((e) => setError(errorMessage(e)))
  }, [id])

  if (!stats) return error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>
  const { link } = stats

  return (
    <div className="links">
      <p>
        <Link className="text-link" to="/links">
          ← 我的短網址
        </Link>
      </p>
      <h1 className="links-title">{link.title || `/s/${link.code}`}</h1>
      <p className="muted links-dest">
        → <a href={link.url} target="_blank" rel="noreferrer">{link.url}</a>
      </p>

      <QrCard link={link} />

      <div className="visit-stats">
        {(
          [
            ['點擊', link.clicks],
            ['不同 IP', link.ips],
            ['最後一次', link.last_click_at ? formatTime(link.last_click_at) : '—'],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="card">
            <span className="muted">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <DailyChart days={stats.days} today={loadedAt} />

      <section className="card stack">
        <div className="links-section-head">
          <h2>誰點過</h2>
          <div className="links-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'ips'} className={view === 'ips' ? '' : 'secondary'} onClick={() => setView('ips')}>
              依 IP
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'clicks'}
              className={view === 'clicks' ? '' : 'secondary'}
              onClick={() => setView('clicks')}
            >
              每一次
            </button>
          </div>
        </div>
        {link.clicks === 0 ? (
          <p className="muted">還沒有人點過。</p>
        ) : view === 'ips' ? (
          <div className="table-wrap">
            <table className="responsive">
              <thead>
                <tr>
                  <th>IP</th>
                  <th>次數</th>
                  <th>最後一次</th>
                  <th>裝置</th>
                  <th>帳號</th>
                </tr>
              </thead>
              <tbody>
                {stats.ips.map((row) => (
                  <tr key={row.ip}>
                    <td data-label="IP" className="primary">
                      <IpLink ip={row.ip} />
                    </td>
                    <td data-label="次數">{row.clicks}</td>
                    <td data-label="最後一次">
                      <time dateTime={row.last_at} title={`第一次：${formatTime(row.first_at)}`}>
                        {formatTime(row.last_at)}
                      </time>
                    </td>
                    <td data-label="裝置" title={row.user_agent}>
                      {describeAgent(row.user_agent)}
                    </td>
                    <td data-label="帳號">{row.users ? row.users.split(',').join('、') : '訪客'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="responsive">
              <thead>
                <tr>
                  <th>時間</th>
                  <th>IP</th>
                  <th>裝置</th>
                  <th>帳號</th>
                  <th>從哪裡來</th>
                </tr>
              </thead>
              <tbody>
                {stats.clicks.map((click) => (
                  <tr key={click.id}>
                    <td data-label="時間" className="primary">
                      <time dateTime={click.created_at}>{formatTime(click.created_at)}</time>
                    </td>
                    <td data-label="IP">
                      <IpLink ip={click.ip} />
                    </td>
                    <td data-label="裝置" title={click.user_agent}>
                      {describeAgent(click.user_agent)}
                    </td>
                    <td data-label="帳號">{click.username ?? '訪客'}</td>
                    <td data-label="從哪裡來">
                      <span className="links-referer">{click.referer || '直接開啟'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {view === 'clicks' && link.clicks > stats.clicks.length && (
          <p className="muted links-note">只列出最近 {stats.clicks.length} 次。</p>
        )}
      </section>

      <EditForm key={link.id} link={link} onSaved={(updated) => setStats((prev) => prev && { ...prev, link: updated })} />
    </div>
  )
}
