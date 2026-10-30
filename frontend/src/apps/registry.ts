import { PERMISSIONS } from '../api'
import { GAME_CATEGORIES, GAMES } from '../games/registry'

export type AppNavItem = { to: string; label: string; icon: string }
export type AppNavGroup = { label?: string; items: AppNavItem[] }

export type AppInfo = {
  /** 網址前綴：/<id>/... */
  id: string
  name: string
  icon: string
  /** 首頁卡片用的大字 */
  glyph: string
  blurb: string
  /** 首頁卡片上的標籤 */
  tag: string
  live?: boolean
  /** 沒有這個權限就不出現在切換面板與首頁 */
  permission?: string
  /** 側邊欄（手機是頂部選單）的內容 */
  nav: AppNavGroup[]
}

// 新的 APP 在這裡登記一筆，切換面板、側邊欄、首頁卡片都會自動出現
export const APPS: AppInfo[] = [
  {
    id: 'games',
    name: '小遊戲',
    icon: '🎮',
    glyph: '戲',
    blurb: `${GAMES.map((g) => g.name).join('、')}。棋類可以跟電腦下，也能開房間線上對戰。`,
    tag: `${GAMES.length} 款`,
    live: true,
    nav: [
      { items: [{ to: '/games', label: '大廳', icon: '▦' }] },
      ...GAME_CATEGORIES.map((category) => ({
        label: category,
        items: GAMES.filter((g) => g.category === category).map((g) => ({
          to: `/games/${g.id}`,
          label: g.name,
          icon: g.icon,
        })),
      })),
    ],
  },
  {
    id: 'calendar',
    name: '日曆',
    icon: '📅',
    glyph: '曆',
    blurb: '農曆、節氣、國定假日與補假一目了然。登入後可以記下自己的事項，跨多天、每週每月每年或農曆重複都行。',
    tag: '農曆 · 節氣',
    live: true,
    nav: [
      {
        items: [
          { to: '/calendar', label: '月曆', icon: '▦' },
          { to: '/calendar/holidays', label: '節日與節氣', icon: '🏮' },
          { to: '/calendar/events', label: '我的事項', icon: '📝' },
        ],
      },
    ],
  },
  {
    id: 'admin',
    name: '系統管理',
    icon: '🛠️',
    glyph: '管',
    blurb: '帳號、角色與權限。之後每個 APP 的權限都從這裡發。',
    tag: '僅管理員',
    permission: PERMISSIONS.adminUsers,
    nav: [
      {
        items: [
          { to: '/admin/users', label: '使用者', icon: '👤' },
          { to: '/admin/roles', label: '角色與權限', icon: '🔑' },
        ],
      },
    ],
  },
]

/** 這個使用者看得到的 APP；前端只是不顯示，真正的檢查在後端 */
export function visibleApps(can: (permission: string) => boolean): AppInfo[] {
  return APPS.filter((app) => !app.permission || can(app.permission))
}

export function appPath(app: AppInfo) {
  return `/${app.id}`
}

/** 目前網址屬於哪個 APP；首頁、登入、帳號頁不屬於任何 APP */
export function findAppByPath(pathname: string): AppInfo | undefined {
  return APPS.find((app) => pathname === appPath(app) || pathname.startsWith(`${appPath(app)}/`))
}

/** 目前網址對應到選單裡的哪一項 */
export function findNavItem(app: AppInfo, pathname: string): AppNavItem | undefined {
  return app.nav.flatMap((group) => group.items).find((item) => item.to === pathname)
}
