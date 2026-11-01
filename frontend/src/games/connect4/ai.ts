import { COLS, ROWS } from './rules'

export type Level = 'easy' | 'normal' | 'hard'

/*
 * 電腦玩家：bitboard + negamax + alpha-beta。
 *
 * 盤面用 bitboard 表示：第 c 欄第 r 列（r = 0 是最下面）是第 `c * 7 + r` 個 bit，每欄上面多留一個永遠是 0 的哨兵 bit，
 * 位移時才不會從這一欄跑到下一欄。總共 49 個 bit，但 JS 的位元運算只有 32 位元（BigInt 又慢十倍以上），
 * 所以拆成兩個 32 位元整數：lo 是第 0～31 個 bit，hi 是第 32～48 個 bit。
 *
 * 局面只記兩個 bitboard：`cur` 是輪到的那一方的棋子，`mask` 是所有棋子。對方的棋子是 `cur ^ mask`，
 * 下一手後輪到對方，新的 `cur` 就是原本的 `cur ^ mask`（剛下的那顆屬於上一個人）。
 *
 * 分數一律從輪到的那一方來看。能贏的分數是 `WIN - 棋盤上已有幾顆`：越早贏越高，而且只跟局面有關，
 * 存進置換表後在別的路徑上也能直接用。
 */

const H1 = ROWS + 1 // 每欄 7 個 bit（6 格 + 哨兵）
const WIN = 10_000
/** 超過這個分數一定是算出勝負，不是評估值 */
const DECIDED = WIN - COLS * ROWS - 2

// ---- 49 位元的 bitboard，用 (lo, hi) 兩個 32 位元整數表示 ----

function bitLo(b: number): number {
  return b < 32 ? 1 << b : 0
}
function bitHi(b: number): number {
  return b >= 32 ? 1 << (b - 32) : 0
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return Math.imul(x, 0x01010101) >>> 24
}

function maskOf(cells: (c: number, r: number) => boolean): [number, number] {
  let lo = 0
  let hi = 0
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (cells(c, r)) {
        lo |= bitLo(c * H1 + r)
        hi |= bitHi(c * H1 + r)
      }
    }
  }
  return [lo, hi]
}

const [BOTTOM_LO, BOTTOM_HI] = maskOf((_, r) => r === 0)
const [BOARD_LO, BOARD_HI] = maskOf(() => true)
const COL_LO: number[] = []
const COL_HI: number[] = []
for (let col = 0; col < COLS; col++) {
  const [lo, hi] = maskOf((c) => c === col)
  COL_LO.push(lo)
  COL_HI.push(hi)
}
// 從下面數第 1、3、5 列（先手有利的「奇數列」威脅）和第 2、4、6 列（後手有利）
const [ODD_LO, ODD_HI] = maskOf((_, r) => r % 2 === 0)
const [EVEN_LO, EVEN_HI] = maskOf((_, r) => r % 2 === 1)

/** 每一格能參與幾條四連線：中間的格子比較有價值。依權重分組，評估時用 popcount 算 */
const CELL_WEIGHTS = [
  [3, 4, 5, 5, 4, 3],
  [4, 6, 8, 8, 6, 4],
  [5, 8, 11, 11, 8, 5],
  [7, 10, 13, 13, 10, 7],
  [5, 8, 11, 11, 8, 5],
  [4, 6, 8, 8, 6, 4],
  [3, 4, 5, 5, 4, 3],
] // [欄][列]，列從下往上
const WEIGHT_GROUPS: { w: number; lo: number; hi: number }[] = [
  ...new Set(CELL_WEIGHTS.flat()),
].map((w) => {
  const [lo, hi] = maskOf((c, r) => CELL_WEIGHTS[c][r] === w)
  return { w, lo, hi }
})

/** 中間優先的走法順序 */
const CENTER_ORDER = [3, 2, 4, 1, 5, 0, 6]

// winning() 的結果放在這兩個變數，省掉每次配置陣列
let outLo = 0
let outHi = 0

/**
 * 棋子 p（mask 是所有棋子）再下一子就能連成四的空格。
 * 做法是把 p 往各方向位移後取交集：例如水平方向，(p << 7) & (p << 14) & (p << 21) 是「左邊連三顆」的格子。
 */
function winning(pLo: number, pHi: number, mLo: number, mHi: number) {
  // 直的只可能往上接
  let rLo = (pLo << 1) & (pLo << 2) & (pLo << 3)
  let rHi =
    ((pHi << 1) | (pLo >>> 31)) & ((pHi << 2) | (pLo >>> 30)) & ((pHi << 3) | (pLo >>> 29))
  // 水平（7）、兩個斜向（6、8）
  for (let s = 6; s <= 8; s++) {
    const s2 = s * 2
    const s3 = s * 3
    // 左右位移的 lo / hi
    const l1Lo = pLo << s
    const l1Hi = (pHi << s) | (pLo >>> (32 - s))
    const l2Lo = pLo << s2
    const l2Hi = (pHi << s2) | (pLo >>> (32 - s2))
    const l3Lo = pLo << s3
    const l3Hi = (pHi << s3) | (pLo >>> (32 - s3))
    const r1Lo = (pLo >>> s) | (pHi << (32 - s))
    const r1Hi = pHi >>> s
    const r2Lo = (pLo >>> s2) | (pHi << (32 - s2))
    const r2Hi = pHi >>> s2
    const r3Lo = (pLo >>> s3) | (pHi << (32 - s3))
    const r3Hi = pHi >>> s3

    let aLo = l1Lo & l2Lo
    let aHi = l1Hi & l2Hi
    rLo |= (aLo & l3Lo) | (aLo & r1Lo)
    rHi |= (aHi & l3Hi) | (aHi & r1Hi)
    aLo = r1Lo & r2Lo
    aHi = r1Hi & r2Hi
    rLo |= (aLo & l1Lo) | (aLo & r3Lo)
    rHi |= (aHi & l1Hi) | (aHi & r3Hi)
  }
  outLo = rLo & (BOARD_LO ^ mLo)
  outHi = rHi & (BOARD_HI ^ mHi)
}

// possible() 的結果
let possLo = 0
let possHi = 0

/** 每一欄下一顆會落在哪一格：mask 加上每欄最底下的 bit，進位會停在那一欄第一個空格 */
function possible(mLo: number, mHi: number) {
  const sum = (mLo >>> 0) + (BOTTOM_LO >>> 0)
  const carry = sum > 0xffffffff ? 1 : 0
  possLo = sum & BOARD_LO
  possHi = (mHi + BOTTOM_HI + carry) & BOARD_HI
}

// ---- 置換表：key 是 cur + mask（同一個局面一定相同，不同局面一定不同） ----

const TT_BITS = 19
const TT_SIZE = 1 << TT_BITS
const EXACT = 1
const LOWER = 2
const UPPER = 3
const ttKeyLo = new Int32Array(TT_SIZE)
const ttKeyHi = new Int32Array(TT_SIZE)
/** 搜尋深度 + 1；0 表示空格 */
const ttDepth = new Uint8Array(TT_SIZE)
const ttFlag = new Uint8Array(TT_SIZE)
const ttScore = new Int16Array(TT_SIZE)
const ttMove = new Int8Array(TT_SIZE)

let keyLo = 0
let keyHi = 0
let slot = 0

function computeKey(cLo: number, cHi: number, mLo: number, mHi: number) {
  const sum = (cLo >>> 0) + (mLo >>> 0)
  keyLo = sum | 0
  keyHi = (cHi + mHi + (sum > 0xffffffff ? 1 : 0)) | 0
  let h = Math.imul(keyLo ^ Math.imul(keyHi, 0x85ebca6b), 0xc2b2ae35)
  h ^= h >>> 15
  slot = h & (TT_SIZE - 1)
}

// ---- 搜尋 ----

let nodes = 0
let deadline = Infinity
let aborted = false

function evaluate(
  cLo: number,
  cHi: number,
  mLo: number,
  mHi: number,
  n: number,
  myLo: number,
  myHi: number,
  opLo: number,
  opHi: number,
): number {
  const oLo = cLo ^ mLo
  const oHi = cHi ^ mHi
  let score = 0
  for (const g of WEIGHT_GROUPS) {
    score +=
      g.w *
      (popcount32(cLo & g.lo) + popcount32(cHi & g.hi) - popcount32(oLo & g.lo) - popcount32(oHi & g.hi))
  }
  // 威脅（再一子就連四的空格）：越多越好，落在對自己有利的列（先手奇數列、後手偶數列）更好
  const myThreats = popcount32(myLo) + popcount32(myHi)
  const opThreats = popcount32(opLo) + popcount32(opHi)
  const iAmFirst = n % 2 === 0
  const myGood = iAmFirst
    ? popcount32(myLo & ODD_LO) + popcount32(myHi & ODD_HI)
    : popcount32(myLo & EVEN_LO) + popcount32(myHi & EVEN_HI)
  const opGood = iAmFirst
    ? popcount32(opLo & EVEN_LO) + popcount32(opHi & EVEN_HI)
    : popcount32(opLo & ODD_LO) + popcount32(opHi & ODD_HI)
  score += 12 * (myThreats - opThreats) + 10 * (myGood - opGood)
  return Math.max(-900, Math.min(900, score))
}

/** 回傳輪到的那一方的分數；`n` 是棋盤上已有幾顆 */
function negamax(
  cLo: number,
  cHi: number,
  mLo: number,
  mHi: number,
  n: number,
  depth: number,
  alpha: number,
  beta: number,
): number {
  if ((++nodes & 4095) === 0 && performance.now() > deadline) aborted = true
  if (aborted) return 0
  if (n === COLS * ROWS) return 0

  possible(mLo, mHi)
  const pLo = possLo
  const pHi = possHi
  winning(cLo, cHi, mLo, mHi)
  const myLo = outLo
  const myHi = outHi
  // 這一手就能贏
  if ((myLo & pLo) | (myHi & pHi)) return WIN - n

  const oLo = cLo ^ mLo
  const oHi = cHi ^ mHi
  winning(oLo, oHi, mLo, mHi)
  const opLo = outLo
  const opHi = outHi
  let nextLo = pLo
  let nextHi = pHi
  const forcedLo = pLo & opLo
  const forcedHi = pHi & opHi
  if (forcedLo | forcedHi) {
    // 對方有兩個以上馬上能贏的點，擋不完
    if (popcount32(forcedLo) + popcount32(forcedHi) > 1) return -(WIN - n - 1)
    nextLo = forcedLo
    nextHi = forcedHi
  }
  // 不要下在對方連四點的正下方（下了等於幫對方墊高）
  nextLo &= ~((opLo >>> 1) | (opHi << 31))
  nextHi &= ~(opHi >>> 1)
  if (!(nextLo | nextHi)) return -(WIN - n - 1)
  if (depth <= 0) return evaluate(cLo, cHi, mLo, mHi, n, myLo, myHi, opLo, opHi)

  // 這一手贏不了，最快也要再下一手（n + 2 顆時）才贏；對方最快在 n + 3 顆時贏
  const max = WIN - n - 2
  if (beta > max) {
    beta = max
    if (alpha >= beta) return beta
  }
  const min = -(WIN - n - 3)
  if (alpha < min) {
    alpha = min
    if (alpha >= beta) return alpha
  }

  computeKey(cLo, cHi, mLo, mHi)
  const s = slot
  const kLo = keyLo
  const kHi = keyHi
  let ttBest = -1
  if (ttDepth[s] !== 0 && ttKeyLo[s] === kLo && ttKeyHi[s] === kHi) {
    ttBest = ttMove[s]
    if (ttDepth[s] - 1 >= depth) {
      const score = ttScore[s]
      const flag = ttFlag[s]
      if (flag === EXACT) return score
      if (flag === LOWER && score > alpha) alpha = score
      else if (flag === UPPER && score < beta) beta = score
      if (alpha >= beta) return score
    }
  }

  // 走法排序：置換表的最佳手最先，其他依「下完後有幾個連四點」由多到少，同分中間優先
  const order: number[] = []
  const keys: number[] = []
  for (const col of CENTER_ORDER) {
    const moveLo = nextLo & COL_LO[col]
    const moveHi = nextHi & COL_HI[col]
    if (!(moveLo | moveHi)) continue
    winning(cLo | moveLo, cHi | moveHi, mLo | moveLo, mHi | moveHi)
    const key = col === ttBest ? 1000 : popcount32(outLo) + popcount32(outHi)
    let i = order.length
    while (i > 0 && keys[i - 1] < key) i--
    order.splice(i, 0, col)
    keys.splice(i, 0, key)
  }

  const alphaStart = alpha
  let best = -Infinity
  let bestCol = order[0]
  for (const col of order) {
    const moveLo = nextLo & COL_LO[col]
    const moveHi = nextHi & COL_HI[col]
    const score = -negamax(oLo, oHi, mLo | moveLo, mHi | moveHi, n + 1, depth - 1, -beta, -alpha)
    if (aborted) return 0
    if (score > best) {
      best = score
      bestCol = col
    }
    if (score > alpha) alpha = score
    if (alpha >= beta) break
  }

  ttKeyLo[s] = kLo
  ttKeyHi[s] = kHi
  ttDepth[s] = Math.min(255, depth + 1)
  ttScore[s] = best
  ttMove[s] = bestCol
  ttFlag[s] = best <= alphaStart ? UPPER : best >= beta ? LOWER : EXACT
  return best
}

// ---- 對外介面 ----

type Position = { cLo: number; cHi: number; mLo: number; mHi: number; n: number }

/** 由棋譜（每手投進哪一欄）建立局面；棋譜必須合法 */
function fromMoves(moves: readonly number[]): Position {
  const lo = [0, 0]
  const hi = [0, 0]
  const heights = new Array<number>(COLS).fill(0)
  moves.forEach((col, i) => {
    const b = col * H1 + heights[col]++
    lo[i % 2] |= bitLo(b)
    hi[i % 2] |= bitHi(b)
  })
  const n = moves.length
  return { cLo: lo[n % 2], cHi: hi[n % 2], mLo: lo[0] | lo[1], mHi: hi[0] | hi[1], n }
}

function legalColumns(p: Position): number[] {
  possible(p.mLo, p.mHi)
  return CENTER_ORDER.filter((col) => (possLo & COL_LO[col]) | (possHi & COL_HI[col]))
}

/** 這一手直接贏的欄；沒有就回傳 -1 */
function winningColumn(p: Position): number {
  possible(p.mLo, p.mHi)
  const pLo = possLo
  const pHi = possHi
  winning(p.cLo, p.cHi, p.mLo, p.mHi)
  for (const col of CENTER_ORDER) if ((outLo & pLo & COL_LO[col]) | (outHi & pHi & COL_HI[col])) return col
  return -1
}

/** 在 col 下一手後，從輪到的人（也就是對方）看的分數取負號 = 自己的分數 */
function scoreMove(p: Position, col: number, depth: number, alpha: number, beta: number): number {
  possible(p.mLo, p.mHi)
  const moveLo = possLo & COL_LO[col]
  const moveHi = possHi & COL_HI[col]
  return -negamax(p.cLo ^ p.mLo, p.cHi ^ p.mHi, p.mLo | moveLo, p.mHi | moveHi, p.n + 1, depth - 1, -beta, -alpha)
}

/** 每個合法的欄位搜尋 depth 層的分數（完整視窗，分數是準的，用來在差不多好的走法裡隨機挑） */
function rootScores(p: Position, depth: number): { col: number; score: number }[] {
  deadline = Infinity
  aborted = false
  return legalColumns(p).map((col) => ({ col, score: scoreMove(p, col, depth, -WIN, WIN) }))
}

/** 迭代加深：時間內一層一層加深，用最後一層算完的結果；算出勝負就提早停 */
function iterativeDeepening(p: Position, timeMs: number): number {
  const start = performance.now()
  deadline = start + timeMs
  aborted = false
  let order = legalColumns(p)
  let bestCol = order[0]
  for (let depth = 1; depth <= COLS * ROWS - p.n; depth++) {
    let alpha = -WIN
    let iterationBest = order[0]
    for (const col of order) {
      const score = scoreMove(p, col, depth, alpha, WIN)
      if (aborted) break
      if (score > alpha) {
        alpha = score
        iterationBest = col
      }
    }
    if (aborted) break
    bestCol = iterationBest
    // 下一層先試這一層最好的
    order = [iterationBest, ...order.filter((c) => c !== iterationBest)]
    if (Math.abs(alpha) > DECIDED) break
    // 每加深一層大約要多花兩三倍時間，剩下的時間不夠就不用開始了
    if (performance.now() - start > timeMs * 0.4) break
  }
  aborted = false
  deadline = Infinity
  return bestCol
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

/** 電腦這一手要投進哪一欄。moves 是目前為止的棋譜，必須還有空欄、而且還沒分出勝負 */
export function chooseMove(moves: readonly number[], level: Level): number {
  const p = fromMoves(moves)
  const legal = legalColumns(p)
  const win = winningColumn(p)
  if (win >= 0) return win

  if (level === 'easy') {
    // 偶爾亂下（可能沒擋到對方），其他時候看兩層加上大量隨機
    if (Math.random() < 0.3) return pickRandom(legal)
    const scored = rootScores(p, 2).map(({ col, score }) => ({ col, score: score + Math.random() * 250 }))
    return scored.reduce((a, b) => (b.score > a.score ? b : a)).col
  }

  if (level === 'normal') {
    const scored = rootScores(p, 6)
    const best = Math.max(...scored.map((s) => s.score))
    // 已經算出勝負就照最好的下；否則在差不多好的走法裡隨機挑，每局才不會一模一樣
    const margin = Math.abs(best) > DECIDED ? 0 : 8
    return pickRandom(scored.filter((s) => s.score >= best - margin)).col
  }

  // 空棋盤下中間是理論上先手必勝的唯一一手，但 1 秒內搜不到那麼深，直接下
  if (p.n === 0) return 3
  return iterativeDeepening(p, 1000)
}
