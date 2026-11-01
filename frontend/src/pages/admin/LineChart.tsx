import { useState } from 'react'

export type ChartSeries = {
  label: string
  /** 線的顏色由 CSS class 決定（`.sys-line.is-1`、`.is-2`），才吃得到主題變數 */
  tone: 1 | 2
  values: number[]
}

type Props = {
  /** 每個點的時間（Unix 毫秒），和每條線的 values 一一對應 */
  times: number[]
  series: ChartSeries[]
  format: (value: number) => string
  /** 固定的上限（例如百分比是 100）；沒給就依資料取整 */
  max?: number
  /** 小圖：不畫座標軸文字 */
  compact?: boolean
  label: string
}

const W = 600
const H = 100

/** 1、2、5 × 10ⁿ 裡第一個不小於 value 的 */
function niceMax(value: number) {
  if (value <= 0) return 1
  const base = 10 ** Math.floor(Math.log10(value))
  return ([1, 2, 5, 10].find((m) => m * base >= value) ?? 10) * base
}

function formatTime(t: number, withSeconds: boolean) {
  return new Date(t).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
  })
}

/** 時間序列的折線圖：SVG 只畫線（拉伸也不會變粗），文字、十字線和提示框用 HTML 疊上去 */
export default function LineChart({ times, series, format, max, compact, label }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const n = times.length
  if (n < 2) return <p className="muted sys-chart-empty">資料累積中…</p>

  const top = max ?? niceMax(Math.max(...series.flatMap((s) => s.values)))
  const x = (i: number) => (i / (n - 1)) * W
  const y = (v: number) => H - (Math.min(v, top) / top) * H
  const line = (values: number[]) =>
    values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const single = series.length === 1
  const withSeconds = times[n - 1] - times[0] < 2 * 60 * 60 * 1000

  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    setHover(Math.round(ratio * (n - 1)))
  }
  const hoverLeft = hover === null ? 0 : (hover / (n - 1)) * 100

  return (
    <div className={compact ? 'sys-plot is-compact' : 'sys-plot'}>
      {!compact && (
        <div className="sys-axis" aria-hidden="true">
          <span>{format(top)}</span>
          <span>{format(top / 2)}</span>
          <span>0</span>
        </div>
      )}
      <div
        className="sys-canvas"
        role="img"
        aria-label={label}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {!compact &&
            [0.5, 1].map((f) => <line key={f} className="sys-grid" x1={0} x2={W} y1={H * (1 - f)} y2={H * (1 - f)} />)}
          {single && <path className="sys-area" d={`${line(series[0].values)}L${W},${H}L0,${H}Z`} />}
          {series.map((s) => (
            <path key={s.label} className={`sys-line is-${s.tone}`} d={line(s.values)} />
          ))}
        </svg>
        {hover !== null && (
          <>
            <div className="sys-cursor" style={{ left: `${hoverLeft}%` }} />
            {series.map((s) => (
              <div
                key={s.label}
                className={`sys-dot is-${s.tone}`}
                style={{
                  left: `${hoverLeft}%`,
                  top: `${(y(s.values[hover]) / H) * 100}%`,
                }}
              />
            ))}
            <div className={hoverLeft > 50 ? 'sys-tip is-left' : 'sys-tip'} style={{ left: `${hoverLeft}%` }}>
              <time>{formatTime(times[hover], withSeconds)}</time>
              {series.map((s) => (
                <span key={s.label}>
                  {!single && <i className={`sys-swatch is-${s.tone}`} />}
                  {!single && `${s.label} `}
                  <strong>{format(s.values[hover])}</strong>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      {!compact && (
        <div className="sys-times" aria-hidden="true">
          <span>{formatTime(times[0], false)}</span>
          <span>{formatTime(times[n - 1], false)}</span>
        </div>
      )}
    </div>
  )
}
