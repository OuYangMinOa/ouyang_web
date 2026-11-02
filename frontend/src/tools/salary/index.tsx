import { useEffect, useState, type ReactNode } from 'react'
import { incomeTax, monthly, supplement } from './calc'
import {
  DATA_YEAR,
  HEALTH_MAX_DEPENDENTS,
  LABOR_GRADES,
  MIN_WAGE,
  OCC_RATES,
  PENSION_SELF_MAX,
  TAX,
} from './rates'
import './salary.css'

type Form = {
  salary: string
  insured: string
  dependents: number
  selfPension: number
  occ: number
  bonus: string
  married: boolean
  spouseSalary: string
  taxDependents: number
  seniors: number
  itemized: string
}

const DEFAULT_FORM: Form = {
  salary: '45000',
  insured: '',
  dependents: 0,
  selfPension: 0,
  occ: 0,
  bonus: '',
  married: false,
  spouseSalary: '',
  taxDependents: 0,
  seniors: 0,
  itemized: '',
}

const STORE_KEY = 'tools:salary'

// 存檔可能是舊版或被改壞，型別不對的欄位用預設值
function load(): Form {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return DEFAULT_FORM
    const s = JSON.parse(raw) as Record<string, unknown>
    const out = { ...DEFAULT_FORM }
    for (const k of Object.keys(DEFAULT_FORM) as (keyof Form)[]) {
      if (typeof s[k] === typeof DEFAULT_FORM[k]) Object.assign(out, { [k]: s[k] })
    }
    out.occ = Math.min(Math.max(0, Math.trunc(out.occ)), OCC_RATES.length - 1)
    out.selfPension = Math.min(Math.max(0, Math.trunc(out.selfPension)), PENSION_SELF_MAX)
    return out
  } catch {
    return DEFAULT_FORM
  }
}

/** 金額文字轉整數元；可以有千分位逗號，空白回傳 0，看不懂回傳 null */
function money(text: string): number | null {
  const s = text.replace(/[,\s，]/g, '')
  if (s === '') return 0
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  return Math.round(Number(s))
}

const fmt = (n: number) => n.toLocaleString('zh-TW')
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

export default function Salary() {
  const [form, setForm] = useState(load)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(form))
    } catch {
      // 存不了就算了
    }
  }, [form])

  const salary = money(form.salary)
  const insuredInput = money(form.insured)
  const bonus = money(form.bonus)
  const spouseSalary = money(form.spouseSalary)
  const itemized = money(form.itemized)

  const valid = salary !== null && salary > 0 && insuredInput !== null && bonus !== null && spouseSalary !== null && itemized !== null
  // 投保薪資沒填就用月薪；全時勞工不得低於基本工資
  const insured = valid ? Math.max(insuredInput || salary, MIN_WAGE) : 0
  const m = valid ? monthly({ salary, insured, dependents: form.dependents, selfPension: form.selfPension, occRate: OCC_RATES[form.occ].rate }) : null
  const supp = m && bonus ? supplement(bonus, m.grades.health) : null
  const annualSalary = valid ? salary * 12 + bonus : 0
  const tax = valid
    ? incomeTax({
        salary: annualSalary,
        selfPension: m!.pension.employee * 12,
        married: form.married,
        spouseSalary: spouseSalary,
        dependents: form.taxDependents,
        seniors: form.seniors,
        itemized: itemized,
      })
    : null

  return (
    <div className="sal">
      <p className="sal-disclaimer" role="note">
        ⚠️ 僅供參考：依 {DATA_YEAR} 年（民國 {DATA_YEAR - 1911} 年）公告的費率與級距概算，實際金額以勞保局、健保署的計費和國稅局核定為準。
      </p>

      <section className="card sal-card">
        <h2>月薪與投保</h2>
        <div className="sal-grid">
          <label>
            月薪（元）
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={form.salary}
              onChange={(e) => set('salary', e.target.value)}
              aria-invalid={salary === null || salary === 0}
            />
          </label>
          <label>
            投保薪資（選填）
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="跟月薪一樣"
              value={form.insured}
              onChange={(e) => set('insured', e.target.value)}
              aria-invalid={insuredInput === null}
            />
          </label>
          <label>
            健保眷屬人數
            <select value={form.dependents} onChange={(e) => set('dependents', Number(e.target.value))}>
              {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? '沒有眷屬' : `${n} 人`}
                  {n > HEALTH_MAX_DEPENDENTS ? `（以 ${HEALTH_MAX_DEPENDENTS} 人計）` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            行業（職災保險費率）
            <select value={form.occ} onChange={(e) => set('occ', Number(e.target.value))}>
              {OCC_RATES.map((o, i) => (
                <option key={o.label} value={i}>
                  {o.label}　{(o.rate / 100).toFixed(2)}%
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="sal-seg-wrap">
          <span className="sal-seg-label" id="sal-pension">
            勞退自提
          </span>
          <div className="sal-seg" role="radiogroup" aria-labelledby="sal-pension">
            {Array.from({ length: PENSION_SELF_MAX + 1 }, (_, n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={form.selfPension === n}
                className={form.selfPension === n ? 'active' : undefined}
                onClick={() => set('selfPension', n)}
              >
                {n}%
              </button>
            ))}
          </div>
        </div>

        {salary !== null && salary > 0 && salary < MIN_WAGE && (
          <p className="sal-warn">
            {DATA_YEAR} 年基本工資是 {fmt(MIN_WAGE)} 元，全時勞工的投保薪資不得低於這個數字，這裡以 {fmt(MIN_WAGE)}{' '}
            元計算（部分工時的級距不同）。
          </p>
        )}
        {!valid && <p className="error">請輸入正確的金額。</p>}
      </section>

      {m && (
        <section className="card sal-card">
          <h2>每月</h2>
          <div className="sal-big">
            <div>
              <span>實領</span>
              <strong>{fmt(m.net)}</strong>
              <span className="muted">自付 {fmt(m.deductions)} 元</span>
            </div>
            <div>
              <span>雇主每月總成本</span>
              <strong>{fmt(m.employerTotal)}</strong>
              <span className="muted">薪水以外再負擔 {fmt(m.employerCost)} 元</span>
            </div>
          </div>

          <div className="table-wrap">
            <table className="responsive sal-table">
              <thead>
                <tr>
                  <th>項目</th>
                  <th>投保級距</th>
                  <th>勞工自付</th>
                  <th>雇主負擔</th>
                </tr>
              </thead>
              <tbody>
                <Row name="勞保（普通事故 11.5%）" grade={m.grades.labor} employee={m.labor.employee} employer={m.labor.employer} />
                <Row name="就業保險（1%）" grade={m.grades.labor} employee={m.employment.employee} employer={m.employment.employer} />
                <Row
                  name={`健保（5.17%${m.health.heads > 1 ? `，本人＋眷屬 ${m.health.heads - 1} 人` : ''}）`}
                  grade={m.grades.health}
                  employee={m.health.employee}
                  employer={m.health.employer}
                />
                <Row
                  name={`勞退（雇主 6%${form.selfPension ? `、自提 ${form.selfPension}%` : ''}）`}
                  grade={m.grades.pension}
                  employee={m.pension.employee}
                  employer={m.pension.employer}
                />
                <Row name={`職災保險（${(OCC_RATES[form.occ].rate / 100).toFixed(2)}%）`} grade={m.grades.occ} employee={0} employer={m.occ} />
                <Row name="工資墊償基金（0.025%）" grade={m.grades.labor} employee={0} employer={m.arrears} />
                <tr className="sal-total">
                  <td className="primary">合計</td>
                  <td className="sal-empty" />
                  <td data-label="勞工自付">
                    <strong>{fmt(m.deductions)}</strong>
                  </td>
                  <td data-label="雇主負擔">
                    <strong>{fmt(m.employerCost)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul className="muted sal-notes">
            <li>勞保投保薪資最高 {fmt(LABOR_GRADES[LABOR_GRADES.length - 1])} 元、健保最高 313,000 元、勞退最高 150,000 元、職災最高 72,800 元。</li>
            <li>健保眷屬最多算 {HEALTH_MAX_DEPENDENTS} 人；雇主的健保負擔固定以本人加平均眷口數 0.56 人計算。</li>
            <li>勞退自提的錢存進你自己的個人專戶，而且不算進當年度的薪資所得。</li>
            <li>實領沒有扣每月預扣的所得稅、福利金等其他項目。</li>
          </ul>
        </section>
      )}

      {m && tax && (
        <section className="card sal-card">
          <h2>年度綜合所得稅概算</h2>
          <div className="sal-grid">
            <label>
              年終、獎金（全年合計）
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="0"
                value={form.bonus}
                onChange={(e) => set('bonus', e.target.value)}
                aria-invalid={bonus === null}
              />
            </label>
            <label>
              申報方式
              <select value={form.married ? '1' : '0'} onChange={(e) => set('married', e.target.value === '1')}>
                <option value="0">單身</option>
                <option value="1">夫妻合併申報</option>
              </select>
            </label>
            {form.married && (
              <label>
                配偶全年薪資
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="0"
                  value={form.spouseSalary}
                  onChange={(e) => set('spouseSalary', e.target.value)}
                  aria-invalid={spouseSalary === null}
                />
              </label>
            )}
            <label>
              受扶養親屬
              <select
                value={form.taxDependents}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  setForm((f) => ({ ...f, taxDependents: n, seniors: Math.min(f.seniors, n) }))
                }}
              >
                {Array.from({ length: 9 }, (_, n) => (
                  <option key={n} value={n}>
                    {n === 0 ? '沒有' : `${n} 人`}
                  </option>
                ))}
              </select>
            </label>
            {form.taxDependents > 0 && (
              <label>
                其中年滿 70 歲的直系尊親屬
                <select value={form.seniors} onChange={(e) => set('seniors', Number(e.target.value))}>
                  {Array.from({ length: form.taxDependents + 1 }, (_, n) => (
                    <option key={n} value={n}>
                      {n === 0 ? '沒有' : `${n} 人`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              列舉扣除額（選填）
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="比標準扣除額多才會採用"
                value={form.itemized}
                onChange={(e) => set('itemized', e.target.value)}
                aria-invalid={itemized === null}
              />
            </label>
          </div>

          <div className="sal-big">
            <div>
              <span>{TAX.year} 年度應納稅額（概算）</span>
              <strong>{fmt(tax.tax)}</strong>
              <span className="muted">
                適用稅率 {tax.marginal}%，約占全年薪資 {annualSalary + (form.married ? spouseSalary! : 0) > 0 ? pct(tax.tax / (annualSalary + (form.married ? spouseSalary! : 0))) : '0%'}
              </span>
            </div>
            <div>
              <span>全年實領（扣稅後）</span>
              <strong>{fmt(m.net * 12 + bonus! - (supp?.fee ?? 0) - tax.tax)}</strong>
              <span className="muted">月實領 × 12 ＋ 獎金 − 補充保費 − 所得稅</span>
            </div>
          </div>

          <dl className="sal-steps">
            <Step label="本人全年薪資" value={annualSalary}>
              月薪 {fmt(salary!)} × 12{bonus ? ` ＋ 獎金 ${fmt(bonus)}` : ''}
            </Step>
            {m.pension.employee > 0 && (
              <Step label="減：勞退自提（免稅）" value={-m.pension.employee * 12}>
                {fmt(m.pension.employee)} × 12
              </Step>
            )}
            <Step label="薪資所得合計" value={tax.salaryIncome}>
              每人減除薪資所得特別扣除額（上限 {fmt(TAX.salaryDeduction)}）{form.married ? '，含配偶' : ''}
            </Step>
            <Step label="減：免稅額" value={-tax.exemption}>
              {tax.people} 人，每人 {fmt(TAX.exemption)}
              {form.seniors > 0 ? `（70 歲以上 ${fmt(TAX.exemptionSenior)}）` : ''}
            </Step>
            <Step label={`減：${tax.usedItemized ? '列舉' : '標準'}扣除額`} value={-tax.general}>
              {tax.usedItemized ? '列舉扣除額比標準扣除額多' : `${form.married ? '有配偶' : '單身'} ${fmt(tax.standard)}`}
            </Step>
            {tax.basicDiff > 0 && (
              <Step label="減：基本生活費差額" value={-tax.basicDiff}>
                {tax.people} 人 × {fmt(TAX.basicLiving)} − 免稅額 − 扣除額
              </Step>
            )}
            <Step label="綜合所得淨額" value={tax.net} strong />
          </dl>
          {supp && supp.fee > 0 && (
            <p className="sal-warn">
              獎金超過健保投保金額 4 倍（{fmt(m.grades.health * 4)}）的部分 {fmt(supp.base)} 元，要另扣二代健保補充保費 2.11%，約 {fmt(supp.fee)} 元。
            </p>
          )}

          <details className="sal-brackets">
            <summary>{TAX.year} 年度課稅級距</summary>
            <table className="sal-bracket-table">
              <tbody>
                {TAX.brackets.map(([upper, rate], i) => {
                  const lower = i === 0 ? 0 : TAX.brackets[i - 1][0]
                  return (
                    <tr key={rate} className={rate === tax.marginal ? 'active' : undefined}>
                      <td>{upper === Infinity ? `${fmt(lower + 1)} 以上` : `${i === 0 ? '0' : fmt(lower + 1)} – ${fmt(upper)}`}</td>
                      <td>{rate}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </details>
          <ul className="muted sal-notes">
            <li>
              只計算薪資所得；沒有算利息、股利、租賃等其他所得，也沒有算幼兒學前、長期照顧、房屋租金、身心障礙等特別扣除額。
            </li>
            <li>
              免稅額 {fmt(TAX.exemption)}、標準扣除額 {fmt(TAX.standardSingle)}／{fmt(TAX.standardMarried)}、薪資特別扣除額 {fmt(TAX.salaryDeduction)}{' '}
              依財政部公告的 {TAX.year} 年度金額（{TAX.year + 1} 年 5 月申報）；基本生活費 {TAX.year} 年度尚未公告，暫用{' '}
              {TAX.basicLivingYear} 年度的每人 {fmt(TAX.basicLiving)} 元。
            </li>
          </ul>
        </section>
      )}
    </div>
  )
}

function Row({ name, grade, employee, employer }: { name: string; grade: number; employee: number; employer: number }) {
  return (
    <tr>
      <td className="primary">{name}</td>
      <td data-label="投保級距">{fmt(grade)}</td>
      <td data-label="勞工自付">{employee ? fmt(employee) : '—'}</td>
      <td data-label="雇主負擔">{fmt(employer)}</td>
    </tr>
  )
}

function Step({ label, value, strong, children }: { label: string; value: number; strong?: boolean; children?: ReactNode }) {
  return (
    <div className={strong ? 'strong' : undefined}>
      <dt>
        {label}
        {children && <small>{children}</small>}
      </dt>
      <dd>{value < 0 ? `−${fmt(-value)}` : fmt(value)}</dd>
    </div>
  )
}
