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

export type DayCell = {
  date: string
  day: DayResult | undefined
  /** 還沒過去的時段 */
  times: string[]
  fresh: Set<string>
}

export type Row = {
  place: Place
  /** 地圖上的那家（星等、地區、料理） */
  restaurant: Restaurant | undefined
  result: PartyResult | undefined
  cells: DayCell[]
  slots: number
  fresh: number
  /** 最早的時段 */
  first: { date: string; time: string } | null
  /** 有讀到任何一天的資料 */
  hasData: boolean
}

const byId = new Map(RESTAURANTS.map((r) => [r.id, r]))

/** 某個人數的結果整理成每家一列：有時段的在前（最早的先），沒時段的照星等，沒資料的最後 */
export function buildRows(data: Availability, party: number, now = taipeiTime()): Row[] {
  const days = upcomingDays(data, now)
  const rows = data.restaurants.map((place): Row => {
    const result = place.parties[String(party)]
    let first: Row['first'] = null
    let slots = 0
    let fresh = 0
    const cells = days.map((date): DayCell => {
      const day = result?.days[date]
      const times = (day?.times ?? []).filter((t) => `${date} ${t}` > now)
      const isNew = new Set((day?.new ?? []).filter((t) => times.includes(t)))
      if (times.length > 0 && !first) first = { date, time: times[0] }
      slots += times.length
      fresh += isNew.size
      return { date, day, times, fresh: isNew }
    })
    return {
      place,
      restaurant: place.id ? byId.get(place.id) : undefined,
      result,
      cells,
      slots,
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
