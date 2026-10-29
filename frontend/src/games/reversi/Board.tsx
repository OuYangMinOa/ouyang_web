import type { MouseEvent } from 'react'
import { N } from './rules'

const LINES = Array.from({ length: N - 1 }, (_, i) => i + 1)
const DOTS = [
  [2, 2],
  [2, 6],
  [6, 2],
  [6, 6],
]

/** 8×8 棋盤（SVG，每格 1 單位）。flipped 是最後一手翻過來的子，ply 讓同一顆子再被翻時動畫能重播 */
export function ReversiBoard({
  board,
  last,
  flipped,
  ply,
  hints,
  interactive,
  onPick,
}: {
  board: Int8Array
  last: number | null
  flipped: number[]
  ply: number
  hints: number[]
  interactive: boolean
  onPick: (pos: number) => void
}) {
  function posAt(e: MouseEvent<SVGSVGElement>): number {
    const rect = e.currentTarget.getBoundingClientRect()
    const clamp = (v: number) => Math.min(N - 1, Math.max(0, Math.floor(v * N)))
    return clamp((e.clientY - rect.top) / rect.height) * N + clamp((e.clientX - rect.left) / rect.width)
  }

  const flippedSet = new Set(flipped)
  const discs: number[] = []
  for (let p = 0; p < board.length; p++) if (board[p]) discs.push(p)
  const cx = (p: number) => (p % N) + 0.5
  const cy = (p: number) => Math.floor(p / N) + 0.5

  return (
    <svg
      className={`reversi-board${interactive ? ' interactive' : ''}`}
      viewBox={`0 0 ${N} ${N}`}
      role="img"
      aria-label="黑白棋棋盤"
      onClick={(e) => interactive && onPick(posAt(e))}
    >
      <rect className="reversi-bg" x={0} y={0} width={N} height={N} rx={0.15} />
      {LINES.map((v) => (
        <g key={v}>
          <line className="reversi-grid" x1={0} y1={v} x2={N} y2={v} />
          <line className="reversi-grid" x1={v} y1={0} x2={v} y2={N} />
        </g>
      ))}
      {DOTS.map(([x, y]) => (
        <circle key={`${x}${y}`} className="reversi-dot" cx={x} cy={y} r={0.07} />
      ))}
      {interactive &&
        hints.map((p) => <circle key={`h${p}`} className="reversi-hint" cx={cx(p)} cy={cy(p)} r={0.14} />)}
      {discs.map((p) => {
        const isFlipped = flippedSet.has(p)
        let cls = `reversi-disc ${board[p] === 1 ? 'black' : 'white'}`
        if (isFlipped) cls += ' flipped'
        else if (p === last) cls += ' placed'
        return <circle key={isFlipped ? `${p}-${ply}` : p} className={cls} cx={cx(p)} cy={cy(p)} r={0.4} />
      })}
      {last !== null && board[last] !== 0 && <circle className="reversi-last" cx={cx(last)} cy={cy(last)} r={0.1} />}
    </svg>
  )
}
