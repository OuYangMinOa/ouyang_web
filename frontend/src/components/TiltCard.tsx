import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react'

/**
 * 跟著滑鼠傾斜的 3D 卡片。子元素加上 `depth-1`～`depth-3` 會浮在不同高度，傾斜時看得出前後層次。
 * 只回應滑鼠；手機上維持平放，避免手指捲動時卡片亂晃。
 */
export default function TiltCard({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)

  function move(e: PointerEvent<HTMLDivElement>) {
    const el = ref.current
    if (!el || e.pointerType !== 'mouse') return
    const rect = el.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    el.style.setProperty('--rx', `${(0.5 - y) * 14}deg`)
    el.style.setProperty('--ry', `${(x - 0.5) * 18}deg`)
    el.style.setProperty('--gx', `${x * 100}%`)
    el.style.setProperty('--gy', `${y * 100}%`)
  }

  function reset() {
    ref.current?.style.setProperty('--rx', '0deg')
    ref.current?.style.setProperty('--ry', '0deg')
  }

  return (
    <div ref={ref} className={`tilt ${className}`} style={style} onPointerMove={move} onPointerLeave={reset}>
      <div className="tilt-body">
        {children}
        <span className="tilt-glare" aria-hidden="true" />
      </div>
    </div>
  )
}
