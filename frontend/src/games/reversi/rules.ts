// 黑白棋規則：8×8，黑先；沒有合法步就自動 pass，雙方都不能下就結束

export const N = 8
export const CELLS = N * N

/** 1 = 黑、2 = 白；棋盤上 0 是空格 */
export type Disc = 1 | 2
export const BLACK: Disc = 1
export const WHITE: Disc = 2

export type Result = {
  /** null 表示平手 */
  winner: Disc | null
  reason: 'count' | 'resign'
}

export type GameState = {
  board: Int8Array
  toMove: Disc
  /** 每一手的位置與下子的一方（pass 不記錄） */
  moves: number[]
  movers: Disc[]
  /** 最後一手翻過來的子，用來做動畫 */
  flipped: number[]
  /** 最後一手之後被跳過的一方（無處可下） */
  passed: Disc | null
  result: Result | null
}

export function other(disc: Disc): Disc {
  return disc === BLACK ? WHITE : BLACK
}

export function discName(disc: Disc): string {
  return disc === BLACK ? '黑方' : '白方'
}

/** RAYS[p][d]：從 p 往第 d 個方向延伸的格子（不含 p） */
export const RAYS: number[][][] = []
for (let p = 0; p < CELLS; p++) {
  const r0 = Math.floor(p / N)
  const c0 = p % N
  const rays: number[][] = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue
      const ray: number[] = []
      for (let r = r0 + dr, c = c0 + dc; r >= 0 && r < N && c >= 0 && c < N; r += dr, c += dc) ray.push(r * N + c)
      rays.push(ray)
    }
  }
  RAYS.push(rays)
}

/** disc 下在 pos 會翻過來的子；不合法時是空陣列 */
export function flipsFor(board: ArrayLike<number>, pos: number, disc: Disc): number[] {
  if (board[pos] !== 0) return []
  const flips: number[] = []
  for (const ray of RAYS[pos]) {
    let i = 0
    while (i < ray.length && board[ray[i]] === 3 - disc) i++
    // 要先有至少一顆對方的子，再接到自己的子；碰到空格或邊界就不算
    if (i > 0 && i < ray.length && board[ray[i]] === disc) for (let k = 0; k < i; k++) flips.push(ray[k])
  }
  return flips
}

export function legalMoves(board: ArrayLike<number>, disc: Disc): number[] {
  const moves: number[] = []
  for (let p = 0; p < CELLS; p++) if (board[p] === 0 && isLegal(board, p, disc)) moves.push(p)
  return moves
}

function isLegal(board: ArrayLike<number>, pos: number, disc: Disc): boolean {
  for (const ray of RAYS[pos]) {
    let i = 0
    while (i < ray.length && board[ray[i]] === 3 - disc) i++
    if (i > 0 && i < ray.length && board[ray[i]] === disc) return true
  }
  return false
}

export function hasMove(board: ArrayLike<number>, disc: Disc): boolean {
  for (let p = 0; p < CELLS; p++) if (board[p] === 0 && isLegal(board, p, disc)) return true
  return false
}

export function countDiscs(board: ArrayLike<number>): [number, number] {
  let black = 0
  let white = 0
  for (let p = 0; p < CELLS; p++) {
    if (board[p] === BLACK) black++
    else if (board[p] === WHITE) white++
  }
  return [black, white]
}

export function newGame(): GameState {
  const board = new Int8Array(CELLS)
  // 標準開局：d4、e5 白，e4、d5 黑
  board[3 * N + 3] = WHITE
  board[4 * N + 4] = WHITE
  board[3 * N + 4] = BLACK
  board[4 * N + 3] = BLACK
  return { board, toMove: BLACK, moves: [], movers: [], flipped: [], passed: null, result: null }
}

/** 輪到的一方下在 pos；不合法（已結束、位置錯誤、翻不到子）就回傳 null。不改動原本的局面 */
export function play(state: GameState, pos: number): GameState | null {
  if (state.result || !Number.isInteger(pos) || pos < 0 || pos >= CELLS) return null
  const disc = state.toMove
  const flipped = flipsFor(state.board, pos, disc)
  if (flipped.length === 0) return null
  const board = state.board.slice()
  board[pos] = disc
  for (const p of flipped) board[p] = disc

  let toMove = other(disc)
  let passed: Disc | null = null
  let result: Result | null = null
  if (!hasMove(board, toMove)) {
    if (hasMove(board, disc)) {
      passed = toMove
      toMove = disc
    } else {
      const [black, white] = countDiscs(board)
      result = { winner: black === white ? null : black > white ? BLACK : WHITE, reason: 'count' }
    }
  }
  return {
    board,
    toMove,
    moves: [...state.moves, pos],
    movers: [...state.movers, disc],
    flipped,
    passed,
    result,
  }
}

/** 由棋譜重建局面（離線模式的棋譜一定合法） */
export function replay(moves: readonly number[]): GameState {
  let state = newGame()
  for (const pos of moves) state = play(state, pos) ?? state
  return state
}
