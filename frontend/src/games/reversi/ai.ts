import { CELLS, N, RAYS, type Disc } from './rules'

export type Level = 'easy' | 'normal' | 'hard'

// 經典的位置權重：角最好，角旁邊的 X、C 格在角還空著時很危險
const WEIGHTS = [
  100, -20, 10, 5, 5, 10, -20, 100,
  -20, -50, -2, -2, -2, -2, -50, -20,
  10, -2, 1, 1, 1, 1, -2, 10,
  5, -2, 1, 0, 0, 1, -2, 5,
  5, -2, 1, 0, 0, 1, -2, 5,
  10, -2, 1, 1, 1, 1, -2, 10,
  -20, -50, -2, -2, -2, -2, -50, -20,
  100, -20, 10, 5, 5, 10, -20, 100,
]

const CORNERS = [0, 7, 56, 63]
// 每個角旁邊的 X 格與兩個 C 格
const CORNER_NEIGHBORS = [
  [9, 1, 8],
  [14, 6, 15],
  [49, 57, 48],
  [54, 62, 55],
]
// 從每個角沿兩條邊走的方向
const EDGE_STEPS = [
  [1, N],
  [-1, N],
  [1, -N],
  [-1, -N],
]
const NEIGHBORS: number[][] = []
for (let p = 0; p < CELLS; p++) NEIGHBORS.push(RAYS[p].filter((ray) => ray.length > 0).map((ray) => ray[0]))

const ABORT = new Error('timeout')
const WIN = 100_000

type Ctx = { deadline: number; nodes: number }

function tick(ctx: Ctx) {
  if ((++ctx.nodes & 1023) === 0 && performance.now() > ctx.deadline) throw ABORT
}

// 翻子用的堆疊，下子時把翻過的子推進去，退回時照著翻回來
const STACK = new Uint8Array(CELLS * CELLS)
let sp = 0

/** 在 b 上直接下子，回傳翻了幾顆（0 = 不合法，沒有改動） */
function doMove(b: Int8Array, pos: number, disc: Disc): number {
  const opp = 3 - disc
  const start = sp
  for (const ray of RAYS[pos]) {
    let i = 0
    while (i < ray.length && b[ray[i]] === opp) i++
    if (i > 0 && i < ray.length && b[ray[i]] === disc) {
      for (let k = 0; k < i; k++) {
        b[ray[k]] = disc
        STACK[sp++] = ray[k]
      }
    }
  }
  const n = sp - start
  if (n) b[pos] = disc
  return n
}

function undoMove(b: Int8Array, pos: number, n: number, disc: Disc) {
  const opp = 3 - disc
  for (let k = 0; k < n; k++) b[STACK[--sp]] = opp
  b[pos] = 0
}

function isLegal(b: Int8Array, pos: number, disc: number): boolean {
  const opp = 3 - disc
  for (const ray of RAYS[pos]) {
    let i = 0
    while (i < ray.length && b[ray[i]] === opp) i++
    if (i > 0 && i < ray.length && b[ray[i]] === disc) return true
  }
  return false
}

function genMoves(b: Int8Array, disc: number): number[] {
  const moves: number[] = []
  for (let p = 0; p < CELLS; p++) if (b[p] === 0 && isLegal(b, p, disc)) moves.push(p)
  return moves
}

function mobility(b: Int8Array, disc: number): number {
  let n = 0
  for (let p = 0; p < CELLS; p++) if (b[p] === 0 && isLegal(b, p, disc)) n++
  return n
}

function discDiff(b: Int8Array, disc: number): number {
  let d = 0
  for (let p = 0; p < CELLS; p++) if (b[p]) d += b[p] === disc ? 1 : -1
  return d
}

/** 終局分數：贏一定比任何評估值高，贏越多越好 */
function finalScore(b: Int8Array, disc: number): number {
  const d = discDiff(b, disc)
  return d > 0 ? WIN + d : d < 0 ? -WIN + d : 0
}

/** 從角沿著邊連成一片的同色子不會再被翻，當作穩定子（簡化版，只算邊） */
function edgeStable(b: Int8Array, disc: number, mark: Uint8Array): number {
  mark.fill(0)
  let n = 0
  for (let i = 0; i < 4; i++) {
    const corner = CORNERS[i]
    if (b[corner] !== disc) continue
    for (const step of EDGE_STEPS[i]) {
      for (let k = 0, p = corner; k < N && b[p] === disc; k++, p += step) {
        if (!mark[p]) {
          mark[p] = 1
          n++
        }
      }
    }
  }
  return n
}

function evalNormal(b: Int8Array, disc: number): number {
  let pos = 0
  for (let p = 0; p < CELLS; p++) if (b[p]) pos += b[p] === disc ? WEIGHTS[p] : -WEIGHTS[p]
  return pos + 8 * (mobility(b, disc) - mobility(b, 3 - disc))
}

const MARK = new Uint8Array(CELLS)

function evalHard(b: Int8Array, disc: number): number {
  const opp = 3 - disc
  let pos = 0
  let frontier = 0
  let empties = 0
  for (let p = 0; p < CELLS; p++) {
    const v = b[p]
    if (!v) {
      empties++
      continue
    }
    const sign = v === disc ? 1 : -1
    pos += sign * WEIGHTS[p]
    // 鄰接空格的子（前緣子）越多，越容易給對方下的地方
    for (const q of NEIGHBORS[p]) {
      if (b[q] === 0) {
        frontier += sign
        break
      }
    }
  }
  // 角已經有子時，旁邊的 X、C 格就不再危險，把扣分加回來
  for (let i = 0; i < 4; i++) {
    if (!b[CORNERS[i]]) continue
    for (const q of CORNER_NEIGHBORS[i]) if (b[q]) pos -= (b[q] === disc ? 1 : -1) * WEIGHTS[q]
  }
  const myMob = mobility(b, disc)
  const oppMob = mobility(b, opp)
  const mob = (100 * (myMob - oppMob)) / (myMob + oppMob + 2)
  const stable = edgeStable(b, disc, MARK) - edgeStable(b, opp, MARK)
  // 開局、中盤重視行動力；接近終局時子數本身越來越重要
  const late = empties < 20 ? (20 - empties) * 2 : 0
  return pos + mob * 3 - frontier * 4 + stable * 20 + late * discDiff(b, disc) * 0.5
}

type Evaluator = (b: Int8Array, disc: number) => number

function orderByWeight(moves: number[]) {
  return moves.sort((a, c) => WEIGHTS[c] - WEIGHTS[a])
}

function negamax(
  b: Int8Array,
  disc: Disc,
  depth: number,
  alpha: number,
  beta: number,
  passed: boolean,
  evaluate: Evaluator,
  ctx: Ctx,
): number {
  tick(ctx)
  if (depth <= 0) return evaluate(b, disc)
  const opp: Disc = disc === 1 ? 2 : 1
  const moves = genMoves(b, disc)
  if (moves.length === 0) {
    if (passed) return finalScore(b, disc)
    return -negamax(b, opp, depth - 1, -beta, -alpha, true, evaluate, ctx)
  }
  orderByWeight(moves)
  let best = -Infinity
  for (const m of moves) {
    const n = doMove(b, m, disc)
    let v: number
    try {
      v = -negamax(b, opp, depth - 1, -beta, -alpha, false, evaluate, ctx)
    } finally {
      undoMove(b, m, n, disc)
    }
    if (v > best) {
      best = v
      if (v > alpha) alpha = v
      if (alpha >= beta) break
    }
  }
  return best
}

/** 終盤完全解：回傳 disc 一方最後的子數差 */
function solve(b: Int8Array, disc: Disc, alpha: number, beta: number, passed: boolean, empties: number, ctx: Ctx): number {
  tick(ctx)
  const opp: Disc = disc === 1 ? 2 : 1
  const moves = genMoves(b, disc)
  if (moves.length === 0) {
    if (passed) return discDiff(b, disc)
    return -solve(b, opp, -beta, -alpha, true, empties, ctx)
  }
  if (empties > 6 && moves.length > 1) {
    // 先試對方能下的地方最少的步（fastest-first），剪枝效果最好
    const keys = new Map<number, number>()
    for (const m of moves) {
      const n = doMove(b, m, disc)
      keys.set(m, mobility(b, opp) * 100 - WEIGHTS[m])
      undoMove(b, m, n, disc)
    }
    moves.sort((a, c) => keys.get(a)! - keys.get(c)!)
  }
  let best = -Infinity
  for (const m of moves) {
    const n = doMove(b, m, disc)
    let v: number
    try {
      v = -solve(b, opp, -beta, -alpha, false, empties - 1, ctx)
    } finally {
      undoMove(b, m, n, disc)
    }
    if (v > best) {
      best = v
      if (v > alpha) alpha = v
      if (alpha >= beta) break
    }
  }
  return best
}

type RootSearch = (b: Int8Array, alpha: number) => number

/** 依序搜尋每個根節點的步，回傳最佳步與各步分數（用來排序下一輪） */
function searchRoot(b: Int8Array, disc: Disc, moves: number[], child: RootSearch) {
  let alpha = -Infinity
  let best = moves[0]
  const scores = new Map<number, number>()
  for (const m of moves) {
    const n = doMove(b, m, disc)
    let v: number
    try {
      v = child(b, alpha)
    } finally {
      undoMove(b, m, n, disc)
    }
    scores.set(m, v)
    if (v > alpha) {
      alpha = v
      best = m
    }
  }
  return { best, score: alpha, scores }
}

export type AiOptions = {
  random?: () => number
  /** 困難難度的思考時間上限（毫秒） */
  timeLimit?: number
}

/** 電腦選一步；沒有合法步時回傳 -1。board：0 空、1 黑、2 白 */
export function chooseMove(board: ArrayLike<number>, disc: Disc, level: Level, options: AiOptions = {}): number {
  const random = options.random ?? Math.random
  const b = Int8Array.from(board)
  sp = 0
  const moves = genMoves(b, disc)
  if (moves.length <= 1) return moves[0] ?? -1
  const opp: Disc = disc === 1 ? 2 : 1

  if (level === 'easy') {
    // 隨機，但翻越多子的步越容易被選到
    const weights = moves.map((m) => {
      const n = doMove(b, m, disc)
      undoMove(b, m, n, disc)
      return n * n
    })
    let r = random() * weights.reduce((a, w) => a + w, 0)
    for (let i = 0; i < moves.length; i++) {
      r -= weights[i]
      if (r < 0) return moves[i]
    }
    return moves[moves.length - 1]
  }

  if (level === 'normal') {
    const ctx: Ctx = { deadline: Infinity, nodes: 0 }
    // 先打亂再依權重排序，同分的步每盤不一定一樣
    for (let i = moves.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[moves[i], moves[j]] = [moves[j], moves[i]]
    }
    moves.sort((a, c) => WEIGHTS[c] - WEIGHTS[a])
    return searchRoot(b, disc, moves, (bb, alpha) => -negamax(bb, opp, 3, -Infinity, -alpha, false, evalNormal, ctx))
      .best
  }

  const start = performance.now()
  const limit = options.timeLimit ?? 900
  const ctx: Ctx = { deadline: start + limit, nodes: 0 }
  let empties = 0
  for (let p = 0; p < CELLS; p++) if (!b[p]) empties++

  let order = orderByWeight(moves)
  let best = order[0]
  if (empties <= 14) {
    // 終盤：直接算到底（剩 12 格左右通常很快；算不完就退回一般搜尋）
    try {
      return searchRoot(b, disc, order, (bb, alpha) =>
        -solve(bb, opp, -64, Math.min(64, -alpha), false, empties - 1, ctx),
      ).best
    } catch (err) {
      if (err !== ABORT) throw err
      sp = 0
      ctx.deadline = performance.now() + limit / 3
    }
  }
  // 迭代加深：時間到就用上一個完整搜完的深度的結果
  for (let depth = 1; depth <= empties; depth++) {
    try {
      const r = searchRoot(b, disc, order, (bb, alpha) =>
        -negamax(bb, opp, depth - 1, -Infinity, -alpha, false, evalHard, ctx),
      )
      best = r.best
      order = [...order].sort((a, c) => r.scores.get(c)! - r.scores.get(a)!)
      if (Math.abs(r.score) >= WIN) break
    } catch (err) {
      if (err !== ABORT) throw err
      sp = 0
      break
    }
  }
  return best
}
