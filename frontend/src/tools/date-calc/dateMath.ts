// 日期的加減與差距。日期一律用日曆 APP 的 Day（1970-01-01 起算的天數），
// 這裡只補上日曆沒有的：任意年份（含西元 100 年以前）、加減月份、民國年。
import { fromDay, WEEKDAY_NAMES, type Day } from '../../calendar/dates'

const MS_PER_DAY = 86_400_000

/** 輸入框接受的年份範圍（<input type="date"> 也只到 9999 年） */
export const YEAR_MIN = 1
export const YEAR_MAX = 9999

export function isLeap(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function monthDays(year: number, month: number) {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/** 跟日曆的 toDay 一樣，但 Date.UTC 會把 0–99 年當成 1900 年代，這裡另外處理 */
export function makeDay(year: number, month: number, day: number): Day {
  const d = new Date(Date.UTC(2000, month - 1, day))
  d.setUTCFullYear(year)
  return d.getTime() / MS_PER_DAY
}

/** 「YYYY-MM-DD」轉成 Day；格式不對或超出範圍回傳 null */
export function parseIso(value: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (year < YEAR_MIN || month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) return null
  return makeDay(year, month, day)
}

export function toIso(day: Day): string {
  const d = fromDay(day)
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
}

export function inRange(day: Day) {
  const { year } = fromDay(day)
  return year >= YEAR_MIN && year <= YEAR_MAX
}

/** 加減 n 個月；目標月份沒有那一天（例如 1/31 加一個月）就用那個月的最後一天 */
export function addMonths(day: Day, n: number): Day {
  const d = fromDay(day)
  const total = d.year * 12 + (d.month - 1) + n
  const year = Math.floor(total / 12)
  const month = total - year * 12 + 1
  return makeDay(year, month, Math.min(d.day, monthDays(year, month)))
}

/** a 到 b（a ≤ b）是幾個整月又幾天 */
export function monthsBetween(a: Day, b: Day): { months: number; days: number } {
  const da = fromDay(a)
  const db = fromDay(b)
  let months = (db.year - da.year) * 12 + (db.month - da.month)
  // 先用年月估，再修正到「加上去不超過 b」的最大月數
  while (months > 0 && addMonths(a, months) > b) months--
  while (addMonths(a, months + 1) <= b) months++
  return { months, days: b - addMonths(a, months) }
}

/** 西元年轉民國年的文字：1912 年以前是「民國前」 */
export function rocYearLabel(year: number): string {
  return year >= 1912 ? `民國 ${year - 1911} 年` : `民國前 ${1912 - year} 年`
}

/** 「民國 115 年 11 月 2 日（星期一）」 */
export function rocLabel(day: Day): string {
  const d = fromDay(day)
  return `${rocYearLabel(d.year)} ${d.month} 月 ${d.day} 日（星期${WEEKDAY_NAMES[d.weekday]}）`
}

/** 「2026 年 11 月 2 日（星期一）」 */
export function westLabel(day: Day): string {
  const d = fromDay(day)
  return `${d.year} 年 ${d.month} 月 ${d.day} 日（星期${WEEKDAY_NAMES[d.weekday]}）`
}

/** 民國日期：115/11/2、115-11-02、115.11.2、115年11月2日、1151102、991231；「前」開頭是民國前 */
export function parseRoc(text: string): Day | null {
  const s = text.trim().replace(/\s+/g, '')
  let before = false
  let rest = s.replace(/^民國/, '')
  if (rest.startsWith('前')) {
    before = true
    rest = rest.slice(1)
  }
  let y: number, m: number, d: number
  const sep = /^(\d{1,4})\D+(\d{1,2})\D+(\d{1,2})\D*$/.exec(rest)
  if (sep) {
    ;[y, m, d] = [Number(sep[1]), Number(sep[2]), Number(sep[3])]
  } else if (/^\d{6,7}$/.test(rest)) {
    y = Number(rest.slice(0, -4))
    m = Number(rest.slice(-4, -2))
    d = Number(rest.slice(-2))
  } else {
    return null
  }
  if (y < 1) return null
  const year = before ? 1912 - y : y + 1911
  if (year < YEAR_MIN || year > YEAR_MAX || m < 1 || m > 12 || d < 1 || d > monthDays(year, m)) return null
  return makeDay(year, m, d)
}

/** 民國日期的輸入框文字：「115/11/2」，民國前加「前」 */
export function rocText(day: Day): string {
  const d = fromDay(day)
  const y = d.year >= 1912 ? String(d.year - 1911) : `前${1912 - d.year}`
  return `${y}/${d.month}/${d.day}`
}

// 每個月的分界日，以及從那天開始的星座
const SIGNS: [number, number, string][] = [
  [1, 20, '水瓶座'],
  [2, 19, '雙魚座'],
  [3, 21, '牡羊座'],
  [4, 20, '金牛座'],
  [5, 21, '雙子座'],
  [6, 22, '巨蟹座'],
  [7, 23, '獅子座'],
  [8, 23, '處女座'],
  [9, 23, '天秤座'],
  [10, 24, '天蠍座'],
  [11, 23, '射手座'],
  [12, 22, '摩羯座'],
]

/** 星座：每個月的分界日之前算上一個星座 */
export function starSign(day: Day): string {
  const { month, day: date } = fromDay(day)
  const [, start, name] = SIGNS[month - 1]
  if (date >= start) return name
  return SIGNS[(month + 10) % 12][2]
}
