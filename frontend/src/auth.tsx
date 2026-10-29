import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { api, type User } from './api'

type Auth = {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<User>
  logout: () => Promise<void>
  can: (permission: string) => boolean
}

const AuthContext = createContext<Auth | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<User>('/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const auth: Auth = {
    user,
    loading,
    async login(username, password) {
      const me = await api<User>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      setUser(me)
      return me
    },
    async logout() {
      await api('/auth/logout', { method: 'POST' })
      setUser(null)
    },
    can: (permission) => user?.permissions.includes(permission) ?? false,
  }

  return <AuthContext value={auth}>{children}</AuthContext>
}

// oxlint-disable-next-line react/only-export-components
export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>')
  return auth
}

/** 沒登入導去登入頁（登入後回到原頁），登入了但沒有權限就顯示提示 */
export function RequireAuth({ permission, children }: { permission?: string; children: ReactNode }) {
  const { user, loading, can } = useAuth()
  const location = useLocation()

  if (loading) return <p className="muted">載入中…</p>
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  if (permission && !can(permission)) return <p className="error">你沒有權限查看這個頁面。</p>
  return children
}
