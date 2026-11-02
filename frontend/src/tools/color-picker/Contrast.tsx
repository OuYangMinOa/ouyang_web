import { useState } from 'react'
import { contrast, parseHex, toHex, type RGB } from './color'

type Target = 'fg' | 'bg'

/** 一個顏色欄位：色票 + 可以直接打的 HEX */
function ColorField({ label, value, onChange }: { label: string; value: RGB; onChange: (c: RGB) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const hex = toHex(value)
  const bad = draft !== null && !parseHex(draft)
  return (
    <div className="cpk-cfield">
      <span className="cpk-label">{label}</span>
      <div className="cpk-cfield-row">
        <input
          type="color"
          value={hex.toLowerCase()}
          onChange={(e) => {
            const c = parseHex(e.target.value)
            if (c) onChange(c)
            setDraft(null)
          }}
          aria-label={`${label}色票`}
        />
        <input
          className={`cpk-hex${bad ? ' bad' : ''}`}
          value={draft ?? hex}
          spellCheck={false}
          autoCapitalize="characters"
          aria-label={`${label} HEX`}
          aria-invalid={bad}
          onChange={(e) => {
            setDraft(e.target.value)
            const c = parseHex(e.target.value)
            if (c) onChange(c)
          }}
          onBlur={() => setDraft(null)}
        />
      </div>
    </div>
  )
}

/** WCAG 2.1 對比檢查 */
export default function Contrast({
  fg,
  bg,
  setFg,
  setBg,
  swatches,
}: {
  fg: RGB
  bg: RGB
  setFg: (c: RGB) => void
  setBg: (c: RGB) => void
  /** 可以點來套用的顏色（取過的色、調色盤） */
  swatches: RGB[]
}) {
  const [target, setTarget] = useState<Target>('fg')
  const ratio = contrast(fg, bg)
  const shown = Math.floor(ratio * 100) / 100
  const checks = [
    { label: '一般文字 AA', need: 4.5 },
    { label: '一般文字 AAA', need: 7 },
    { label: '大字 AA', need: 3 },
    { label: '大字 AAA', need: 4.5 },
    { label: '圖示與介面元件', need: 3 },
  ]

  // 去掉重複的
  const uniq = [...new Map(swatches.map((c) => [toHex(c), c])).values()]

  return (
    <div className="cpk-contrast">
      <div className="cpk-contrast-fields">
        <ColorField label="文字色" value={fg} onChange={setFg} />
        <button
          type="button"
          className="secondary cpk-swap"
          onClick={() => {
            setFg(bg)
            setBg(fg)
          }}
          aria-label="文字色和背景色對調"
        >
          ⇄
        </button>
        <ColorField label="背景色" value={bg} onChange={setBg} />
      </div>

      {uniq.length > 0 && (
        <div className="cpk-apply">
          <div className="cpk-apply-head">
            <span className="cpk-label">點色塊套用到</span>
            <div className="cpk-seg" role="radiogroup" aria-label="點色塊套用到">
              {(['fg', 'bg'] as Target[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={target === t}
                  className={target === t ? 'active' : ''}
                  onClick={() => setTarget(t)}
                >
                  {t === 'fg' ? '文字色' : '背景色'}
                </button>
              ))}
            </div>
          </div>
          <div className="cpk-mini">
            {uniq.map((c) => (
              <button
                key={toHex(c)}
                type="button"
                className="cpk-mini-swatch"
                style={{ background: toHex(c) }}
                title={toHex(c)}
                aria-label={`把 ${toHex(c)} 設為${target === 'fg' ? '文字色' : '背景色'}`}
                onClick={() => (target === 'fg' ? setFg(c) : setBg(c))}
              />
            ))}
          </div>
        </div>
      )}

      <div className="cpk-sample" style={{ color: toHex(fg), background: toHex(bg) }}>
        <span className="cpk-sample-big">大字範例 Aa 24px</span>
        <span>一般文字範例：今天天氣很好，適合出去走走。The quick brown fox.</span>
        <span className="cpk-sample-icon" aria-hidden="true" style={{ borderColor: toHex(fg) }}>
          ★
        </span>
      </div>

      <div className="cpk-ratio">
        <strong>{shown.toFixed(2)} : 1</strong>
        <span className="muted">對比值（1–21，越大越清楚）</span>
      </div>
      <ul className="cpk-checks">
        {checks.map((c) => {
          const ok = ratio >= c.need
          return (
            <li key={c.label} className={ok ? 'pass' : 'fail'}>
              <span aria-hidden="true">{ok ? '✓' : '✕'}</span>
              <span>{c.label}</span>
              <span className="muted">≥ {c.need}</span>
              <span className="cpk-sr">{ok ? '通過' : '未通過'}</span>
            </li>
          )
        })}
      </ul>
      <p className="muted">大字指 24px（18pt）以上，或 18.66px（14pt）以上的粗體。</p>
    </div>
  )
}
