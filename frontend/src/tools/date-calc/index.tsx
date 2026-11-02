import { useState, type ReactNode } from 'react'
import { fromDay, MAX_YEAR, MIN_YEAR, today, weekday, type Day } from '../../calendar/dates'
import { isDayOff, marksOf } from '../../calendar/holidays'
import { ganzhiYear, lunarLabel, lunarOf, zodiac } from '../../calendar/lunar'
import {
  addMonths,
  inRange,
  makeDay,
  monthsBetween,
  parseIso,
  parseRoc,
  rocLabel,
  rocText,
  rocYearLabel,
  starSign,
  toIso,
  westLabel,
  YEAR_MAX,
  YEAR_MIN,
} from './dateMath'
import './date-calc.css'

type Tab = 'roc' | 'add' | 'diff' | 'age' | 'work'

const TABS: { value: Tab; label: string }[] = [
  { value: 'roc', label: '民國／西元' },
  { value: 'add', label: '日期加減' },
  { value: 'diff', label: '相差天數' },
  { value: 'age', label: '年齡' },
  { value: 'work', label: '工作天' },
]

const STORE_KEY = 'tools:date-calc:tab'

function loadTab(): Tab {
  try {
    const t = localStorage.getItem(STORE_KEY)
    return TABS.some((x) => x.value === t) ? (t as Tab) : 'roc'
  } catch {
    return 'roc'
  }
}

const fmt = (n: number) => n.toLocaleString('zh-TW')

export default function DateCalc() {
  const [tab, setTab] = useState(loadTab)
  const choose = (t: Tab) => {
    setTab(t)
    try {
      localStorage.setItem(STORE_KEY, t)
    } catch {
      // 存不了就算了
    }
  }

  return (
    <div className="dc">
      <div className="dc-tabs" role="tablist" aria-label="計算項目">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={t.value === tab}
            className={t.value === tab ? 'active' : undefined}
            onClick={() => choose(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'roc' && <RocPanel />}
      {tab === 'add' && <AddPanel />}
      {tab === 'diff' && <DiffPanel />}
      {tab === 'age' && <AgePanel />}
      {tab === 'work' && <WorkPanel />}
    </div>
  )
}

/** 西元日期選擇器；值是 YYYY-MM-DD 字串 */
function DateField({ label, value, onChange, min, max }: { label: string; value: string; onChange: (v: string) => void; min?: string; max?: string }) {
  return (
    <label className="dc-field">
      {label}
      <input type="date" value={value} min={min ?? '0001-01-01'} max={max ?? '9999-12-31'} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function Result({ main, sub, children }: { main: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="dc-result" aria-live="polite">
      <strong>{main}</strong>
      {sub && <span>{sub}</span>}
      {children}
    </div>
  )
}

const TODAY_ISO = () => toIso(today())

/* ---- 民國／西元 ---- */

function RocPanel() {
  const now = fromDay(today())
  const [west, setWest] = useState(String(now.year))
  const [roc, setRoc] = useState(String(now.year - 1911))
  const [before, setBefore] = useState(false)
  const [iso, setIso] = useState(TODAY_ISO)
  const [rocDate, setRocDate] = useState(() => rocText(today()))

  const westYear = /^\d{1,4}$/.test(west.trim()) ? Number(west) : null
  const yearOk = westYear !== null && westYear >= YEAR_MIN && westYear <= YEAR_MAX

  const onWest = (v: string) => {
    setWest(v)
    const y = Number(v)
    if (/^\d{1,4}$/.test(v.trim()) && y >= YEAR_MIN) {
      setRoc(String(y >= 1912 ? y - 1911 : 1912 - y))
      setBefore(y < 1912)
    }
  }
  // 民國 0 年不存在：民國 1 年是 1912，民國前 1 年是 1911
  const syncRoc = (v: string, b: boolean) => {
    const n = Number(v)
    if (!/^\d{1,4}$/.test(v.trim()) || n === 0) return
    const y = b ? 1912 - n : n + 1911
    if (y >= YEAR_MIN && y <= YEAR_MAX) setWest(String(y))
  }
  const onRoc = (v: string) => {
    setRoc(v)
    syncRoc(v, before)
  }
  const onBefore = (b: boolean) => {
    setBefore(b)
    syncRoc(roc, b)
  }

  const isoDay = parseIso(iso)
  const rocDay = parseRoc(rocDate)
  const onIso = (v: string) => {
    setIso(v)
    const d = parseIso(v)
    if (d !== null) setRocDate(rocText(d))
  }
  const onRocDate = (v: string) => {
    setRocDate(v)
    const d = parseRoc(v)
    if (d !== null) setIso(toIso(d))
  }

  return (
    <>
      <section className="card dc-card">
        <h2>年份</h2>
        <div className="dc-pair">
          <label className="dc-field">
            西元
            <input type="text" inputMode="numeric" autoComplete="off" value={west} onChange={(e) => onWest(e.target.value)} />
          </label>
          <span className="dc-eq" aria-hidden="true">
            ⇄
          </span>
          <div className="dc-field">
            <label htmlFor="dc-roc">{before ? '民國前' : '民國'}</label>
            <div className="dc-roc">
              <input id="dc-roc" type="text" inputMode="numeric" autoComplete="off" value={roc} onChange={(e) => onRoc(e.target.value)} />
              <label className="dc-check">
                <input type="checkbox" checked={before} onChange={(e) => onBefore(e.target.checked)} />
                <span>民國前</span>
              </label>
            </div>
          </div>
        </div>
        {yearOk ? (
          <p className="muted dc-note">
            西元 {westYear} 年 = {rocYearLabel(westYear)}，{ganzhiYear(westYear)}（生肖{zodiac(westYear)}）
            {westYear % 4 === 0 && (westYear % 100 !== 0 || westYear % 400 === 0) ? '，閏年' : ''}
          </p>
        ) : (
          <p className="error dc-note">請輸入 1–9999 的西元年，或民國年。</p>
        )}
        <p className="muted dc-note">民國年 = 西元年 − 1911；1912 年以前勾選「民國前」，例如民國前 1 年是 1911 年。</p>
      </section>

      <section className="card dc-card">
        <h2>日期</h2>
        <div className="dc-pair">
          <DateField label="西元日期" value={iso} onChange={onIso} />
          <span className="dc-eq" aria-hidden="true">
            ⇄
          </span>
          <label className="dc-field">
            民國日期
            <input
              type="text"
              inputMode="text"
              autoComplete="off"
              placeholder="115/11/2"
              value={rocDate}
              onChange={(e) => onRocDate(e.target.value)}
              aria-invalid={rocDate.trim() !== '' && rocDay === null}
            />
          </label>
        </div>
        {rocDate.trim() !== '' && rocDay === null ? (
          <p className="error dc-note">看不懂這個民國日期，可以寫成 115/11/2、115.11.2、115年11月2日或 1151102。</p>
        ) : isoDay !== null ? (
          <Result main={rocLabel(isoDay)} sub={westLabel(isoDay)} />
        ) : null}
      </section>
    </>
  )
}

/* ---- 日期加減 ---- */

type Unit = 'day' | 'week' | 'month' | 'year'
const UNITS: { value: Unit; label: string }[] = [
  { value: 'day', label: '天' },
  { value: 'week', label: '週' },
  { value: 'month', label: '個月' },
  { value: 'year', label: '年' },
]

function AddPanel() {
  const [start, setStart] = useState(TODAY_ISO)
  const [sign, setSign] = useState<1 | -1>(1)
  const [amount, setAmount] = useState('30')
  const [unit, setUnit] = useState<Unit>('day')

  const startDay = parseIso(start)
  const n = /^\d{1,6}$/.test(amount.trim()) ? Number(amount) * sign : null
  let result: Day | null = null
  if (startDay !== null && n !== null) {
    result =
      unit === 'day' ? startDay + n : unit === 'week' ? startDay + n * 7 : addMonths(startDay, unit === 'month' ? n : n * 12)
  }
  const ok = result !== null && inRange(result)
  const clamped = ok && (unit === 'month' || unit === 'year') && startDay !== null && fromDay(result!).day !== fromDay(startDay).day

  return (
    <section className="card dc-card">
      <div className="dc-row">
        <DateField label="開始日期" value={start} onChange={setStart} />
        <button type="button" className="secondary dc-today" onClick={() => setStart(TODAY_ISO())}>
          今天
        </button>
      </div>
      <div className="dc-row">
        <div className="dc-seg" role="radiogroup" aria-label="往後或往前">
          {(
            [
              [1, '＋ 往後'],
              [-1, '－ 往前'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={sign === v} className={sign === v ? 'active' : undefined} onClick={() => setSign(v)}>
              {label}
            </button>
          ))}
        </div>
        <label className="dc-field dc-num">
          <span className="dc-sr">數量</span>
          <input type="text" inputMode="numeric" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="dc-field dc-unit">
          <span className="dc-sr">單位</span>
          <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
            {UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {startDay === null ? (
        <p className="error dc-note">請選擇開始日期。</p>
      ) : n === null ? (
        <p className="error dc-note">請輸入整數。</p>
      ) : !ok ? (
        <p className="error dc-note">結果超出西元 1–9999 年的範圍。</p>
      ) : (
        <Result main={westLabel(result!)} sub={rocLabel(result!)}>
          {unit === 'day' && n !== 0 && (
            <span className="muted">若開始日算第 1 天，則是 {westLabel(result! - sign)}</span>
          )}
          {clamped && <span className="muted">那個月沒有 {fromDay(startDay).day} 日，所以用月底。</span>}
        </Result>
      )}
    </section>
  )
}

/* ---- 相差天數 ---- */

function spanText(months: number, days: number) {
  const y = Math.floor(months / 12)
  const m = months % 12
  const parts = []
  if (y) parts.push(`${y} 年`)
  if (m) parts.push(`${m} 個月`)
  if (days || parts.length === 0) parts.push(`${days} 天`)
  return parts.join(' ')
}

function DiffPanel() {
  const [a, setA] = useState(TODAY_ISO)
  // 預設算到今年年底
  const [b, setB] = useState(() => toIso(makeDay(fromDay(today()).year, 12, 31)))

  const da = parseIso(a)
  const db = parseIso(b)
  const valid = da !== null && db !== null
  const [lo, hi] = valid ? (da <= db ? [da, db] : [db, da]) : [0, 0]
  const days = hi - lo
  const span = valid ? monthsBetween(lo, hi) : null

  return (
    <section className="card dc-card">
      <div className="dc-pair">
        <DateField label="開始日期" value={a} onChange={setA} />
        <button type="button" className="secondary dc-swap" onClick={() => (setA(b), setB(a))} aria-label="對調兩個日期" title="對調">
          ⇄
        </button>
        <DateField label="結束日期" value={b} onChange={setB} />
      </div>
      {!valid ? (
        <p className="error dc-note">請選擇兩個日期。</p>
      ) : (
        <>
          <Result main={`相差 ${fmt(days)} 天`} sub={`含頭尾共 ${fmt(days + 1)} 天`} />
          <dl className="dc-facts">
            <div>
              <dt>週數</dt>
              <dd>
                {fmt(Math.floor(days / 7))} 週{days % 7 ? ` ${days % 7} 天` : ''}
              </dd>
            </div>
            <div>
              <dt>年月日</dt>
              <dd>{spanText(span!.months, span!.days)}</dd>
            </div>
            <div>
              <dt>月數</dt>
              <dd>
                {fmt(span!.months)} 個月{span!.days ? ` ${span!.days} 天` : ''}
              </dd>
            </div>
            <div>
              <dt>小時</dt>
              <dd>{fmt(days * 24)} 小時</dd>
            </div>
          </dl>
          {da !== null && db !== null && da > db && <p className="muted dc-note">結束日期比開始日期早，已用兩者的差距計算。</p>}
        </>
      )}
    </section>
  )
}

/* ---- 年齡 ---- */

function AgePanel() {
  const [birth, setBirth] = useState('2000-01-01')
  const [ref, setRef] = useState(TODAY_ISO)

  const b = parseIso(birth)
  const r = parseIso(ref)

  let body: ReactNode
  if (b === null || r === null) {
    body = <p className="error dc-note">請選擇生日和計算日期。</p>
  } else if (b > r) {
    body = <p className="error dc-note">生日比計算日期晚。</p>
  } else {
    const { months, days } = monthsBetween(b, r)
    const years = Math.floor(months / 12)
    // 虛歲：出生就算 1 歲，每過一次農曆新年加 1 歲
    const lb = lunarOf(b)
    const lr = lunarOf(r)
    const nominal = lb && lr ? lr.year - lb.year + 1 : null
    // 下一次生日（2/29 出生的人，平年用 2/28）
    const next = addMonths(b, (years + 1) * 12)
    const birthdayToday = addMonths(b, years * 12) === r
    body = (
      <>
        <Result main={`${years} 足歲`} sub={`${spanText(months, days)}`}>
          {nominal !== null ? (
            <span className="muted">虛歲 {nominal} 歲（出生算 1 歲，每過農曆新年加 1 歲）</span>
          ) : (
            <span className="muted">虛歲需要農曆資料，只支援 1900–2100 年。</span>
          )}
        </Result>
        <dl className="dc-facts">
          <div>
            <dt>已經過了</dt>
            <dd>{fmt(r - b)} 天</dd>
          </div>
          <div>
            <dt>下次生日</dt>
            <dd>{birthdayToday ? '就是今天 🎂' : `${fmt(next - r)} 天後（${westLabel(next)}）`}</dd>
          </div>
          <div>
            <dt>出生</dt>
            <dd>
              {westLabel(b)}
              {lb && `，農曆${lunarLabel(lb)}`}
            </dd>
          </div>
          <div>
            <dt>生肖・星座</dt>
            <dd>
              {lb ? `${ganzhiYear(lb.year)}・${zodiac(lb.year)}` : '—'}・{starSign(b)}
            </dd>
          </div>
        </dl>
      </>
    )
  }

  return (
    <section className="card dc-card">
      <div className="dc-pair">
        <DateField label="生日" value={birth} onChange={setBirth} />
        <DateField label="計算到" value={ref} onChange={setRef} />
      </div>
      {body}
      <p className="muted dc-note">生肖以農曆新年為界：國曆一、二月出生的人可能屬前一年的生肖。</p>
    </section>
  )
}

/* ---- 工作天 ---- */

const WORK_MIN = `${MIN_YEAR}-01-01`
const WORK_MAX = `${MAX_YEAR}-12-31`

type Special = { day: Day; name: string; off: boolean }

/** 平日放假（國定假日、補假、調整放假）和週末補班 */
function specialOf(day: Day): Special | null {
  const marks = marksOf(day)
  const w = weekday(day)
  const weekend = w === 0 || w === 6
  const off = isDayOff(day, marks)
  if (!weekend && off) {
    const h = marks.find((m) => m.kind === 'holiday')
    return { day, name: h ? (h.detail ? `${h.detail}補假` : h.name) : '放假', off: true }
  }
  if (weekend && !off) {
    const wk = marks.find((m) => m.kind === 'workday')
    return { day, name: wk?.name ?? '補班', off: false }
  }
  return null
}

function inWorkRange(day: Day) {
  const { year } = fromDay(day)
  return year >= MIN_YEAR && year <= MAX_YEAR
}

function WorkPanel() {
  const [mode, setMode] = useState<'count' | 'add'>('count')
  const [a, setA] = useState(TODAY_ISO)
  const [b, setB] = useState(() => toIso(today() + 30))
  const [n, setN] = useState('10')

  return (
    <section className="card dc-card">
      <div className="dc-seg" role="radiogroup" aria-label="計算方式">
        {(
          [
            ['count', '兩個日期之間有幾個工作天'],
            ['add', '幾個工作天後是哪天'],
          ] as const
        ).map(([v, label]) => (
          <button key={v} type="button" role="radio" aria-checked={mode === v} className={mode === v ? 'active' : undefined} onClick={() => setMode(v)}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'count' ? <WorkCount a={a} b={b} setA={setA} setB={setB} /> : <WorkAdd a={a} setA={setA} n={n} setN={setN} />}

      <p className="muted dc-note">
        扣掉週六、週日和國定假日（含補假、調整放假），加回補班日。假日資料跟「日曆」APP 一樣，支援 {MIN_YEAR}–{MAX_YEAR}{' '}
        年；人事行政總處每年公告的調整放假與補班若有更動，請以公告為準。
      </p>
    </section>
  )
}

function SpecialList({ items }: { items: Special[] }) {
  if (items.length === 0) return <p className="muted dc-note">這段期間平日沒有放假，也沒有補班。</p>
  const shown = items.slice(0, 60)
  return (
    <details className="dc-specials" open={items.length <= 12}>
      <summary>
        平日放假 {items.filter((s) => s.off).length} 天、補班 {items.filter((s) => !s.off).length} 天
      </summary>
      <ul>
        {shown.map((s) => (
          <li key={s.day} className={s.off ? 'off' : 'work'}>
            <span className="dc-specials-date">{toIso(s.day)}（{'日一二三四五六'[weekday(s.day)]}）</span>
            <span>
              {s.name}
              {s.off ? '' : '（上班）'}
            </span>
          </li>
        ))}
      </ul>
      {items.length > shown.length && <p className="muted">……還有 {items.length - shown.length} 天沒有列出</p>}
    </details>
  )
}

function WorkCount({ a, b, setA, setB }: { a: string; b: string; setA: (v: string) => void; setB: (v: string) => void }) {
  const da = parseIso(a)
  const db = parseIso(b)

  let body: ReactNode = null
  if (da === null || db === null) {
    body = <p className="error dc-note">請選擇兩個日期。</p>
  } else if (!inWorkRange(da) || !inWorkRange(db)) {
    body = (
      <p className="error dc-note">
        假日資料只支援 {MIN_YEAR}–{MAX_YEAR} 年。
      </p>
    )
  } else {
    const [lo, hi] = da <= db ? [da, db] : [db, da]
    let work = 0
    const specials: Special[] = []
    for (let d = lo; d <= hi; d++) {
      if (!isDayOff(d)) work++
      const s = specialOf(d)
      if (s) specials.push(s)
    }
    const total = hi - lo + 1
    body = (
      <>
        <Result main={`${fmt(work)} 個工作天`} sub={`含頭尾共 ${fmt(total)} 天，放假 ${fmt(total - work)} 天`} />
        <SpecialList items={specials} />
      </>
    )
  }

  return (
    <>
      <div className="dc-pair">
        <DateField label="開始日期（含）" value={a} onChange={setA} min={WORK_MIN} max={WORK_MAX} />
        <DateField label="結束日期（含）" value={b} onChange={setB} min={WORK_MIN} max={WORK_MAX} />
      </div>
      {body}
    </>
  )
}

function WorkAdd({ a, setA, n, setN }: { a: string; setA: (v: string) => void; n: string; setN: (v: string) => void }) {
  const [dir, setDir] = useState<1 | -1>(1)
  const start = parseIso(a)
  const count = /^\d{1,5}$/.test(n.trim()) ? Number(n) : null

  let body: ReactNode = null
  if (start === null) {
    body = <p className="error dc-note">請選擇開始日期。</p>
  } else if (count === null) {
    body = <p className="error dc-note">請輸入工作天數（整數）。</p>
  } else if (!inWorkRange(start)) {
    body = (
      <p className="error dc-note">
        假日資料只支援 {MIN_YEAR}–{MAX_YEAR} 年。
      </p>
    )
  } else {
    // 開始日不算，從下一天開始數第 count 個工作天
    let d = start
    let left = count
    const specials: Special[] = []
    let ok = true
    while (left > 0) {
      d += dir
      if (!inWorkRange(d)) {
        ok = false
        break
      }
      if (!isDayOff(d)) left--
      const s = specialOf(d)
      if (s) specials.push(s)
    }
    body = ok ? (
      <>
        <Result main={westLabel(d)} sub={rocLabel(d)}>
          <span className="muted">
            {dir === 1 ? '往後' : '往前'}共 {fmt(Math.abs(d - start))} 個日曆天（開始日不算）
          </span>
        </Result>
        {count > 0 && <SpecialList items={dir === 1 ? specials : [...specials].reverse()} />}
      </>
    ) : (
      <p className="error dc-note">
        超出 {MIN_YEAR}–{MAX_YEAR} 年的範圍。
      </p>
    )
  }

  return (
    <>
      <DateField label="開始日期（不算在內）" value={a} onChange={setA} min={WORK_MIN} max={WORK_MAX} />
      <div className="dc-row">
        <div className="dc-seg" role="radiogroup" aria-label="往後或往前">
          {(
            [
              [1, '＋ 往後'],
              [-1, '－ 往前'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={dir === v} className={dir === v ? 'active' : undefined} onClick={() => setDir(v)}>
              {label}
            </button>
          ))}
        </div>
        <label className="dc-field dc-num">
          <span className="dc-sr">工作天數</span>
          <input type="text" inputMode="numeric" autoComplete="off" value={n} onChange={(e) => setN(e.target.value)} />
        </label>
        <span className="dc-suffix">個工作天</span>
      </div>
      {body}
    </>
  )
}
