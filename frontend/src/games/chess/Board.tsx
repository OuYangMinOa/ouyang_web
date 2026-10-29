import { squareName } from './engine'
import { Piece } from './Piece'

const NAMES = ['', '兵', '馬', '象', '車', '后', '王']

type Props = {
  board: Int8Array
  flipped: boolean
  selected: number | null
  /** 可走的格子 → 是否吃子 */
  targets: Map<number, boolean>
  lastMove: [number, number] | null
  checkSq: number | null
  interactive: boolean
  onSquare: (sq: number) => void
}

export function ChessBoard({ board, flipped, selected, targets, lastMove, checkSq, interactive, onSquare }: Props) {
  const cells = []
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const rank = flipped ? row : 7 - row
      const file = flipped ? 7 - col : col
      const sq = rank * 8 + file
      const piece = board[sq]
      const light = (rank + file) % 2 === 1
      const target = targets.get(sq)
      const classes = ['chess-sq', light ? 'light' : 'dark']
      if (lastMove && (sq === lastMove[0] || sq === lastMove[1])) classes.push('last')
      if (lastMove && sq === lastMove[1]) classes.push('arrived')
      if (sq === selected) classes.push('selected')
      if (sq === checkSq) classes.push('check')
      if (target !== undefined) classes.push(target ? 'capture' : 'move')
      const name = squareName(sq)
      cells.push(
        <button
          key={sq}
          type="button"
          className={classes.join(' ')}
          aria-label={piece ? `${name} ${piece > 0 ? '白' : '黑'}${NAMES[Math.abs(piece)]}` : name}
          aria-pressed={sq === selected}
          tabIndex={interactive ? 0 : -1}
          onClick={() => onSquare(sq)}
        >
          {col === 0 && <span className="chess-coord rank">{rank + 1}</span>}
          {row === 7 && <span className="chess-coord file">{name[0]}</span>}
          {piece !== 0 && <Piece piece={piece} />}
        </button>,
      )
    }
  }
  return (
    <div className={`chess-board${interactive ? '' : ' locked'}`} role="group" aria-label="棋盤">
      {cells}
    </div>
  )
}
