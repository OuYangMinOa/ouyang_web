// 日曆裡的日期一律用「1970-01-01 起算的天數」：沒有時區和夏令時間的問題，加減就是加減天數。
// 字串格式是 YYYY-MM-DD，跟後端一樣。

export type Day = number

const MS_PER_DAY = 86_400_000

export const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']

export function toDay(year: number, month: number, day: number): Day {
  return Date.UTC(year, month - 1, day) / MS_PER_DAY
}

export function parseDay(value: string): Day {
  const [year, month, day] = value.split('-').map(Number)
  return toDay(year, month, day)
}

export function fromDay(day: Day) {
  const date = new Date(day * MS_PER_DAY)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    /** 0 = 星期日 */
    weekday: date.getUTCDay(),
  }
}

export function formatDay(day: Day): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/** 使用者所在時區的今天 */
export function today(): Day {
  const now = new Date()
  return toDay(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export function weekday(day: Day): number {
  // 1970-01-01 是星期四
  return (((day + 4) % 7) + 7) % 7
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 「10月30日 星期五」 */
export function longLabel(day: Day): string {
  const d = fromDay(day)
  return `${d.month}月${d.day}日 星期${WEEKDAY_NAMES[d.weekday]}`
}

/** 「11/2」，跨年時加上年份 */
export function shortLabel(day: Day, relativeTo?: Day): string {
  const d = fromDay(day)
  const sameYear = relativeTo === undefined || fromDay(relativeTo).year === d.year
  return sameYear ? `${d.month}/${d.day}` : `${d.year}/${d.month}/${d.day}`
}

/** 日曆支援的年份（農曆換算的範圍，跟後端一樣） */
export const MIN_YEAR = 1901
export const MAX_YEAR = 2099
