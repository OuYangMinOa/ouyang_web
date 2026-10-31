import { useEffect, useMemo, useState } from 'react'
import { RANGES, convert, isoDate, pairDate, persist, store, useRates, useSeries, type Range } from './api'
import { POPULAR, currencyName, evaluate, flag, formatAmount, formatRate, isExpression, isListed, optionLabel } from './currencies'
import TrendChart from './TrendChart'
import './currency.css'

type Prefs = {
  base: string
  targets: string[]
  /** 走勢圖要看哪一個目標貨幣 */
  chart: string
  range: Range
}

const DEFAULT_PREFS: Prefs = {
  base: 'TWD',
  targets: ['USD', 'JPY', 'EUR', 'KRW', 'CNY', 'HKD'],
  chart: 'USD',
  range: '3m',
}

const isCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v)

// 存檔可能是舊版或被改壞，逐欄檢查
function loadPrefs(): Prefs {
  const p = store<Partial<Prefs> | null>('prefs', null)
  if (!p || typeof p !== 'object') return DEFAULT_PREFS
  const base = isCode(p.base) ? p.base : DEFAULT_PREFS.base
  const targets = Array.isArray(p.targets)
    ? [...new Set(p.targets.filter(isCode))].filter((c) => c !== base)
    : DEFAULT_PREFS.targets.filter((c) => c !== base)
  return {
    base,
    targets,
    chart: isCode(p.chart) ? p.chart : (targets[0] ?? ''),
    range: RANGES.some((r) => r.value === p.range) ? (p.range as Range) : DEFAULT_PREFS.range,
  }
}

/** 選單內容：常用的排前面，其餘照代碼排 */
function CurrencyOptions({ codes }: { codes: string[] }) {
  const set = new Set(codes)
  const popular = POPULAR.filter((c) => set.has(c))
  const rest = codes.filter((c) => !POPULAR.includes(c)).sort()
  return (
    <>
      {popular.length > 0 && (
        <optgroup label="常用">
          {popular.map((c) => (
            <option key={c} value={c}>
              {optionLabel(c)}
            </option>
          ))}
        </optgroup>
      )}
      {rest.length > 0 && (
        <optgroup label="全部">
          {rest.map((c) => (
            <option key={c} value={c}>
              {optionLabel(c)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  )
}

export default function Currency() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [amountText, setAmountText] = useState(() => {
    const saved = store<unknown>('amount', '1000')
    return typeof saved === 'string' ? saved : '1000'
  })
  const [date, setDate] = useState<string | null>(null)
  const [today] = useState(() => isoDate(new Date()))
  const rates = useRates(date)
  const { base, targets, range } = prefs
  const chartQuote = targets.includes(prefs.chart) ? prefs.chart : targets[0]
  const series = useSeries(base, chartQuote ?? base, range)

  useEffect(() => persist('prefs', prefs), [prefs])
  useEffect(() => persist('amount', amountText), [amountText])

  const table = rates.table
  const amount = evaluate(amountText)

  // 可選的貨幣：有匯率表就用表裡的，還沒載入前先列常用的
  const allCodes = useMemo(() => {
    const codes = table ? Object.keys(table.rates).filter(isListed) : POPULAR
    return [...new Set([...codes, base, ...targets])]
  }, [table, base, targets])
  const addable = allCodes.filter((c) => c !== base && !targets.includes(c))

  // 設為基準：如果它原本在清單裡，就跟原本的基準對調位置
  const makeBase = (code: string) => {
    if (code === base) return
    setPrefs((p) => {
      if (!p.targets.includes(code)) return { ...p, base: code }
      return {
        ...p,
        base: code,
        targets: p.targets.map((c) => (c === code ? p.base : c)),
        chart: p.chart === code ? p.base : p.chart,
      }
    })
  }
  const addTarget = (code: string) => {
    if (!code) return
    setPrefs((p) => (p.targets.includes(code) || p.base === code ? p : { ...p, targets: [...p.targets, code] }))
  }
  const removeTarget = (code: string) => setPrefs((p) => ({ ...p, targets: p.targets.filter((c) => c !== code) }))

  const baseName = currencyName(base)
  const baseMissing = table !== null && !table.rates[base]

  return (
    <div className="fx">
      <section className="card fx-panel">
        <div className="fx-top">
          <label className="fx-amount">
            金額
            <input
              type="text"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              placeholder="例如 1,000 或 100*3"
              aria-describedby="fx-amount-hint"
            />
          </label>
          <div className="fx-from">
            <label>
              貨幣
              <select value={base} onChange={(e) => makeBase(e.target.value)}>
                <CurrencyOptions codes={allCodes} />
              </select>
            </label>
            <button
              type="button"
              className="secondary fx-swap"
              onClick={() => targets[0] && makeBase(targets[0])}
              disabled={!targets[0]}
              title={targets[0] ? `和 ${targets[0]} 對調` : undefined}
              aria-label={targets[0] ? `${base} 和 ${targets[0]} 對調` : '對調'}
            >
              ⇅
            </button>
          </div>
        </div>
        <p id="fx-amount-hint" className={`fx-hint${amountText.trim() && amount === null ? ' error' : ''}`}>
          {amountText.trim() === ''
            ? '輸入金額，可以用 + − × ÷ 算式'
            : amount === null
              ? '看不懂這個金額，請輸入數字或像 100*3 的算式'
              : isExpression(amountText)
                ? `= ${formatAmount(amount, base)} ${base}`
                : `${baseName || base}`}
        </p>

        <Status rates={rates} date={date} />
        {baseMissing && <p className="error">這一天沒有 {base} 的匯率，請換一個日期或貨幣。</p>}

        {targets.length === 0 ? (
          <p className="muted fx-empty">從下面加入要換算的貨幣。</p>
        ) : (
          <ul className="fx-list">
            {targets.map((code) => {
              const value = table && amount !== null ? convert(table, amount, base, code) : null
              const rate = table ? convert(table, 1, base, code) : null
              const rowDate = table && rate !== null ? pairDate(table, base, code) : null
              const name = currencyName(code)
              return (
                <li key={code} className="fx-item">
                  <button
                    type="button"
                    className={`fx-row${code === chartQuote ? ' charted' : ''}`}
                    onClick={() => makeBase(code)}
                    title="點一下改用這個貨幣當基準"
                  >
                    <span className="fx-flag" aria-hidden="true">
                      {flag(code)}
                    </span>
                    <span className="fx-cur">
                      <strong>{code}</strong>
                      {name && <span className="fx-name">{name}</span>}
                    </span>
                    <span className="fx-val">
                      <strong>{value === null ? '—' : formatAmount(value, code)}</strong>
                      <span className="fx-rate">
                        {rate === null
                          ? table
                            ? '這一天沒有資料'
                            : ''
                          : `1 ${base} = ${formatRate(rate)} ${code}`}
                        {rowDate && table && rowDate !== table.date && ` · ${rowDate}`}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="secondary fx-remove"
                    onClick={() => removeTarget(code)}
                    aria-label={`移除 ${name || code}`}
                    title="移除"
                  >
                    ✕
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <label className="fx-add">
          <span className="fx-sr">加入貨幣</span>
          <select value="" onChange={(e) => addTarget(e.target.value)} disabled={addable.length === 0}>
            <option value="">＋ 加入貨幣…</option>
            <CurrencyOptions codes={addable} />
          </select>
        </label>

        <div className="fx-date">
          <label>
            換算日期
            <input
              type="date"
              value={date ?? ''}
              max={today}
              onChange={(e) => setDate(e.target.value && e.target.value < today ? e.target.value : null)}
            />
          </label>
          {date && (
            <button type="button" className="secondary" onClick={() => setDate(null)}>
              回到最新匯率
            </button>
          )}
        </div>
      </section>

      {chartQuote && (
        <section className="card fx-trend">
          <div className="fx-trend-head">
            <h2>走勢</h2>
            <label className="fx-pair">
              <span className="fx-sr">走勢的目標貨幣</span>
              <span aria-hidden="true">{base} →</span>
              <select value={chartQuote} onChange={(e) => setPrefs((p) => ({ ...p, chart: e.target.value }))}>
                {targets.map((c) => (
                  <option key={c} value={c}>
                    {optionLabel(c)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="fx-seg" role="radiogroup" aria-label="期間">
            {RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={r.value === range}
                className={r.value === range ? 'active' : undefined}
                onClick={() => setPrefs((p) => ({ ...p, range: r.value }))}
              >
                {r.label}
              </button>
            ))}
          </div>
          {series.status === 'loading' && <p className="muted fx-chart-empty">載入走勢中…</p>}
          {series.status === 'error' && (
            <div className="fx-chart-empty">
              <p className="error">{series.error}，暫時看不到走勢。</p>
              <button type="button" className="secondary" onClick={series.retry}>
                重試
              </button>
            </div>
          )}
          {series.status === 'ok' && <TrendChart points={series.points} base={base} quote={chartQuote} />}
          <p className="muted fx-note">走勢一律是最新的資料，不受上面的換算日期影響。</p>
        </section>
      )}

      <p className="muted fx-source">
        匯率來源：
        <a href="https://frankfurter.dev" target="_blank" rel="noreferrer">
          Frankfurter
        </a>
        ，彙整各國央行公布的參考匯率（中間價），每日更新，僅供參考；實際買賣請以銀行牌告為準。
      </p>
    </div>
  )
}

function Status({ rates, date }: { rates: ReturnType<typeof useRates>; date: string | null }) {
  const { status, table, error } = rates

  if (status === 'error') {
    return (
      <div className="fx-status">
        <p className="error">{error}</p>
        <button type="button" className="secondary" onClick={rates.retry}>
          重試
        </button>
      </div>
    )
  }
  if (!table) return <p className="muted fx-status">正在取得匯率…</p>

  if (status === 'stale') {
    return (
      <div className="fx-status">
        <p className="fx-warn">
          {error}，顯示上次取得的匯率（{table.date}）。
        </p>
        <button type="button" className="secondary" onClick={rates.retry}>
          重試
        </button>
      </div>
    )
  }

  return (
    <p className="muted fx-status">
      {date ? '歷史匯率' : '匯率日期'}：{table.date}
      {date && table.date !== date && `（${date} 沒有資料，改用最近的一天）`}
      {status === 'loading' && '　更新中…'}
    </p>
  )
}
