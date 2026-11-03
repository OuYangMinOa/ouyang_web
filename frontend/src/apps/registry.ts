import { PERMISSIONS } from '../api'
import type { NavGroup, NavItem } from '../components/SideNav'
import { GAME_CATEGORIES, GAMES } from '../games/registry'
import { TOOL_CATEGORIES, TOOLS } from '../tools/registry'

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
  /** 只有登入的人看得到（不需要特別的權限） */
  loginOnly?: boolean
  /** 側邊欄（手機是頂部選單）的內容 */
  nav: NavGroup[]
}

// 新的 APP 在這裡登記一筆，切換面板、側邊欄、首頁卡片都會自動出現
export const APPS: AppInfo[] = [
  {
    id: 'games',
    name: '小遊戲',
    icon: '🎮',
    glyph: '戲',
    blurb: `${GAMES.map((g) => g.name).join('、')}。雙人遊戲可以跟電腦下或開房間線上對戰，派對遊戲開個房間就能和朋友一起玩。`,
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
    id: 'tools',
    name: '小工具',
    icon: '🧰',
    glyph: '具',
    blurb: `${TOOLS.map((t) => t.name).join('、')}。全部在瀏覽器裡執行。`,
    tag: `${TOOLS.length} 個`,
    live: true,
    nav: [
      { items: [{ to: '/tools', label: '全部工具', icon: '▦' }] },
      ...TOOL_CATEGORIES.map((category) => ({
        label: category,
        items: TOOLS.filter((t) => t.category === category).map((t) => ({
          to: `/tools/${t.id}`,
          label: t.name,
          icon: t.icon,
        })),
      })),
    ],
  },
  {
    id: 'music',
    name: '音樂',
    icon: '🎵',
    glyph: '樂',
    blurb: 'Discord 機器人 Xiao-Xia 收的音樂和音效，線上直接播。可以搜尋、隨機播放、循環，喜歡的加進收藏。',
    tag: '播放器',
    live: true,
    nav: [
      {
        items: [
          { to: '/music', label: '全部音樂', icon: '♫' },
          { to: '/music/favorites', label: '我的收藏', icon: '★' },
        ],
      },
    ],
  },
  {
    id: 'weather',
    name: '天氣與環境',
    icon: '🌦️',
    glyph: '氣',
    blurb: '颱風路徑（各國官方與 AI 預報）、全台縣市天氣與空氣品質，還有台灣、日本、中國的即時地震速報。',
    tag: '颱風 · 地震',
    live: true,
    nav: [
      {
        items: [
          { to: '/weather', label: '總覽', icon: '▦' },
          { to: '/weather/typhoon', label: '颱風', icon: '🌀' },
          { to: '/weather/typhoon/names', label: '颱風名稱表', icon: '📋' },
          { to: '/weather/forecast', label: '全台天氣', icon: '⛅' },
          { to: '/weather/quake', label: '地震', icon: '📈' },
        ],
      },
    ],
  },
  {
    id: 'lol',
    name: 'LoL 世界賽',
    icon: '🏆',
    glyph: '賽',
    blurb: '英雄聯盟世界大賽的賽程、瑞士輪戰績和淘汰賽對戰表。比賽進行中可以直接看直播和即時數據，打完的每一局都有重播。',
    tag: '直播 · 賽程',
    live: true,
    nav: [
      {
        items: [
          { to: '/lol', label: '賽況', icon: '●' },
          { to: '/lol/schedule', label: '賽程', icon: '▦' },
          { to: '/lol/standings', label: '戰績', icon: '🏆' },
        ],
      },
    ],
  },
  {
    id: 'threads',
    name: 'Threads 下載',
    icon: '🧵',
    glyph: '串',
    blurb: '在 Threads 按分享就能把影片存進 iPhone 相簿，也可以直接在網頁貼網址下載。這裡拿你的下載金鑰、安裝捷徑，還有下載過的貼文紀錄。',
    tag: 'iPhone 捷徑',
    live: true,
    loginOnly: true,
    nav: [
      {
        items: [
          { to: '/threads', label: '安裝捷徑', icon: '📲' },
          { to: '/threads/paste', label: '貼網址下載', icon: '🔗' },
          { to: '/threads/downloads', label: '下載紀錄', icon: '🕘' },
        ],
      },
    ],
  },
  {
    id: 'admin',
    name: '系統管理',
    icon: '🛠️',
    glyph: '管',
    blurb: '帳號、角色與權限、註冊審核、回覆大家的回報與許願，全站的 IP 訪問紀錄、隱藏頁面的訪客、誰來偷拿假的 .env、現在誰在玩哪個遊戲，以及主機和上面各個 bot 的 CPU、記憶體與磁碟。之後每個 APP 的權限都從這裡發。',
    tag: '僅管理員',
    permission: PERMISSIONS.adminUsers,
    nav: [
      {
        items: [
          { to: '/admin/users', label: '使用者', icon: '👤' },
          { to: '/admin/roles', label: '角色與權限', icon: '🔑' },
          { to: '/admin/registrations', label: '註冊審核', icon: '📝' },
          { to: '/admin/feedback', label: '回報與許願', icon: '💬' },
          { to: '/admin/access', label: 'IP 訪問紀錄', icon: '🌐' },
          { to: '/admin/visits', label: '頁面訪客', icon: '👁️' },
          { to: '/admin/honeypot', label: '.env 蜜罐', icon: '🍯' },
          { to: '/admin/games', label: '遊戲狀態', icon: '🎮' },
          { to: '/admin/system', label: '主機監控', icon: '📊' },
        ],
      },
    ],
  },
]

type Viewer = { user: unknown; can: (permission: string) => boolean }

/** 這個使用者看不看得到這個 APP；前端只是不顯示，真正的檢查在後端 */
export function canSeeApp(app: AppInfo, { user, can }: Viewer): boolean {
  return (!app.loginOnly || !!user) && (!app.permission || can(app.permission))
}

export function visibleApps(viewer: Viewer): AppInfo[] {
  return APPS.filter((app) => canSeeApp(app, viewer))
}

export function appPath(app: AppInfo) {
  return `/${app.id}`
}

/** 目前網址屬於哪個 APP；首頁、登入、帳號頁不屬於任何 APP */
export function findAppByPath(pathname: string): AppInfo | undefined {
  return APPS.find((app) => pathname === appPath(app) || pathname.startsWith(`${appPath(app)}/`))
}

/** 目前網址對應到選單裡的哪一項 */
export function findNavItem(app: AppInfo, pathname: string): NavItem | undefined {
  return app.nav.flatMap((group) => group.items).find((item) => item.to === pathname)
}
