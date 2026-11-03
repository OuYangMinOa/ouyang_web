import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router'
import { errorMessage, PERMISSIONS, registrationOpen } from '../api'
import { useAuth } from '../auth'

export default function Login() {
  const { user, login, can } = useAuth()
  const from = (useLocation().state as { from?: string } | null)?.from
  // 後端導過來的（例如要登入才能開的短網址 /s/<code>）：只接受站內路徑，登入後整頁重新載入，讓後端處理
  const next = useSearchParams()[0].get('next')
  const nextPath = next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : null
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 管理員開放註冊時才顯示註冊按鈕
  const [canRegister, setCanRegister] = useState(false)

  useEffect(() => {
    registrationOpen()
      .then(setCanRegister)
      .catch(() => setCanRegister(false))
  }, [])

  useEffect(() => {
    if (user && nextPath) window.location.replace(nextPath)
  }, [user, nextPath])

  if (user && nextPath) return <p className="muted">前往中…</p>
  // 登入成功後 user 會更新、重新 render 到這裡：回到原本要去的頁面，否則管理員進系統管理、其他人回首頁
  if (user) return <Navigate to={from ?? (can(PERMISSIONS.adminUsers) ? '/admin' : '/')} replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await login(username, password)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <form className="card narrow stack" onSubmit={submit}>
      <h1>登入</h1>
      {nextPath?.startsWith('/s/') && <p className="muted">這個短網址要登入才能開啟，登入後會自動前往。</p>}
      <label>
        帳號
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </label>
      <label>
        密碼
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? '登入中…' : '登入'}
      </button>
      {canRegister && (
        <p className="muted">
          還沒有帳號？<Link to="/register" className="text-link">註冊</Link>
        </p>
      )}
    </form>
  )
}
