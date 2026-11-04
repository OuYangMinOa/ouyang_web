import { useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import SideNav from '../components/SideNav'
import { useMenu } from '../components/useMenu'
import { appPath, findAppByPath, findNavItem, type AppInfo } from './registry'
import './apps.css'

const COLLAPSED_KEY = 'sidebar-collapsed'

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function saveCollapsed(collapsed: boolean) {
  try {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, '1')
    else localStorage.removeItem(COLLAPSED_KEY)
  } catch {
    // 存不了就只在這次有效
  }
}

/** APP 自己的頁面清單：桌機放在側邊欄，手機放在頁首的下拉選單 */
function AppNav({ app, collapsed }: { app: AppInfo; collapsed?: boolean }) {
  return <SideNav label={app.name} groups={app.nav} pinScope={app.id} collapsed={collapsed} />
}

/** 手機版：頁首上的「小遊戲 › 五子棋 ▾」，點開是這個 APP 的頁面清單 */
export function AppMenu({ app }: { app: AppInfo }) {
  const { ref: menuRef, ...menu } = useMenu()
  const { pathname } = useLocation()
  const page = findNavItem(app, pathname)

  return (
    <div className="menu app-menu" ref={menuRef}>
      <button className="menu-button crumb" {...menu.button}>
        <span className="crumb-app">{app.name}</span>
        {page && (
          <>
            <span className="crumb-sep" aria-hidden="true">
              ›
            </span>
            <span className="crumb-page">{page.label}</span>
          </>
        )}
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {menu.open && (
        <div id={menu.panelId} className="menu-panel" onClick={menu.onPanelClick}>
          <AppNav app={app} />
        </div>
      )}
    </div>
  )
}

/**
 * APP 的共用版面：側邊欄固定在畫面最左邊（可收合成只剩圖示），右邊是各頁內容，
 * 內容區在剩下的寬度裡置中，寬螢幕的空間都留給內容（小遊戲的盤面、大逃殺的小盤面）。
 */
export default function AppLayout() {
  const { pathname } = useLocation()
  const app = findAppByPath(pathname)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  if (!app) return <Outlet />

  function toggle() {
    setCollapsed(!collapsed)
    saveCollapsed(!collapsed)
  }

  return (
    <div className={['app-layout', collapsed && 'collapsed', app.wide && 'wide'].filter(Boolean).join(' ')}>
      <aside className="app-sidebar">
        <div className="app-sidebar-head">
          <Link to={appPath(app)} className="app-sidebar-title" title={collapsed ? app.name : undefined}>
            <span className="side-nav-icon" aria-hidden="true">
              {app.icon}
            </span>
            <span className="side-nav-text">{app.name}</span>
          </Link>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展開側邊欄' : '收合側邊欄'}
            title={collapsed ? '展開側邊欄' : '收合側邊欄'}
          >
            {collapsed ? '»' : '«'}
          </button>
        </div>
        <AppNav app={app} collapsed={collapsed} />
      </aside>
      <div className="app-content">
        <Outlet />
      </div>
    </div>
  )
}
