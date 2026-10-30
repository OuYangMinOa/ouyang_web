import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { formatDay, parseDay, shortLabel, today } from './dates'
import EventDialog, { type EditTarget } from './EventDialog'
import { describeRepeat, useCalendarEvents, type CalendarEvent } from './events'
import './calendar.css'

function dateRange(event: CalendarEvent) {
  const start = parseDay(event.start_date)
  const end = parseDay(event.end_date)
  const startText = shortLabel(start, today())
  return start === end ? startText : `${startText}–${shortLabel(end, start)}`
}

/** 自己所有的事項（重複的只列一次），方便整理 */
export default function MyEventsPage() {
  const { events, error, reload } = useCalendarEvents()
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [showPast, setShowPast] = useState(false)

  const now = today()
  // 已經結束、也不會再重複的事項算「過去」
  const isPast = (e: CalendarEvent) =>
    parseDay(e.repeat === 'none' ? e.end_date : (e.until ?? '9999-12-31')) < now
  const pastCount = events.filter(isPast).length
  const shown = showPast ? events : events.filter((e) => !isPast(e))

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <div className="cal-title">
          <h1>我的事項</h1>
          <span className="muted">共 {events.length} 個，重複的事項只列一次</span>
        </div>
        <div className="cal-nav">
          <button type="button" onClick={() => setEditing({ date: now })}>
            ＋ 新增事項
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {pastCount > 0 && (
        <div className="checks">
          <label>
            <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
            顯示已結束的 {pastCount} 個
          </label>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="muted cal-empty">
          還沒有事項。可以在<Link to="/calendar">月曆</Link>上點選日期新增。
        </p>
      ) : (
        <table className="responsive cal-table">
          <thead>
            <tr>
              <th>標題</th>
              <th>日期</th>
              <th>重複</th>
              <th>備註</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((event) => (
              <tr key={event.id}>
                <td data-label="標題" className="primary">
                  <span className="cal-dot" style={{ '--ev': `var(--ev-${event.color})` } as CSSProperties} />
                  {event.title}
                </td>
                <td data-label="日期">
                  <Link to={`/calendar?day=${event.start_date}`}>{dateRange(event)}</Link>
                </td>
                <td data-label="重複">{describeRepeat(event)}</td>
                <td data-label="備註" className="cal-note">
                  {event.note || '—'}
                </td>
                <td className="actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setEditing({ event, date: parseDay(event.start_date) })}
                  >
                    編輯
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <EventDialog
          key={`${editing.event?.id}:${formatDay(editing.date)}`}
          target={editing}
          onChanged={reload}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
