// 每天的標記：台灣的放假日（紀念日及節日實施條例，含補假）、其他節日、節氣、補班。
// 補假規則：紀念日、節日逢星期六在前一個上班日補假，逢星期日在後一個上班日補假；
// 春節（含除夕、小年夜）逢週末則在春節後補假。人事行政總處每年另外公告的調整放假與補班只能逐年登記在 ADJUSTMENTS。
import { fromDay, toDay, weekday, type Day } from './dates'
import { lunarToDay } from './lunar'
import { solarTerms } from './solarTerms'

export type MarkKind = 'holiday' | 'festival' | 'term' | 'workday'

export type DayMark = {
  name: string
  kind: MarkKind
  /** 補假是幫哪個節日補的 */
  detail?: string
}

/** 人事行政總處公告的調整放假（off）與補班（work） */
const ADJUSTMENTS: { date: string; off: boolean; name: string }[] = [
  { date: '2025-01-27', off: true, name: '調整放假' },
  { date: '2025-02-08', off: false, name: '補班' },
]

type Holiday = { day: Day; name: string }

/** 西元 year 年的國定假日本身（不含補假）；春節另外回傳，因為補假規則不同 */
function holidaysOf(year: number): { normal: Holiday[]; springFestival: Holiday[] } {
  const fixed: [number, number, string][] = [
    [1, 1, '元旦'],
    [2, 28, '和平紀念日'],
    [5, 1, '勞動節'],
    [10, 10, '國慶日'],
  ]
  // 2025 年修法新增的放假日
  if (year >= 2025) fixed.push([9, 28, '教師節'], [10, 25, '光復節'], [12, 25, '行憲紀念日'])
  const normal: Holiday[] = fixed.map(([month, day, name]) => ({ day: toDay(year, month, day), name }))

  const qingming = solarTerms(year).find((t) => t.name === '清明')!.day
  normal.push({ day: qingming, name: '清明節' })
  // 兒童節跟清明同一天時提前一天放，但那天是星期四就延後一天
  let children = toDay(year, 4, 4)
  if (children === qingming) children += weekday(children) === 4 ? 1 : -1
  normal.push({ day: children, name: '兒童節' })

  for (const [month, day, name] of [
    [5, 5, '端午節'],
    [8, 15, '中秋節'],
  ] as const) {
    const d = lunarToDay(year, month, day)
    if (d !== null) normal.push({ day: d, name })
  }

  const newYear = lunarToDay(year, 1, 1)!
  const springFestival: Holiday[] = [
    { day: newYear - 1, name: '除夕' },
    { day: newYear, name: '春節' },
    { day: newYear + 1, name: '春節' },
    { day: newYear + 2, name: '春節' },
  ]
  if (year >= 2026) springFestival.unshift({ day: newYear - 2, name: '小年夜' })
  return { normal, springFestival }
}

function isWeekend(day: Day) {
  const w = weekday(day)
  return w === 0 || w === 6
}

const holidayCache = new Map<number, Holiday[]>()

/** 西元 year 年實際放假的日子（含補假與調整放假） */
export function daysOff(year: number): Holiday[] {
  const cached = holidayCache.get(year)
  if (cached) return cached

  // 元旦逢星期六會在前一年的 12/31 補假，所以前後一年也要一起算
  const years = [year - 1, year, year + 1].map(holidaysOf)
  const taken = new Set<Day>()
  const result: Holiday[] = []
  for (const { normal, springFestival } of years) {
    for (const h of [...normal, ...springFestival]) {
      taken.add(h.day)
      result.push(h)
    }
  }
  const isWorkday = (day: Day) => !isWeekend(day) && !taken.has(day)
  const addMakeUp = (day: Day, name: string) => {
    taken.add(day)
    result.push({ day, name: `${name}補假` })
  }

  for (const { normal, springFestival } of years) {
    for (const h of [...normal].sort((a, b) => a.day - b.day)) {
      const w = weekday(h.day)
      if (w !== 0 && w !== 6) continue
      let day = h.day + (w === 6 ? -1 : 1)
      while (!isWorkday(day)) day += w === 6 ? -1 : 1
      addMakeUp(day, h.name)
    }
    const last = springFestival[springFestival.length - 1].day
    let day = last + 1
    const weekendDays = springFestival.filter((h) => isWeekend(h.day)).length
    for (let i = 0; i < weekendDays; i++) {
      while (!isWorkday(day)) day++
      addMakeUp(day, '春節')
    }
  }

  for (const adjustment of ADJUSTMENTS.filter((a) => a.off)) {
    const [y, m, d] = adjustment.date.split('-').map(Number)
    result.push({ day: toDay(y, m, d), name: adjustment.name })
  }

  const days = result.filter((h) => fromDay(h.day).year === year).sort((a, b) => a.day - b.day)
  holidayCache.set(year, days)
  return days
}

/** 不放假的節日：國際節日與傳統節日 */
export function festivalsOf(year: number): Holiday[] {
  const fixed: [number, number, string][] = [
    [2, 14, '情人節'],
    [3, 8, '婦女節'],
    [3, 12, '植樹節'],
    [3, 14, '白色情人節'],
    [3, 29, '青年節'],
    [4, 1, '愚人節'],
    [4, 22, '世界地球日'],
    [8, 8, '父親節'],
    [9, 3, '軍人節'],
    [10, 31, '萬聖節'],
    [11, 12, '國父誕辰'],
    [12, 24, '平安夜'],
    [12, 25, '聖誕節'],
  ]
  if (year < 2025) fixed.push([9, 28, '教師節'], [10, 25, '光復節'], [12, 25, '行憲紀念日'])
  const result: Holiday[] = fixed.map(([month, day, name]) => ({ day: toDay(year, month, day), name }))

  // 母親節是五月第二個星期日，感恩節是十一月第四個星期四
  const may1 = toDay(year, 5, 1)
  result.push({ day: may1 + ((7 - weekday(may1)) % 7) + 7, name: '母親節' })
  const nov1 = toDay(year, 11, 1)
  result.push({ day: nov1 + ((4 - weekday(nov1) + 7) % 7) + 21, name: '感恩節' })

  // 臘月的節日落在下一個西元年的一月，所以前一個農曆年也要算
  const lunarFestivals: [number, number, string][] = [
    [1, 15, '元宵節'],
    [7, 7, '七夕'],
    [7, 15, '中元節'],
    [9, 9, '重陽節'],
    [12, 8, '臘八節'],
    [12, 16, '尾牙'],
  ]
  for (const lunarYear of [year - 1, year]) {
    for (const [month, day, name] of lunarFestivals) {
      const d = lunarToDay(lunarYear, month, day)
      if (d !== null) result.push({ day: d, name })
    }
  }
  return result.filter((h) => fromDay(h.day).year === year).sort((a, b) => a.day - b.day)
}

const markCache = new Map<number, Map<Day, DayMark[]>>()

/** 西元 year 年每天的標記，依放假、補班、節氣、節日排序 */
export function yearMarks(year: number): Map<Day, DayMark[]> {
  const cached = markCache.get(year)
  if (cached) return cached

  const marks = new Map<Day, DayMark[]>()
  const add = (day: Day, mark: DayMark) => marks.set(day, [...(marks.get(day) ?? []), mark])
  for (const h of daysOff(year)) {
    const makeUp = h.name.endsWith('補假')
    add(h.day, makeUp ? { name: '補假', kind: 'holiday', detail: h.name.slice(0, -2) } : { name: h.name, kind: 'holiday' })
  }
  for (const adjustment of ADJUSTMENTS.filter((a) => !a.off && a.date.startsWith(`${year}-`))) {
    const [y, m, d] = adjustment.date.split('-').map(Number)
    add(toDay(y, m, d), { name: adjustment.name, kind: 'workday' })
  }
  for (const term of solarTerms(year)) add(term.day, { name: term.name, kind: 'term' })
  for (const festival of festivalsOf(year)) add(festival.day, { name: festival.name, kind: 'festival' })

  markCache.set(year, marks)
  return marks
}

export function marksOf(day: Day): DayMark[] {
  return yearMarks(fromDay(day).year).get(day) ?? []
}

/** 這天放不放假：國定假日（含補假）放，週末除非補班也放 */
export function isDayOff(day: Day, marks = marksOf(day)): boolean {
  if (marks.some((m) => m.kind === 'holiday')) return true
  if (marks.some((m) => m.kind === 'workday')) return false
  return isWeekend(day)
}

