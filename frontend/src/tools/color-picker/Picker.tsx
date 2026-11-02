import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { toHex, type RGB } from './color'
import { sampleAt, type Loaded } from './sample'

/** 放大鏡：邊長幾個像素、每個像素放大幾倍 */
const LOUPE_PX = 15
const LOUPE_ZOOM = 8
const LOUPE_SIZE = LOUPE_PX * LOUPE_ZOOM

/**
 * 顯示圖片，滑鼠移動或手指按住拖動時出現放大鏡，放開（點一下）就取色。
 * 也可以用鍵盤：方向鍵移動（Shift 一次 10 格），Enter 取色。
 */
export default function Picker({
  image,
  sample,
  onPick,
}: {
  image: Loaded
  sample: number
  onPick: (c: RGB) => void
}) {
  const view = useRef<HTMLCanvasElement>(null)
  const loupe = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  /** 放大鏡在 wrap 裡的位置（CSS px） */
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const pressing = useRef(false)
  const touch = useRef(false)

  // 圖片畫到看得到的畫布上（內部尺寸 = 圖片尺寸，CSS 負責縮放）
  useEffect(() => {
    const c = view.current
    if (!c) return
    c.width = image.canvas.width
    c.height = image.canvas.height
    c.getContext('2d')?.drawImage(image.canvas, 0, 0)
  }, [image])

  // 畫放大鏡
  useEffect(() => {
    const c = loupe.current
    if (!c || !pos) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const size = Math.round(LOUPE_SIZE * dpr)
    if (c.width !== size) {
      c.width = size
      c.height = size
    }
    const ctx = c.getContext('2d')
    if (!ctx) return
    const half = Math.floor(LOUPE_PX / 2)
    const cell = size / LOUPE_PX
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(image.canvas, pos.x - half, pos.y - half, LOUPE_PX, LOUPE_PX, 0, 0, size, size)
    // 中間要取的範圍：黑白雙框，不管底下什麼顏色都看得到
    const sh = Math.floor(sample / 2)
    const x0 = (half - sh) * cell
    const w = sample * cell
    ctx.lineWidth = Math.max(1, dpr)
    ctx.strokeStyle = 'rgb(0 0 0 / 0.85)'
    ctx.strokeRect(x0 - ctx.lineWidth, x0 - ctx.lineWidth, w + ctx.lineWidth * 2, w + ctx.lineWidth * 2)
    ctx.strokeStyle = 'rgb(255 255 255 / 0.95)'
    ctx.strokeRect(x0, x0, w, w)
  }, [pos, image, sample])

  /** 指標位置換成圖片像素，並算出放大鏡要放哪裡 */
  function locate(clientX: number, clientY: number) {
    const c = view.current
    const w = wrap.current
    if (!c || !w) return null
    const r = c.getBoundingClientRect()
    const x = Math.floor(((clientX - r.left) / r.width) * c.width)
    const y = Math.floor(((clientY - r.top) / r.height) * c.height)
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null
    const wr = w.getBoundingClientRect()
    const px = clientX - wr.left
    const py = clientY - wr.top
    const gap = touch.current ? 48 : 20
    // 手指會擋住，所以放在上方；滑鼠放右下，碰到邊就換邊。一律限制在 wrap 裡，手機才不會出現橫向捲動
    let left = touch.current ? px - LOUPE_SIZE / 2 : px + gap
    let top = touch.current ? py - LOUPE_SIZE - gap : py + gap
    if (!touch.current && left + LOUPE_SIZE > wr.width) left = px - gap - LOUPE_SIZE
    if (!touch.current && top + LOUPE_SIZE + 28 > wr.height) top = py - gap - LOUPE_SIZE - 28
    if (touch.current && top < 0) top = py + gap
    left = Math.min(Math.max(0, left), Math.max(0, wr.width - LOUPE_SIZE))
    top = Math.min(Math.max(0, top), Math.max(0, wr.height - LOUPE_SIZE - 28))
    return { x, y, left, top }
  }

  function update(e: PointerEvent) {
    const p = locate(e.clientX, e.clientY)
    if (!p) return null
    setPos({ x: p.x, y: p.y })
    setPlace({ left: p.left, top: p.top })
    return p
  }

  function onKeyDown(e: KeyboardEvent) {
    const c = view.current
    if (!c) return
    const step = e.shiftKey ? 10 : 1
    const cur = pos ?? { x: Math.floor(c.width / 2), y: Math.floor(c.height / 2) }
    let { x, y } = cur
    if (e.key === 'ArrowLeft') x -= step
    else if (e.key === 'ArrowRight') x += step
    else if (e.key === 'ArrowUp') y -= step
    else if (e.key === 'ArrowDown') y += step
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPick(sampleAt(image, cur.x, cur.y, sample))
      return
    } else return
    e.preventDefault()
    x = Math.min(c.width - 1, Math.max(0, x))
    y = Math.min(c.height - 1, Math.max(0, y))
    const r = c.getBoundingClientRect()
    touch.current = false
    const p = locate(r.left + ((x + 0.5) / c.width) * r.width, r.top + ((y + 0.5) / c.height) * r.height)
    setPos({ x, y })
    if (p) setPlace({ left: p.left, top: p.top })
  }

  const hover = pos ? sampleAt(image, pos.x, pos.y, sample) : null

  return (
    <div ref={wrap} className="cpk-stage">
      <canvas
        ref={view}
        className="cpk-image"
        tabIndex={0}
        role="img"
        aria-label="圖片：移動游標或手指選色，方向鍵也可以移動，Enter 取色"
        onPointerDown={(e) => {
          touch.current = e.pointerType !== 'mouse'
          pressing.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          update(e)
        }}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' || pressing.current) {
            touch.current = e.pointerType !== 'mouse'
            update(e)
          }
        }}
        onPointerUp={(e) => {
          if (!pressing.current) return
          pressing.current = false
          const p = locate(e.clientX, e.clientY)
          if (p) onPick(sampleAt(image, p.x, p.y, sample))
          if (e.pointerType !== 'mouse') {
            setPos(null)
            setPlace(null)
          }
        }}
        onPointerCancel={() => {
          pressing.current = false
          setPos(null)
          setPlace(null)
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse' && !pressing.current) {
            setPos(null)
            setPlace(null)
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setPos(null)
          setPlace(null)
        }}
      />
      {pos && place && hover && (
        <div className="cpk-loupe" style={{ left: place.left, top: place.top }} aria-hidden="true">
          <canvas ref={loupe} style={{ width: LOUPE_SIZE, height: LOUPE_SIZE }} />
          <span className="cpk-loupe-label">
            <i style={{ background: toHex(hover) }} />
            {toHex(hover)}
          </span>
        </div>
      )}
    </div>
  )
}
