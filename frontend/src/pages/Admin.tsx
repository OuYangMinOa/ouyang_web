import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../api'
import { useAuth } from '../auth'

type AdminUser = {
  id: number
  username: string
  disabled: boolean
  created_at: string
  last_login_at: string | null
  roles: string[]
}

type Role = {
  id: number
  name: string
  description: string
  permissions: { name: string; description: string }[]
}

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—'
}

function RolePicker({
  roles,
  value,
  onChange,
}: {
  roles: Role[]
  value: string[]
  onChange: (value: string[]) => void
}) {
  return (
    <div className="checks">
      {roles.map((role) => (
        <label key={role.id}>
          <input
            type="checkbox"
            checked={value.includes(role.name)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, role.name] : value.filter((r) => r !== role.name))
            }
          />
          {role.description || role.name}
        </label>
      ))}
    </div>
  )
}

function CreateUser({ roles, onCreated }: { roles: Role[]; onCreated: (user: AdminUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      const user = await api<AdminUser>('/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, roles: selected }),
      })
      onCreated(user)
      setUsername('')
      setPassword('')
      setSelected([])
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h3>新增使用者</h3>
      <div className="row">
        <label>
          帳號
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
        </label>
        <label>
          初始密碼（至少 8 字）
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
      </div>
      <RolePicker roles={roles} value={selected} onChange={setSelected} />
      {error && <p className="error">{error}</p>}
      <button type="submit">新增</button>
    </form>
  )
}

function EditUser({
  user,
  roles,
  isSelf,
  onSave,
  onCancel,
}: {
  user: AdminUser
  roles: Role[]
  isSelf: boolean
  onSave: (patch: { roles: string[]; password?: string }) => Promise<boolean>
  onCancel: () => void
}) {
  const [selected, setSelected] = useState(user.roles)
  const [password, setPassword] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (await onSave({ roles: selected, ...(password ? { password } : {}) })) onCancel()
  }

  return (
    <form className="stack edit" onSubmit={submit}>
      <RolePicker roles={roles} value={selected} onChange={setSelected} />
      {isSelf && <p className="muted">不能移除自己的系統管理員角色；改自己的密碼請到「我的帳號」。</p>}
      {!isSelf && (
        <label>
          重設密碼（留空則不變，重設後該使用者會被登出）
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
          />
        </label>
      )}
      <div className="row">
        <button type="submit">儲存</button>
        <button type="button" className="secondary" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}

export default function Admin() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api<AdminUser[]>('/admin/users'), api<Role[]>('/admin/roles')])
      .then(([users, roles]) => {
        setUsers(users)
        setRoles(roles)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])

  async function update(id: number, patch: object): Promise<boolean> {
    try {
      const updated = await api<AdminUser>(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)))
      setError(null)
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    }
  }

  const roleLabel = (name: string) => roles.find((r) => r.name === name)?.description || name

  return (
    <>
      <h1>系統管理</h1>

      <section>
        <h2>使用者</h2>
        {error && <p className="error">{error}</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>帳號</th>
                <th>角色</th>
                <th>狀態</th>
                <th>最後登入</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const isSelf = user.id === me?.id
                return (
                  <tr key={user.id} className={user.disabled ? 'disabled' : undefined}>
                    <td>
                      {user.username}
                      {isSelf && <span className="chip subtle">你</span>}
                    </td>
                    <td>
                      {editing === user.id ? (
                        <EditUser
                          user={user}
                          roles={roles}
                          isSelf={isSelf}
                          onSave={(patch) => update(user.id, patch)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : user.roles.length ? (
                        user.roles.map((r) => (
                          <span key={r} className="chip">
                            {roleLabel(r)}
                          </span>
                        ))
                      ) : (
                        <span className="muted">無</span>
                      )}
                    </td>
                    <td>{user.disabled ? <span className="error">已停用</span> : '啟用中'}</td>
                    <td>
                      <time>{formatTime(user.last_login_at)}</time>
                    </td>
                    <td className="actions">
                      {editing !== user.id && (
                        <button type="button" className="secondary" onClick={() => setEditing(user.id)}>
                          編輯
                        </button>
                      )}
                      {!isSelf && (
                        <button
                          type="button"
                          className={user.disabled ? 'secondary' : 'danger'}
                          onClick={() => update(user.id, { disabled: !user.disabled })}
                        >
                          {user.disabled ? '啟用' : '停用'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <CreateUser roles={roles} onCreated={(user) => setUsers((prev) => [...prev, user])} />
      </section>

      <section>
        <h2>角色與權限</h2>
        <p className="muted">權限由程式定義，新的 APP 上線時會在資料庫 migration 裡加入自己的權限並指派給角色。</p>
        <div className="roles">
          {roles.map((role) => (
            <div key={role.id} className="card">
              <h3>
                {role.description || role.name} <code>{role.name}</code>
              </h3>
              <ul>
                {role.permissions.map((p) => (
                  <li key={p.name}>
                    <code>{p.name}</code> {p.description}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
