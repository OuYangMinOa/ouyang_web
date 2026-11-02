import type { CSSProperties } from 'react'

/** 大字時間：字級跟著容器寬度和字數縮放，手機上也不會超出畫面 */
export default function BigTime({ text, sub, className = '' }: { text: string; sub?: string; className?: string }) {
  return (
    <div className={`tm-big-wrap ${className}`}>
      <div className="tm-big" style={{ '--chars': text.length } as CSSProperties} role="timer" aria-live="off">
        {text}
      </div>
      {sub && <div className="tm-big-sub">{sub}</div>}
    </div>
  )
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="tm-progress" aria-hidden="true">
      <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}
