import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { Point } from './api'
import { formatPercent, formatRate } from './currencies'

// 上下各留一點空間給最高、最低的標籤（單位：圖表高度的 %）
const PAD_TOP = 16
const PAD_BOTTOM = 16

/**
 * 單一序列的折線圖。線和面積用 SVG（拉伸填滿寬度），
 * 文字、十字線和圓點用 HTML 疊上去，才不會跟著被拉變形。
 */
export default function TrendChart({ points, base, quote }: { points: Point[]; base: string; quote: string }) {
  const [active, setActive] = useState<number | null>(null)
  const n = points.length

  if (n < 2) return <p className="muted fx-chart-empty">這段期間的資料不足，畫不出走勢。</p>

  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const iMin = values.indexOf(min)
  const iMax = values.indexOf(max)
  const span = max - min || max || 1

  const x = (i: number) => (i / (n - 1)) * 100
  const y = (v: number) => PAD_TOP + ((max - v) / span) * (100 - PAD_TOP - PAD_BOTTOM)

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(3)},${y(p.value).toFixed(3)}`).join('')
  const area = `${line}L100,100L0,100Z`

  const first = points[0]
  const last = points[n - 1]
  const shown = active === null ? last : points[active]
  const change = (shown.value - first.value) / first.value

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const f = (e.clientX - rect.left) / rect.width
    setActive(Math.round(Math.min(1, Math.max(0, f)) * (n - 1)))
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    if (!step) return
    e.preventDefault()
    setActive((i) => Math.min(n - 1, Math.max(0, (i ?? n - 1) + step)))
  }

  // 標籤放在離極值點遠的那一側，避免壓到線
  const side = (i: number) => (i > (n - 1) / 2 ? 'left' : 'right')

  return (
    <div className="fx-chart">
      <p className="fx-readout" aria-live="polite">
        <span className="fx-readout-date">{shown.date}</span>
        <span>
          1 {base} = <strong>{formatRate(shown.value)}</strong> {quote}
        </span>
        <span>
          {active === null ? '期間' : '較期初'} {change > 0 ? '▲' : change < 0 ? '▼' : ''}
          {formatPercent(change)}
        </span>
      </p>
      <div
        className="fx-plot"
        tabIndex={0}
        role="img"
        aria-label={`${base} 兌 ${quote} 走勢，${first.date} 到 ${last.date}，最高 ${formatRate(max)}，最低 ${formatRate(min)}。可用左右鍵查看每一天。`}
        onPointerMove={pick}
        onPointerDown={pick}
        // 手指離開後保留讀數，滑鼠離開才清掉
        onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line className="fx-grid" x1="0" x2="100" y1={y(max)} y2={y(max)} vectorEffect="non-scaling-stroke" />
          <line className="fx-grid" x1="0" x2="100" y1={y(min)} y2={y(min)} vectorEffect="non-scaling-stroke" />
          <path className="fx-area" d={area} />
          <path className="fx-line" d={line} vectorEffect="non-scaling-stroke" />
        </svg>
        <span className={`fx-extreme top ${side(iMax)}`} style={{ top: `${y(max)}%` }}>
          最高 {formatRate(max)}
        </span>
        <span className={`fx-extreme bottom ${side(iMin)}`} style={{ top: `${y(min)}%` }}>
          最低 {formatRate(min)}
        </span>
        {active !== null && (
          <>
            <span className="fx-cross" style={{ left: `${x(active)}%` }} aria-hidden="true" />
            <span
              className="fx-dot"
              style={{ left: `${x(active)}%`, top: `${y(points[active].value)}%` }}
              aria-hidden="true"
            />
          </>
        )}
      </div>
      <div className="fx-axis" aria-hidden="true">
        <span>{first.date}</span>
        <span>{last.date}</span>
      </div>
    </div>
  )
}
