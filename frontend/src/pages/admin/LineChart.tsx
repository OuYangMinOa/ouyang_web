import { useState } from 'react'

export type ChartSeries = {
  label: string
  /** 線的顏色由 CSS class 決定（`.sys-line.is-1`、`.is-2`），才吃得到主題變數 */
  tone: 1 | 2
  values: number[]
}

type Props = {
  /** 每個點的時間（Unix 毫秒，由舊到新），和每條線的 values 一一對應 */
  times: number[]
  series: ChartSeries[]
  format: (value: number) => string
  /** 固定的上限（例如百分比是 100）；沒給就依資料取整 */
  max?: number
  /** 相鄰兩點隔超過這麼久（毫秒）就斷開不連線，例如網站停機的那段 */
  gap?: number
  /** 小圖：不畫座標軸文字 */
  compact?: boolean
  label: string
}

const W = 600
const H = 100
const HOUR = 60 * 60 * 1000

/** 1、2、5 × 10ⁿ 裡第一個不小於 value 的 */
function niceMax(value: number) {
  if (value <= 0) return 1
  const base = 10 ** Math.floor(Math.log10(value))
  return ([1, 2, 5, 10].find((m) => m * base >= value) ?? 10) * base
}

/** 跨天的圖要帶日期；2 小時內的提示框帶秒 */
function formatTime(t: number, span: number, precise: boolean) {
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  if (span > 20 * HOUR) return new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', ...time })
  return new Date(t).toLocaleTimeString([], { ...time, second: precise && span < 2 * HOUR ? '2-digit' : undefined })
}

/** 排好的 times 裡最接近 t 的位置 */
function nearest(times: number[], t: number) {
  let lo = 0
  let hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo > 0 && t - times[lo - 1] < times[lo] - t ? lo - 1 : lo
}

/** 時間序列的折線圖：橫軸照時間比例，SVG 只畫線（拉伸也不會變粗），文字、十字線和提示框用 HTML 疊上去 */
export default function LineChart({ times, series, format, max, gap, compact, label }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const n = times.length
  if (n < 2) return <p className="muted sys-chart-empty">資料累積中…</p>

  const start = times[0]
  const span = Math.max(1, times[n - 1] - start)
  const top = max ?? niceMax(Math.max(...series.flatMap((s) => s.values)))
  const x = (i: number) => ((times[i] - start) / span) * W
  const y = (v: number) => H - (Math.min(v, top) / top) * H
  // 每一段連續的點 [第一個, 最後一個]
  const runs: [number, number][] = []
  let from = 0
  for (let i = 1; i < n; i++) {
    if (gap && times[i] - times[i - 1] > gap) {
      runs.push([from, i - 1])
      from = i
    }
  }
  runs.push([from, n - 1])
  const path = (values: number[], [a, b]: [number, number]) => {
    let d = ''
    for (let i = a; i <= b; i++) d += `${i === a ? 'M' : 'L'}${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`
    return d
  }
  const line = (values: number[]) => runs.map((run) => path(values, run)).join('')
  const area = (values: number[]) =>
    runs
      .filter(([a, b]) => b > a)
      .map((run) => `${path(values, run)}L${x(run[1]).toFixed(1)},${H}L${x(run[0]).toFixed(1)},${H}Z`)
      .join('')
  const single = series.length === 1

  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    setHover(nearest(times, start + ratio * span))
  }
  // 資料換了（例如切換範圍）點變少時，舊的位置可能超出去
  const at = hover === null ? null : Math.min(hover, n - 1)
  const hoverLeft = at === null ? 0 : (x(at) / W) * 100

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
          {single && <path className="sys-area" d={area(series[0].values)} />}
          {series.map((s) => (
            <path key={s.label} className={`sys-line is-${s.tone}`} d={line(s.values)} />
          ))}
        </svg>
        {at !== null && (
          <>
            <div className="sys-cursor" style={{ left: `${hoverLeft}%` }} />
            {series.map((s) => (
              <div
                key={s.label}
                className={`sys-dot is-${s.tone}`}
                style={{
                  left: `${hoverLeft}%`,
                  top: `${(y(s.values[at]) / H) * 100}%`,
                }}
              />
            ))}
            <div className={hoverLeft > 50 ? 'sys-tip is-left' : 'sys-tip'} style={{ left: `${hoverLeft}%` }}>
              <time>{formatTime(times[at], span, true)}</time>
              {series.map((s) => (
                <span key={s.label}>
                  {!single && <i className={`sys-swatch is-${s.tone}`} />}
                  {!single && `${s.label} `}
                  <strong>{format(s.values[at])}</strong>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      {!compact && (
        <div className="sys-times" aria-hidden="true">
          <span>{formatTime(start, span, false)}</span>
          <span>{formatTime(times[n - 1], span, false)}</span>
        </div>
      )}
    </div>
  )
}
