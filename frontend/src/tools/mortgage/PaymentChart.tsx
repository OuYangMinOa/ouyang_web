import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { Row } from './calc'

const PAD_TOP = 8
const PAD_BOTTOM = 4

const fmt = (n: number) => Math.round(n).toLocaleString('zh-TW')

type Series = { key: string; label: string; rows: Row[] }

/**
 * 兩種攤還方式的每月還款金額。線用 SVG（拉伸填滿寬度），
 * 讀數、十字線和圓點用 HTML 疊上去，才不會跟著被拉變形。
 */
export default function PaymentChart({ series }: { series: Series[] }) {
  const [active, setActive] = useState<number | null>(null)
  const n = series[0].rows.length
  if (n < 2) return null

  const max = Math.max(...series.flatMap((s) => s.rows.map((r) => r.payment))) * 1.05 || 1
  const x = (i: number) => (i / (n - 1)) * 100
  const y = (v: number) => PAD_TOP + ((max - v) / max) * (100 - PAD_TOP - PAD_BOTTOM)
  // 每期一個點；期數很多，寬限期結束或利率改變的跳動看起來就是一段直線
  const path = (rows: Row[]) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(3)},${y(r.payment).toFixed(3)}`).join('')

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const f = (e.clientX - rect.left) / rect.width
    setActive(Math.round(Math.min(1, Math.max(0, f)) * (n - 1)))
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!step) return
    e.preventDefault()
    setActive((i) => Math.min(n - 1, Math.max(0, (i ?? 0) + step)))
  }

  const shown = active ?? 0
  const years = Math.ceil(n / 12)
  // 格線：0、一半、最高
  const grid = [0, max / 2 / 1.05, max / 1.05]

  return (
    <div className="mtg-chart">
      <ul className="mtg-legend">
        {series.map((s) => (
          <li key={s.key}>
            <span className={`mtg-swatch ${s.key}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <p className="mtg-readout" aria-live="polite">
        <span className="mtg-readout-period">
          第 {shown + 1} 期（第 {Math.floor(shown / 12) + 1} 年第 {(shown % 12) + 1} 個月）
        </span>
        {series.map((s) => (
          <span key={s.key}>
            {s.label} <strong>{fmt(s.rows[shown].payment)}</strong>
          </span>
        ))}
      </p>
      <div className="mtg-plot-wrap">
        <div className="mtg-yaxis" aria-hidden="true">
          {grid
            .slice()
            .reverse()
            .map((v) => (
              <span key={v} style={{ top: `${y(v)}%` }}>
                {v >= 10_000 ? `${(v / 10_000).toFixed(v >= 100_000 ? 0 : 1)}萬` : fmt(v)}
              </span>
            ))}
        </div>
        <div
          className="mtg-plot"
          tabIndex={0}
          role="img"
          aria-label={`每月還款金額走勢，共 ${n} 期。${series.map((s) => `${s.label}第一期 ${fmt(s.rows[0].payment)} 元、最後一期 ${fmt(s.rows[n - 1].payment)} 元`).join('；')}。可用左右鍵查看每一期。`}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {grid.map((v) => (
              <line key={v} className="mtg-gridline" x1="0" x2="100" y1={y(v)} y2={y(v)} vectorEffect="non-scaling-stroke" />
            ))}
            {series.map((s) => (
              <path key={s.key} className={`mtg-line ${s.key}`} d={path(s.rows)} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          {active !== null && (
            <>
              <span className="mtg-cross" style={{ left: `${x(active)}%` }} aria-hidden="true" />
              {series.map((s) => (
                <span
                  key={s.key}
                  className={`mtg-dot ${s.key}`}
                  style={{ left: `${x(active)}%`, top: `${y(s.rows[active].payment)}%` }}
                  aria-hidden="true"
                />
              ))}
            </>
          )}
        </div>
      </div>
      <div className="mtg-axis" aria-hidden="true">
        <span>第 1 年</span>
        {years >= 4 && <span>第 {Math.round(years / 2)} 年</span>}
        <span>第 {years} 年</span>
      </div>
    </div>
  )
}
