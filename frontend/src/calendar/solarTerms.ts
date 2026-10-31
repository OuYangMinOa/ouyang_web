// 二十四節氣：太陽視黃經每走 15° 一個節氣。用 Meeus《Astronomical Algorithms》第 25 章的簡化公式，
// 誤差約 0.01°（十幾分鐘），只有節氣剛好落在午夜前後時日期可能差一天。日期以台灣時間（UTC+8）為準。
import type { Day } from './dates'

export const SOLAR_TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '驚蟄', '春分', '清明', '穀雨', '立夏', '小滿', '芒種', '夏至',
  '小暑', '大暑', '立秋', '處暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
]

const DEG = Math.PI / 180
const MS_PER_DAY = 86_400_000
/** TT − UT，2020 年代約 69 秒 */
const DELTA_T_DAYS = 69 / 86_400
const TAIWAN_OFFSET_DAYS = 8 / 24

/** 太陽視黃經（度），jd 是儒略日（TT） */
function sunLongitude(jd: number): number {
  const t = (jd - 2451545) / 36525
  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t
  const m = (357.52911 + 35999.05029 * t - 0.0001537 * t * t) * DEG
  const c =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(m) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * m) +
    0.000289 * Math.sin(3 * m)
  const omega = (125.04 - 1934.136 * t) * DEG
  const longitude = l0 + c - 0.00569 - 0.00478 * Math.sin(omega)
  return ((longitude % 360) + 360) % 360
}

/** 太陽到達黃經 target 的時刻（UT 的儒略日），guess 是附近的儒略日 */
function solveLongitude(target: number, guess: number): number {
  let jd = guess
  for (let i = 0; i < 6; i++) {
    const diff = ((target - sunLongitude(jd + DELTA_T_DAYS) + 540) % 360) - 180
    jd += (diff * 365.2422) / 360
    if (Math.abs(diff) < 1e-6) break
  }
  return jd
}

const cache = new Map<number, { name: string; day: Day }[]>()

/** 西元 year 年的 24 個節氣，從小寒排到冬至 */
export function solarTerms(year: number): { name: string; day: Day }[] {
  const cached = cache.get(year)
  if (cached) return cached

  const jan1 = Date.UTC(year, 0, 1) / MS_PER_DAY + 2440587.5
  const terms = SOLAR_TERM_NAMES.map((name, i) => {
    // 小寒約在 1/5，之後每個節氣隔約 15.2 天
    const jd = solveLongitude((285 + 15 * i) % 360, jan1 + 5 + 15.22 * i)
    const day = Math.floor(jd - 2440587.5 + TAIWAN_OFFSET_DAYS)
    return { name, day }
  })
  cache.set(year, terms)
  return terms
}
