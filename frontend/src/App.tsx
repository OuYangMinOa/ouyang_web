import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react'
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router'
import { api, PERMISSIONS, type User } from './api'
import AppLauncher from './apps/AppLauncher'
import AppLayout, { AppMenu } from './apps/AppLayout'
import { findAppByPath } from './apps/registry'
import { AuthProvider, RequireAuth, useAuth } from './auth'
import CalendarPage from './calendar/CalendarPage'
import HolidaysPage from './calendar/HolidaysPage'
import MyEventsPage from './calendar/MyEventsPage'
import { useMenu } from './components/useMenu'
import GamePage from './games/GamePage'
import GamesHub from './games/GamesHub'
import LolApp from './lol/LolApp'
import MatchPage from './lol/MatchPage'
import Overview from './lol/Overview'
import Schedule from './lol/Schedule'
import Standings from './lol/Standings'
import MusicApp from './music/MusicApp'
import MusicLibrary from './music/MusicLibrary'
import Account from './pages/Account'
import AdminAccess from './pages/admin/Access'
import AdminRegistrations from './pages/admin/Registrations'
import AdminRoles from './pages/admin/Roles'
import AdminUsers from './pages/admin/Users'
import AdminVisits from './pages/admin/Visits'
import Home from './pages/Home'
import Login from './pages/Login'
import Register from './pages/Register'
import ToolPage from './tools/ToolPage'
import ToolsHub from './tools/ToolsHub'
import { getThemePreference, setThemePreference, type ThemePreference } from './theme'
import './App.css'

// 天氣與環境的頁面帶著 Leaflet 地圖，進到那一頁才下載
const WeatherHub = lazy(() => import('./weather/WeatherHub'))
const TyphoonPage = lazy(() => import('./weather/TyphoonPage'))
const ForecastPage = lazy(() => import('./weather/ForecastPage'))
const QuakePage = lazy(() => import('./weather/QuakePage'))
// 隱藏頁面：不在任何選單裡，只有知道網址的人進得來；條碼函式庫也只在這頁下載
const DataMatrixPage = lazy(() => import('./datamatrix/DataMatrixPage'))

function Lazy({ page: Page }: { page: ComponentType }) {
  return (
    <Suspense fallback={<p className="muted">載入中…</p>}>
      <Page />
    </Suspense>
  )
}

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
      <span aria-hidden="true">{current.icon}</span> <span className="theme-label">{current.label}</span>
    </button>
  )
}

/** 右上角的帳號選單：版本、我的帳號、登出 */
function UserMenu({ user }: { user: User }) {
  const { logout } = useAuth()
  const navigate = useNavigate()
  const { ref: menuRef, ...menu } = useMenu()
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    api<Health>('/health').then(setHealth).catch(() => setHealth(null))
  }, [])

  async function signOut() {
    menu.close()
    await logout()
    navigate('/')
  }

  return (
    <div className="menu" ref={menuRef}>
      <button className="menu-button user-button" {...menu.button}>
        <span className="avatar" aria-hidden="true">
          {user.username.slice(0, 1).toUpperCase()}
        </span>
        <span className="user-name">{user.username}</span>
      </button>
      {menu.open && (
        <div id={menu.panelId} className="menu-panel end user-panel" onClick={menu.onPanelClick}>
          <div className="user-panel-head">
            <strong>{user.username}</strong>
            {health && (
              <span className={`badge ${health.status === 'ok' ? 'ok' : 'bad'}`}>
                {health.env} · v{health.version}
              </span>
            )}
          </div>
          <Link to="/account" className="menu-item">
            我的帳號
          </Link>
          <button type="button" className="menu-item" onClick={signOut}>
            登出
          </button>
        </div>
      )}
    </div>
  )
}

function Header() {
  const { user, can } = useAuth()
  const { pathname } = useLocation()
  const found = findAppByPath(pathname)
  // 沒有權限的 APP 不顯示它的選單，頁面本身會由 RequireAuth 擋下
  const app = found && (!found.permission || can(found.permission)) ? found : undefined

  return (
    <header className={`site-header ${app ? 'in-app' : ''}`}>
      <Link to="/" className="brand">
        歐陽天地
      </Link>
      <AppLauncher current={app} />
      {app && <AppMenu app={app} />}
      <div className="header-end">
        <ThemeToggle />
        {user ? (
          <UserMenu user={user} />
        ) : (
          <NavLink to="/login" className="header-link">
            登入
          </NavLink>
        )}
      </div>
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
            <Route path="/games" element={<AppLayout />}>
              <Route index element={<GamesHub />} />
              <Route path=":id" element={<GamePage />} />
            </Route>
            <Route path="/calendar" element={<AppLayout />}>
              <Route index element={<CalendarPage />} />
              <Route path="holidays" element={<HolidaysPage />} />
              <Route
                path="events"
                element={
                  <RequireAuth>
                    <MyEventsPage />
                  </RequireAuth>
                }
              />
            </Route>
            <Route path="/tools" element={<AppLayout />}>
              <Route index element={<ToolsHub />} />
              <Route path=":id" element={<ToolPage />} />
            </Route>
            <Route path="/music" element={<AppLayout />}>
              {/* 播放器放在外層，切換頁面時音樂不會停 */}
              <Route element={<MusicApp />}>
                <Route index element={<MusicLibrary />} />
                <Route path="favorites" element={<MusicLibrary favoritesOnly />} />
              </Route>
            </Route>
            <Route path="/weather" element={<AppLayout />}>
              <Route index element={<Lazy page={WeatherHub} />} />
              <Route path="typhoon" element={<Lazy page={TyphoonPage} />} />
              <Route path="forecast" element={<Lazy page={ForecastPage} />} />
              <Route path="quake" element={<Lazy page={QuakePage} />} />
            </Route>
            <Route path="/lol" element={<AppLayout />}>
              {/* 賽程和直播狀態在外層抓一次，切換頁面不用重抓 */}
              <Route element={<LolApp />}>
                <Route index element={<Overview />} />
                <Route path="schedule" element={<Schedule />} />
                <Route path="standings" element={<Standings />} />
                <Route path="match/:id" element={<MatchPage />} />
              </Route>
            </Route>
            <Route path="/bcs" element={<Lazy page={DataMatrixPage} />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
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
                  <AppLayout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="users" replace />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="roles" element={<AdminRoles />} />
              <Route path="registrations" element={<AdminRegistrations />} />
              <Route path="access" element={<AdminAccess />} />
              <Route path="visits" element={<AdminVisits />} />
            </Route>
            <Route path="*" element={<p className="muted">找不到這個頁面。</p>} />
          </Routes>
        </main>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
