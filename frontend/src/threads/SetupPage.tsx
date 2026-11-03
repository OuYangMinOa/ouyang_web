import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { PERMISSIONS, errorMessage } from '../api'
import { useAuth } from '../auth'
import { getSetup, resetKey, setShortcut, type Setup } from './api'
import './threads.css'

export default function SetupPage() {
  const { can } = useAuth()
  const [setup, setSetup] = useState<Setup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getSetup()
      .then(setSetup)
      .catch((e) => setError(errorMessage(e)))
  }, [])

  async function copy(key: string) {
    try {
      await navigator.clipboard.writeText(key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('複製你的下載金鑰：', key)
    }
  }

  async function reset() {
    if (!confirm('換一把新的金鑰？舊的金鑰會馬上失效，已經裝好的捷徑下次執行時要重新貼上。')) return
    setBusy(true)
    try {
      setSetup(await resetKey())
      setShown(true)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!setup) return error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>

  return (
    <div className="threads">
      <h1>Threads 影片下載</h1>
      <p className="muted">在 Threads 的貼文按「分享」，選這個捷徑，影片就會存進 iPhone 的相簿。</p>
      {error && <p className="error">{error}</p>}

      <section className="card stack">
        <h2>1. 安裝捷徑</h2>
        {setup.shortcut_url ? (
          <a className="threads-install" href={setup.shortcut_url} target="_blank" rel="noreferrer">
            📲 安裝「Threads 影片下載器」
          </a>
        ) : (
          <p className="muted">管理員還沒設定捷徑的連結。</p>
        )}
        <p className="muted">請用 iPhone 打開這個連結，在「捷徑」App 裡按「加入捷徑」。</p>
      </section>

      <section className="card stack">
        <h2>2. 複製你的下載金鑰</h2>
        <p className="muted">第一次用捷徑時，它會要你貼上這把金鑰，之後就不會再問。金鑰代表你的帳號，不要給別人。</p>
        <code className="threads-key">{shown ? setup.key : '•'.repeat(24)}</code>
        <div className="row">
          <button type="button" onClick={() => copy(setup.key)}>
            {copied ? '已複製 ✓' : '複製金鑰'}
          </button>
          <button type="button" className="secondary" onClick={() => setShown(!shown)}>
            {shown ? '隱藏' : '顯示'}
          </button>
          <button type="button" className="danger" disabled={busy} onClick={reset}>
            換一把新的
          </button>
        </div>
      </section>

      <section className="card stack">
        <h2>3. 開始下載</h2>
        <ol className="threads-steps">
          <li>在 Threads 打開有影片的貼文，按「分享」（紙飛機圖示）。</li>
          <li>在分享選單裡選「Threads 影片下載器」。第一次會要你貼上金鑰。</li>
          <li>看到「已存到相簿」的通知就完成了，下載過的貼文會記在「下載紀錄」。</li>
        </ol>
        <p className="muted">
          同一個網路 10 秒內只能下載一次。要登入 Threads 才看得到的影片（例如引用了限制瀏覽的貼文）抓不到。
        </p>
        <p className="muted">
          不是 iPhone、或不想裝捷徑？到 <Link to="/threads/paste">貼網址下載</Link> 直接貼上貼文的網址。
        </p>
      </section>

      {can(PERMISSIONS.adminUsers) && (
        <ShortcutLink current={setup.shortcut_url} onSaved={(url) => setSetup({ ...setup, shortcut_url: url })} />
      )}
    </div>
  )
}

/** 管理員設定大家共用的捷徑連結 */
function ShortcutLink({ current, onSaved }: { current: string | null; onSaved: (url: string | null) => void }) {
  const [url, setUrl] = useState(current ?? '')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await setShortcut(url.trim())
      onSaved(url.trim() || null)
      setMessage({ ok: true, text: '已儲存' })
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) })
    }
  }

  return (
    <section className="card stack">
      <h2>捷徑連結（管理員）</h2>
      <p className="muted">在 iPhone 的捷徑 App 分享捷徑、拷貝 iCloud 連結貼在這裡。留空是清掉。</p>
      <form className="inline-form" onSubmit={save}>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.icloud.com/shortcuts/…"
          aria-label="捷徑的 iCloud 連結"
        />
        <button type="submit">儲存</button>
      </form>
      {message && <p className={message.ok ? 'success' : 'error'}>{message.text}</p>}
    </section>
  )
}
