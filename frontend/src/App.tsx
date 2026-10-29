import { useEffect, useState } from 'react'
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate } from 'react-router'
import { api, PERMISSIONS } from './api'
import { AuthProvider, RequireAuth, useAuth } from './auth'
import Account from './pages/Account'
import Admin from './pages/Admin'
import Home from './pages/Home'
import Login from './pages/Login'
import { getThemePreference, setThemePreference, type ThemePreference } from './theme'
import './App.css'

type Health = { status: string; env: string; version: string; db: boolean }

const THEMES: { value: ThemePreference; icon: string; label: string }[] = [
  { value: 'system', icon: '◐', label: '跟隨系統' },
  { value: 'light', icon: '☀', label: '亮色' },
  { value: 'dark', icon: '☾', label: '深色' },
]

/** 依序切換：跟隨系統 → 亮色 → 深色 */
function ThemeToggle() {
  const [preference, setPreference] = useState(getThemePreference)
  const current = THEMES.find((t) => t.value === preference) ?? THEMES[0]

  function cycle() {
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length].value
    setThemePreference(next)
    setPreference(next)
  }

  return (
    <button type="button" className="theme-toggle" onClick={cycle} title={`主題：${current.label}（點擊切換）`}>
      <span aria-hidden="true">{current.icon}</span> {current.label}
    </button>
  )
}

function Header() {
  const { user, can, logout } = useAuth()
  const navigate = useNavigate()
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    api<Health>('/health').then(setHealth).catch(() => setHealth(null))
  }, [])

  async function signOut() {
    await logout()
    navigate('/')
  }

  return (
    <header className="site-header">
      <Link to="/" className="brand">
        ouyang_web
      </Link>
      {health && (
        <span className={`badge ${health.status === 'ok' ? 'ok' : 'bad'}`}>
          {health.env} · v{health.version}
        </span>
      )}
      <ThemeToggle />
      <nav>
        <NavLink to="/" end>
          首頁
        </NavLink>
        {can(PERMISSIONS.adminUsers) && <NavLink to="/admin">系統管理</NavLink>}
        {user ? (
          <>
            <NavLink to="/account">{user.username}</NavLink>
            <button type="button" className="link" onClick={signOut}>
              登出
            </button>
          </>
        ) : (
          <NavLink to="/login">登入</NavLink>
        )}
      </nav>
    </header>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Header />
        <main>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route
              path="/account"
              element={
                <RequireAuth>
                  <Account />
                </RequireAuth>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireAuth permission={PERMISSIONS.adminUsers}>
                  <Admin />
                </RequireAuth>
              }
            />
            <Route path="*" element={<p className="muted">找不到這個頁面。</p>} />
          </Routes>
        </main>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
