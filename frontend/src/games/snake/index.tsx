import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { load, save } from '../shared/storage'
import { GameLayout, Overlay, Segmented, StatusLine, Toolbar } from '../shared/ui'
import { drawGame, readPalette } from './draw'
import {
  APPLE_MOVE_MS,
  TICK_MS,
  ageApple,
  appleWarnMs,
  newGame,
  queueTurn,
  step,
  type AppleLevel,
  type Dir,
  type Game,
  type Mode,
  type Speed,
} from './logic'
import './snake.css'

type Phase = 'ready' | 'running' | 'paused' | 'over'
type Settings = { speed: Speed; apple: AppleLevel; mode: Mode }

type Engine = {
  game: Game
  phase: Phase
  settings: Settings
  /** 累積到下一步的時間 */
  acc: number
  /** 頭尾互換提示光圈剩下的毫秒數 */
  flash: number
  /** 不在遊戲中時，只有狀態變了才重畫 */
  dirty: boolean
}

const SPEEDS: { value: Speed; label: string }[] = [
  { value: 'slow', label: '慢' },
  { value: 'normal', label: '普通' },
  { value: 'fast', label: '快' },
]
const APPLES: { value: AppleLevel; label: string }[] = [
  { value: 'easy', label: '簡單' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困難' },
]
const MODES: { value: Mode; label: string }[] = [
  { value: 'normal', label: '一般' },
  { value: 'reverse', label: '來回' },
]

const APPLE_HINT: Record<AppleLevel, string> = {
  easy: '蘋果不會移動',
  normal: '蘋果每 5 秒換位置',
  hard: '蘋果每 2 秒換位置',
}
const MODE_HINT: Record<Mode, string> = {
  normal: '吃到蘋果後繼續往前走',
  reverse: '吃到蘋果後頭尾互換，改從原本的尾巴往外走',
}

// 用 code 而不是 key：注音輸入法開著時 WASD 一樣能用
const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
}

const SWIPE_PX = 24
const FLASH_MS = 500

function loadSettings(): Settings {
  const raw = load<Partial<Settings>>('snake:settings', {})
  return {
    speed: SPEEDS.some((o) => o.value === raw.speed) ? raw.speed! : 'normal',
    apple: APPLES.some((o) => o.value === raw.apple) ? raw.apple! : 'easy',
    mode: MODES.some((o) => o.value === raw.mode) ? raw.mode! : 'normal',
  }
}

function createEngine(): Engine {
  return { game: newGame(), phase: 'ready', settings: loadSettings(), acc: 0, flash: 0, dirty: true }
}

function comboKey(s: Settings): string {
  return `${s.speed}-${s.apple}-${s.mode}`
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

export default function Snake() {
  const [settings, setSettings] = useState(loadSettings)
  const [phase, setPhase] = useState<Phase>('ready')
  const [score, setScore] = useState(0)
  const [result, setResult] = useState<{ won: boolean; record: boolean } | null>(null)
  const [best, setBest] = useState<Record<string, number>>(() => load('snake:best', {}))
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const swipe = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  // 遊戲狀態放在 ref 裡的可變物件給 requestAnimationFrame 迴圈用，React state 只放畫面上要顯示的文字。
  // 第一次用到時才建立；只在事件處理與 effect 裡呼叫
  const engineRef = useRef<Engine | null>(null)
  const engine = () => (engineRef.current ??= createEngine())

  function setBoth(p: Phase) {
    const e = engine()
    e.phase = p
    e.dirty = true
    setPhase(p)
  }

  function restart(next: Settings = engine().settings) {
    const e = engine()
    e.settings = next
    e.game = newGame()
    e.acc = 0
    e.flash = 0
    setScore(0)
    setResult(null)
    setBoth('ready')
  }

  function start() {
    if (engine().phase !== 'ready') return
    engine().acc = 0
    setBoth('running')
  }

  function pause() {
    if (engine().phase === 'running') setBoth('paused')
  }

  function resume() {
    if (engine().phase === 'paused') setBoth('running')
  }

  function togglePause() {
    if (engine().phase === 'running') pause()
    else resume()
  }

  function turn(d: Dir) {
    const e = engine()
    if (e.phase === 'over') return
    e.game = queueTurn(e.game, d)
    if (e.phase === 'ready') start()
    else resume()
  }

  /** 點擊棋盤（沒有滑動） */
  function tap() {
    if (engine().phase === 'ready') start()
    else resume()
  }

  function finish(game: Game) {
    const key = comboKey(engine().settings)
    const record = game.score > 0 && game.score > (best[key] ?? 0)
    if (record) {
      const next = { ...best, [key]: game.score }
      setBest(next)
      save('snake:best', next)
    }
    setResult({ won: game.over === 'won', record })
    setBoth('over')
  }

  function changeSettings(patch: Partial<Settings>) {
    const next = { ...settings, ...patch }
    if (comboKey(next) === comboKey(settings)) return
    setSettings(next)
    save('snake:settings', next)
    restart(next)
  }

  /** 每一幀由迴圈呼叫：推進遊戲時間 */
  function frame(dt: number) {
    const e = engine()
    if (e.phase !== 'running') return
    const { speed, apple, mode } = e.settings
    const tick = TICK_MS[speed]
    e.flash = Math.max(0, e.flash - dt)
    e.game = ageApple(e.game, dt, APPLE_MOVE_MS[apple])
    e.acc += dt
    while (e.acc >= tick && e.phase === 'running') {
      e.acc -= tick
      const r = step(e.game, mode)
      e.game = r.game
      if (r.ate) setScore(r.game.score)
      if (r.reversed) {
        // 頭尾互換後多停一拍，讓玩家看清楚新的頭在哪
        e.acc = -tick
        e.flash = FLASH_MS
      }
      if (r.game.over) finish(r.game)
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
    const d = KEY_DIRS[e.code]
    if (d) {
      e.preventDefault()
      turn(d)
      return
    }
    if (e.code === 'Escape') {
      pause()
    } else if (e.code === 'Space' || e.code === 'KeyP') {
      // 焦點在按鈕上時讓按鈕自己處理空白鍵，免得觸發兩次
      if (e.code === 'Space' && e.target instanceof HTMLButtonElement) return
      e.preventDefault()
      if (engine().phase === 'ready') start()
      else if (engine().phase === 'over') restart()
      else togglePause()
    }
  }

  // 迴圈與事件只註冊一次，透過 ref 呼叫最新版本的函式
  const actions = useRef({ frame, onKey, pause })
  useEffect(() => {
    actions.current = { frame, onKey, pause }
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let palette = readPalette()
    let px = 0
    let raf = 0
    let last = performance.now()

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      px = canvas.clientWidth
      if (px === 0) return
      canvas.width = Math.round(px * dpr)
      canvas.height = Math.round(px * dpr)
      ctx.setTransform(canvas.width / px, 0, 0, canvas.height / px, 0, 0)
      engine().dirty = true
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    const refresh = () => {
      palette = readPalette()
      engine().dirty = true
    }
    const mo = new MutationObserver(refresh)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', refresh)

    const loop = (now: number) => {
      // 分頁在背景時 rAF 會停，回來時的 dt 很大，限制住免得一次跳很多格
      const dt = Math.min(now - last, 100)
      last = now
      actions.current.frame(dt)
      const e = engine()
      if ((e.dirty || e.phase === 'running') && px > 0) {
        e.dirty = false
        const period = APPLE_MOVE_MS[e.settings.apple]
        const left = period === null ? 0 : Math.max(0, period - e.game.appleAge)
        // 最後一小段時間閃爍，提醒蘋果要跑了
        const warning = period !== null && e.phase === 'running' && left < appleWarnMs(period)
        drawGame(ctx, px, e.game, palette, {
          appleLeft: period === null ? null : left / period,
          appleHidden: warning && Math.floor(left / 125) % 2 === 0,
          flash: e.flash / FLASH_MS,
        })
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
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => actions.current.onKey(e)
    const visibility = () => {
      if (document.hidden) actions.current.pause()
    }
    window.addEventListener('keydown', key)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('keydown', key)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    swipe.current = { x: e.clientX, y: e.clientY, moved: false }
  }

  function onPointerMove(e: PointerEvent) {
    const s = swipe.current
    if (!s) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up')
    // 以目前位置為新起點，一次滑動中途可以再轉彎
    swipe.current = { x: e.clientX, y: e.clientY, moved: true }
  }

  function onPointerUp() {
    if (swipe.current && !swipe.current.moved) tap()
    swipe.current = null
  }

  const bestHere = best[comboKey(settings)] ?? 0
  const running = phase === 'running'

  const side = (
    <>
      <Segmented
        label="速度"
        value={settings.speed}
        options={SPEEDS}
        onChange={(speed) => changeSettings({ speed })}
        disabled={running}
      />
      <Segmented
        label="蘋果"
        value={settings.apple}
        options={APPLES}
        onChange={(apple) => changeSettings({ apple })}
        disabled={running}
      />
      <Segmented
        label="模式"
        value={settings.mode}
        options={MODES}
        onChange={(mode) => changeSettings({ mode })}
        disabled={running}
      />
      <p className="muted">
        {APPLE_HINT[settings.apple]}；{MODE_HINT[settings.mode]}。
        {running ? '暫停後可以改設定（會重新開始）。' : ''}
      </p>
      <p className="muted">方向鍵／WASD 轉向，空白鍵暫停；手機在棋盤上滑動或用下方按鈕。</p>
    </>
  )

  return (
    <GameLayout side={side}>
      <StatusLine tone={phase === 'over' ? (result?.won ? 'ok' : 'danger') : undefined}>
        分數 {score}
        <span className="snake-best"> · 最高 {Math.max(bestHere, phase === 'over' ? 0 : score)}</span>
      </StatusLine>

      <div
        className="board-box snake-board"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipe.current = null)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={canvasRef} className="snake-canvas" aria-label="貪食蛇棋盤" />
        {phase === 'ready' && (
          <Overlay>
            <strong className="snake-overlay-title">點擊或按任意方向開始</strong>
            <span className="muted">
              {MODE_HINT[settings.mode]}，{APPLE_HINT[settings.apple]}
            </span>
          </Overlay>
        )}
        {phase === 'paused' && (
          <Overlay>
            <strong className="snake-overlay-title">⏸ 已暫停</strong>
            <span className="muted">點擊棋盤、按空白鍵或方向鍵繼續</span>
          </Overlay>
        )}
        {phase === 'over' && result && (
          <Overlay>
            <strong className="snake-overlay-title">{result.won ? '🎉 整個棋盤都是蛇了！' : '💥 遊戲結束'}</strong>
            <span>
              得分 {score}
              {result.record ? '，新紀錄！' : `（最高 ${bestHere}）`}
            </span>
            <button type="button" onClick={() => restart()}>
              再玩一次
            </button>
          </Overlay>
        )}
      </div>

      <div className="snake-dpad" aria-label="方向按鈕">
        {(
          [
            ['up', '▲', '上'],
            ['left', '◀', '左'],
            ['down', '▼', '下'],
            ['right', '▶', '右'],
          ] as const
        ).map(([d, icon, label]) => (
          <button
            key={d}
            type="button"
            className={`secondary snake-dpad-${d}`}
            aria-label={label}
            onPointerDown={(e) => {
              // 按下就轉向（比 click 快）；不搶焦點，免得之後空白鍵按到這顆按鈕
              e.preventDefault()
              turn(d)
            }}
            onClick={() => turn(d)}
          >
            {icon}
          </button>
        ))}
      </div>

      <Toolbar>
        <button type="button" className="secondary" onClick={togglePause} disabled={phase === 'ready' || phase === 'over'}>
          {phase === 'paused' ? '▶ 繼續' : '⏸ 暫停'}
        </button>
        <button type="button" className="secondary" onClick={() => restart()}>
          重新開始
        </button>
      </Toolbar>
    </GameLayout>
  )
}
