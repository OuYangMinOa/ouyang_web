// 電腦：negamax alpha-beta + 迭代加深 + 靜態搜尋 + 置換表；在 Web Worker 裡跑
import {
  BISHOP,
  FLAG_CAPTURE,
  KING,
  PAWN,
  QUEEN,
  WHITE,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  type Position,
} from './engine.ts'

export type Level = 'easy' | 'normal' | 'hard'

const INF = 1_000_000
const MATE = 100_000
const MATE_BOUND = MATE - 1000
const MAX_PLY = 64

export const PIECE_VALUE = [0, 100, 320, 330, 500, 900, 0]

// Piece-square tables（白方視角，第一列是第 8 橫列），出自 Simplified Evaluation Function
// prettier-ignore
const PST: number[][] = [
  [],
  [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
]
// prettier-ignore
const KING_END = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
]
const PHASE = [0, 0, 1, 1, 2, 4, 0]

const centerDistance = (sq: number) => Math.max(3 - (sq & 7), (sq & 7) - 4, 3 - (sq >> 3), (sq >> 3) - 4)
const kingDistance = (a: number, b: number) => Math.max(Math.abs((a & 7) - (b & 7)), Math.abs((a >> 3) - (b >> 3)))

/** 靜態評估（輪到的一方視角，單位約 1/100 兵） */
export function evaluate(pos: Position): number {
  const b = pos.board
  let score = 0
  let material = 0
  let phase = 0
  let kingMid = 0
  let kingEnd = 0
  let whiteBishops = 0
  let blackBishops = 0
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq]
    if (p === 0) continue
    const type = p > 0 ? p : -p
    // 黑子用上下鏡射後的格子查表
    const idx = p > 0 ? (7 - (sq >> 3)) * 8 + (sq & 7) : sq
    const sign = p > 0 ? 1 : -1
    phase += PHASE[type]
    if (type === KING) {
      kingMid += sign * PST[KING][idx]
      kingEnd += sign * KING_END[idx]
      continue
    }
    material += sign * PIECE_VALUE[type]
    score += sign * PST[type][idx]
    if (type === BISHOP) {
      if (p > 0) whiteBishops++
      else blackBishops++
    }
  }
  phase = Math.min(phase, 24)
  score += material + Math.round((kingMid * phase + kingEnd * (24 - phase)) / 24)
  if (whiteBishops >= 2) score += 30
  if (blackBishops >= 2) score -= 30
  // 殘局子力領先時把對方的王逼到邊角、自己的王靠過去，才知道怎麼將死
  if (phase <= 8 && Math.abs(material) >= 400) {
    const winner = material > 0 ? 0 : 1
    const loserKing = pos.kingSq[1 - winner]
    const bonus = centerDistance(loserKing) * 10 + (7 - kingDistance(pos.kingSq[0], pos.kingSq[1])) * 4
    score += winner === 0 ? bonus : -bonus
  }
  return pos.turn === WHITE ? score : -score
}

// ---- 搜尋 ----

const TT_BITS = 18
const TT_SIZE = 1 << TT_BITS
const TT_MASK = TT_SIZE - 1
const EXACT = 1
const LOWER = 2
const UPPER = 3

class Searcher {
  pos: Position
  deadline = Infinity
  stopped = false
  nodes = 0
  rootBest = 0
  private killers = new Int32Array(MAX_PLY * 2)
  private history = new Int32Array(64 * 64)
  private ttCheck = new Int32Array(TT_SIZE)
  private ttMove = new Int32Array(TT_SIZE)
  private ttScore = new Int32Array(TT_SIZE)
  private ttDepth = new Int8Array(TT_SIZE)
  private ttFlag = new Int8Array(TT_SIZE)

  constructor(pos: Position) {
    this.pos = pos
  }

  private tick() {
    if ((++this.nodes & 1023) === 0 && performance.now() > this.deadline) this.stopped = true
  }

  /** 排序分數：置換表走法 > 吃子（MVV-LVA）／升后 > killer > history */
  private scoreMoves(moves: number[], ttMove: number, ply: number): number[] {
    const b = this.pos.board
    const k0 = this.killers[ply * 2]
    const k1 = this.killers[ply * 2 + 1]
    return moves.map((m) => {
      if (m === ttMove) return 10_000_000
      const promo = movePromo(m)
      if (moveFlags(m) & FLAG_CAPTURE) {
        const victim = Math.abs(b[moveTo(m)]) || PAWN
        return 1_000_000 + victim * 100 - Math.abs(b[moveFrom(m)]) + (promo === QUEEN ? 5000 : 0)
      }
      if (promo === QUEEN) return 900_000
      if (m === k0) return 800_000
      if (m === k1) return 700_000
      return this.history[(m & 4095)]
    })
  }

  private static pickNext(moves: number[], scores: number[], i: number) {
    let best = i
    for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j
    if (best !== i) {
      ;[moves[i], moves[best]] = [moves[best], moves[i]]
      ;[scores[i], scores[best]] = [scores[best], scores[i]]
    }
  }

  private hasPieces(): boolean {
    const b = this.pos.board
    const us = this.pos.turn
    for (let sq = 0; sq < 64; sq++) {
      const t = b[sq] * us
      if (t > PAWN && t < KING) return true
    }
    return false
  }

  negamax(depth: number, alpha: number, beta: number, ply: number, allowNull: boolean, rootMove = 0): number {
    this.tick()
    if (this.stopped) return 0
    const pos = this.pos
    if (ply > 0) {
      if (pos.halfmove >= 100 || pos.isRepetition()) return 0
      if (ply >= MAX_PLY - 1) return evaluate(pos)
    }
    const inCheck = pos.inCheck()
    if (inCheck) depth++
    if (depth <= 0) return this.quiesce(alpha, beta, ply)

    const idx = pos.hashLo & TT_MASK
    let ttMove = rootMove
    if (this.ttCheck[idx] === pos.hashHi && this.ttFlag[idx]) {
      if (!ttMove) ttMove = this.ttMove[idx]
      if (ply > 0 && this.ttDepth[idx] >= depth) {
        let s = this.ttScore[idx]
        if (s > MATE_BOUND) s -= ply
        else if (s < -MATE_BOUND) s += ply
        const flag = this.ttFlag[idx]
        if (flag === EXACT || (flag === LOWER && s >= beta) || (flag === UPPER && s <= alpha)) return s
      }
    }

    // 空著剪枝：讓對方連走兩步還是贏不了，這一支就不用細算
    if (allowNull && !inCheck && ply > 0 && depth >= 3 && beta < MATE_BOUND && this.hasPieces()) {
      pos.makeNull()
      const s = -this.negamax(depth - 3, -beta, -beta + 1, ply + 1, false)
      pos.unmakeNull()
      if (this.stopped) return 0
      if (s >= beta) return beta
    }

    const moves = pos.generate([])
    const scores = this.scoreMoves(moves, ttMove, ply)
    const alpha0 = alpha
    let best = -INF
    let bestMove = 0
    let legal = 0
    for (let i = 0; i < moves.length; i++) {
      Searcher.pickNext(moves, scores, i)
      const m = moves[i]
      pos.make(m)
      if (!pos.isLegalAfterMake()) {
        pos.unmake(m)
        continue
      }
      legal++
      const quiet = !(moveFlags(m) & FLAG_CAPTURE) && !movePromo(m)
      let s: number
      if (legal === 1) s = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true)
      else {
        // 後面的安靜步先用較淺、零寬度視窗試，有希望再完整搜
        const reduce = depth >= 3 && legal > 4 && quiet && !inCheck && !pos.inCheck() ? 1 : 0
        s = -this.negamax(depth - 1 - reduce, -alpha - 1, -alpha, ply + 1, true)
        if (s > alpha && (reduce || s < beta)) s = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true)
      }
      pos.unmake(m)
      if (this.stopped) return 0
      if (s > best) {
        best = s
        bestMove = m
        if (ply === 0) this.rootBest = m
      }
      if (s > alpha) alpha = s
      if (alpha >= beta) {
        if (quiet) {
          if (this.killers[ply * 2] !== m) {
            this.killers[ply * 2 + 1] = this.killers[ply * 2]
            this.killers[ply * 2] = m
          }
          this.history[m & 4095] = Math.min(this.history[m & 4095] + depth * depth, 600_000)
        }
        break
      }
    }
    if (legal === 0) return inCheck ? -MATE + ply : 0

    let stored = best
    if (stored > MATE_BOUND) stored += ply
    else if (stored < -MATE_BOUND) stored -= ply
    this.ttCheck[idx] = pos.hashHi
    this.ttMove[idx] = bestMove
    this.ttScore[idx] = stored
    this.ttDepth[idx] = Math.min(depth, 127)
    this.ttFlag[idx] = best <= alpha0 ? UPPER : best >= beta ? LOWER : EXACT
    return best
  }

  /** 靜態搜尋：只算吃子（被將軍時算全部應將），避免停在一半的交換上誤判 */
  quiesce(alpha: number, beta: number, ply: number): number {
    this.tick()
    if (this.stopped) return 0
    const pos = this.pos
    if (ply >= MAX_PLY - 1) return evaluate(pos)
    const inCheck = pos.inCheck()
    let best = -INF
    if (!inCheck) {
      best = evaluate(pos)
      if (best >= beta) return best
      if (best > alpha) alpha = best
    }
    const moves = pos.generate([], !inCheck)
    const scores = this.scoreMoves(moves, 0, ply)
    let legal = 0
    for (let i = 0; i < moves.length; i++) {
      Searcher.pickNext(moves, scores, i)
      const m = moves[i]
      pos.make(m)
      if (!pos.isLegalAfterMake()) {
        pos.unmake(m)
        continue
      }
      legal++
      const s = -this.quiesce(-beta, -alpha, ply + 1)
      pos.unmake(m)
      if (this.stopped) return 0
      if (s > best) best = s
      if (s > alpha) alpha = s
      if (alpha >= beta) break
    }
    if (inCheck && legal === 0) return -MATE + ply
    return best
  }
}

/** 有一步殺就直接走（每種難度都不會放過） */
export function findMateInOne(pos: Position, legal = pos.legalMoves()): number | null {
  for (const m of legal) {
    pos.make(m)
    const mate = pos.inCheck() && pos.legalMoves().length === 0
    pos.unmake(m)
    if (mate) return m
  }
  return null
}

const TIME_MS: Record<Level, number> = { easy: 0, normal: 500, hard: 2000 }

/** 選一步棋；局面會被暫時改動但最後還原。沒有合法走法時回傳 0 */
export function chooseMove(pos: Position, level: Level, rand: () => number = Math.random): number {
  const legal = pos.legalMoves()
  if (legal.length === 0) return 0
  if (legal.length === 1) return legal[0]
  const mate = findMateInOne(pos, legal)
  if (mate !== null) return mate

  // 打亂順序，分數相同時每盤走法不一樣
  for (let i = legal.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[legal[i], legal[j]] = [legal[j], legal[i]]
  }
  const searcher = new Searcher(pos)

  if (level === 'easy') {
    // 偶爾亂走一步，其餘用淺層搜尋加上雜訊
    if (rand() < 0.12) return legal[Math.floor(rand() * legal.length)]
    const depth = rand() < 0.5 ? 1 : 2
    let best = legal[0]
    let bestScore = -INF
    for (const m of legal) {
      pos.make(m)
      const s = -searcher.negamax(depth - 1, -INF, INF, 1, false) + (rand() - 0.5) * 160
      pos.unmake(m)
      if (s > bestScore) {
        bestScore = s
        best = m
      }
    }
    return best
  }

  const start = performance.now()
  const budget = TIME_MS[level]
  searcher.deadline = start + budget
  let best = legal[0]
  for (let depth = 1; depth < MAX_PLY; depth++) {
    searcher.rootBest = 0
    const score = searcher.negamax(depth, -INF, INF, 0, false, best)
    // 時間到時這一層只算完一部分，但第一步就是上一層的最佳步，所以找到的更好步仍然可信
    if (searcher.rootBest && legal.includes(searcher.rootBest)) best = searcher.rootBest
    if (searcher.stopped) break
    if (Math.abs(score) > MATE_BOUND) break
    // 下一層大概要花好幾倍時間，剩下不多就不開始
    if (performance.now() - start > budget * 0.45) break
  }
  return best
}
