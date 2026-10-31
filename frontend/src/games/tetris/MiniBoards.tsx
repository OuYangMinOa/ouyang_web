import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { drawMinis, miniAt, miniLayout, readPalette, type MiniInfo } from './draw'

/**
 * 其他玩家的小盤面，全部畫在同一張 canvas 上（最多 98 個）。
 * `fill`：塞滿容器的高度（桌機放在主盤面兩側）；否則用固定大小往下排（手機放在主盤面下面）。
 */
export function MiniBoards({
  minis,
  boards,
  version,
  fill,
  onPick,
  label,
}: {
  minis: MiniInfo[]
  boards: Map<number, string>
  /** 盤面有更新時會變，用來觸發重畫 */
  version: number
  fill: boolean
  onPick?: (pid: number) => void
  label: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [palette, setPalette] = useState(readPalette)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    const refresh = () => setPalette(readPalette())
    const mo = new MutationObserver(refresh)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', refresh)
    return () => {
      ro.disconnect()
      mo.disconnect()
      mq.removeEventListener('change', refresh)
    }
  }, [])

  const layout = useMemo(
    () => miniLayout(box.width, minis.length, fill ? box.height : null),
    [box.width, box.height, minis.length, fill],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || box.width === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(box.width * dpr)
    canvas.height = Math.round(Math.max(layout.height, 1) * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawMinis(ctx, box.width, layout, minis, boards, palette)
  }, [box.width, layout, minis, boards, version, palette])

  function pick(e: PointerEvent<HTMLCanvasElement>) {
    if (!onPick) return
    const rect = e.currentTarget.getBoundingClientRect()
    const i = miniAt(layout, minis.length, e.clientX - rect.left, e.clientY - rect.top)
    if (i >= 0) onPick(minis[i].pid)
  }

  return (
    <div ref={boxRef} className={`tetris-minis${fill ? ' fill' : ''}`}>
      <canvas
        ref={canvasRef}
        className="tetris-minis-canvas"
        style={{ height: layout.height }}
        onPointerDown={pick}
        aria-label={label}
      />
    </div>
  )
}
