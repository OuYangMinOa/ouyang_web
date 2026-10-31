import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api'
import type { Role } from './types'

export default function AdminRoles() {
  const [roles, setRoles] = useState<Role[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<Role[]>('/admin/roles')
      .then(setRoles)
      .catch((e) => setError(errorMessage(e)))
  }, [])

  return (
    <>
      <h1>角色與權限</h1>
      <p className="muted">權限由程式定義，新的 APP 上線時會在資料庫 migration 裡加入自己的權限並指派給角色。</p>
      {error && <p className="error">{error}</p>}
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
    </>
  )
}
