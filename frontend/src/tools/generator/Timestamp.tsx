import { useEffect, useId, useMemo, useState } from 'react'
import { CopyButton, Segmented } from '../encoding/ui'
import { store } from './store'
import {
  allTimeZones,
  COMMON_TZ,
  formatDateTime,
  formatOffset,
  isoIn,
  LOCAL_TZ,
  offsetIn,
  parseTimestamp,
  partsIn,
  relative,
  rocDate,
  weekday,
  zonedToEpoch,
  type Unit,
} from './time'

const UNITS: { value: Unit; label: string }[] = [
  { value: 'auto', label: '自動' },
  { value: 's', label: '秒' },
  { value: 'ms', label: '毫秒' },
]

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

function Row({ name, value }: { name: string; value: string }) {
  return (
    <li className="enc-row">
      <span className="enc-row-name">{name}</span>
      <span className="enc-row-value">{value}</span>
      <CopyButton text={value} />
    </li>
  )
}

function TimeZoneSelect({ value, onChange, id, now }: { value: string; onChange: (tz: string) => void; id: string; now: number }) {
  const zones = useMemo(() => allTimeZones(), [])
  const common = [...new Set([LOCAL_TZ, ...COMMON_TZ])]
  const label = (tz: string) => `${tz}（UTC${formatOffset(offsetIn(now, tz))}）${tz === LOCAL_TZ ? '・本機' : ''}`
  return (
    <select id={id} className="enc-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <optgroup label="常用">
        {common.map((tz) => (
          <option key={tz} value={tz}>
            {label(tz)}
          </option>
        ))}
      </optgroup>
      <optgroup label="全部時區">
        {zones
          .filter((tz) => !common.includes(tz))
          .map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
      </optgroup>
    </select>
  )
}

/** datetime-local 的值（YYYY-MM-DDTHH:mm:ss） */
function toInputValue(t: number, tz: string): string {
  return formatDateTime(partsIn(t, tz)).replace(' ', 'T')
}

export default function TimestampPanel() {
  const id = useId()
  const now = useNow()
  const [tz, setTz] = useState(() => {
    const saved = store.load('tz', LOCAL_TZ)
    return allTimeZones().includes(saved) || saved === 'UTC' ? saved : LOCAL_TZ
  })
  const [input, setInput] = useState(() => String(Math.floor(Date.now() / 1000)))
  const [unit, setUnit] = useState<Unit>('auto')
  const [local, setLocal] = useState(() => toInputValue(Date.now(), tz))

  const changeTz = (v: string) => {
    setTz(v)
    store.save('tz', v)
  }

  const parsed = parseTimestamp(input, unit)
  const p = parsed ? partsIn(parsed.ms, tz) : null

  // 日期時間 → 時間戳
  const fromLocal = useMemo(() => {
    const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(local)
    if (!m) return null
    const [y, mo, d, h, mi, s = '0', ms = '0'] = m.slice(1)
    return zonedToEpoch({ y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +s, ms: +ms.padEnd(3, '0') }, tz)
  }, [local, tz])

  return (
    <div className="enc">
      <div className="gen-now">
        <div>
          <span className="muted">現在（秒）</span>
          <strong>{Math.floor(now / 1000)}</strong>
        </div>
        <div>
          <span className="muted">現在（毫秒）</span>
          <strong>{now}</strong>
        </div>
        <div className="gen-now-time">
          <span className="muted">{tz}</span>
          <strong>{formatDateTime(partsIn(now, tz))}</strong>
        </div>
        <div className="enc-actions">
          <CopyButton text={String(Math.floor(now / 1000))} />
        </div>
      </div>

      <label className="enc-field">
        時區
        <TimeZoneSelect id={`${id}-tz`} value={tz} onChange={changeTz} now={now} />
      </label>

      <h2 className="gen-h">時間戳 → 日期時間</h2>
      <div className="enc-controls">
        <div className="enc-field enc-grow">
          <label htmlFor={`${id}-ts`}>Unix 時間戳</label>
          <input
            id={`${id}-ts`}
            inputMode="numeric"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="例如 1793600000"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <Segmented label="單位" value={unit} options={UNITS} onChange={setUnit} />
        <button type="button" className="secondary gen-fit" onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>
          現在
        </button>
      </div>
      {input.trim() && !parsed && <p className="error enc-msg">請輸入整數，超出西元前後約 27 萬年的範圍也無法表示。</p>}
      {parsed && p && (
        <>
          {unit === 'auto' && <p className="muted enc-msg">判斷為{parsed.unit === 's' ? '秒' : '毫秒'}</p>}
          <ul className="enc-rows">
            <Row name="日期時間" value={`${formatDateTime(p, parsed.unit === 'ms')} ${weekday(p)}`} />
            <Row name="ISO 8601" value={isoIn(parsed.ms, tz)} />
            <Row name="UTC" value={new Date(parsed.ms).toISOString()} />
            <Row name="民國" value={rocDate(p)} />
            <Row name="相對時間" value={relative(parsed.ms, now)} />
            <Row name={parsed.unit === 's' ? '毫秒' : '秒'} value={String(parsed.unit === 's' ? parsed.ms : Math.floor(parsed.ms / 1000))} />
          </ul>
        </>
      )}

      <h2 className="gen-h">日期時間 → 時間戳</h2>
      <div className="enc-controls">
        <div className="enc-field enc-grow">
          <label htmlFor={`${id}-dt`}>{tz} 的日期時間</label>
          <input id={`${id}-dt`} type="datetime-local" step={1} value={local} onChange={(e) => setLocal(e.target.value)} />
        </div>
        <button type="button" className="secondary gen-fit" onClick={() => setLocal(toInputValue(Date.now(), tz))}>
          現在
        </button>
      </div>
      {fromLocal !== null && Number.isFinite(fromLocal) ? (
        <ul className="enc-rows">
          <Row name="秒" value={String(Math.floor(fromLocal / 1000))} />
          <Row name="毫秒" value={String(fromLocal)} />
          <Row name="ISO 8601" value={isoIn(fromLocal, tz)} />
          <Row name="UTC" value={new Date(fromLocal).toISOString()} />
        </ul>
      ) : (
        local && <p className="error enc-msg">日期時間格式不正確。</p>
      )}
    </div>
  )
}
