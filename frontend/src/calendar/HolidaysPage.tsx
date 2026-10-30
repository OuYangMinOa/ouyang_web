import { Link, useSearchParams } from 'react-router'
import { formatDay, fromDay, MAX_YEAR, MIN_YEAR, toDay, today, weekday, WEEKDAY_NAMES, type Day } from './dates'
import { daysOff, festivalsOf, isDayOff } from './holidays'
import { lunarLabel, lunarOf } from './lunar'
import { solarTerms } from './solarTerms'
import './calendar.css'

function DayLink({ day, withWeekday = false }: { day: Day; withWeekday?: boolean }) {
  const d = fromDay(day)
  return (
    <Link to={`/calendar?day=${formatDay(day)}`}>
      {d.month}月{d.day}日{withWeekday && `（${WEEKDAY_NAMES[weekday(day)]}）`}
    </Link>
  )
}

/** 一天一行：日期（星期）、名稱、農曆 */
function DayList({ days, off = false }: { days: { day: Day; name: string }[]; off?: boolean }) {
  return (
    <ul className="cal-list">
      {days.map((h) => {
        const lunar = lunarOf(h.day)
        return (
          <li key={`${h.day}:${h.name}`}>
            <DayLink day={h.day} withWeekday />
            <span className={`name ${off ? 'cal-off-text' : ''}`}>{h.name}</span>
            <span className="lunar">{lunar ? `農曆${lunarLabel(lunar)}` : ''}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** 一整年的放假日、節氣與節日 */
export default function HolidaysPage() {
  const [params, setParams] = useSearchParams()
  const requested = Number(params.get('year'))
  const year = Number.isInteger(requested) && requested >= MIN_YEAR && requested <= MAX_YEAR ? requested : fromDay(today()).year

  const holidays = daysOff(year)
  const first = toDay(year, 1, 1)
  const total = toDay(year + 1, 1, 1) - first
  const offCount = Array.from({ length: total }, (_, i) => first + i).filter((day) => isDayOff(day)).length

  function go(next: number) {
    if (next >= MIN_YEAR && next <= MAX_YEAR) setParams({ year: String(next) }, { replace: true })
  }

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <div className="cal-title">
          <h1>{year} 年節日與節氣</h1>
          <span className="muted">
            國定假日與補假 {holidays.length} 天，含週末全年放假 {offCount} 天
          </span>
        </div>
        <div className="cal-nav">
          <button type="button" className="secondary" onClick={() => go(year - 1)} aria-label="前一年">
            ‹
          </button>
          <button type="button" className="secondary" onClick={() => go(fromDay(today()).year)}>
            今年
          </button>
          <button type="button" className="secondary" onClick={() => go(year + 1)} aria-label="下一年">
            ›
          </button>
        </div>
      </div>

      <h2>放假日</h2>
      <p className="muted">
        依「紀念日及節日實施條例」推算，含補假；人事行政總處另外公告的調整放假與補班可能沒有列入。
      </p>
      <DayList days={holidays} off />

      <h2>二十四節氣</h2>
      <ul className="cal-terms">
        {solarTerms(year).map((t) => (
          <li key={t.name}>
            <strong>{t.name}</strong>
            <DayLink day={t.day} />
          </li>
        ))}
      </ul>

      <h2>其他節日</h2>
      <DayList days={festivalsOf(year)} />
    </div>
  )
}
