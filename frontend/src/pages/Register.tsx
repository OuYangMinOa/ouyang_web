import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router'
import { api, errorMessage, registrationOpen } from '../api'
import { useAuth } from '../auth'

const MAX_NOTE_LEN = 200

export default function Register() {
  const { user } = useAuth()
  const [open, setOpen] = useState<boolean | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    registrationOpen()
      .then(setOpen)
      .catch(() => setOpen(false))
  }, [])

  if (user) return <Navigate to="/" replace />
  if (open === null) return <p className="muted">載入中…</p>

  if (sent) {
    return (
      <div className="card narrow stack">
        <h1>已送出申請</h1>
        <p>管理員核准後，就可以用帳號 <strong>{username}</strong> 和剛剛設定的密碼登入。</p>
        <Link to="/login" className="text-link">回登入頁</Link>
      </div>
    )
  }

  if (!open) {
    return (
      <div className="card narrow stack">
        <h1>註冊</h1>
        <p className="muted">目前不開放註冊。需要帳號請直接聯絡管理員。</p>
        <Link to="/login" className="text-link">回登入頁</Link>
      </div>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password !== repeat) {
      setError('兩次輸入的密碼不一樣')
      return
    }
    setBusy(true)
    try {
      await api('/auth/register', { method: 'POST', body: JSON.stringify({ username, password, note }) })
      setSent(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card narrow stack" onSubmit={submit}>
      <h1>註冊</h1>
      <p className="muted">送出後由管理員審核，核准了才能登入。</p>
      <label>
        帳號（3–32 個英數字或 _ . -）
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          pattern="[A-Za-z0-9_.\-]{3,32}"
          autoFocus
          required
        />
      </label>
      <label>
        密碼（至少 8 字）
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
        />
      </label>
      <label>
        再輸入一次密碼
        <input
          type="password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
        />
      </label>
      <label>
        想對管理員說的話（選填，例如你是誰）
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={MAX_NOTE_LEN} rows={3} />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? '送出中…' : '送出申請'}
      </button>
      <p className="muted">
        已經有帳號？<Link to="/login" className="text-link">登入</Link>
      </p>
    </form>
  )
}
