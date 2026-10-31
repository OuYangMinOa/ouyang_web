import { useEffect, useRef, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { actionOf } from '../shared/keys'
import { BOARD_ASPECT, NEXT_ASPECT, drawBoard, drawNext, readPalette, type Palette } from './draw'
import { NEXT, type Puyo } from './engine'
import { KEYS, type Action, type Keys } from './keys'

/** 左右鍵按住多久開始連續移動，以及之後每格的間隔（盤面只有 6 欄，比俄羅斯方塊慢一點） */
const DAS_MS = 160
const ARR_MS = 60

type Held = { dir: -1 | 1; since: number; acc: number } | null

export type PlayfieldHooks = {
  /** 每一幀推進完遊戲後呼叫（取走連鎖事件、推進電腦、送出干擾泡…） */
  onFrame?: (dt: number) => void
  /** 先交給上層處理的按鍵（暫停、音樂），處理了就回傳 true；`action` 是這個鍵設定的動作 */
  onKey?: (code: string, action: Action | undefined) => boolean
}

export type PlayfieldProps = {
  /** 目前的這一局；換局時換一個新的物件 */
  game: RefObject<Puyo | null>
  /** 時間有沒有在走、能不能操作 */
  running: boolean
  keys: Keys
  /** 由上層在 effect 裡更新，迴圈每一幀拿最新的版本來呼叫 */
  hooks: RefObject<PlayfieldHooks>
  overlay?: ReactNode
  /** 盤面上方閃過的字（3 連鎖…） */
  flash?: ReactNode
  /** 放在 NEXT 下面的資訊 */
  info?: ReactNode
  /** 對戰時對手的盤面，放在右邊 */
  opponent?: ReactNode
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

/** 主題切換時重讀顏色；回傳取得目前顏色的函式和解除監聽 */
function watchPalette(): [() => Palette, () => void] {
  let palette = readPalette()
  const refresh = () => (palette = readPalette())
  const mo = new MutationObserver(refresh)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', refresh)
  return [
    () => palette,
    () => {
      mo.disconnect()
      mq.removeEventListener('change', refresh)
    },
  ]
}

const PAD = [
  ['ccw', '⟲', '逆時針旋轉'],
  ['cw', '⟳', '順時針旋轉'],
  ['left', '◀', '左移'],
  ['down', '▼', '加速下落'],
  ['right', '▶', '右移'],
  ['drop', '⤓', '直接落下'],
] as const

/** 只負責畫的盤面（對戰時電腦那邊），遊戲由上層推進 */
export function BoardView({ game, label, flash }: { game: RefObject<Puyo | null>; label: string; flash?: ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let size = 0
    const ro = new ResizeObserver(() => (size = fit(canvas, ctx, BOARD_ASPECT)))
    ro.observe(canvas)
    size = fit(canvas, ctx, BOARD_ASPECT)
    const [palette, unwatch] = watchPalette()
    let raf = 0
    const loop = () => {
      const g = game.current
      if (g && size > 0) drawBoard(ctx, size, g, palette())
      else ctx.clearRect(0, 0, canvas.width, canvas.height)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      unwatch()
    }
  }, [game])
  return (
    <div className="puyo-board-box">
      <canvas ref={ref} className="puyo-board" aria-label={label} />
      {flash && <div className="game-flash">{flash}</div>}
    </div>
  )
}

export function Playfield({ game, running, keys, hooks, overlay, flash, info, opponent }: PlayfieldProps) {
  const boardRef = useRef<HTMLCanvasElement>(null)
  const nextRef = useRef<HTMLCanvasElement>(null)
  const held = useRef<Held>(null)

  // 迴圈與事件只註冊一次，透過 ref 拿最新的 props
  const latest = useRef({ running, keys })
  useEffect(() => {
    latest.current = { running, keys }
  })

  function act(fn: (g: Puyo) => void) {
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
    game.current?.setSoftDrop(on && latest.current.running)
  }

  const controls = useRef({ press, release, soft, act })
  useEffect(() => {
    controls.current = { press, release, soft, act }
  })

  useEffect(() => {
    const board = boardRef.current
    const next = nextRef.current
    const bctx = board?.getContext('2d')
    const nctx = next?.getContext('2d')
    if (!board || !next || !bctx || !nctx) return
    const size = { board: 0, next: 0 }
    const resize = () => {
      size.board = fit(board, bctx, BOARD_ASPECT)
      size.next = fit(next, nctx, NEXT_ASPECT)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(board)
    ro.observe(next)
    resize()
    const [palette, unwatch] = watchPalette()

    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(now - last, 100)
      last = now
      const g = game.current
      if (g && latest.current.running && !g.over) {
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
        drawBoard(bctx, size.board, g, palette())
        drawNext(nctx, size.next, g.next.slice(0, NEXT), palette())
      } else {
        bctx.clearRect(0, 0, board.width, board.height)
        nctx.clearRect(0, 0, next.width, next.height)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      unwatch()
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
    <div className="puyo-play">
      <div className={`puyo-field${opponent ? ' versus' : ''}`}>
        <div className="puyo-side">
          {opponent && <span className="puyo-label">YOU</span>}
          <div className="puyo-board-box">
            <canvas ref={boardRef} className="puyo-board" aria-label="魔法氣泡盤面" />
            {flash && <div className="game-flash">{flash}</div>}
            {overlay}
          </div>
        </div>
        <div className="puyo-col">
          <span className="puyo-label">NEXT</span>
          <canvas ref={nextRef} className="puyo-next" aria-label="接下來的氣泡" />
          {info}
        </div>
        {opponent}
      </div>

      <div className="puyo-pad" aria-label="操作按鈕" onContextMenu={(e) => e.preventDefault()}>
        {PAD.map(([action, icon, label]) => (
          <button
            key={action}
            type="button"
            className={action === 'drop' ? 'puyo-drop' : 'secondary'}
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
