import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { formatTime } from '../shared/format'
import { load, save } from '../shared/storage'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { LEVELS, flagCount, newGame, reveal, toggleFlag, type Cell, type Game, type Level } from './logic'
import './minesweeper.css'

type Tool = 'dig' | 'flag'

const LEVEL_KEYS = Object.keys(LEVELS) as Level[]
const LEVEL_OPTIONS = LEVEL_KEYS.map((value) => ({ value, label: LEVELS[value].label }))
const TOOL_OPTIONS: { value: Tool; label: string }[] = [
  { value: 'dig', label: '⛏️ 挖開' },
  { value: 'flag', label: '🚩 插旗' },
]

const LONG_PRESS_MS = 350
/** 手指移動超過這個距離就當作在捲動棋盤，不算長按 */
const MOVE_TOLERANCE = 10

// 直向螢幕時把高級（30×16）轉成 16 欄 × 30 列，比較好捲動和點
const PORTRAIT = '(orientation: portrait)'
function subscribePortrait(cb: () => void) {
  const mq = window.matchMedia(PORTRAIT)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const isPortrait = () => window.matchMedia(PORTRAIT).matches

function loadLevel(): Level {
  const saved = load<string>('minesweeper:level', 'beginner')
  return LEVEL_KEYS.includes(saved as Level) ? (saved as Level) : 'beginner'
}

function create(level: Level): Game {
  const { cols, rows, mines } = LEVELS[level]
  return newGame(cols, rows, mines)
}

function cellView(cell: Cell, lost: boolean): { text: string; className: string; label: string } {
  if (cell.open) {
    if (cell.mine) return { text: '💣', className: 'ms-cell open boom', label: '踩到的地雷' }
    if (cell.adj > 0) return { text: String(cell.adj), className: `ms-cell open n${cell.adj}`, label: String(cell.adj) }
    return { text: '', className: 'ms-cell open', label: '空白' }
  }
  if (lost && cell.flag && !cell.mine) return { text: '❌', className: 'ms-cell wrong', label: '插錯的旗' }
  if (cell.flag) return { text: '🚩', className: 'ms-cell', label: '旗子' }
  if (lost && cell.mine) return { text: '💣', className: 'ms-cell mine', label: '地雷' }
  return { text: '', className: 'ms-cell', label: '未開' }
}

export default function Minesweeper() {
  const [level, setLevel] = useState(loadLevel)
  const [game, setGame] = useState(() => create(level))
  const [tool, setTool] = useState<Tool>('dig')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [best, setBest] = useState<Partial<Record<Level, number>>>(() => load('minesweeper:best', {}))
  const [record, setRecord] = useState(false)
  const portrait = useSyncExternalStore(subscribePortrait, isPortrait, () => false)

  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const pointerType = useRef('mouse')
  /** 長按已經處理過，接下來那個 click 要忽略 */
  const skipClick = useRef(false)

  useEffect(() => {
    if (game.status !== 'playing') return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [game.status])

  function restart(next: Level = level) {
    setGame(create(next))
    setStartedAt(null)
    setEndedAt(null)
    setRecord(false)
  }

  function changeLevel(next: Level) {
    setLevel(next)
    save('minesweeper:level', next)
    restart(next)
  }

  function apply(next: Game) {
    if (next === game) return
    const t = Date.now()
    const start = startedAt ?? t
    if (startedAt === null && next.status !== 'ready') {
      setStartedAt(t)
      setNow(t)
    }
    if (next.status === 'won' || next.status === 'lost') {
      setEndedAt(t)
      if (next.status === 'won') {
        const seconds = Math.floor((t - start) / 1000)
        const prev = best[level]
        if (prev === undefined || seconds < prev) {
          const updated = { ...best, [level]: seconds }
          setBest(updated)
          save('minesweeper:best', updated)
          setRecord(true)
        }
      }
    }
    setGame(next)
  }

  /** primary：一般點擊（依目前工具）；alt：右鍵或長按（相反的動作） */
  function act(i: number, alt: boolean) {
    const flagging = (tool === 'flag') !== alt
    // 已打開的格子不能插旗，點下去一律當作挖開（數字格會 chord）
    if (flagging && !game.cells[i].open) apply(toggleFlag(game, i))
    else apply(reveal(game, i))
  }

  // 長按的計時器在 render 之後才觸發，透過 ref 呼叫最新的 act
  const actRef = useRef(act)
  useEffect(() => {
    actRef.current = act
  })

  function indexOf(target: EventTarget): number | null {
    const el = (target as HTMLElement).closest<HTMLElement>('[data-i]')
    return el ? Number(el.dataset.i) : null
  }

  function cancelPress() {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }

  function onPointerDown(e: PointerEvent) {
    pointerType.current = e.pointerType
    skipClick.current = false
    cancelPress()
    if (e.pointerType === 'mouse') return
    const i = indexOf(e.target)
    if (i === null) return
    const timer = setTimeout(() => {
      press.current = null
      skipClick.current = true
      navigator.vibrate?.(15)
      actRef.current(i, true)
    }, LONG_PRESS_MS)
    press.current = { x: e.clientX, y: e.clientY, timer }
  }

  function onPointerMove(e: PointerEvent) {
    const p = press.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) cancelPress()
  }

  function onClick(e: MouseEvent) {
    if (skipClick.current) {
      skipClick.current = false
      return
    }
    const i = indexOf(e.target)
    if (i !== null) act(i, false)
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault()
    // 觸控長按也會觸發 contextmenu，那已經由長按計時器處理了
    if (pointerType.current !== 'mouse') return
    const i = indexOf(e.target)
    if (i !== null) act(i, true)
  }

  function onKeyDown(e: KeyboardEvent) {
    // 鍵盤操作：Enter／空白鍵挖開（按鈕預設行為），F 插旗
    if (e.code !== 'KeyF' || e.ctrlKey || e.metaKey || e.altKey) return
    const i = indexOf(e.target)
    if (i !== null && !game.cells[i].open) apply(toggleFlag(game, i))
  }

  const { cols, rows } = game
  const transposed = portrait && cols > rows
  const viewCols = transposed ? rows : cols
  const viewRows = transposed ? cols : rows
  const lost = game.status === 'lost'
  const minesLeft = game.mines - flagCount(game)
  const elapsed = startedAt === null ? 0 : Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000))
  const face = game.status === 'won' ? '😎' : lost ? '😵' : '🙂'

  const cells = []
  for (let vr = 0; vr < viewRows; vr++) {
    for (let vc = 0; vc < viewCols; vc++) {
      // 轉置時畫面上的 (列, 欄) 對應到邏輯上的 (欄, 列)；相鄰關係不變，所以規則不用改
      const i = transposed ? vc * cols + vr : vr * cols + vc
      const view = cellView(game.cells[i], lost)
      cells.push(
        <button
          key={i}
          type="button"
          data-i={i}
          className={view.className}
          aria-label={`第 ${vr + 1} 列第 ${vc + 1} 欄：${view.label}`}
        >
          {view.text}
        </button>,
      )
    }
  }

  let status: string
  let tone: 'ok' | 'danger' | undefined
  if (game.status === 'won') {
    status = `🎉 完成！用時 ${formatTime(elapsed)}${record ? '，新紀錄！' : ''}`
    tone = 'ok'
  } else if (lost) {
    status = '💥 踩到地雷了'
    tone = 'danger'
  } else if (game.status === 'ready') {
    status = '點任一格開始，第一下保證安全'
  } else {
    status = tool === 'flag' ? '插旗模式：點格子插旗／拔旗' : '長按或右鍵插旗；點數字可快速打開周圍'
  }

  return (
    <GameLayout>
      <div className="ms-top">
        <Segmented value={level} options={LEVEL_OPTIONS} onChange={changeLevel} />
        <Segmented value={tool} options={TOOL_OPTIONS} onChange={setTool} />
      </div>

      <div className="ms-bar">
        <span className="ms-counter" aria-label="剩餘雷數">
          💣 {minesLeft}
        </span>
        <button type="button" className="secondary ms-face" onClick={() => restart()} aria-label="重新開始">
          {face}
        </button>
        <span className="ms-counter" aria-label="經過時間">
          ⏱ {formatTime(elapsed)}
        </span>
      </div>

      <StatusLine tone={tone}>{status}</StatusLine>

      <div className="ms-scroll">
        <div
          className={`ms-board${game.status === 'won' || lost ? ' done' : ''}`}
          style={{ '--cols': viewCols } as CSSProperties}
          onClick={onClick}
          onContextMenu={onContextMenu}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onPointerLeave={cancelPress}
          onKeyDown={onKeyDown}
        >
          {cells}
        </div>
      </div>

      <p className="muted ms-records">
        最佳紀錄：
        {LEVEL_KEYS.map((l, k) => (
          <span key={l} className={l === level ? 'current' : undefined}>
            {k > 0 && ' · '}
            {LEVELS[l].label} {best[l] === undefined ? '—' : formatTime(best[l])}
          </span>
        ))}
      </p>
    </GameLayout>
  )
}
