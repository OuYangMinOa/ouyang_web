import type { MouseEvent } from 'react'
import { SIZE, type Stone } from './rules'

const STARS = [3 * SIZE + 3, 3 * SIZE + 11, 7 * SIZE + 7, 11 * SIZE + 3, 11 * SIZE + 11]
const LINES = Array.from({ length: SIZE }, (_, i) => i + 0.5)

export type Ghost = { pos: number; color: Stone; kind: 'pending' | 'hover' }

/** 15×15 的棋盤（SVG，每個交叉點佔 1 單位）。點擊位置換算成最近的交叉點 */
export function GomokuBoard({
  board,
  last,
  line,
  ghost,
  interactive,
  onPick,
  onHover,
}: {
  board: Int8Array
  last: number | null
  line: number[] | null
  ghost: Ghost | null
  interactive: boolean
  onPick: (pos: number) => void
  onHover: (pos: number | null) => void
}) {
  function posAt(e: MouseEvent<SVGSVGElement>): number {
    const rect = e.currentTarget.getBoundingClientRect()
    const clamp = (v: number) => Math.min(SIZE - 1, Math.max(0, Math.floor(v * SIZE)))
    const c = clamp((e.clientX - rect.left) / rect.width)
    const r = clamp((e.clientY - rect.top) / rect.height)
    return r * SIZE + c
  }

  const stones: number[] = []
  for (let p = 0; p < board.length; p++) if (board[p]) stones.push(p)
  const xy = (p: number) => ({ x: (p % SIZE) + 0.5, y: Math.floor(p / SIZE) + 0.5 })

  let winLine = null
  if (line && line.length >= 2) {
    const a = xy(line[0])
    const b = xy(line[line.length - 1])
    winLine = <line className="gomoku-win-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
  }

  return (
    <svg
      className={`gomoku-board${interactive ? ' interactive' : ''}`}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`五子棋棋盤，已下 ${stones.length} 手`}
      onClick={(e) => interactive && onPick(posAt(e))}
      onPointerMove={(e) => interactive && e.pointerType === 'mouse' && onHover(posAt(e))}
      onPointerLeave={() => onHover(null)}
    >
      <rect className="gomoku-bg" x={0} y={0} width={SIZE} height={SIZE} rx={0.3} />
      {LINES.map((v) => (
        <g key={v}>
          <line className="gomoku-grid" x1={0.5} y1={v} x2={SIZE - 0.5} y2={v} />
          <line className="gomoku-grid" x1={v} y1={0.5} x2={v} y2={SIZE - 0.5} />
        </g>
      ))}
      {STARS.map((p) => (
        <circle key={p} className="gomoku-star" cx={xy(p).x} cy={xy(p).y} r={0.1} />
      ))}
      {stones.map((p) => (
        <circle
          key={p}
          className={`gomoku-stone ${board[p] === 1 ? 'black' : 'white'}`}
          cx={xy(p).x}
          cy={xy(p).y}
          r={0.44}
        />
      ))}
      {winLine}
      {line?.map((p) => (
        <circle key={`w${p}`} className="gomoku-win" cx={xy(p).x} cy={xy(p).y} r={0.44} />
      ))}
      {last !== null && board[last] !== 0 && (
        <circle className="gomoku-last" cx={xy(last).x} cy={xy(last).y} r={0.14} />
      )}
      {ghost && board[ghost.pos] === 0 && (
        <circle
          className={`gomoku-stone ${ghost.color === 1 ? 'black' : 'white'} ${ghost.kind}`}
          cx={xy(ghost.pos).x}
          cy={xy(ghost.pos).y}
          r={0.44}
        />
      )}
    </svg>
  )
}
