import { useState, type KeyboardEvent } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router'
import { useNavPins } from './navPins'
import './SideNav.css'

export type NavItem = { to: string; label: string; icon: string }
export type NavGroup = { label?: string; items: NavItem[] }

/** 頁面多到一眼看不完時才出現搜尋框和釘選 */
const SEARCH_FROM = 10

/** 圖示來自 Lucide（ISC）；顏色跟著文字走，亮色深色都不用另外設定 */
function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  )
}

type Props = {
  /** 給螢幕閱讀器的名稱 */
  label: string
  groups: NavGroup[]
  /** 釘選分開存的名稱（APP 的 id） */
  pinScope: string
  /** 收合成只剩圖示：不顯示搜尋框和釘選按鈕，釘選的頁面還是排在最上面 */
  collapsed?: boolean
}

/**
 * 頁面清單（APP 的側邊欄、手機的頁首選單共用）。頁面很多時上面有搜尋框，
 * 常用的可以釘選到最上面，釘選跟著帳號存在後端（見 navPins.tsx）。
 */
export default function SideNav({ label, groups, pinScope, collapsed = false }: Props) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const pins = useNavPins(pinScope)
  // 記住是在哪一頁搜尋的，點了結果換頁就清掉
  const [search, setSearch] = useState({ query: '', on: pathname })
  const query = search.on === pathname ? search.query : ''

  const all = groups.flatMap((group) => group.items)
  const enhanced = all.length >= SEARCH_FROM
  const keyword = query.trim().toLowerCase()

  let shown = groups
  if (keyword) {
    shown = groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          `${item.label} ${item.to} ${group.label ?? ''}`.toLowerCase().includes(keyword),
        ),
      }))
      .filter((group) => group.items.length > 0)
  } else if (enhanced) {
    // 釘選後又被拿掉的頁面就不顯示
    const pinned = pins.paths.flatMap((path) => all.find((item) => item.to === path) ?? [])
    if (pinned.length > 0) shown = [{ label: '釘選', items: pinned }, ...groups]
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const first = shown[0]?.items[0]
      if (first) navigate(first.to)
    } else if (e.key === 'Escape' && query) {
      // 先清搜尋字，再按一次才關掉手機選單
      e.stopPropagation()
      setSearch({ query: '', on: pathname })
    }
  }

  const canPin = enhanced && !collapsed

  return (
    <nav className="side-nav" aria-label={label}>
      {enhanced && !collapsed && (
        <input
          type="search"
          className="side-nav-search"
          value={query}
          onChange={(e) => setSearch({ query: e.target.value, on: pathname })}
          onKeyDown={onKeyDown}
          placeholder="搜尋…"
          aria-label={`搜尋${label}的頁面`}
        />
      )}
      {shown.map((group, i) => (
        <div key={group.label ?? i} className="side-nav-group">
          {group.label && <p className="side-nav-label">{group.label}</p>}
          <ul>
            {group.items.map((item) => {
              const pinned = pins.paths.includes(item.to)
              return (
                <li key={item.to} className={canPin ? 'pinnable' : undefined}>
                  <NavLink to={item.to} end className="side-nav-link" title={collapsed ? item.label : undefined}>
                    <span className="side-nav-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="side-nav-text">{item.label}</span>
                  </NavLink>
                  {canPin && (
                    <button
                      type="button"
                      className={`side-nav-pin ${pinned ? 'pinned' : ''}`}
                      onClick={() => pins.toggle(item.to)}
                      aria-pressed={pinned}
                      aria-label={`釘選${item.label}`}
                      title={pinned ? '取消釘選' : '釘選到最上面'}
                    >
                      <PinIcon filled={pinned} />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {keyword && shown.length === 0 && <p className="muted side-nav-empty">找不到符合的頁面。</p>}
      {canPin && pins.error && (
        <p className="side-nav-error" role="alert">
          {pins.error}
        </p>
      )}
    </nav>
  )
}
