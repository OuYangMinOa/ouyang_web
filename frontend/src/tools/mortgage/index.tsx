import { useEffect, useState } from 'react'
import { schedule, yearly, type Method, type Plan, type RateSegment } from './calc'
import PaymentChart from './PaymentChart'
import './mortgage.css'

type SegmentText = { months: string; rate: string }

type Form = {
  /** 貸款金額（萬元） */
  amount: string
  years: string
  grace: number
  segments: SegmentText[]
}

const DEFAULT_FORM: Form = {
  amount: '1000',
  years: '30',
  grace: 0,
  segments: [{ months: '', rate: '2.2' }],
}

const STORE_KEY = 'tools:mortgage'
const MAX_YEARS = 50
const MAX_GRACE = 5

const METHODS: { value: Method; label: string; short: string }[] = [
  { value: 'annuity', label: '本息平均攤還', short: '本息' },
  { value: 'principal', label: '本金平均攤還', short: '本金' },
]

// 存檔可能是舊版或被改壞，型別不對就用預設值
function load(): Form {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return DEFAULT_FORM
    const s = JSON.parse(raw) as Partial<Form>
    const segments = Array.isArray(s.segments)
      ? s.segments.filter((x) => x && typeof x.months === 'string' && typeof x.rate === 'string').slice(0, 6)
      : []
    return {
      amount: typeof s.amount === 'string' ? s.amount : DEFAULT_FORM.amount,
      years: typeof s.years === 'string' ? s.years : DEFAULT_FORM.years,
      grace: typeof s.grace === 'number' && s.grace >= 0 && s.grace <= MAX_GRACE ? Math.trunc(s.grace) : 0,
      segments: segments.length ? segments : DEFAULT_FORM.segments,
    }
  } catch {
    return DEFAULT_FORM
  }
}

function num(text: string): number | null {
  const s = text.replace(/[,\s，]/g, '')
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null
  return Number(s)
}

const fmt = (n: number) => Math.round(n).toLocaleString('zh-TW')

export default function Mortgage() {
  const [form, setForm] = useState(load)
  const [tableMethod, setTableMethod] = useState<Method>('annuity')
  const [byYear, setByYear] = useState(true)

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(form))
    } catch {
      // 存不了就算了
    }
  }, [form])

  const amount = num(form.amount)
  const years = num(form.years)
  const months = years !== null ? Math.round(years * 12) : 0

  // 檢查輸入，整理出分段利率
  let error = ''
  const segments: RateSegment[] = []
  if (amount === null || amount <= 0) error = '請輸入貸款金額。'
  else if (years === null || months < 1 || years > MAX_YEARS) error = `貸款年限請輸入 1–${MAX_YEARS} 年。`
  else if (form.grace * 12 >= months) error = '寬限期要比貸款年限短。'
  else {
    for (const [i, s] of form.segments.entries()) {
      const rate = num(s.rate)
      const last = i === form.segments.length - 1
      const m = last ? 0 : num(s.months)
      if (rate === null || rate > 30) {
        error = `第 ${i + 1} 段的年利率不對。`
        break
      }
      if (!last && (m === null || m < 1 || !Number.isInteger(m))) {
        error = `第 ${i + 1} 段請輸入期數（整數個月）。`
        break
      }
      segments.push({ months: m ?? 0, rate })
    }
  }

  const loan = amount !== null ? amount * 10_000 : 0
  const graceMonths = form.grace * 12
  // 最多 600 期，每次重算也很快
  const plans = error
    ? null
    : {
        annuity: schedule(loan, months, graceMonths, segments, 'annuity'),
        principal: schedule(loan, months, graceMonths, segments, 'principal'),
      }

  const setSegment = (i: number, patch: Partial<SegmentText>) =>
    setForm((f) => ({ ...f, segments: f.segments.map((s, j) => (j === i ? { ...s, ...patch } : s)) }))
  const addSegment = () =>
    setForm((f) => {
      // 新的一段接在最後：原本的最後一段先給 12 期
      const segs = f.segments.map((s, i) => (i === f.segments.length - 1 && !s.months ? { ...s, months: '12' } : s))
      return { ...f, segments: [...segs, { months: '', rate: f.segments[f.segments.length - 1].rate }] }
    })
  const removeSegment = (i: number) => setForm((f) => ({ ...f, segments: f.segments.filter((_, j) => j !== i) }))

  // 每一段從第幾期開始，給標籤用
  const segmentStarts = form.segments.reduce<number[]>(
    (acc, _s, i) => [...acc, i === 0 ? 1 : acc[i - 1] + (num(form.segments[i - 1].months) ?? 0)],
    [],
  )

  return (
    <div className="mtg">
      <section className="card mtg-card">
        <div className="mtg-grid">
          <label>
            貸款金額（萬元）
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            />
          </label>
          <label>
            貸款年限（年）
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={form.years}
              onChange={(e) => setForm((f) => ({ ...f, years: e.target.value }))}
            />
          </label>
          <label>
            寬限期
            <select value={form.grace} onChange={(e) => setForm((f) => ({ ...f, grace: Number(e.target.value) }))}>
              {Array.from({ length: MAX_GRACE + 1 }, (_, n) => (
                <option key={n} value={n}>
                  {n === 0 ? '沒有寬限期' : `${n} 年（只繳利息）`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="mtg-rates">
          <legend>年利率{form.segments.length > 1 ? '（分段）' : ''}</legend>
          {form.segments.map((s, i) => {
            const last = i === form.segments.length - 1
            const from = segmentStarts[i]
            const m = num(s.months)
            return (
              <div key={i} className="mtg-seg-row">
                <span className="mtg-seg-label">
                  {form.segments.length === 1
                    ? '全期'
                    : last
                      ? `第 ${from} 期起`
                      : `第 ${from}${m ? `–${from + m - 1}` : ''} 期`}
                </span>
                {!last && (
                  <label className="mtg-seg-months">
                    <span className="mtg-sr">第 {i + 1} 段期數</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={s.months}
                      placeholder="12"
                      onChange={(e) => setSegment(i, { months: e.target.value })}
                    />
                    <span aria-hidden="true">個月</span>
                  </label>
                )}
                <label className="mtg-seg-rate">
                  <span className="mtg-sr">第 {i + 1} 段年利率</span>
                  <input type="text" inputMode="decimal" autoComplete="off" value={s.rate} onChange={(e) => setSegment(i, { rate: e.target.value })} />
                  <span aria-hidden="true">%</span>
                </label>
                {form.segments.length > 1 && (
                  <button type="button" className="secondary mtg-icon" onClick={() => removeSegment(i)} aria-label={`刪除第 ${i + 1} 段`} title="刪除">
                    ✕
                  </button>
                )}
              </div>
            )
          })}
          {form.segments.length < 6 && (
            <button type="button" className="secondary mtg-add" onClick={addSegment}>
              ＋ 新增分段利率
            </button>
          )}
        </fieldset>
        {error && <p className="error">{error}</p>}
      </section>

      {plans && (
        <>
          <section className="card mtg-card">
            <h2>比較</h2>
            <div className="mtg-compare">
              {METHODS.map((m) => (
                <Summary key={m.value} method={m.value} label={m.label} plan={plans[m.value]} graceMonths={graceMonths} />
              ))}
            </div>
            <p className="mtg-diff">
              本金平均攤還總利息少 <strong>{fmt(plans.annuity.totalInterest - plans.principal.totalInterest)}</strong> 元，但前期月付較高；本息平均攤還每月金額固定（利率不變時），前期壓力較小。
            </p>
            <PaymentChart
              series={METHODS.map((m) => ({ key: m.value, label: m.label, rows: plans[m.value].rows }))}
            />
          </section>

          <section className="card mtg-card">
            <div className="mtg-table-head">
              <h2>攤還表</h2>
              <div className="mtg-seg" role="radiogroup" aria-label="攤還方式">
                {METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={tableMethod === m.value}
                    className={tableMethod === m.value ? 'active' : undefined}
                    onClick={() => setTableMethod(m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="mtg-seg" role="radiogroup" aria-label="顯示方式">
                {(
                  [
                    [true, '每年'],
                    [false, '每月'],
                  ] as const
                ).map(([v, label]) => (
                  <button key={label} type="button" role="radio" aria-checked={byYear === v} className={byYear === v ? 'active' : undefined} onClick={() => setByYear(v)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <AmortTable plan={plans[tableMethod]} byYear={byYear} />
          </section>
        </>
      )}

      <p className="muted mtg-note">
        試算按月計息（月利率 = 年利率 ÷ 12），本息平均攤還在利率改變時以剩餘本金與期數重算月付金。實際金額依銀行的計息方式（例如按日計息）、尾數處理和手續費而略有不同，僅供參考。
      </p>
    </div>
  )
}

function Summary({ method, label, plan, graceMonths }: { method: Method; label: string; plan: Plan; graceMonths: number }) {
  const rows = plan.rows
  const first = rows[graceMonths]
  const max = Math.max(...rows.map((r) => r.payment))
  return (
    <div className={`mtg-sum ${method}`}>
      <h3>
        <span className={`mtg-swatch ${method}`} aria-hidden="true" />
        {label}
      </h3>
      <dl>
        {graceMonths > 0 && (
          <div>
            <dt>寬限期月付（只繳利息）</dt>
            <dd>{fmt(rows[0].payment)}</dd>
          </div>
        )}
        <div>
          <dt>{graceMonths > 0 ? '寬限期後第一期' : '第一期月付'}</dt>
          <dd className="big">{fmt(first.payment)}</dd>
        </div>
        <div>
          <dt>最後一期月付</dt>
          <dd>{fmt(rows[rows.length - 1].payment)}</dd>
        </div>
        {max > first.payment + 0.5 && (
          <div>
            <dt>最高月付</dt>
            <dd>{fmt(max)}</dd>
          </div>
        )}
        <div>
          <dt>總利息</dt>
          <dd className="big">{fmt(plan.totalInterest)}</dd>
        </div>
        <div>
          <dt>本金＋利息</dt>
          <dd>{fmt(plan.totalPayment)}</dd>
        </div>
      </dl>
    </div>
  )
}

function AmortTable({ plan, byYear }: { plan: Plan; byYear: boolean }) {
  const rows = byYear ? yearly(plan.rows) : plan.rows
  return (
    <div className="mtg-table-wrap" tabIndex={0} role="region" aria-label="攤還表">
      <table className="mtg-table">
        <thead>
          <tr>
            <th>{byYear ? '年' : '期'}</th>
            <th>利率</th>
            <th>{byYear ? '全年還款' : '月付'}</th>
            <th>本金</th>
            <th>利息</th>
            <th>剩餘本金</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.period}>
              <td>{'year' in r ? (r as { year: number }).year : r.period}</td>
              <td>{r.rate}%</td>
              <td>{fmt(r.payment)}</td>
              <td>{fmt(r.principal)}</td>
              <td>{fmt(r.interest)}</td>
              <td>{fmt(r.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
