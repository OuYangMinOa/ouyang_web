import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { errorMessage } from '../api'
import { copyToClipboard } from '../clipboard'
import { createLink, listLinks, shortUrl, type ShortLink } from './api'
import './links.css'

function CopyLink({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await copyToClipboard(shortUrl(code))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button type="button" className="secondary" onClick={copy}>
      {copied ? '已複製' : '複製'}
    </button>
  )
}

export default function LinksPage() {
  const navigate = useNavigate()
  const [links, setLinks] = useState<ShortLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [requireLogin, setRequireLogin] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listLinks()
      .then(setLinks)
      .catch((e) => setError(errorMessage(e)))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const link = await createLink({ url, code: code.trim(), title, require_login: requireLogin })
      // 建好直接進詳細頁，馬上就能拿 QR Code 分享
      navigate(`/links/${link.id}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="links">
      <h1>短網址</h1>
      <p className="muted">
        把長網址變成 <code>{window.location.host}/s/xxxx</code>，可以產生 QR Code 分享，並看是哪些 IP 點過。
      </p>

      <form className="card stack" onSubmit={submit}>
        <label>
          網址
          <input
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            required
            autoFocus
          />
        </label>
        <div className="row">
          <label>
            名稱（只有你看得到）
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
          </label>
          <label>
            自訂代碼（留空就隨機 4 碼）
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={32}
              pattern="[A-Za-z0-9_\-]{2,32}"
              title="2～32 個英數字、- 或 _"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        </div>
        <label className="switch">
          <input type="checkbox" role="switch" checked={requireLogin} onChange={(e) => setRequireLogin(e.target.checked)} />
          要登入本站才能開啟
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? '建立中…' : '建立短網址'}
        </button>
      </form>

      <h2 className="links-heading">我的短網址</h2>
      {!links ? (
        !error && <p className="muted">載入中…</p>
      ) : links.length === 0 ? (
        <p className="muted">還沒有建立過短網址。</p>
      ) : (
        <div className="table-wrap">
          <table className="responsive">
            <thead>
              <tr>
                <th>短網址</th>
                <th>目的網址</th>
                <th>點擊</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td data-label="短網址" className="primary">
                    <Link className="text-link links-code" to={`/links/${link.id}`}>
                      /s/{link.code}
                    </Link>
                    {link.require_login && (
                      <span className="badge" title="要登入才能開啟">
                        🔒
                      </span>
                    )}
                  </td>
                  <td data-label="目的網址">
                    <span className="links-target">
                      {link.title && <strong>{link.title}</strong>}
                      <span className="muted">{link.url}</span>
                    </span>
                  </td>
                  <td data-label="點擊">
                    {link.clicks} 次 · {link.ips} 個 IP
                  </td>
                  <td className="actions">
                    <CopyLink code={link.code} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
