import { useEffect, useRef, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { drawBoard, drawPreview, readPalette, METER } from './draw'
import { COLS, PREVIEW, ROWS, type Tetris } from './engine'
import { actionOf } from '../shared/keys'
import { KEYS, type Action, type Keys } from './keys'

/** 左右鍵按住多久開始連續移動，以及之後每格的間隔 */
const DAS_MS = 150
const ARR_MS = 40

type Held = { dir: -1 | 1; since: number; acc: number } | null

export type PlayfieldHooks = {
  /** 每一幀推進完遊戲後呼叫（取走鎖定事件、送出攻擊…） */
  onFrame?: (dt: number) => void
  /** 先交給上層處理的按鍵（暫停、音樂、換目標策略…），處理了就回傳 true；`action` 是這個鍵設定的動作 */
  onKey?: (code: string, action: Action | undefined) => boolean
}

export type PlayfieldProps = {
  /** 目前的這一局；換局時換一個新的物件 */
  game: RefObject<Tetris | null>
  /** 時間有沒有在走、能不能操作 */
  running: boolean
  /** 快捷鍵設定 */
  keys: Keys
  /** 由上層在 effect 裡更新，迴圈每一幀拿最新的版本來呼叫 */
  hooks: RefObject<PlayfieldHooks>
  overlay?: ReactNode
  /** 盤面上方閃過的字（TETRIS、T-SPIN…） */
  flash?: ReactNode
  /** 放在 Hold 下面的資訊 */
  info?: ReactNode
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/** 讓 canvas 的實際像素跟著顯示大小與螢幕密度；回傳 CSS 寬度 */
function fit(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, aspect: number): number {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = w * aspect
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx.setTransform(canvas.width / (w || 1), 0, 0, canvas.height / (h || 1), 0, 0)
  return w
}

const PAD = [
  ['hold', 'HOLD', '保留'],
  ['ccw', '⟲', '逆時針旋轉'],
  ['cw', '⟳', '順時針旋轉'],
  ['left', '◀', '左移'],
  ['down', '▼', '加速下落'],
  ['right', '▶', '右移'],
  ['drop', '⤓', '直接落下'],
] as const

const BOARD_ASPECT = ROWS / (COLS + METER)
const HOLD_ASPECT = 0.75
const NEXT_ASPECT = 0.75 * PREVIEW

export function Playfield({ game, running, keys, hooks, overlay, flash, info }: PlayfieldProps) {
  const boardRef = useRef<HTMLCanvasElement>(null)
  const holdRef = useRef<HTMLCanvasElement>(null)
  const nextRef = useRef<HTMLCanvasElement>(null)
  const held = useRef<Held>(null)

  // 迴圈與事件只註冊一次，透過 ref 拿最新的 props
  const latest = useRef({ running, keys })
  useEffect(() => {
    latest.current = { running, keys }
  })

  function act(fn: (g: Tetris) => void) {
    const g = game.current
    if (g && latest.current.running && !g.over) fn(g)
  }

  function press(dir: -1 | 1) {
    act((g) => g.move(dir))
    held.current = { dir, since: performance.now(), acc: 0 }
  }

  function release(dir: -1 | 1) {
    if (held.current?.dir === dir) held.current = null
  }

  function soft(on: boolean) {
    const g = game.current
    g?.setSoftDrop(on && latest.current.running)
  }

  const controls = useRef({ press, release, soft, act })
  useEffect(() => {
    controls.current = { press, release, soft, act }
  })

  useEffect(() => {
    const board = boardRef.current
    const hold = holdRef.current
    const next = nextRef.current
    const bctx = board?.getContext('2d')
    const hctx = hold?.getContext('2d')
    const nctx = next?.getContext('2d')
    if (!board || !hold || !next || !bctx || !hctx || !nctx) return
    let palette = readPalette()
    const size = { board: 0, hold: 0, next: 0 }
    const resize = () => {
      size.board = fit(board, bctx, BOARD_ASPECT)
      size.hold = fit(hold, hctx, HOLD_ASPECT)
      size.next = fit(next, nctx, NEXT_ASPECT)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(board)
    ro.observe(hold)
    ro.observe(next)
    resize()
    const refresh = () => (palette = readPalette())
    const mo = new MutationObserver(refresh)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', refresh)

    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(now - last, 100)
      last = now
      const g = game.current
      const { running } = latest.current
      if (g && running && !g.over) {
        const h = held.current
        if (h && now - h.since >= DAS_MS) {
          h.acc += dt
          while (h.acc >= ARR_MS) {
            h.acc -= ARR_MS
            if (!g.move(h.dir)) {
              h.acc = 0
              break
            }
          }
        }
        g.update(dt)
      }
      hooks.current.onFrame?.(dt)
      if (g && size.board > 0) {
        drawBoard(bctx, size.board, g, palette)
        drawPreview(hctx, size.hold, [g.hold], palette, g.holdUsed)
        drawPreview(nctx, size.next, g.next.slice(0, PREVIEW), palette)
      } else {
        bctx.clearRect(0, 0, board.width, board.height)
        hctx.clearRect(0, 0, hold.width, hold.height)
        nctx.clearRect(0, 0, next.width, next.height)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      mq.removeEventListener('change', refresh)
    }
  }, [game, hooks])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.altKey || isTyping(e.target)) return
      const c = controls.current
      const code = e.code
      const action = actionOf(KEYS, latest.current.keys, code)
      const handled = () => e.preventDefault()
      if (hooks.current.onKey?.(code, action)) return handled()
      if (!latest.current.running || !action) return
      // 焦點留在按鈕上的話，空白鍵放開時會再按一次那顆按鈕
      if (e.target instanceof HTMLButtonElement) e.target.blur()
      // 按住不放時瀏覽器會一直送 keydown，移動的連發自己算
      if (e.repeat) return handled()
      switch (action) {
        case 'left':
          c.press(-1)
          return handled()
        case 'right':
          c.press(1)
          return handled()
        case 'soft':
          c.soft(true)
          return handled()
        case 'hard':
          c.act((g) => g.hardDrop())
          return handled()
        case 'cw':
          c.act((g) => g.rotate(1))
          return handled()
        case 'ccw':
          c.act((g) => g.rotate(-1))
          return handled()
        case 'hold':
          c.act((g) => g.holdPiece())
          return handled()
      }
    }
    const up = (e: KeyboardEvent) => {
      const c = controls.current
      const action = actionOf(KEYS, latest.current.keys, e.code)
      if (action === 'left') c.release(-1)
      else if (action === 'right') c.release(1)
      else if (action === 'soft') c.soft(false)
    }
    const blur = () => {
      held.current = null
      controls.current.soft(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [hooks])

  /** 觸控按鈕：按下就動作（比 click 快），不搶焦點；左右和下可以按住 */
  function padDown(e: PointerEvent<HTMLButtonElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const c = controls.current
    switch (e.currentTarget.dataset.action) {
      case 'hold':
        return c.act((g) => g.holdPiece())
      case 'ccw':
        return c.act((g) => g.rotate(-1))
      case 'cw':
        return c.act((g) => g.rotate(1))
      case 'left':
        return c.press(-1)
      case 'right':
        return c.press(1)
      case 'down':
        return c.soft(true)
      case 'drop':
        return c.act((g) => g.hardDrop())
    }
  }

  function padUp(e: PointerEvent<HTMLButtonElement>) {
    const c = controls.current
    switch (e.currentTarget.dataset.action) {
      case 'left':
        return c.release(-1)
      case 'right':
        return c.release(1)
      case 'down':
        return c.soft(false)
    }
  }

  const pad = { onPointerDown: padDown, onPointerUp: padUp, onPointerCancel: padUp }

  return (
    <div className="tetris-play">
      <div className="tetris-field">
        <div className="tetris-col">
          <span className="tetris-label">HOLD</span>
          <canvas ref={holdRef} className="tetris-hold" aria-label="保留的方塊" />
          {info}
        </div>
        <div className="tetris-board-box">
          <canvas ref={boardRef} className="tetris-board" aria-label="俄羅斯方塊盤面" />
          {flash && <div className="game-flash">{flash}</div>}
          {overlay}
        </div>
        <div className="tetris-col">
          <span className="tetris-label">NEXT</span>
          <canvas ref={nextRef} className="tetris-next" aria-label="接下來的方塊" />
        </div>
      </div>

      <div className="tetris-pad" aria-label="操作按鈕" onContextMenu={(e) => e.preventDefault()}>
        {PAD.map(([action, icon, label]) => (
          <button
            key={action}
            type="button"
            className={action === 'drop' ? 'tetris-drop' : 'secondary'}
            data-action={action}
            aria-label={label}
            {...pad}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  )
}
