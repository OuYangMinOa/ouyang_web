// 圖片小工具共用的控制項：分段按鈕、滑桿、顏色
import type { ReactNode } from 'react'
import './image-kit.css'

export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="ik-field">
      <span className="ik-label">{label}</span>
      <div className="ik-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? 'active' : ''}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Range({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  display,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  /** 右邊顯示的值，預設就是數字本身 */
  display?: ReactNode
}) {
  return (
    <label className="ik-field ik-range">
      <span className="ik-range-head">
        <span>{label}</span>
        <output>{display ?? value}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

/** 一排預設色塊，最後一個是自訂顏色 */
export function Swatches({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  const preset = options.some((o) => o.value.toLowerCase() === value.toLowerCase())
  return (
    <div className="ik-field">
      <span className="ik-label">{label}</span>
      <div className="ik-swatches" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            aria-label={o.label}
            title={o.label}
            className={`ik-swatch${o.value.toLowerCase() === value.toLowerCase() ? ' active' : ''}`}
            style={{ background: o.value }}
            onClick={() => onChange(o.value)}
          />
        ))}
        <label
          className={`ik-swatch custom${preset ? '' : ' active'}`}
          title="自訂顏色"
          style={preset ? undefined : { background: value }}
        >
          {preset && <span aria-hidden="true">＋</span>}
          <input type="color" aria-label="自訂顏色" value={value} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
    </div>
  )
}
