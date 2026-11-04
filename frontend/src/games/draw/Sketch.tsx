import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Board } from './board'
import { Paper } from './paper'
import {
  COLOR_NAMES,
  ERASER,
  H,
  MAX_BATCH,
  MAX_FILLS,
  MAX_POINTS,
  MAX_STROKES,
  PALETTE,
  W,
  WIDTH_NAMES,
  WIDTHS,
  type DrawAction,
} from './types'

/** 每隔多久把累積的點送出去（太頻繁會碰到伺服器的限速，太久別人看起來會一頓一頓的） */
const FLUSH_MS = 50
/** 兩個點至少隔這麼遠（畫布單位）才記，手抖和高頻率的觸控不會塞一堆幾乎重疊的點；粗的筆隔遠一點也看不出來 */
const MIN_STEP = 3
/** 送出前拿掉偏離不到這麼多（畫布單位）的點：直線和平順的曲線只要留幾個點 */
const SIMPLIFY = 1

const FULL = '這張畫的筆畫太多了，清除或復原一些再畫。'
const TOO_MANY_FILLS = '這張畫倒太多次顏料了，清除或復原一些再倒。'

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

/** 點到線段 a–b 的距離 */
function distance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1)
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/**
 * 拿掉幾乎在一直線上的點（Ramer–Douglas–Peucker）：`from` 是已經送出去的上一個點，
 * 回傳 `p` 裡要留下的點，最後一個點一定留著。
 */
function simplify(from: [number, number], p: number[]): number[] {
  const xs = [from[0]]
  const ys = [from[1]]
  for (let i = 0; i + 1 < p.length; i += 2) {
    xs.push(p[i])
    ys.push(p[i + 1])
  }
  const n = xs.length
  const keep = new Uint8Array(n)
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    let far = SIMPLIFY
    let worst = -1
    for (let i = a + 1; i < b; i++) {
      const d = distance(xs[i], ys[i], xs[a], ys[a], xs[b], ys[b])
      if (d > far) {
        far = d
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  const out: number[] = []
  for (let i = 1; i < n; i++) if (keep[i]) out.push(xs[i], ys[i])
  return out
}

type Tool = 'pen' | 'eraser' | 'fill'

/** `sent` 是已經送出去的最後一個點，`queue` 是還沒送的點 */
type Active = { pointer: number; canvas: number; step: number; last: [number, number]; sent: [number, number]; queue: number[] }

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
  toast,
  maxStrokes = MAX_STROKES,
  maxPoints = MAX_POINTS,
}: {
  board: Board
  /** 目前這一棒的畫布 id：本地的畫布還沒換成這一張（剛換人、view 還沒套用）時先不能畫 */
  canvasId: number
  canDraw: boolean
  send: (action: DrawAction) => void
  overlay?: ReactNode
  /** 浮在畫布上方、不擋住畫面的短暫提示（例如「差一點！」） */
  toast?: ReactNode
  /** 一張畫最多幾筆、幾個點（傳話畫畫整張一次送，上限比較低） */
  maxStrokes?: number
  maxPoints?: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const active = useRef<Active | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const [paper] = useState(() => new Paper())
  const [color, setColor] = useState(1)
  const [width, setWidth] = useState(1)
  const [tool, setTool] = useState<Tool>('pen')
  // 畫不下時的提示，只在同一張畫布顯示（換下一棒就不見）
  const [full, setFull] = useState<{ canvas: number; message: string } | null>(null)
  const fullMessage = full?.canvas === canvasId ? full.message : null
  const eraser = tool === 'eraser'
  // 讓「復原」「清除」按鈕跟著畫布狀態更新
  const [, setVersion] = useState(0)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let frame = 0
    const draw = () => {
      frame = 0
      paper.paint(el, board.strokes)
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
  }, [board, paper])

  function flush() {
    const s = active.current
    if (!s || s.queue.length === 0) return
    // 剛換下一棒、畫布已經換掉了：這些點沒地方接
    if (board.id !== s.canvas) {
      s.queue = []
      return
    }
    const count = s.queue.length / 2
    const points = simplify(s.sent, s.queue)
    s.queue = []
    s.sent = [points[points.length - 2], points[points.length - 1]]
    board.replaceTail(count, points)
    for (let i = 0; i < points.length; i += MAX_BATCH * 2) {
      send({ type: 'more', p: points.slice(i, i + MAX_BATCH * 2) })
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
    if (board.strokes.length >= maxStrokes || board.points >= maxPoints) {
      setFull({ canvas: canvasId, message: FULL })
      return
    }
    e.preventDefault()
    const [x, y] = point(e)
    if (tool === 'fill') {
      if (board.fills >= MAX_FILLS) {
        setFull({ canvas: canvasId, message: TOO_MANY_FILLS })
        return
      }
      board.local({ kind: 'fill', c: color, p: [x, y] })
      send({ type: 'fill', c: color, p: [x, y] })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const c = eraser ? ERASER : color
    board.local({ kind: 'begin', c, w: width, p: [x, y] })
    send({ type: 'begin', c, w: width, p: [x, y] })
    active.current = {
      pointer: e.pointerId,
      canvas: board.id,
      step: Math.max(MIN_STEP, WIDTHS[width] / 4),
      last: [x, y],
      sent: [x, y],
      queue: [],
    }
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
      if (dx * dx + dy * dy < s.step * s.step) continue
      if (board.points + added.length / 2 >= maxPoints) {
        setFull({ canvas: canvasId, message: FULL })
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
    setFull(null)
  }

  function clear() {
    if (active.current || board.strokes.length === 0) return
    if (board.strokes.length > 5 && !window.confirm('清除整張畫？')) return
    board.local({ kind: 'clear' })
    send({ type: 'clear' })
    setFull(null)
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
      <div className={`dg-paper${canDraw ? ` drawing${tool === 'fill' ? ' filling' : ''}` : ''}`}>
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
        {toast}
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
                    if (eraser) setTool('pen')
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
                  onClick={() => {
                    setWidth(i)
                    if (tool === 'fill') setTool('pen')
                  }}
                >
                  <span style={{ width: 4 + w * 0.6, height: 4 + w * 0.6 }} />
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`dg-tool${tool === 'fill' ? '' : ' secondary'}`}
              aria-pressed={tool === 'fill'}
              title="點一下，把那一塊塗滿目前的顏色"
              onClick={() => setTool((t) => (t === 'fill' ? 'pen' : 'fill'))}
            >
              🪣 倒顏料
            </button>
            <button
              type="button"
              className={`dg-tool${eraser ? '' : ' secondary'}`}
              aria-pressed={eraser}
              onClick={() => setTool((t) => (t === 'eraser' ? 'pen' : 'eraser'))}
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
          {fullMessage && <p className="error">{fullMessage}</p>}
        </div>
      )}
    </div>
  )
}
