import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Board } from './board'
import {
  COLOR_NAMES,
  ERASER,
  H,
  MAX_BATCH,
  MAX_POINTS,
  MAX_STROKES,
  PALETTE,
  PAPER,
  W,
  WIDTH_NAMES,
  WIDTHS,
  type DrawAction,
  type Stroke,
} from './types'

/** 每隔多久把累積的點送出去（太頻繁會碰到伺服器的限速，太久別人看起來會一頓一頓的） */
const FLUSH_MS = 50
/** 兩個點至少隔這麼遠（畫布單位）才記，手抖和高頻率的觸控不會塞一堆幾乎重疊的點 */
const MIN_STEP = 3

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

/** 整張重畫（點最多兩萬個，一次不到幾毫秒），用 requestAnimationFrame 合併 */
function paint(el: HTMLCanvasElement, strokes: Stroke[]) {
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, el.width, el.height)
  ctx.setTransform(el.width / W, 0, 0, el.height / H, 0, 0)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of strokes) {
    const color = PALETTE[s.c] ?? PALETTE[1]
    const width = WIDTHS[s.w] ?? WIDTHS[1]
    const p = s.p
    if (p.length < 2) continue
    if (p.length === 2) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(p[0], p[1], width / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.moveTo(p[0], p[1])
    for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i], p[i + 1])
    ctx.stroke()
  }
}

type Active = { pointer: number; last: [number, number]; queue: number[] }

/**
 * 畫布：所有人都看得到，`canDraw` 時（輪到自己、作畫中）可以畫，下面多一排工具。
 * 筆畫存在 `board`（見 board.ts），這裡只負責畫出來和把輸入變成動作送出去。
 */
export function Sketch({
  board,
  canvasId,
  canDraw,
  send,
  overlay,
}: {
  board: Board
  /** 目前這一棒的畫布 id：本地的畫布還沒換成這一張（剛換人、view 還沒套用）時先不能畫 */
  canvasId: number
  canDraw: boolean
  send: (action: DrawAction) => void
  overlay?: ReactNode
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const active = useRef<Active | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const [color, setColor] = useState(1)
  const [width, setWidth] = useState(1)
  const [eraser, setEraser] = useState(false)
  const [full, setFull] = useState(false)
  // 讓「復原」「清除」按鈕跟著畫布狀態更新
  const [, setVersion] = useState(0)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let frame = 0
    const draw = () => {
      frame = 0
      paint(el, board.strokes)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw)
      setVersion((n) => n + 1)
    }
    // 畫布的像素跟著實際大小和螢幕密度，線條才清楚
    const resize = () => {
      const rect = el.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(rect.width * dpr))
      const h = Math.max(1, Math.round(rect.height * dpr))
      if (el.width !== w || el.height !== h) {
        el.width = w
        el.height = h
      }
      schedule()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()
    const unsubscribe = board.subscribe(schedule)
    return () => {
      observer.disconnect()
      unsubscribe()
      cancelAnimationFrame(frame)
    }
  }, [board])

  function flush() {
    const s = active.current
    if (!s) return
    while (s.queue.length > 0) {
      const p = s.queue.splice(0, MAX_BATCH * 2)
      send({ type: 'more', p })
      board.sent()
    }
  }

  function stop() {
    flush()
    clearInterval(timer.current)
    timer.current = undefined
    active.current = null
  }

  // 輪到別人或時間到：正在畫的那一筆就停在這裡
  useEffect(() => {
    if (!canDraw && active.current) stop()
  })
  useEffect(() => () => clearInterval(timer.current), [])

  function point(e: { clientX: number; clientY: number }): [number, number] {
    const rect = canvas.current!.getBoundingClientRect()
    return [
      clamp(Math.round(((e.clientX - rect.left) / rect.width) * W), 0, W),
      clamp(Math.round(((e.clientY - rect.top) / rect.height) * H), 0, H),
    ]
  }

  function down(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!canDraw || board.id !== canvasId || active.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (board.strokes.length >= MAX_STROKES || board.points >= MAX_POINTS) {
      setFull(true)
      return
    }
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const [x, y] = point(e)
    const c = eraser ? ERASER : color
    board.local({ kind: 'begin', c, w: width, p: [x, y] })
    send({ type: 'begin', c, w: width, p: [x, y] })
    active.current = { pointer: e.pointerId, last: [x, y], queue: [] }
    clearInterval(timer.current)
    timer.current = setInterval(flush, FLUSH_MS)
  }

  function move(e: ReactPointerEvent<HTMLCanvasElement>) {
    const s = active.current
    if (!s || e.pointerId !== s.pointer) return
    const native = e.nativeEvent
    const coalesced = native.getCoalescedEvents?.() ?? []
    const added: number[] = []
    for (const ev of coalesced.length > 0 ? coalesced : [native]) {
      const [x, y] = point(ev)
      const dx = x - s.last[0]
      const dy = y - s.last[1]
      if (dx * dx + dy * dy < MIN_STEP * MIN_STEP) continue
      if (board.points + added.length / 2 >= MAX_POINTS) {
        setFull(true)
        break
      }
      added.push(x, y)
      s.last = [x, y]
    }
    if (added.length > 0) {
      s.queue.push(...added)
      board.extend(added)
    }
  }

  function up(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (active.current?.pointer === e.pointerId) stop()
  }

  function undo() {
    if (active.current || board.strokes.length === 0) return
    board.local({ kind: 'undo' })
    send({ type: 'undo' })
    setFull(false)
  }

  function clear() {
    if (active.current || board.strokes.length === 0) return
    if (board.strokes.length > 5 && !window.confirm('清除整張畫？')) return
    board.local({ kind: 'clear' })
    send({ type: 'clear' })
    setFull(false)
  }

  // 鍵盤：Ctrl／Cmd + Z 復原
  useEffect(() => {
    if (!canDraw) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        if (active.current || board.strokes.length === 0) return
        board.local({ kind: 'undo' })
        send({ type: 'undo' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canDraw, board, send])

  const empty = board.strokes.length === 0

  return (
    <div className="dg-sketch">
      <div className={`dg-paper${canDraw ? ' drawing' : ''}`}>
        <canvas
          ref={canvas}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onLostPointerCapture={up}
          aria-label={canDraw ? '畫布：在這裡畫' : '畫布'}
        />
        {overlay && <div className="dg-overlay">{overlay}</div>}
      </div>
      {canDraw && (
        <div className="dg-tools" aria-label="畫筆工具">
          <div className="dg-palette" role="radiogroup" aria-label="顏色">
            {PALETTE.map((hex, i) =>
              i === ERASER ? null : (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={!eraser && color === i}
                  aria-label={COLOR_NAMES[i]}
                  title={COLOR_NAMES[i]}
                  className={`dg-swatch${!eraser && color === i ? ' active' : ''}`}
                  style={{ background: hex }}
                  onClick={() => {
                    setColor(i)
                    setEraser(false)
                  }}
                />
              ),
            )}
          </div>
          <div className="dg-tool-row">
            <div className="dg-widths" role="radiogroup" aria-label="粗細">
              {WIDTHS.map((w, i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={width === i}
                  aria-label={WIDTH_NAMES[i]}
                  title={WIDTH_NAMES[i]}
                  className={`dg-width${width === i ? ' active' : ' secondary'}`}
                  onClick={() => setWidth(i)}
                >
                  <span style={{ width: 4 + w * 0.6, height: 4 + w * 0.6 }} />
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`dg-tool${eraser ? '' : ' secondary'}`}
              aria-pressed={eraser}
              onClick={() => setEraser((on) => !on)}
            >
              橡皮擦
            </button>
            <button type="button" className="dg-tool secondary" onClick={undo} disabled={empty}>
              復原
            </button>
            <button type="button" className="dg-tool secondary" onClick={clear} disabled={empty}>
              清除
            </button>
          </div>
          {full && <p className="error">這張畫的筆畫太多了，清除或復原一些再畫。</p>}
        </div>
      )}
    </div>
  )
}
