import { useEffect, useState } from 'react'
import { CATEGORIES, formatNumber, parseNumber, type Category } from './units'
import './unit-convert.css'

type Input = { unit: string; text: string }
type Saved = { cat: string; inputs: Record<string, Input> }

const STORE_KEY = 'tools:unit-convert'

/** 每一類預設從哪個單位開始 */
const DEFAULTS: Record<string, Input> = {
  length: { unit: 'm', text: '1' },
  area: { unit: 'ping', text: '1' },
  weight: { unit: 'jin', text: '1' },
  volume: { unit: 'l', text: '1' },
  temperature: { unit: 'c', text: '25' },
  speed: { unit: 'kmh', text: '100' },
  data: { unit: 'GB', text: '1' },
}

// 存檔可能是舊版或被改壞，逐欄檢查
function load(): Saved {
  const fallback: Saved = { cat: CATEGORIES[0].id, inputs: {} }
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return fallback
    const s = JSON.parse(raw) as Partial<Saved>
    const cat = CATEGORIES.some((c) => c.id === s.cat) ? s.cat! : fallback.cat
    const inputs: Record<string, Input> = {}
    for (const c of CATEGORIES) {
      const i = s.inputs?.[c.id]
      if (i && typeof i.text === 'string' && c.units.some((u) => u.id === i.unit)) inputs[c.id] = { unit: i.unit, text: i.text }
    }
    return { cat, inputs }
  } catch {
    return fallback
  }
}

export default function UnitConvert() {
  const [saved, setSaved] = useState(load)
  const cat = CATEGORIES.find((c) => c.id === saved.cat)!
  const input = saved.inputs[cat.id] ?? DEFAULTS[cat.id]

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(saved))
    } catch {
      // 存不了就算了
    }
  }, [saved])

  const setInput = (unit: string, text: string) => setSaved((s) => ({ ...s, inputs: { ...s.inputs, [cat.id]: { unit, text } } }))

  return (
    <div className="uc">
      <div className="uc-tabs" role="tablist" aria-label="單位類別">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === cat.id}
            className={c.id === cat.id ? 'active' : undefined}
            onClick={() => setSaved((s) => ({ ...s, cat: c.id }))}
          >
            {c.name}
          </button>
        ))}
      </div>
      <Panel key={cat.id} cat={cat} input={input} onInput={setInput} />
    </div>
  )
}

function Panel({ cat, input, onInput }: { cat: Category; input: Input; onInput: (unit: string, text: string) => void }) {
  const source = cat.units.find((u) => u.id === input.unit) ?? cat.units[0]
  const value = parseNumber(input.text)
  const base = value === null ? null : source.to(value)
  const belowZero = cat.id === 'temperature' && base !== null && base < -273.15

  // 溫度要能輸入負號，但手機的數字鍵盤沒有負號，另外給一個按鈕
  const flipSign = () => {
    const t = input.text.trim()
    onInput(source.id, t.startsWith('-') || t.startsWith('−') ? t.slice(1) : `-${t}`)
  }

  return (
    <section className="card uc-card">
      <ul className="uc-list">
        {cat.units.map((u) => {
          const active = u.id === source.id
          const text = active ? input.text : base === null ? '' : formatNumber(u.from(base))
          return (
            <li key={u.id} className={active ? 'active' : undefined}>
              <label htmlFor={`uc-${u.id}`} className="uc-label">
                <span className="uc-name">{u.name}</span>
                {u.symbol !== u.name && <span className="uc-symbol">{u.symbol}</span>}
              </label>
              <div className="uc-input">
                <input
                  id={`uc-${u.id}`}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={text}
                  onChange={(e) => onInput(u.id, e.target.value)}
                  onFocus={(e) => {
                    // 點別的單位時從那一欄的數字接著改
                    if (!active) onInput(u.id, text)
                    e.target.select()
                  }}
                  aria-invalid={active && input.text.trim() !== '' && value === null}
                />
                {cat.signed && active && (
                  <button type="button" className="secondary uc-sign" onClick={flipSign} aria-label="正負號">
                    ±
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {input.text.trim() !== '' && value === null && <p className="error uc-msg">請輸入數字。</p>}
      {belowZero && <p className="error uc-msg">低於絕對零度（−273.15 °C），這個溫度不存在。</p>}
      {cat.note && <p className="muted uc-note">{cat.note}</p>}
    </section>
  )
}
