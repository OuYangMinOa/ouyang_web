// 象棋 AI：alpha-beta（PVS）+ 迭代加深 + 靜態搜尋 + 置換表 + MVV-LVA／殺手步／歷史表排序。
// 不含 React，Web Worker 和測試都直接呼叫 findBestMove。
import { BLACK, KING, RED, findKing, genMoves, isAttacked, legalMoves, type Board, type Move, type Position, type Side } from './rules.ts'

export type Level = 'easy' | 'normal' | 'hard'
export type SearchOptions = {
  maxDepth: number
  timeMs: number
  /** 根節點每步加上 ±noise 的隨機分數（簡單難度用），0 表示不加 */
  noise: number
  random?: () => number
}

export const LEVELS: Record<Level, SearchOptions> = {
  easy: { maxDepth: 1, timeMs: 1000, noise: 120 },
  normal: { maxDepth: 64, timeMs: 500, noise: 0 },
  hard: { maxDepth: 64, timeMs: 2000, noise: 0 },
}

export type SearchResult = { move: Move; score: number; depth: number; nodes: number }

const MATE = 30000
const INF = 32000
const MATE_BOUND = MATE - 500
const MAX_PLY = 96

// 子力：帥、仕、相、馬、車、炮、兵（兵的過河加分寫在位置表）
const BASE = [0, 0, 200, 200, 400, 900, 450, 100]
const VICTIM = [0, 10000, 200, 200, 400, 900, 450, 100]

// 位置表以紅方視角寫，row 0 是黑方底線；黑方棋子上下翻轉後查表
const PST_KING = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, -20, -30, -20, 0, 0, 0],
  [0, 0, 0, -8, -8, -8, 0, 0, 0],
  [0, 0, 0, 2, 8, 2, 0, 0, 0],
].flat()
const PST_ADVISOR = [
  ...new Array(63).fill(0),
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 6, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
].flat()
const PST_ELEPHANT = [
  ...new Array(45).fill(0),
  [0, 0, -2, 0, 0, 0, -2, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-2, 0, 0, 0, 6, 0, 0, 0, -2],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
].flat()
const PST_HORSE = [
  [4, 8, 16, 12, 4, 12, 16, 8, 4],
  [4, 10, 28, 16, 8, 16, 28, 10, 4],
  [12, 14, 16, 20, 18, 20, 16, 14, 12],
  [8, 24, 18, 24, 20, 24, 18, 24, 8],
  [6, 16, 14, 18, 16, 18, 14, 16, 6],
  [4, 12, 16, 14, 12, 14, 16, 12, 4],
  [2, 6, 8, 6, 10, 6, 8, 6, 2],
  [4, 2, 8, 8, 4, 8, 8, 2, 4],
  [0, 2, 4, 4, -2, 4, 4, 2, 0],
  [0, -4, 0, 0, 0, 0, 0, -4, 0],
].flat()
const PST_ROOK = [
  [14, 14, 12, 18, 16, 18, 12, 14, 14],
  [16, 20, 18, 24, 26, 24, 18, 20, 16],
  [12, 12, 12, 18, 18, 18, 12, 12, 12],
  [12, 18, 16, 22, 22, 22, 16, 18, 12],
  [12, 14, 12, 18, 18, 18, 12, 14, 12],
  [12, 16, 14, 20, 20, 20, 14, 16, 12],
  [6, 10, 8, 14, 14, 14, 8, 10, 6],
  [4, 8, 6, 14, 12, 14, 6, 8, 4],
  [8, 4, 8, 16, 8, 16, 8, 4, 8],
  [-2, 10, 6, 14, 12, 14, 6, 10, -2],
].flat()
const PST_CANNON = [
  [6, 4, 0, -10, -12, -10, 0, 4, 6],
  [2, 2, 0, -4, -14, -4, 0, 2, 2],
  [2, 2, 0, -10, -8, -10, 0, 2, 2],
  [0, 0, -2, 4, 10, 4, -2, 0, 0],
  [0, 0, 0, 2, 8, 2, 0, 0, 0],
  [-2, 0, 4, 2, 6, 2, 4, 0, -2],
  [0, 0, 0, 2, 4, 2, 0, 0, 0],
  [4, 0, 8, 6, 10, 6, 8, 0, 4],
  [0, 2, 4, 6, 6, 6, 4, 2, 0],
  [0, 0, 2, 6, 6, 6, 2, 0, 0],
].flat()
const PST_PAWN = [
  [20, 30, 40, 50, 60, 50, 40, 30, 20],
  [90, 108, 130, 150, 160, 150, 130, 108, 90],
  [90, 108, 120, 140, 150, 140, 120, 108, 90],
  [80, 96, 110, 120, 130, 120, 110, 96, 80],
  [60, 70, 80, 90, 100, 90, 80, 70, 60],
  [0, 0, -10, 0, 15, 0, -10, 0, 0],
  [0, 0, -10, 0, 15, 0, -10, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
].flat()
const PST = [[], PST_KING, PST_ADVISOR, PST_ELEPHANT, PST_HORSE, PST_ROOK, PST_CANNON, PST_PAWN] as number[][]

/** 某顆棋子在某格的分數（紅方視角，黑子為負） */
function pieceValue(p: number, sq: number): number {
  if (p > 0) return BASE[p] + PST[p][sq]
  const r = (sq / 9) | 0
  const flipped = (9 - r) * 9 + (sq - r * 9)
  return -(BASE[-p] + PST[-p][flipped])
}

export function evaluate(board: Board): number {
  let s = 0
  for (let i = 0; i < 90; i++) if (board[i] !== 0) s += pieceValue(board[i], i)
  return s
}

// ---- Zobrist：兩組 32 位元雜湊，一組當索引、一組驗證，降低碰撞 ----

function xorshift(seed: number): () => number {
  let x = seed | 0
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x | 0
  }
}
const rand32 = xorshift(0x2f6b3a91)
const Z1 = new Int32Array(15 * 90)
const Z2 = new Int32Array(15 * 90)
for (let i = 0; i < Z1.length; i++) {
  Z1[i] = rand32()
  Z2[i] = rand32()
}
const Z_SIDE1 = rand32()
const Z_SIDE2 = rand32()

function zIndex(p: number, sq: number): number {
  return (p + 7) * 90 + sq
}

function hashOf(board: Board, turn: Side): [number, number] {
  let h1 = 0
  let h2 = 0
  for (let i = 0; i < 90; i++) {
    if (board[i] === 0) continue
    h1 ^= Z1[zIndex(board[i], i)]
    h2 ^= Z2[zIndex(board[i], i)]
  }
  if (turn === BLACK) {
    h1 ^= Z_SIDE1
    h2 ^= Z_SIDE2
  }
  return [h1, h2]
}

// ---- 置換表 ----

const TT_BITS = 18
const TT_SIZE = 1 << TT_BITS
const TT_MASK = TT_SIZE - 1
const ttKey = new Int32Array(TT_SIZE)
const ttMove = new Int32Array(TT_SIZE)
const ttScore = new Int32Array(TT_SIZE)
const ttDepth = new Int8Array(TT_SIZE)
const ttFlag = new Int8Array(TT_SIZE) // 0 空、1 精確、2 下界、3 上界
const EXACT = 1
const LOWER = 2
const UPPER = 3

// ---- 搜尋狀態（Worker 是單執行緒，用模組變數即可） ----

let board: Board = []
let turn: Side = RED
let h1 = 0
let h2 = 0
let score = 0 // 紅方視角
let kings = [0, 0] // [紅, 黑]
let nodes = 0
let deadline = 0
let stopped = false
const hashStack: number[] = []
const captureStack: boolean[] = []
const killers: Move[][] = Array.from({ length: MAX_PLY + 1 }, () => [0, 0])
const history = new Int32Array(1 << 16)

function sideIdx(side: Side): number {
  return side === RED ? 0 : 1
}

function make(m: Move): number {
  const from = m & 255
  const to = m >> 8
  const p = board[from]
  const cap = board[to]
  if (cap !== 0) {
    score -= pieceValue(cap, to)
    h1 ^= Z1[zIndex(cap, to)]
    h2 ^= Z2[zIndex(cap, to)]
  }
  score += pieceValue(p, to) - pieceValue(p, from)
  h1 ^= Z1[zIndex(p, from)] ^ Z1[zIndex(p, to)] ^ Z_SIDE1
  h2 ^= Z2[zIndex(p, from)] ^ Z2[zIndex(p, to)] ^ Z_SIDE2
  board[to] = p
  board[from] = 0
  if (p === KING || p === -KING) kings[p > 0 ? 0 : 1] = to
  turn = -turn as Side
  hashStack.push(h1)
  captureStack.push(cap !== 0)
  return cap
}

function unmake(m: Move, cap: number) {
  const from = m & 255
  const to = m >> 8
  const p = board[to]
  hashStack.pop()
  captureStack.pop()
  turn = -turn as Side
  board[from] = p
  board[to] = cap
  if (p === KING || p === -KING) kings[p > 0 ? 0 : 1] = from
  score -= pieceValue(p, to) - pieceValue(p, from)
  h1 ^= Z1[zIndex(p, from)] ^ Z1[zIndex(p, to)] ^ Z_SIDE1
  h2 ^= Z2[zIndex(p, from)] ^ Z2[zIndex(p, to)] ^ Z_SIDE2
  if (cap !== 0) {
    score += pieceValue(cap, to)
    h1 ^= Z1[zIndex(cap, to)]
    h2 ^= Z2[zIndex(cap, to)]
  }
}

/** side 方的帥／將是否被攻擊 */
function sideInCheck(side: Side): boolean {
  return isAttacked(board, kings[sideIdx(side)], -side as Side)
}

/** 目前局面是否和吃子之後的某個同方局面重複 */
function isRepetition(): boolean {
  const n = hashStack.length - 1
  for (let i = n - 2; i >= 0; i -= 2) {
    if (captureStack[i + 1] || captureStack[i + 2]) return false
    if (hashStack[i] === h1) return true
  }
  return false
}

function checkTime() {
  if ((++nodes & 1023) === 0 && Date.now() > deadline) stopped = true
}

function orderMoves(moves: Move[], ttBest: Move, ply: number): number[] {
  const scores: number[] = new Array(moves.length)
  const k = killers[ply]
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    const victim = board[m >> 8]
    if (m === ttBest) scores[i] = 1 << 30
    else if (victim !== 0) scores[i] = (1 << 24) + VICTIM[Math.abs(victim)] * 16 - Math.abs(board[m & 255])
    else if (m === k[0]) scores[i] = (1 << 23) + 1
    else if (m === k[1]) scores[i] = 1 << 23
    else scores[i] = history[m]
  }
  return scores
}

/** 選擇排序：每次把剩下最好的換到 i */
function pickNext(moves: Move[], scores: number[], i: number) {
  let best = i
  for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j
  if (best !== i) {
    const m = moves[i]
    moves[i] = moves[best]
    moves[best] = m
    const s = scores[i]
    scores[i] = scores[best]
    scores[best] = s
  }
}

function quiesce(alpha: number, beta: number, ply: number): number {
  checkTime()
  if (stopped) return 0
  const me = turn
  const checked = sideInCheck(me)
  if (ply >= MAX_PLY) return score * me

  if (!checked) {
    const stand = score * me
    if (stand >= beta) return stand
    if (stand > alpha) alpha = stand
  }
  // 被將軍時要看所有應將步，才能認出將死
  const moves: Move[] = []
  genMoves(board, me, moves, !checked)
  const scores = orderMoves(moves, 0, ply)
  let legal = 0
  let best = checked ? -INF : alpha
  for (let i = 0; i < moves.length; i++) {
    pickNext(moves, scores, i)
    const m = moves[i]
    const cap = make(m)
    if (sideInCheck(me)) {
      unmake(m, cap)
      continue
    }
    legal++
    const s = -quiesce(-beta, -alpha, ply + 1)
    unmake(m, cap)
    if (stopped) return 0
    if (s > best) best = s
    if (s > alpha) alpha = s
    if (alpha >= beta) break
  }
  if (checked && legal === 0) return -MATE + ply
  return best
}

function search(depth: number, alpha: number, beta: number, ply: number): number {
  checkTime()
  if (stopped) return 0
  if (ply > 0 && isRepetition()) return 0
  const me = turn
  const checked = sideInCheck(me)
  if (checked && ply < MAX_PLY - 8) depth++ // 將軍延伸，避免看漏殺棋
  if (depth <= 0 || ply >= MAX_PLY) return quiesce(alpha, beta, ply)

  const idx = h1 & TT_MASK
  let ttBest: Move = 0
  if (ttFlag[idx] !== 0 && ttKey[idx] === h2) {
    ttBest = ttMove[idx]
    if (ply > 0 && ttDepth[idx] >= depth) {
      let s = ttScore[idx]
      if (s > MATE_BOUND) s -= ply
      else if (s < -MATE_BOUND) s += ply
      const f = ttFlag[idx]
      if (f === EXACT || (f === LOWER && s >= beta) || (f === UPPER && s <= alpha)) return s
    }
  }

  const moves: Move[] = []
  genMoves(board, me, moves)
  const scores = orderMoves(moves, ttBest, ply)
  const alpha0 = alpha
  let best = -INF
  let bestMove: Move = 0
  let legal = 0
  for (let i = 0; i < moves.length; i++) {
    pickNext(moves, scores, i)
    const m = moves[i]
    const cap = make(m)
    if (sideInCheck(me)) {
      unmake(m, cap)
      continue
    }
    legal++
    let s: number
    if (legal === 1) s = -search(depth - 1, -beta, -alpha, ply + 1)
    else {
      s = -search(depth - 1, -alpha - 1, -alpha, ply + 1)
      if (s > alpha && s < beta) s = -search(depth - 1, -beta, -alpha, ply + 1)
    }
    unmake(m, cap)
    if (stopped) return 0
    if (s > best) {
      best = s
      bestMove = m
    }
    if (s > alpha) alpha = s
    if (alpha >= beta) {
      if (cap === 0) {
        const k = killers[ply]
        if (k[0] !== m) {
          k[1] = k[0]
          k[0] = m
        }
        history[m] += depth * depth
      }
      break
    }
  }
  // 象棋沒有和局式的「無子可動」：將死、困斃都判負
  if (legal === 0) return -MATE + ply

  let stored = best
  if (stored > MATE_BOUND) stored += ply
  else if (stored < -MATE_BOUND) stored -= ply
  ttKey[idx] = h2
  ttMove[idx] = bestMove
  ttScore[idx] = stored
  ttDepth[idx] = depth
  ttFlag[idx] = best <= alpha0 ? UPPER : best >= beta ? LOWER : EXACT
  return best
}

function setup(pos: Position, past: Position[]) {
  board = pos.board.slice()
  turn = pos.turn
  ;[h1, h2] = hashOf(board, turn)
  score = evaluate(board)
  kings = [findKing(board, RED), findKing(board, BLACK)]
  hashStack.length = 0
  captureStack.length = 0
  // 歷史局面一起放進堆疊，搜尋時走回這些局面就當和棋
  for (const p of past) {
    hashStack.push(hashOf(p.board, p.turn)[0])
    captureStack.push(false)
  }
  hashStack.push(h1)
  captureStack.push(false)
  for (const k of killers) k[0] = k[1] = 0
  history.fill(0)
  ttFlag.fill(0)
  nodes = 0
  stopped = false
}

/**
 * 找出 pos 的最佳棋步。past 是吃子之後、目前局面之前的局面（判斷重複用）。
 * 回傳的棋步一定是合法步；沒有合法步時 move 為 -1。
 */
export function findBestMove(pos: Position, past: Position[], opts: SearchOptions): SearchResult {
  const roots = legalMoves(pos)
  if (roots.length === 0) return { move: -1, score: -MATE, depth: 0, nodes: 0 }
  setup(pos, past)
  const random = opts.random ?? Math.random
  // 第一層一定要搜完，之後才受時間限制
  deadline = Number.POSITIVE_INFINITY
  const start = Date.now()

  let bestMove = roots[0]
  let bestScore = -INF
  let doneDepth = 0
  const order = roots.slice()
  for (let depth = 1; depth <= opts.maxDepth; depth++) {
    if (depth > 1) deadline = start + opts.timeMs
    let alpha = -INF
    let iterBest = order[0]
    let iterScore = -INF
    const rootScores = new Set<Move>()
    for (let i = 0; i < order.length; i++) {
      const m = order[i]
      const cap = make(m)
      let s: number
      if (opts.noise > 0 || i === 0) s = -search(depth - 1, -INF, opts.noise > 0 ? INF : -alpha, 1)
      else {
        s = -search(depth - 1, -alpha - 1, -alpha, 1)
        if (s > alpha && !stopped) s = -search(depth - 1, -INF, -alpha, 1)
      }
      unmake(m, cap)
      if (stopped) break
      // 殺棋分數不加雜訊，簡單難度也不會放過一步殺
      if (opts.noise > 0 && Math.abs(s) < MATE_BOUND) s += Math.round((random() * 2 - 1) * opts.noise)
      rootScores.add(m)
      if (s > iterScore) {
        iterScore = s
        iterBest = m
      }
      if (s > alpha) alpha = s
    }
    if (stopped) {
      // 這一層沒搜完；上一層的最佳步排第一個，若已搜完的步裡有比它好的，就改用那一步
      if (rootScores.has(order[0]) && iterBest !== order[0]) {
        bestMove = iterBest
        bestScore = iterScore
      }
      break
    }
    bestMove = iterBest
    bestScore = iterScore
    doneDepth = depth
    // 下一層先搜這層最好的步
    order.sort((a, b) => (b === bestMove ? 1 : 0) - (a === bestMove ? 1 : 0))
    if (Math.abs(bestScore) > MATE_BOUND) break
    if (Date.now() - start > opts.timeMs / 2 && depth >= 2) break // 下一層通常要更久，不夠時間就停
  }
  return { move: bestMove, score: bestScore, depth: doneDepth, nodes }
}
