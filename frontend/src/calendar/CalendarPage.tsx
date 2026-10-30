import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { useAuth } from '../auth'
import {
  daysInMonth,
  formatDay,
  fromDay,
  longLabel,
  MAX_YEAR,
  MIN_YEAR,
  parseDay,
  shortLabel,
  toDay,
  today,
  weekday,
  WEEKDAY_NAMES,
  type Day,
} from './dates'
import EventDialog, { type EditTarget } from './EventDialog'
import { describeRepeat, occurrencesBetween, useCalendarEvents, type Occurrence } from './events'
import { isDayOff, marksOf, type DayMark } from './holidays'
import { ganzhiYear, lunarDayName, lunarLabel, lunarMonthName, lunarOf, zodiac } from './lunar'
import './calendar.css'

type Filters = { lunar: boolean; terms: boolean; festivals: boolean }

const FILTERS_KEY = 'calendar:filters'
const DEFAULT_FILTERS: Filters = { lunar: true, terms: true, festivals: true }

function loadFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_FILTERS
  }
}

function saveFilters(filters: Filters) {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters))
  } catch {
    // 存不了就只在這次有效
  }
}

const NARROW = '(max-width: 640px)'

function useNarrow() {
  return useSyncExternalStore(
    (onChange) => {
      const query = matchMedia(NARROW)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    },
    () => matchMedia(NARROW).matches,
  )
}

/** 網址上的 ?day=YYYY-MM-DD，格式不對或超出範圍就當作沒有 */
function dayParam(value: string | null): Day | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const day = parseDay(value)
  const year = fromDay(day).year
  return Number.isNaN(day) || year < MIN_YEAR || year > MAX_YEAR || formatDay(day) !== value ? null : day
}

/** 日曆格子裡日期下面那一行：放假日 > 節氣 > 節日 > 農曆（初一顯示月份） */
function cellLabel(day: Day, marks: DayMark[], filters: Filters): { text: string; kind: string } | null {
  const holiday = marks.find((m) => m.kind === 'holiday' || m.kind === 'workday')
  if (holiday) return { text: holiday.name, kind: holiday.kind }
  const term = filters.terms && marks.find((m) => m.kind === 'term')
  if (term) return { text: term.name, kind: 'term' }
  const festival = filters.festivals && marks.find((m) => m.kind === 'festival')
  if (festival) return { text: festival.name, kind: 'festival' }
  const lunar = filters.lunar && lunarOf(day)
  if (!lunar) return null
  return lunar.day === 1
    ? { text: lunarMonthName(lunar.month, lunar.leap), kind: 'lunar-month' }
    : { text: lunarDayName(lunar.day), kind: 'lunar' }
}

type Segment = {
  occurrence: Occurrence
  /** 這週的第幾欄（0 = 星期日） */
  col: number
  span: number
  lane: number
  /** 從上週接過來／接到下週 */
  fromBefore: boolean
  toAfter: boolean
}

/** 一週裡的事項排成一條條橫條：同一條線上不重疊，多天的事項連在一起 */
function layoutWeek(occurrences: Occurrence[], weekStart: Day): Segment[] {
  const weekEnd = weekStart + 6
  const laneEnds: number[] = []
  const segments: Segment[] = []
  for (const occurrence of occurrences) {
    if (occurrence.start > weekEnd || occurrence.end < weekStart) continue
    const col = Math.max(occurrence.start, weekStart) - weekStart
    const last = Math.min(occurrence.end, weekEnd) - weekStart
    let lane = laneEnds.findIndex((end) => end < col)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = last
    segments.push({
      occurrence,
      col,
      span: last - col + 1,
      lane,
      fromBefore: occurrence.start < weekStart,
      toAfter: occurrence.end > weekEnd,
    })
  }
  return segments
}

function Week({
  start,
  month,
  selected,
  occurrences,
  filters,
  maxLanes,
  onSelect,
  onOpen,
}: {
  start: Day
  month: number
  selected: Day
  occurrences: Occurrence[]
  filters: Filters
  maxLanes: number
  onSelect: (day: Day) => void
  onOpen: (occurrence: Occurrence) => void
}) {
  const now = today()
  const segments = layoutWeek(occurrences, start)
  const hidden = Array.from({ length: 7 }, (_, col) =>
    segments.filter((s) => s.lane >= maxLanes && s.col <= col && col < s.col + s.span).length,
  )

  return (
    <div className="cal-week" style={{ '--lanes': maxLanes } as CSSProperties}>
      {Array.from({ length: 7 }, (_, col) => {
        const day = start + col
        const d = fromDay(day)
        const marks = marksOf(day)
        const label = cellLabel(day, marks, filters)
        const classes = [
          'cal-day',
          d.month !== month && 'outside',
          isDayOff(day, marks) && 'off',
          day === now && 'today',
          day === selected && 'selected',
        ]
        return (
          <button
            key={day}
            type="button"
            className={classes.filter(Boolean).join(' ')}
            style={{ gridColumn: col + 1 }}
            onClick={() => onSelect(day)}
            aria-label={`${longLabel(day)}${label ? `，${label.text}` : ''}`}
            aria-pressed={day === selected}
          >
            <span className="cal-num">{d.day}</span>
            {label && <span className={`cal-label ${label.kind}`}>{label.text}</span>}
          </button>
        )
      })}
      {segments
        .filter((s) => s.lane < maxLanes)
        .map((s) => (
          <button
            key={`${s.occurrence.event.id}:${s.occurrence.start}`}
            type="button"
            className={`cal-bar ${s.fromBefore ? 'from-before' : ''} ${s.toAfter ? 'to-after' : ''}`}
            style={
              {
                gridColumn: `${s.col + 1} / span ${s.span}`,
                gridRow: s.lane + 2,
                '--ev': `var(--ev-${s.occurrence.event.color})`,
              } as CSSProperties
            }
            title={s.occurrence.event.title}
            onClick={() => onOpen(s.occurrence)}
          >
            {s.occurrence.event.title}
          </button>
        ))}
      {hidden.map(
        (count, col) =>
          count > 0 && (
            <button
              key={`more-${col}`}
              type="button"
              className="cal-more"
              style={{ gridColumn: col + 1, gridRow: maxLanes + 2 }}
              onClick={() => onSelect(start + col)}
            >
              +{count}
            </button>
          ),
      )}
    </div>
  )
}

const KIND_LABELS: Record<DayMark['kind'], string> = {
  holiday: '放假',
  workday: '補班',
  term: '節氣',
  festival: '節日',
}

function DayPanel({
  day,
  occurrences,
  onAdd,
  onOpen,
}: {
  day: Day
  occurrences: Occurrence[]
  onAdd: () => void
  onOpen: (occurrence: Occurrence) => void
}) {
  const { user, loading } = useAuth()
  const { pathname, search } = useLocation()
  const lunar = lunarOf(day)
  const marks = marksOf(day)
  const items = occurrences.filter((o) => o.start <= day && o.end >= day)

  return (
    <aside className="cal-panel card" aria-live="polite">
      <h2>{longLabel(day)}</h2>
      {lunar && (
        <p className="muted">
          農曆{lunarLabel(lunar)} · {ganzhiYear(lunar.year)}（{zodiac(lunar.year)}年）
        </p>
      )}
      {(marks.length > 0 || isDayOff(day, marks)) && (
        <ul className="cal-marks">
          {marks.map((m) => (
            <li key={`${m.kind}:${m.name}`} className={`cal-mark ${m.kind}`}>
              <span className="cal-mark-kind">{KIND_LABELS[m.kind]}</span>
              {m.detail ? `${m.detail}補假` : m.name}
            </li>
          ))}
          {marks.length === 0 && (
            <li className="cal-mark holiday">
              <span className="cal-mark-kind">放假</span>週末
            </li>
          )}
        </ul>
      )}

      <h3>我的事項</h3>
      {user ? (
        <>
          {items.length === 0 && <p className="muted">這天沒有事項。</p>}
          <ul className="cal-items">
            {items.map((o) => {
              const { event } = o
              const days = o.end - o.start + 1
              return (
                <li key={`${event.id}:${o.start}`}>
                  <button
                    type="button"
                    className="cal-item"
                    style={{ '--ev': `var(--ev-${event.color})` } as CSSProperties}
                    onClick={() => onOpen(o)}
                  >
                    <strong>{event.title}</strong>
                    {days > 1 && (
                      <span className="muted">
                        {shortLabel(o.start)}–{shortLabel(o.end, o.start)} · 第 {day - o.start + 1}/{days} 天
                      </span>
                    )}
                    {event.repeat !== 'none' && <span className="muted">🔁 {describeRepeat(event)}</span>}
                    {event.note && <span className="cal-note">{event.note}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          <button type="button" onClick={onAdd}>
            ＋ 新增事項
          </button>
        </>
      ) : (
        !loading && (
          <p className="muted">
            <Link to="/login" state={{ from: pathname + search }}>
              登入
            </Link>
            後可以記下自己的事項。
          </p>
        )
      )}
    </aside>
  )
}

export default function CalendarPage() {
  const [params, setParams] = useSearchParams()
  const { events, error, reload } = useCalendarEvents()
  const [filters, setFilters] = useState(loadFilters)
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const narrow = useNarrow()

  const now = today()
  const selected = dayParam(params.get('day')) ?? now
  const { year, month } = fromDay(selected)

  const first = toDay(year, month, 1)
  const gridStart = first - weekday(first)
  const monthEnd = toDay(year, month, daysInMonth(year, month))
  const gridEnd = monthEnd + 6 - weekday(monthEnd)
  const weekStarts = Array.from({ length: (gridEnd - gridStart + 1) / 7 }, (_, i) => gridStart + i * 7)

  const occurrences = useMemo(() => occurrencesBetween(events, gridStart, gridEnd), [events, gridStart, gridEnd])
  // 春節所在的月份跨兩個農曆年，兩個都列出來
  const lunarYears = [...new Set([lunarOf(first)?.year ?? year, lunarOf(monthEnd)?.year ?? year])]

  function select(day: Day) {
    const y = fromDay(day).year
    if (y < MIN_YEAR || y > MAX_YEAR) return
    setParams(day === now ? {} : { day: formatDay(day) }, { replace: true })
  }

  /** 換月份：今天在那個月就選今天，不然選那個月的 1 號 */
  function goMonth(delta: number) {
    const index = year * 12 + month - 1 + delta
    const target = toDay(Math.floor(index / 12), (index % 12) + 1, 1)
    const n = fromDay(now)
    select(n.year * 12 + n.month - 1 === index ? now : target)
  }

  function toggle(key: keyof Filters) {
    const next = { ...filters, [key]: !filters[key] }
    setFilters(next)
    saveFilters(next)
  }

  function open(occurrence: Occurrence) {
    setEditing({ event: occurrence.event, occurrence: occurrence.start, date: occurrence.start })
  }

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <div className="cal-title">
          <h1>
            {year} 年 {month} 月
          </h1>
          <span className="muted">{lunarYears.map((y) => `${ganzhiYear(y)}（${zodiac(y)}）`).join(' → ')}</span>
        </div>
        <div className="cal-nav">
          <button type="button" className="secondary" onClick={() => goMonth(-1)} aria-label="上個月">
            ‹
          </button>
          <button type="button" className="secondary" onClick={() => select(now)}>
            今天
          </button>
          <button type="button" className="secondary" onClick={() => goMonth(1)} aria-label="下個月">
            ›
          </button>
        </div>
      </div>

      <div className="checks cal-filters">
        <label>
          <input type="checkbox" checked={filters.lunar} onChange={() => toggle('lunar')} />
          農曆
        </label>
        <label>
          <input type="checkbox" checked={filters.terms} onChange={() => toggle('terms')} />
          節氣
        </label>
        <label>
          <input type="checkbox" checked={filters.festivals} onChange={() => toggle('festivals')} />
          節日
        </label>
        <span className="cal-legend">
          <span className="cal-legend-off">紅字</span>是放假日
        </span>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="cal-body">
        <div className="cal-month">
          <div className="cal-weekdays" aria-hidden="true">
            {WEEKDAY_NAMES.map((name, i) => (
              <span key={name} className={i === 0 || i === 6 ? 'off' : undefined}>
                {name}
              </span>
            ))}
          </div>
          {weekStarts.map((start) => (
            <Week
              key={start}
              start={start}
              month={month}
              selected={selected}
              occurrences={occurrences}
              filters={filters}
              maxLanes={narrow ? 2 : 3}
              onSelect={select}
              onOpen={open}
            />
          ))}
        </div>
        <DayPanel
          day={selected}
          occurrences={occurrences}
          onAdd={() => setEditing({ date: selected })}
          onOpen={open}
        />
      </div>

      {editing && (
        <EventDialog
          key={`${editing.event?.id}:${editing.occurrence}:${editing.date}`}
          target={editing}
          onChanged={reload}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
