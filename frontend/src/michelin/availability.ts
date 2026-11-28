// 米其林星級餐廳的空位（後端 backend/src/michelin_availability.rs）。
// 家裡電腦上的爬蟲每 3 小時看一次訂位系統的公開頁面，跑完上傳；這裡把一次查詢的結果整理成每家一列。
// 時段都是台灣時間，已經過去的（資料最多晚 3 小時）在這裡濾掉。

import { RESTAURANTS, awardRank, type Restaurant } from './data'

export type DayResult = {
  /** open、book：可訂；full：額滿；closed：公休；booking-off：沒開放線上訂位；
   * selectable：TableCheck 列出可選的時間；date_unselectable：訂位頁跳過這天 */
  status: string
  /** 這個人數可訂的時間 HH:MM */
  times: string[]
  /** 其中跟前一次查詢比起來新出現的 */
  new: string[]
}

export type PartyResult = {
  /** inline、tablecheck、sevenrooms、mirror、manual */
  source: string
  /** 讀到這家的時間（UTC）；沒讀到是 null */
  checked_at: string | null
  note: string
  /** 日期 → 那天的狀態；沒查到的日期不會出現 */
  days: Record<string, DayResult>
}

export type Place = {
  /** 地圖上那家的 id；對不到是 null */
  id: string | null
  name: string
  url: string
  phone: string
  /** 人數 → 結果 */
  parties: Record<string, PartyResult>
}

export type Availability = {
  checked_at: string
  uploaded_at: string
  /** 查了哪幾天（台灣日期） */
  days: string[]
  parties: number[]
  restaurants: Place[]
}

const SOURCES: Record<string, string> = {
  inline: 'inline',
  tablecheck: 'TableCheck',
  sevenrooms: 'SevenRooms',
  mirror: 'Noline 備援日曆',
  manual: '要問店家',
}

export function sourceLabel(source: string) {
  return SOURCES[source] ?? source
}

const STATUSES: Record<string, string> = {
  full: '額滿',
  closed: '公休',
  'booking-off': '沒開放線上訂位',
  date_unselectable: '訂位頁不能選這天',
  selectable: '沒有可選的時間',
}

/** 那天沒有時段時寫什麼 */
export function statusLabel(day: DayResult | undefined) {
  if (!day) return '沒有資料'
  return STATUSES[day.status] ?? '沒有這個人數的時段'
}

/** 台灣的時間，寫成 YYYY-MM-DD HH:MM，跟「日期 時段」直接比字串 */
export function taipeiTime(at = Date.now()) {
  return new Date(at).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false }).slice(0, 16)
}

/** 查詢範圍裡還沒過去的日期（今天以後） */
export function upcomingDays(data: Availability, now = taipeiTime()) {
  const today = now.slice(0, 10)
  return data.days.filter((d) => d >= today)
}

const WEEK = '日一二三四五六'

/** 2026-12-03 → 12/3（四） */
export function dayLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  return `${m}/${d}（${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`
}

export function isWeekend(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return day === 0 || day === 6
}

/** 只看這段時間的時段：from ≤ 時段 ≤ to（HH:MM，兩頭都算） */
export type TimeRange = { from: string; to: string }

export type TimeFilter = 'all' | 'lunch' | 'dinner' | 'custom'

export const TIME_FILTERS: { value: TimeFilter; label: string }[] = [
  { value: 'all', label: '全部時段' },
  { value: 'lunch', label: '午餐（10–16 點）' },
  { value: 'dinner', label: '晚餐（16 點以後）' },
  { value: 'custom', label: '自訂時間' },
]

// 午餐和晚餐從 16:00 切開，中間不漏掉時段（實際上 15、16 點沒有店開放訂位）。
// 10 點前只有一家的早餐，只在「全部時段」和自訂裡看得到。
const LUNCH: TimeRange = { from: '10:00', to: '15:59' }
const DINNER: TimeRange = { from: '16:00', to: '23:59' }

/** 自訂時間能選的鐘點：06:00 到 23:30，每半小時一個 */
export const CLOCKS = Array.from({ length: 36 }, (_, i) => {
  const minutes = 6 * 60 + i * 30
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 === 0 ? '00' : '30'}`
})

export const DEFAULT_CUSTOM: TimeRange = { from: '18:00', to: '20:00' }

export function isTimeFilter(value: unknown): value is TimeFilter {
  return TIME_FILTERS.some((f) => f.value === value)
}

/** localStorage 讀回來的自訂時間：兩頭都要是選單上的鐘點，而且不能顛倒 */
export function isTimeRange(value: unknown): value is TimeRange {
  if (typeof value !== 'object' || value === null) return false
  const { from, to } = value as Record<string, unknown>
  return typeof from === 'string' && typeof to === 'string' && CLOCKS.includes(from) && CLOCKS.includes(to) && from <= to
}

/** 選的篩選 → 要留下的時段範圍；全部時段是 null */
export function timeRange(filter: TimeFilter, custom: TimeRange): TimeRange | null {
  if (filter === 'lunch') return LUNCH
  if (filter === 'dinner') return DINNER
  if (filter === 'custom') return custom
  return null
}

/** 句子裡怎麼稱呼選的時段：「晚餐」「18:00–20:00」；全部時段是空字串 */
export function timeName(filter: TimeFilter, custom: TimeRange) {
  if (filter === 'lunch') return '午餐'
  if (filter === 'dinner') return '晚餐'
  if (filter === 'custom') return `${custom.from}–${custom.to}`
  return ''
}

export type DayCell = {
  date: string
  day: DayResult | undefined
  /** 還沒過去、在選的時段裡的時段 */
  times: string[]
  /** 還沒過去、但不在選的時段裡的有幾個 */
  outside: number
  fresh: Set<string>
}

export type Row = {
  place: Place
  /** 地圖上的那家（星等、地區、料理） */
  restaurant: Restaurant | undefined
  result: PartyResult | undefined
  cells: DayCell[]
  slots: number
  /** 被時段篩掉的有幾個（還沒過去的） */
  outside: number
  fresh: number
  /** 最早的時段 */
  first: { date: string; time: string } | null
  /** 有讀到任何一天的資料 */
  hasData: boolean
}

const byId = new Map(RESTAURANTS.map((r) => [r.id, r]))

/** 某個人數的結果整理成每家一列，range 是只看的時段（null 全看）。
 * 有時段的在前（最早的先），只有其他時段的其次，沒時段的照星等，沒資料的最後 */
export function buildRows(data: Availability, party: number, now = taipeiTime(), range: TimeRange | null = null): Row[] {
  const days = upcomingDays(data, now)
  const rows = data.restaurants.map((place): Row => {
    const result = place.parties[String(party)]
    let first: Row['first'] = null
    let slots = 0
    let outside = 0
    let fresh = 0
    const cells = days.map((date): DayCell => {
      const day = result?.days[date]
      const upcoming = (day?.times ?? []).filter((t) => `${date} ${t}` > now)
      const times = range ? upcoming.filter((t) => t >= range.from && t <= range.to) : upcoming
      const isNew = new Set((day?.new ?? []).filter((t) => times.includes(t)))
      if (times.length > 0 && !first) first = { date, time: times[0] }
      slots += times.length
      outside += upcoming.length - times.length
      fresh += isNew.size
      return { date, day, times, outside: upcoming.length - times.length, fresh: isNew }
    })
    return {
      place,
      restaurant: place.id ? byId.get(place.id) : undefined,
      result,
      cells,
      slots,
      outside,
      fresh,
      first,
      hasData: cells.some((c) => c.day),
    }
  })
  const award = (row: Row) => (row.restaurant ? awardRank(row.restaurant.award) : 0)
  const firstKey = (row: Row) => (row.first ? `${row.first.date} ${row.first.time}` : '')
  return rows.sort(
    (a, b) =>
      Number(b.slots > 0) - Number(a.slots > 0) ||
      firstKey(a).localeCompare(firstKey(b)) ||
      Number(b.outside > 0) - Number(a.outside > 0) ||
      Number(b.hasData) - Number(a.hasData) ||
      award(b) - award(a) ||
      a.place.name.localeCompare(b.place.name, 'zh-Hant'),
  )
}

/** 「2 小時前」；超過兩天寫幾天前 */
export function ago(iso: string, now = Date.now()) {
  const hours = (now - Date.parse(iso)) / 3_600_000
  if (hours < 1) return '不到 1 小時前'
  if (hours < 48) return `${Math.floor(hours)} 小時前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 多久沒更新算太久：爬蟲每 3 小時跑一次，連兩次沒跑就提醒 */
export const STALE_HOURS = 7

/** 只認 http(s)，其他的不放進連結（後端也擋過一次） */
export function safeUrl(url: string) {
  return /^https?:\/\//i.test(url) ? url : null
}

/** 02-2181-9950#3261 → tel:0221819950（分機撥不進去，只留總機） */
export function phoneHref(phone: string) {
  const main = phone.split(/[#轉]/)[0].replace(/[^\d+]/g, '')
  return main ? `tel:${main}` : null
}
