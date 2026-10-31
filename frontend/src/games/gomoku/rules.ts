// 五子棋規則（自由規則：連成五子或以上即勝，不設禁手）

export const SIZE = 15
export const CELLS = SIZE * SIZE
export const CENTER = (SIZE * SIZE - 1) / 2

/** 1 = 黑、2 = 白；棋盤上 0 是空點 */
export type Stone = 1 | 2
export const BLACK: Stone = 1
export const WHITE: Stone = 2

export type Result = {
  /** null 表示和局 */
  winner: Stone | null
  reason: 'five' | 'resign' | 'full'
  /** 連成線的棋子（只有 reason = five 時有） */
  line?: number[]
}

export type GameState = {
  board: Int8Array
  moves: number[]
  toMove: Stone
  result: Result | null
}

export function other(stone: Stone): Stone {
  return stone === BLACK ? WHITE : BLACK
}

/** 第 ply 手（從 0 起算）由誰下：黑先 */
export function colorOfPly(ply: number): Stone {
  return ply % 2 === 0 ? BLACK : WHITE
}

export function stoneName(stone: Stone): string {
  return stone === BLACK ? '黑方' : '白方'
}

const DIRS: [number, number][] = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
]

/** 在 pos 落子後，若連成五子以上，回傳整條線（含所有相連的子）；否則 null */
export function fiveLine(board: ArrayLike<number>, pos: number): number[] | null {
  const stone = board[pos]
  if (!stone) return null
  const r0 = Math.floor(pos / SIZE)
  const c0 = pos % SIZE
  for (const [dr, dc] of DIRS) {
    const line = [pos]
    for (const sign of [-1, 1]) {
      let r = r0 + dr * sign
      let c = c0 + dc * sign
      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === stone) {
        line.push(r * SIZE + c)
        r += dr * sign
        c += dc * sign
      }
    }
    if (line.length >= 5) return line.sort((a, b) => a - b)
  }
  return null
}

export function newGame(): GameState {
  return { board: new Int8Array(CELLS), moves: [], toMove: BLACK, result: null }
}

/** 落子；不合法（已結束、位置錯誤或有子）就回傳 null。不改動原本的局面 */
export function play(state: GameState, pos: number): GameState | null {
  if (state.result || !Number.isInteger(pos) || pos < 0 || pos >= CELLS || state.board[pos] !== 0) return null
  const board = state.board.slice()
  const stone = state.toMove
  board[pos] = stone
  const moves = [...state.moves, pos]
  const line = fiveLine(board, pos)
  let result: Result | null = null
  if (line) result = { winner: stone, reason: 'five', line }
  else if (moves.length === CELLS) result = { winner: null, reason: 'full' }
  return { board, moves, toMove: other(stone), result }
}

/** 由棋譜重建局面（離線模式的棋譜一定合法） */
export function replay(moves: readonly number[]): GameState {
  let state = newGame()
  for (const pos of moves) state = play(state, pos) ?? state
  return state
}
