import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { PERMISSIONS } from '../api'
import { useAuth } from '../auth'
import { useMenu } from '../components/useMenu'
import { fetchUnread, onChanged, type Unread } from './api'
import { usePolling } from './util'
import './feedback.css'

function Count({ n, label }: { n: number; label: string }) {
  if (n <= 0) return null
  return (
    <span className="fb-count" aria-label={label}>
      {n > 99 ? '99+' : n}
    </span>
  )
}

/** 右上角的「回報 / 許願」：紅點是有新回覆的對話數；管理員多一個進管理頁的選項 */
export default function FeedbackButton() {
  const { user, can } = useAuth()
  const { pathname } = useLocation()
  const { ref: menuRef, ...menu } = useMenu()
  const [unread, setUnread] = useState<Unread>({ mine: 0 })
  const isAdmin = can(PERMISSIONS.adminUsers)

  const refresh = useCallback(() => {
    fetchUnread()
      .then(setUnread)
      .catch(() => {})
  }, [])
  // 換頁、登入登出時也重新看一次
  useEffect(() => {
    refresh()
  }, [refresh, pathname, user])
  useEffect(() => onChanged(refresh), [refresh])
  usePolling(refresh, 60_000)

  const admin = unread.admin ?? 0
  const label = (
    <>
      <span aria-hidden="true">💬</span>
      <span className="fb-button-label">回報 / 許願</span>
    </>
  )

  if (!isAdmin) {
    return (
      <Link to="/feedback" className="fb-button" title="回報問題或許願">
        {label}
        <Count n={unread.mine} label={`${unread.mine} 則新回覆`} />
      </Link>
    )
  }

  return (
    <div className="menu" ref={menuRef}>
      <button className="fb-button" title="回報問題或許願" {...menu.button}>
        {label}
        <Count n={unread.mine + admin} label={`${unread.mine + admin} 則新留言`} />
      </button>
      {menu.open && (
        <div id={menu.panelId} className="menu-panel end" onClick={menu.onPanelClick}>
          <Link to="/feedback" className="menu-item fb-menu-item">
            我的回報與許願
            <Count n={unread.mine} label={`${unread.mine} 則新回覆`} />
          </Link>
          <Link to="/admin/feedback" className="menu-item fb-menu-item">
            管理所有回報與許願
            <Count n={admin} label={`${admin} 串有新留言`} />
          </Link>
        </div>
      )}
    </div>
  )
}
