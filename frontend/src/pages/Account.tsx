import { useState, type FormEvent } from 'react'
import { api, errorMessage } from '../api'
import { useAuth } from '../auth'

export default function Account() {
  const { user } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next !== confirm) {
      setStatus({ ok: false, text: '兩次輸入的新密碼不一樣' })
      return
    }
    try {
      await api('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: next }),
      })
      setCurrent('')
      setNext('')
      setConfirm('')
      setStatus({ ok: true, text: '密碼已更新，其他裝置上的登入已登出' })
    } catch (e) {
      setStatus({ ok: false, text: errorMessage(e) })
    }
  }

  return (
    <>
      <h1>我的帳號</h1>
      <p className="muted">
        {user?.username} · 角色：{user?.roles.length ? user.roles.join('、') : '無'}
      </p>

      <form className="card narrow stack" onSubmit={submit}>
        <h2>修改密碼</h2>
        <label>
          目前的密碼
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          新密碼（至少 8 字）
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
        </label>
        <label>
          再輸入一次新密碼
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        {status && <p className={status.ok ? 'success' : 'error'}>{status.text}</p>}
        <button type="submit">更新密碼</button>
      </form>
    </>
  )
}
