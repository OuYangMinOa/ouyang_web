import { useEffect, useState, type ReactNode } from 'react'
import { formatTime } from '../shared/format'
import { load, save } from '../shared/storage'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { MineBoard, type CellLook, type Press } from './Board'
import { LEVELS, flagCount, newGame, reveal, toggleFlag, type Cell, type Game, type Level } from './logic'
import { TOOL_OPTIONS, type Tool } from './tools'

const LEVEL_KEYS = Object.keys(LEVELS) as Level[]
const LEVEL_OPTIONS = LEVEL_KEYS.map((value) => ({ value, label: LEVELS[value].label }))

function loadLevel(): Level {
  const saved = load<string>('minesweeper:level', 'beginner')
  return LEVEL_KEYS.includes(saved as Level) ? (saved as Level) : 'beginner'
}

function create(level: Level): Game {
  const { cols, rows, mines } = LEVELS[level]
  return newGame(cols, rows, mines)
}

function cellView(cell: Cell, lost: boolean): CellLook {
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

/** 單人模式：雷在瀏覽器裡埋，第一下保證安全，最佳紀錄存在這台裝置 */
export function Solo({ modeSwitch }: { modeSwitch: ReactNode }) {
  const [level, setLevel] = useState(loadLevel)
  const [game, setGame] = useState(() => create(level))
  const [tool, setTool] = useState<Tool>('dig')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [endedAt, setEndedAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [best, setBest] = useState<Partial<Record<Level, number>>>(() => load('minesweeper:best', {}))
  const [record, setRecord] = useState(false)

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

  function onPress(i: number, press: Press) {
    // 鍵盤的 F 一律插旗；其他照目前的工具，右鍵或長按做相反的動作
    const flagging = press === 'flag' || (tool === 'flag') !== (press === 'alt')
    // 已打開的格子不能插旗，點下去一律當作挖開（數字格會 chord）
    if (flagging && !game.cells[i].open) apply(toggleFlag(game, i))
    else if (press !== 'flag') apply(reveal(game, i))
  }

  const lost = game.status === 'lost'
  const minesLeft = game.mines - flagCount(game)
  const elapsed = startedAt === null ? 0 : Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000))
  const face = game.status === 'won' ? '😎' : lost ? '😵' : '🙂'

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
      {modeSwitch}
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

      <MineBoard
        cols={game.cols}
        rows={game.rows}
        look={(i) => cellView(game.cells[i], lost)}
        onPress={onPress}
        done={game.status === 'won' || lost}
      />

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
