import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { formatBytes } from './util'

/** 前後對照：拖中間的線（或用下面的滑桿）看原圖和轉換後的差別 */
export default function Compare({
  name,
  before,
  after,
  width,
  height,
  beforeSize,
  afterSize,
  onClose,
}: {
  name: string
  before: string
  after: string
  /** 轉換後的尺寸，原圖會縮放成一樣大來比 */
  width: number
  height: number
  beforeSize: number
  afterSize: number
  onClose: () => void
}) {
  const [pos, setPos] = useState(50)
  const [actual, setActual] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const dragging = useRef(false)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    closeBtn.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [])

  const move = (e: PointerEvent) => {
    const r = box.current?.getBoundingClientRect()
    if (!r || r.width === 0) return
    setPos(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
  }

  const style = {
    '--pos': `${pos}%`,
    '--ratio': `${width} / ${height}`,
    '--w': `${width}px`,
    '--fit-w': `min(100%, calc(70dvh * ${width / height}))`,
  } as CSSProperties

  return (
    <div
      className="imc-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`前後對照：${name}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="imc-modal-box">
        <div className="imc-modal-head">
          <strong className="imc-ellipsis">{name}</strong>
          <button type="button" className="secondary" onClick={() => setActual((a) => !a)} aria-pressed={actual}>
            {actual ? '符合視窗' : '實際大小'}
          </button>
          <button ref={closeBtn} type="button" className="secondary imc-icon-btn" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </div>

        <div className={`imc-compare${actual ? ' actual' : ''}`}>
          <div
            ref={box}
            className="imc-compare-box"
            style={style}
            onPointerDown={(e) => {
              dragging.current = true
              e.currentTarget.setPointerCapture(e.pointerId)
              move(e)
            }}
            onPointerMove={(e) => dragging.current && move(e)}
            onPointerUp={() => (dragging.current = false)}
            onPointerCancel={() => (dragging.current = false)}
          >
            <img src={before} alt="原圖" draggable={false} />
            <img src={after} alt="轉換後" draggable={false} className="imc-compare-after" />
            <span className="imc-compare-line" aria-hidden="true" />
            <span className="imc-compare-tag left">原圖 {formatBytes(beforeSize)}</span>
            <span className="imc-compare-tag right">轉換後 {formatBytes(afterSize)}</span>
          </div>
        </div>

        <label className="imc-range">
          <span className="imc-range-head">
            <span>分隔線位置</span>
            <output>{Math.round(pos)}%</output>
          </span>
          <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} />
        </label>
      </div>
    </div>
  )
}
