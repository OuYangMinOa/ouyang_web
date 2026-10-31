// 個人事項：API 型別與重複規則的展開。後端只存規則，每一次在哪天由這裡算（農曆重複要換算農曆）。
import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import { useAuth } from '../auth'
import { daysInMonth, formatDay, fromDay, parseDay, toDay, weekday, WEEKDAY_NAMES, type Day } from './dates'
import { lunarDayName, lunarLabel, lunarOf } from './lunar'

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'lunar_monthly' | 'lunar_yearly'

export type CalendarEvent = {
  id: number
  title: string
  note: string
  color: EventColor
  start_date: string
  end_date: string
  repeat: Repeat
  interval: number
  /** 0 = 星期日，只有 weekly 會有 */
  weekdays: number[]
  /** 最後一次可以開始的日期 */
  until: string | null
  /** 單獨刪掉的那幾次的開始日期 */
  excluded: string[]
  created_at: string
  updated_at: string
}

export type EventInput = Omit<CalendarEvent, 'id' | 'created_at' | 'updated_at'>

/** 跟後端 calendar.rs 的 COLORS 對應，實際顏色是 index.css 的 --ev-* */
export const EVENT_COLORS = [
  { id: 'orange', label: '橘' },
  { id: 'blue', label: '藍' },
  { id: 'green', label: '綠' },
  { id: 'red', label: '紅' },
  { id: 'purple', label: '紫' },
  { id: 'teal', label: '青' },
] as const
export type EventColor = (typeof EVENT_COLORS)[number]['id']

export const REPEAT_OPTIONS: { value: Repeat; label: string; unit?: string }[] = [
  { value: 'none', label: '不重複' },
  { value: 'daily', label: '每天', unit: '天' },
  { value: 'weekly', label: '每週', unit: '週' },
  { value: 'monthly', label: '每月', unit: '個月' },
  { value: 'yearly', label: '每年', unit: '年' },
  { value: 'lunar_monthly', label: '每月（農曆）' },
  { value: 'lunar_yearly', label: '每年（農曆）' },
]

/** 某個事項的某一次 */
export type Occurrence = {
  event: CalendarEvent
  start: Day
  end: Day
}

function overlaps(start: Day, end: Day, from: Day, to: Day) {
  return start <= to && end >= from
}

/** 事項在 [from, to] 之間有碰到的每一次的開始日期 */
function occurrenceStarts(event: CalendarEvent, from: Day, to: Day): Day[] {
  const start = parseDay(event.start_date)
  const span = parseDay(event.end_date) - start
  if (event.repeat === 'none') return overlaps(start, start + span, from, to) ? [start] : []

  // 開始日期落在 [lo, hi] 的那幾次才會碰到這段期間
  const lo = Math.max(start, from - span)
  const hi = Math.min(to, event.until ? parseDay(event.until) : Infinity)
  if (lo > hi) return []

  const result: Day[] = []
  const interval = Math.max(1, event.interval)
  const s = fromDay(start)

  switch (event.repeat) {
    case 'daily': {
      for (let d = start + Math.ceil((lo - start) / interval) * interval; d <= hi; d += interval) result.push(d)
      break
    }
    case 'weekly': {
      const days = event.weekdays.length > 0 ? event.weekdays : [weekday(start)]
      const firstSunday = start - weekday(start)
      for (let d = lo; d <= hi; d++) {
        const weeks = (d - weekday(d) - firstSunday) / 7
        if (weeks % interval === 0 && days.includes(weekday(d))) result.push(d)
      }
      break
    }
    case 'monthly':
    case 'yearly': {
      // 從開始那個月算起第幾個月；31 號在小月、2/29 在平年會跳過
      const step = event.repeat === 'monthly' ? interval : interval * 12
      const index = (day: Day) => fromDay(day).year * 12 + fromDay(day).month - 1
      const first = s.year * 12 + s.month - 1
      for (let i = first + Math.max(0, Math.ceil((index(lo) - first) / step)) * step; i <= index(hi); i += step) {
        const year = Math.floor(i / 12)
        const month = (i % 12) + 1
        if (s.day > daysInMonth(year, month)) continue
        const d = toDay(year, month, s.day)
        if (d >= lo && d <= hi) result.push(d)
      }
      break
    }
    case 'lunar_monthly':
    case 'lunar_yearly': {
      // 農曆每月含閏月；農曆每年只算非閏月。小月沒有三十就跳過
      const first = lunarOf(start)
      if (!first) break
      for (let d = lo; d <= hi; d++) {
        const lunar = lunarOf(d)
        if (!lunar || lunar.day !== first.day) continue
        if (event.repeat === 'lunar_monthly' || d === start || (lunar.month === first.month && !lunar.leap)) {
          result.push(d)
        }
      }
      break
    }
  }
  const excluded = new Set(event.excluded)
  return result.filter((d) => !excluded.has(formatDay(d)))
}

/** 所有事項在 [from, to] 之間的每一次，依開始日期、長度排序 */
export function occurrencesBetween(events: CalendarEvent[], from: Day, to: Day): Occurrence[] {
  const result: Occurrence[] = []
  for (const event of events) {
    const span = parseDay(event.end_date) - parseDay(event.start_date)
    for (const start of occurrenceStarts(event, from, to)) result.push({ event, start, end: start + span })
  }
  return result.sort((a, b) => a.start - b.start || b.end - a.end || a.event.id - b.event.id)
}

/** 「每 2 週的二、四，到 2027/6/30」 */
export function describeRepeat(event: Pick<CalendarEvent, 'repeat' | 'interval' | 'weekdays' | 'until' | 'start_date'>) {
  const start = parseDay(event.start_date)
  const s = fromDay(start)
  const every = (unit: string) => (event.interval > 1 ? `每 ${event.interval} ${unit}` : `每${unit}`)
  let text: string
  switch (event.repeat) {
    case 'none':
      return '不重複'
    case 'daily':
      text = event.interval > 1 ? `每 ${event.interval} 天` : '每天'
      break
    case 'weekly': {
      const days = (event.weekdays.length > 0 ? event.weekdays : [weekday(start)]).map((d) => WEEKDAY_NAMES[d])
      text = `${every('週')}${event.interval > 1 ? '的' : ''}${days.join('、')}`
      break
    }
    case 'monthly':
      text = `${event.interval > 1 ? `每 ${event.interval} 個月` : '每月'}的 ${s.day} 日`
      break
    case 'yearly':
      text = `${every('年')}的 ${s.month}月${s.day}日`
      break
    case 'lunar_monthly': {
      const lunar = lunarOf(start)
      text = `每月農曆${lunar ? lunarDayName(lunar.day) : ''}`
      break
    }
    case 'lunar_yearly': {
      const lunar = lunarOf(start)
      text = `每年農曆${lunar ? lunarLabel({ ...lunar, leap: false }) : ''}`
      break
    }
  }
  if (event.until) {
    const u = fromDay(parseDay(event.until))
    text += `，到 ${u.year}/${u.month}/${u.day}`
  }
  return text
}

/** 登入的使用者自己的事項；沒登入就是空的 */
export function useCalendarEvents() {
  const { user } = useAuth()
  // 記下是誰的事項，登出或換帳號後就不會顯示上一個人的
  const [loaded, setLoaded] = useState<{ userId: number; events: CalendarEvent[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const userId = user?.id

  const reload = useCallback(() => {
    if (userId === undefined) return
    api<CalendarEvent[]>('/calendar/events')
      .then((events) => {
        setLoaded({ userId, events })
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [userId])

  // 登入、登出或換帳號時重新載入
  useEffect(reload, [reload])

  const events = loaded && loaded.userId === userId ? loaded.events : NO_EVENTS
  return { events, error: userId === undefined ? null : error, reload }
}

const NO_EVENTS: CalendarEvent[] = []

export function saveEvent(input: EventInput, id?: number) {
  return api<CalendarEvent>(id === undefined ? '/calendar/events' : `/calendar/events/${id}`, {
    method: id === undefined ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteEvent(id: number) {
  return api<void>(`/calendar/events/${id}`, { method: 'DELETE' })
}

/** 只刪掉重複事項的其中一次 */
export function skipOccurrence(event: CalendarEvent, start: Day) {
  const { id, created_at: _created, updated_at: _updated, ...input } = event
  return saveEvent({ ...input, excluded: [...event.excluded, formatDay(start)] }, id)
}
