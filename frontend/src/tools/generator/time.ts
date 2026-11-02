// 時區換算只靠 Intl.DateTimeFormat，不用額外的時區資料庫

export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export const COMMON_TZ = [
  'Asia/Taipei',
  'UTC',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
]

export function allTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return COMMON_TZ
  }
}

export type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number }

const dtfCache = new Map<string, Intl.DateTimeFormat>()
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    dtfCache.set(tz, f)
  }
  return f
}

/** 某個時間點在某時區的年月日時分秒 */
export function partsIn(t: number, tz: string): Parts {
  const p: Record<string, string> = {}
  for (const x of dtf(tz).formatToParts(new Date(t))) p[x.type] = x.value
  const year = Number(p.year)
  return {
    // 西元前用天文年份：1 BC = 0
    y: p.era === 'BC' || p.era === 'B' ? 1 - year : year,
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
    ms: ((t % 1000) + 1000) % 1000,
  }
}

function utcOf(p: Parts): number {
  const d = new Date(Date.UTC(2000, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms))
  d.setUTCFullYear(p.y)
  return d.getTime()
}

/** 時區相對 UTC 的位移（分鐘），台北是 +480 */
export function offsetIn(t: number, tz: string): number {
  return Math.round((utcOf(partsIn(t, tz)) - t) / 60000)
}

/**
 * 某時區的「牆上時間」換成時間戳。
 * 夏令時間重複的那一小時取第一次；跳過的那一小時（不存在的時間）往後推，跟 JS 的 Date 一樣
 */
export function zonedToEpoch(p: Parts, tz: string): number {
  const guess = utcOf(p)
  const o1 = offsetIn(guess, tz)
  const t = guess - o1 * 60000
  const o2 = offsetIn(t, tz)
  if (o2 === o1) return t
  const t2 = guess - o2 * 60000
  return offsetIn(t2, tz) === o2 ? t2 : t
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')
const year = (y: number) => (y < 0 ? '-' + pad(y, 6) : y > 9999 ? '+' + pad(y, 6) : pad(y, 4))

export function formatOffset(min: number): string {
  return `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`
}

export function formatDateTime(p: Parts, withMs = false): string {
  return `${year(p.y)}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${withMs ? '.' + pad(p.ms, 3) : ''}`
}

/** 帶時區位移的 ISO 8601，例如 2026-11-02T14:30:00.000+08:00 */
export function isoIn(t: number, tz: string): string {
  const p = partsIn(t, tz)
  const off = offsetIn(t, tz)
  return `${year(p.y)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.${pad(p.ms, 3)}${off === 0 ? 'Z' : formatOffset(off)}`
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

export function weekday(p: Parts): string {
  const d = new Date(Date.UTC(2000, p.mo - 1, p.d))
  d.setUTCFullYear(p.y)
  return `星期${WEEK[d.getUTCDay()]}`
}

/** 民國紀年；1912 年以前是「民國前」 */
export function rocDate(p: Parts): string {
  const r = p.y - 1911
  const y = r > 0 ? `民國 ${r} 年` : `民國前 ${1 - r} 年`
  return `${y} ${p.mo} 月 ${p.d} 日`
}

const rtf = new Intl.RelativeTimeFormat('zh-TW', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
]

export function relative(t: number, now: number): string {
  const diff = (t - now) / 1000
  for (const [unit, sec] of UNITS) {
    if (Math.abs(diff) >= sec || unit === 'second') return rtf.format(Math.round(diff / sec), unit)
  }
  return ''
}

/** 時間戳的單位：自動判斷時，數字太大的當毫秒 */
export type Unit = 'auto' | 's' | 'ms'

export function parseTimestamp(input: string, unit: Unit): { ms: number; unit: 's' | 'ms' } | null {
  const s = input.trim().replace(/[,_\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  // 1e11 秒已經是西元 5138 年，比這更大的幾乎都是毫秒
  const u = unit === 'auto' ? (Math.abs(n) >= 1e11 ? 'ms' : 's') : unit
  const ms = u === 's' ? n * 1000 : n
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null
  return { ms: Math.floor(ms), unit: u }
}
