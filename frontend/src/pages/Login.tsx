import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import { errorMessage, PERMISSIONS, registrationOpen } from '../api'
import { useAuth } from '../auth'

export default function Login() {
  const { user, login, can } = useAuth()
  const from = (useLocation().state as { from?: string } | null)?.from
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
