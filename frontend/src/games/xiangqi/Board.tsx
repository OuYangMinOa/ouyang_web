import { pieceName, type Board as BoardData } from './rules.ts'

// 每格 40 單位、四周留 22：360px 手機上每格約 36px
const CELL = 40
const M = 22
const W = CELL * 8 + M * 2
const H = CELL * 9 + M * 2
const R = 18

type Props = {
  board: BoardData
  flipped: boolean
  selected: number | null
  /** 選取棋子的合法落點 */
  targets: number[]
  lastMove: { from: number; to: number } | null
  /** 被將軍的帥／將所在格 */
  checkSq: number | null
  /** 每走一步就變，讓落子動畫重新播放 */
  moveCount: number
  disabled: boolean
  onSquare: (sq: number) => void
}

function px(c: number) {
  return M + c * CELL
}
function py(r: number) {
  return M + r * CELL
}

/** 炮、兵位置的直角記號；邊線上只畫朝內的一半 */
function marker(r: number, c: number): string {
  const g = 3
  const l = 7
  const x = px(c)
  const y = py(r)
  let d = ''
  for (const sx of [-1, 1]) {
    if (c + sx < 0 || c + sx > 8) continue
    for (const sy of [-1, 1]) {
      d += `M${x + sx * g} ${y + sy * (g + l)}V${y + sy * g}H${x + sx * (g + l)}`
    }
  }
  return d
}

function gridPath(): string {
  let d = ''
  for (let r = 0; r < 10; r++) d += `M${px(0)} ${py(r)}H${px(8)}`
  for (let c = 1; c < 8; c++) d += `M${px(c)} ${py(0)}V${py(4)}M${px(c)} ${py(5)}V${py(9)}`
  // 九宮斜線
  for (const top of [0, 7]) {
    d += `M${px(3)} ${py(top)}L${px(5)} ${py(top + 2)}M${px(5)} ${py(top)}L${px(3)} ${py(top + 2)}`
  }
  for (const r of [2, 7]) for (const c of [1, 7]) d += marker(r, c)
  for (const r of [3, 6]) for (let c = 0; c < 9; c += 2) d += marker(r, c)
  return d
}

const GRID = gridPath()

export default function XiangqiBoard({
  board,
  flipped,
  selected,
  targets,
  lastMove,
  checkSq,
  moveCount,
  disabled,
  onSquare,
}: Props) {
  // 棋盤座標 → 畫面座標（執黑時上下左右都翻轉）
  const pos = (sq: number) => {
    const r = Math.floor(sq / 9)
    const c = sq % 9
    return flipped ? { x: px(8 - c), y: py(9 - r) } : { x: px(c), y: py(r) }
  }

  return (
    <svg
      className={`xiangqi-board${disabled ? ' disabled' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="象棋棋盤"
    >
      <rect className="xiangqi-bg" x="0" y="0" width={W} height={H} rx="8" />
      <rect className="xiangqi-frame" x={px(0)} y={py(0)} width={CELL * 8} height={CELL * 9} />
      <path className="xiangqi-grid" d={GRID} />
      <text className="xiangqi-river" x={px(2)} y={py(4.5)}>
        楚 河
      </text>
      <text className="xiangqi-river" x={px(6)} y={py(4.5)}>
        漢 界
      </text>

      {lastMove &&
        [lastMove.from, lastMove.to].map((sq) => {
          const { x, y } = pos(sq)
          return <rect key={sq} className="xiangqi-last" x={x - 19} y={y - 19} width="38" height="38" rx="6" />
        })}

      {checkSq !== null && <circle className="xiangqi-check" {...center(pos(checkSq))} r={R + 4} />}

      {board.map((p, sq) => {
        if (p === 0) return null
        const { x, y } = pos(sq)
        const isNew = lastMove?.to === sq
        return (
          <g
            key={isNew ? `${sq}:${moveCount}` : sq}
            className={`xiangqi-piece ${p > 0 ? 'red' : 'black'}${isNew ? ' moved' : ''}`}
            transform={`translate(${x} ${y})`}
          >
            <circle r={R} className="xiangqi-piece-face" />
            <circle r={R - 3} className="xiangqi-piece-ring" />
            <text className="xiangqi-piece-text">{pieceName(p)}</text>
          </g>
        )
      })}

      {selected !== null && <circle className="xiangqi-selected" {...center(pos(selected))} r={R + 2} />}

      {targets.map((sq) => {
        const c = center(pos(sq))
        return board[sq] !== 0 ? (
          <circle key={sq} className="xiangqi-capture" {...c} r={R + 2} />
        ) : (
          <circle key={sq} className="xiangqi-dot" {...c} r="6" />
        )
      })}

      {board.map((_, sq) => {
        const { x, y } = pos(sq)
        return (
          <rect
            key={sq}
            className="xiangqi-hit"
            x={x - CELL / 2}
            y={y - CELL / 2}
            width={CELL}
            height={CELL}
            onClick={() => onSquare(sq)}
          />
        )
      })}
    </svg>
  )
}

function center({ x, y }: { x: number; y: number }) {
  return { cx: x, cy: y }
}
