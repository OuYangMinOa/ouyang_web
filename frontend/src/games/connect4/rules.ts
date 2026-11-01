// 四子棋規則：7 欄 × 6 列，棋子投進某一欄會落到那一欄最下面的空位，先在橫、直、斜任一方向連成四子的一方獲勝

export const COLS = 7
export const ROWS = 6
export const CELLS = COLS * ROWS

/** 1 = 紅（先手）、2 = 黃；棋盤上 0 是空格 */
export type Disc = 1 | 2
export const RED: Disc = 1
export const YELLOW: Disc = 2

/** 棋盤由上到下、由左到右：第 r 列第 c 欄是 `r * COLS + c`，r = 0 是最上面那一列 */
export function cellAt(row: number, col: number): number {
  return row * COLS + col
}

export type Result = {
  /** null 表示和局 */
  winner: Disc | null
  reason: 'four' | 'resign' | 'full'
  /** 連成線的棋子（只有 reason = four 時有；同時連成好幾條會全部列出） */
  line?: number[]
}

export type GameState = {
  board: Int8Array
  /** 每一手投進哪一欄 */
  moves: number[]
  toMove: Disc
  result: Result | null
}

export function other(disc: Disc): Disc {
  return disc === RED ? YELLOW : RED
}

/** 第 ply 手（從 0 起算）由誰下：紅先 */
export function colorOfPly(ply: number): Disc {
  return ply % 2 === 0 ? RED : YELLOW
}

export function discName(disc: Disc): string {
  return disc === RED ? '紅方' : '黃方'
}

/** 這一欄投下去會落在哪一列；滿了回傳 -1 */
export function landingRow(board: ArrayLike<number>, col: number): number {
  for (let r = ROWS - 1; r >= 0; r--) if (board[cellAt(r, col)] === 0) return r
  return -1
}

const DIRS: [number, number][] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]

/** 在 pos 落子後連成的所有四子以上的線（合併成一組格子）；沒有連成就回傳 null */
export function fourLines(board: ArrayLike<number>, pos: number): number[] | null {
  const disc = board[pos]
  if (!disc) return null
  const r0 = Math.floor(pos / COLS)
  const c0 = pos % COLS
  const cells = new Set<number>()
  for (const [dr, dc] of DIRS) {
    const line = [pos]
    for (const sign of [-1, 1]) {
      let r = r0 + dr * sign
      let c = c0 + dc * sign
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[cellAt(r, c)] === disc) {
        line.push(cellAt(r, c))
        r += dr * sign
        c += dc * sign
      }
    }
    if (line.length >= 4) for (const p of line) cells.add(p)
  }
  return cells.size ? [...cells].sort((a, b) => a - b) : null
}

export function newGame(): GameState {
  return { board: new Int8Array(CELLS), moves: [], toMove: RED, result: null }
}

/** 投進第 col 欄；不合法（已結束、欄位錯誤或已滿）就回傳 null。不改動原本的局面 */
export function play(state: GameState, col: number): GameState | null {
  if (state.result || !Number.isInteger(col) || col < 0 || col >= COLS) return null
  const row = landingRow(state.board, col)
  if (row < 0) return null
  const board = state.board.slice()
  const disc = state.toMove
  const pos = cellAt(row, col)
  board[pos] = disc
  const moves = [...state.moves, col]
  const line = fourLines(board, pos)
  let result: Result | null = null
  if (line) result = { winner: disc, reason: 'four', line }
  else if (moves.length === CELLS) result = { winner: null, reason: 'full' }
  return { board, moves, toMove: other(disc), result }
}

/** 由棋譜重建局面（離線模式的棋譜一定合法） */
export function replay(moves: readonly number[]): GameState {
  let state = newGame()
  for (const col of moves) state = play(state, col) ?? state
  return state
}

/** 最後一手落在哪一格（給畫面標示最後一手、播放落下動畫） */
export function lastCell(state: GameState): number | null {
  const col = state.moves.at(-1)
  if (col === undefined) return null
  // 落下後那一欄最上面的棋子就是最後一手
  for (let r = 0; r < ROWS; r++) if (state.board[cellAt(r, col)] !== 0) return cellAt(r, col)
  return null
}
