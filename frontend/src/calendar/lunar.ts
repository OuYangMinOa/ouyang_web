// 農曆換算：查表法。表格是常見的 1900–2100 年農曆資料（香港天文台的農曆對照表整理而成，
// 取自 calendar.js / js-calendar-converter，MIT）。瀏覽器內建的 Intl 中國曆在朔日剛好落在午夜附近時
// 會差一天（例如把 2027 年春節算成 2/7），所以不用它。
//
// 每年一個數字：
//   bit 0–3   閏哪個月（0 是沒有閏月）
//   bit 4–15  正月到十二月是大月（30 天）還是小月（29 天），正月在 bit 15
//   bit 16    閏月是大月還是小月
import { toDay, type Day } from './dates'

export type LunarDate = {
  /** 農曆年對應的西元年（正月初一所在的那一年） */
  year: number
  month: number
  leap: boolean
  day: number
}

const FIRST_YEAR = 1900
// prettier-ignore
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920
  0x06566, 0x0d4a0, 0x0ea50, 0x16a95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06aa0, 0x1a6c4, 0x0aae0, // 2050
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090
  0x0d520, // 2100
]

type LunarMonth = { month: number; leap: boolean; days: number; start: Day }

/** 每個農曆年的月份（含閏月）與每個月初一是哪天，第一次用到時才算 */
let years: LunarMonth[][] | null = null

function lunarYears(): LunarMonth[][] {
  if (years) return years
  years = []
  // 1900 年正月初一是 1900-01-31
  let start = toDay(1900, 1, 31)
  for (const info of LUNAR_INFO) {
    const months: LunarMonth[] = []
    const leapMonth = info & 0xf
    for (let month = 1; month <= 12; month++) {
      const days = info & (0x10000 >> month) ? 30 : 29
      months.push({ month, leap: false, days, start })
      start += days
      if (month === leapMonth) {
        const leapDays = info & 0x10000 ? 30 : 29
        months.push({ month, leap: true, days: leapDays, start })
        start += leapDays
      }
    }
    years.push(months)
  }
  return years
}

/** 西元日期轉農曆；超出表格範圍（1900-01-31 以前、2101 年春節以後）回傳 null */
export function lunarOf(day: Day): LunarDate | null {
  const all = lunarYears()
  if (day < all[0][0].start) return null
  for (let i = 0; i < all.length; i++) {
    const months = all[i]
    const last = months[months.length - 1]
    if (day >= last.start + last.days) continue
    const m = months.findLast((m) => m.start <= day)!
    return { year: FIRST_YEAR + i, month: m.month, leap: m.leap, day: day - m.start + 1 }
  }
  return null
}

/** 農曆 year 年（非閏月）month 月 day 日是西元哪一天；那個月沒有這天（小月的三十）或超出範圍就回傳 null */
export function lunarToDay(year: number, month: number, day: number): Day | null {
  const m = lunarYears()[year - FIRST_YEAR]?.find((m) => m.month === month && !m.leap)
  return m && day <= m.days ? m.start + day - 1 : null
}

const MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '臘']
const DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

export function lunarMonthName(month: number, leap = false): string {
  return `${leap ? '閏' : ''}${MONTH_NAMES[month - 1]}月`
}

export function lunarDayName(day: number): string {
  if (day <= 10) return `初${DIGITS[day - 1]}`
  if (day < 20) return `十${DIGITS[day - 11]}`
  if (day === 20) return '二十'
  if (day < 30) return `廿${DIGITS[day - 21]}`
  return '三十'
}

/** 「九月廿一」 */
export function lunarLabel(lunar: LunarDate): string {
  return `${lunarMonthName(lunar.month, lunar.leap)}${lunarDayName(lunar.day)}`
}

const STEMS = '甲乙丙丁戊己庚辛壬癸'
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥'
const ZODIAC = '鼠牛虎兔龍蛇馬羊猴雞狗豬'

/** 「丙午年」 */
export function ganzhiYear(year: number): string {
  const n = year - 4
  return `${STEMS[((n % 10) + 10) % 10]}${BRANCHES[((n % 12) + 12) % 12]}年`
}

export function zodiac(year: number): string {
  return ZODIAC[((((year - 4) % 12) + 12) % 12)]
}
