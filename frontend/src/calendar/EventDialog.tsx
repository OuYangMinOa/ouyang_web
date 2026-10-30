import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { errorMessage } from '../api'
import { formatDay, MAX_YEAR, MIN_YEAR, parseDay, weekday, WEEKDAY_NAMES, type Day } from './dates'
import {
  deleteEvent,
  describeRepeat,
  EVENT_COLORS,
  REPEAT_OPTIONS,
  saveEvent,
  skipOccurrence,
  type CalendarEvent,
  type EventColor,
  type Repeat,
} from './events'

export type EditTarget = {
  /** 沒有就是新增 */
  event?: CalendarEvent
  /** 從重複事項的某一次點進來時，那一次的開始日期（可以只刪這一次） */
  occurrence?: Day
  /** 新增時預設的日期 */
  date: Day
}

const MIN_DATE = `${MIN_YEAR}-01-01`
const MAX_DATE = `${MAX_YEAR}-12-31`

/** 新增或編輯個人事項；存檔、刪除後呼叫 onChanged，關掉時呼叫 onClose */
export default function EventDialog({
  target,
  onChanged,
  onClose,
}: {
  target: EditTarget
  onChanged: () => void
  onClose: () => void
}) {
  const { event, occurrence } = target
  const dialog = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState(event?.title ?? '')
  const [start, setStart] = useState(event?.start_date ?? formatDay(target.date))
  const [end, setEnd] = useState(event?.end_date ?? formatDay(target.date))
  const [color, setColor] = useState<EventColor>(event?.color ?? 'orange')
  const [repeat, setRepeat] = useState<Repeat>(event?.repeat ?? 'none')
  const [interval, setRepeatInterval] = useState(event?.interval ?? 1)
  const [weekdays, setWeekdays] = useState(event?.weekdays.length ? event.weekdays : [weekday(parseDay(start))])
  const [until, setUntil] = useState(event?.until ?? '')
  const [note, setNote] = useState(event?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])

  const unit = REPEAT_OPTIONS.find((o) => o.value === repeat)?.unit
  const repeating = event !== undefined && event.repeat !== 'none'

  /** 改開始日期時結束日期跟著移動，天數不變；每週只選了原本那天的話也跟著換 */
  function changeStart(value: string) {
    if (!value) return setStart(value)
    if (start && end) setEnd(formatDay(parseDay(value) + parseDay(end) - parseDay(start)))
    if (start && weekdays.length === 1 && weekdays[0] === weekday(parseDay(start))) {
      setWeekdays([weekday(parseDay(value))])
    }
    setStart(value)
  }

  function toggleWeekday(day: number) {
    const next = weekdays.includes(day) ? weekdays.filter((d) => d !== day) : [...weekdays, day].sort()
    if (next.length > 0) setWeekdays(next)
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      onChanged()
      dialog.current?.close()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    run(() =>
      saveEvent(
        {
          title,
          note,
          color,
          start_date: start,
          end_date: end,
          repeat,
          interval: unit ? interval : 1,
          weekdays: repeat === 'weekly' ? weekdays : [],
          until: repeat !== 'none' && until ? until : null,
          // 規則變了，之前單獨刪掉的那幾次不一定還對得上，只有規則沒變才保留
          excluded:
            event && event.repeat === repeat && event.start_date === start && repeat !== 'none' ? event.excluded : [],
        },
        event?.id,
      ),
    )
  }

  function removeAll() {
    if (!event || (repeating && !confirm(`刪除「${event.title}」的每一次？`))) return
    run(() => deleteEvent(event.id))
  }

  return (
    <dialog ref={dialog} className="cal-dialog" onClose={onClose} aria-labelledby="cal-dialog-title">
      <form className="stack" onSubmit={submit}>
        <h2 id="cal-dialog-title">{event ? '編輯事項' : '新增事項'}</h2>
        <label>
          標題
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} required autoFocus />
        </label>
        <div className="row">
          <label>
            開始
            <input
              type="date"
              value={start}
              min={MIN_DATE}
              max={MAX_DATE}
              onChange={(e) => changeStart(e.target.value)}
              required
            />
          </label>
          <label>
            結束（多天的事項）
            <input
              type="date"
              value={end}
              min={start || MIN_DATE}
              max={MAX_DATE}
              onChange={(e) => setEnd(e.target.value)}
              required
            />
          </label>
        </div>

        <fieldset className="cal-fieldset">
          <legend>顏色</legend>
          <div className="cal-colors">
            {EVENT_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="cal-swatch"
                style={{ '--ev': `var(--ev-${c.id})` } as CSSProperties}
                aria-pressed={color === c.id}
                aria-label={c.label}
                title={c.label}
                onClick={() => setColor(c.id)}
              />
            ))}
          </div>
        </fieldset>

        <div className="row">
          <label>
            重複
            <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
              {REPEAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {unit && (
            <label>
              間隔
              <span className="cal-interval">
                每
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={999}
                  value={interval}
                  onChange={(e) => setRepeatInterval(Math.max(1, Math.min(999, Number(e.target.value) || 1)))}
                />
                {unit}
              </span>
            </label>
          )}
        </div>

        {repeat === 'weekly' && (
          <fieldset className="cal-fieldset">
            <legend>星期</legend>
            <div className="cal-weekday-picks">
              {WEEKDAY_NAMES.map((name, day) => (
                <button
                  key={day}
                  type="button"
                  className="cal-weekday-pick"
                  aria-pressed={weekdays.includes(day)}
                  onClick={() => toggleWeekday(day)}
                >
                  {name}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {repeat !== 'none' && (
          <label>
            重複到（留空是一直重複）
            <input type="date" value={until} min={start || MIN_DATE} max={MAX_DATE} onChange={(e) => setUntil(e.target.value)} />
          </label>
        )}
        {repeat !== 'none' && start && (
          <p className="muted">
            {describeRepeat({ repeat, interval: unit ? interval : 1, weekdays, until: until || null, start_date: start })}
          </p>
        )}

        <label>
          備註
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} />
        </label>

        {repeating && <p className="muted">修改會套用到這個重複事項的每一次。</p>}
        {error && <p className="error">{error}</p>}

        <div className="cal-dialog-actions">
          <button type="submit" disabled={busy}>
            儲存
          </button>
          <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
            取消
          </button>
          {event && (
            <span className="cal-dialog-danger">
              {repeating && occurrence !== undefined && (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => run(() => skipOccurrence(event, occurrence))}
                >
                  只刪這一次
                </button>
              )}
              <button type="button" className="danger" disabled={busy} onClick={removeAll}>
                {repeating ? '全部刪除' : '刪除'}
              </button>
            </span>
          )}
        </div>
      </form>
    </dialog>
  )
}
