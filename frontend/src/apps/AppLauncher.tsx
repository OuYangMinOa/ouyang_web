import { useState, type MouseEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '../auth'
import { useMenu } from '../components/useMenu'
import { appPath, visibleApps, type AppInfo } from './registry'

/** APP 多到一眼看不完時才出現搜尋框 */
const SEARCH_FROM = 10

/** 拆成獨立元件：每次打開都是新的，搜尋字會清掉 */
function LauncherPanel({ id, current, onClick }: { id: string; current?: AppInfo; onClick: (e: MouseEvent) => void }) {
  const { can } = useAuth()
  const { pathname } = useLocation()
  const [query, setQuery] = useState('')
  const apps = visibleApps(can)
  const keyword = query.trim().toLowerCase()
  const shown = keyword ? apps.filter((app) => `${app.name} ${app.blurb}`.toLowerCase().includes(keyword)) : apps

  return (
    <div id={id} className="menu-panel launcher-panel" onClick={onClick}>
      {apps.length >= SEARCH_FROM && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋 APP…"
          aria-label="搜尋 APP"
          autoFocus
        />
      )}
      <ul className="app-grid">
        {!keyword && (
          <li>
            <Link to="/" className={`app-tile ${pathname === '/' ? 'active' : ''}`}>
              <span className="app-tile-icon" aria-hidden="true">
                🏠
              </span>
              首頁
            </Link>
          </li>
        )}
        {shown.map((app) => (
          <li key={app.id}>
            <Link
              to={appPath(app)}
              className={`app-tile ${app === current ? 'active' : ''}`}
              aria-current={app === current ? 'true' : undefined}
            >
              <span className="app-tile-icon" aria-hidden="true">
                {app.icon}
              </span>
              {app.name}
            </Link>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="muted launcher-empty">找不到符合的 APP。</p>}
    </div>
  )
}

/** 頁首的「⊞ 應用程式」：列出這個使用者能用的所有 APP */
export default function AppLauncher({ current }: { current?: AppInfo }) {
  const { ref: menuRef, ...menu } = useMenu()

  return (
    <div className="menu launcher" ref={menuRef}>
      <button className="menu-button" {...menu.button} title="切換 APP">
        <span aria-hidden="true">⊞</span>
        <span className="launcher-label">應用程式</span>
      </button>
      {menu.open && <LauncherPanel id={menu.panelId} current={current} onClick={menu.onPanelClick} />}
    </div>
  )
}
