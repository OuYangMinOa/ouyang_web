import { CELLS, CENTER, SIZE, type Stone } from './rules'

export type Level = 'easy' | 'normal' | 'hard'

/*
 * 棋型：假設在某個空點落子後，該點在某一方向上形成的形狀。
 * 用「再下一子能變成什麼」遞迴定義，所以活三／眠三的判斷會考慮兩端是否真的能變活四。
 */
const NONE = 0
const ONE = 1
const TWO = 2 // 眠二
const OPEN2 = 3 // 活二
const THREE = 4 // 眠三
const OPEN3 = 5 // 活三
const FOUR = 6 // 衝四
const OPEN4 = 7 // 活四（或同一條線上兩個成五點）
const FIVE = 8

// 子棋型降一級後的對應：再下一子能成活四 → 自己是活三，依此類推
const DOWNGRADE = [NONE, NONE, ONE, ONE, TWO, OPEN2, THREE, OPEN3, NONE]

/** 以中心點左右各 4 格（自己 1、空 0、對方或出界 2）的 3 進位編碼查棋型 */
const SHAPES = buildShapeTable()

function buildShapeTable(): Uint8Array {
  const table = new Uint8Array(6561).fill(255)
  const cells = new Uint8Array(9)
  const encode = () => {
    let code = 0
    for (let i = 0; i < 9; i++) if (i !== 4) code = code * 3 + cells[i]
    return code
  }
  const run = () => {
    let n = 1
    for (let i = 3; i >= 0 && cells[i] === 1; i--) n++
    for (let i = 5; i < 9 && cells[i] === 1; i++) n++
    return n
  }
  const classify = (): number => {
    const code = encode()
    if (table[code] !== 255) return table[code]
    let result = NONE
    if (run() >= 5) result = FIVE
    else {
      let wins = 0
      for (let i = 0; i < 9; i++) {
        if (cells[i] !== 0) continue
        cells[i] = 1
        if (run() >= 5) wins++
        cells[i] = 0
      }
      if (wins >= 2) result = OPEN4
      else if (wins === 1) result = FOUR
      else {
        for (let i = 0; i < 9; i++) {
          if (cells[i] !== 0) continue
          cells[i] = 1
          result = Math.max(result, DOWNGRADE[classify()])
          cells[i] = 0
        }
      }
    }
    table[code] = result
    return result
  }
  for (let code = 0; code < 6561; code++) {
    let rest = code
    for (let i = 8; i >= 0; i--) {
      if (i === 4) continue
      cells[i] = rest % 3
      rest = Math.floor(rest / 3)
    }
    cells[4] = 1
    classify()
  }
  return table
}

// LINE[(p * 4 + d) * 8 + k]：p 在方向 d 上偏移 -4..-1、+1..+4 的位置，出界為 -1
const DR = [0, 1, 1, 1]
const DC = [1, 0, 1, -1]
const LINE = new Int16Array(CELLS * 32)
// 每個點周圍 2 格內的點，用來找候選位置
const NEAR: number[][] = []
// 五元組（連續五格的窗口），用來做快速的局面評估
const WINDOW_CELLS: number[] = []
const CELL_WINDOWS: number[][] = Array.from({ length: CELLS }, () => [])

for (let p = 0; p < CELLS; p++) {
  const r = Math.floor(p / SIZE)
  const c = p % SIZE
  for (let d = 0; d < 4; d++) {
    let k = 0
    for (const off of [-4, -3, -2, -1, 1, 2, 3, 4]) {
      const rr = r + DR[d] * off
      const cc = c + DC[d] * off
      LINE[(p * 4 + d) * 8 + k++] = rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE ? rr * SIZE + cc : -1
    }
  }
  const near: number[] = []
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const rr = r + dr
      const cc = c + dc
      if ((dr || dc) && rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) near.push(rr * SIZE + cc)
    }
  }
  NEAR.push(near)
  for (let d = 0; d < 4; d++) {
    const er = r + DR[d] * 4
    const ec = c + DC[d] * 4
    if (er < 0 || er >= SIZE || ec < 0 || ec >= SIZE) continue
    const w = WINDOW_CELLS.length / 5
    for (let i = 0; i < 5; i++) {
      const q = (r + DR[d] * i) * SIZE + c + DC[d] * i
      WINDOW_CELLS.push(q)
      CELL_WINDOWS[q].push(w)
    }
  }
}
const WINDOWS = WINDOW_CELLS.length / 5

// 五元組裡只有一方的棋子時，依子數給分
const TUPLE = [0, 2, 15, 100, 600, 0]

// 單點價值
const SC_FIVE = 10_000_000
const SC_WIN4 = 1_000_000 // 活四或雙四：對方擋不住
const SC_43 = 100_000
const SC_33 = 50_000
const POINT = [0, 8, 40, 200, 250, 2500, 2200, 0, 0]

const WIN = 1_000_000_000
const ABORT = new Error('timeout')

/** 局面與增量維護的棋型、鄰近計數、五元組分數 */
type Engine = {
  b: Int8Array
  /** 第 c 方（0 黑、1 白）在空點 p 方向 d 的棋型：shape[c * CELLS * 4 + p * 4 + d] */
  shape: Uint8Array
  near: Uint8Array
  win: Uint8Array
  /** 黑方觀點的五元組總分 */
  score: number
  stones: number
  h1: number
  h2: number
  deadline: number
  nodes: number
}

const Z1 = new Int32Array(CELLS * 2)
const Z2 = new Int32Array(CELLS * 2)
{
  // 固定種子，讓結果可重現
  let seed = 0x2f6b1d3
  const next = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return seed | 0
  }
  for (let i = 0; i < CELLS * 2; i++) {
    Z1[i] = next()
    Z2[i] = next()
  }
}

function tupleValue(e: Engine, w: number): number {
  const black = e.win[w * 2]
  const white = e.win[w * 2 + 1]
  if (black && !white) return TUPLE[black]
  if (white && !black) return -TUPLE[white]
  return 0
}

function computeShape(e: Engine, p: number, d: number, color: number): number {
  const base = (p * 4 + d) * 8
  let code = 0
  for (let k = 0; k < 8; k++) {
    const q = LINE[base + k]
    const v = q < 0 ? 2 : e.b[q] === 0 ? 0 : e.b[q] === color ? 1 : 2
    code = code * 3 + v
  }
  return SHAPES[code]
}

function refreshPoint(e: Engine, p: number, d: number) {
  e.shape[p * 4 + d] = computeShape(e, p, d, 1)
  e.shape[CELLS * 4 + p * 4 + d] = computeShape(e, p, d, 2)
}

function refreshAround(e: Engine, p: number) {
  for (let d = 0; d < 4; d++) {
    const base = (p * 4 + d) * 8
    for (let k = 0; k < 8; k++) {
      const q = LINE[base + k]
      if (q >= 0 && e.b[q] === 0) refreshPoint(e, q, d)
    }
    if (e.b[p] === 0) refreshPoint(e, p, d)
  }
}

function make(e: Engine, p: number, color: Stone) {
  e.b[p] = color
  e.stones++
  e.h1 ^= Z1[p * 2 + color - 1]
  e.h2 ^= Z2[p * 2 + color - 1]
  for (const q of NEAR[p]) e.near[q]++
  for (const w of CELL_WINDOWS[p]) {
    e.score -= tupleValue(e, w)
    e.win[w * 2 + color - 1]++
    e.score += tupleValue(e, w)
  }
  refreshAround(e, p)
}

function unmake(e: Engine, p: number) {
  const color = e.b[p]
  e.b[p] = 0
  e.stones--
  e.h1 ^= Z1[p * 2 + color - 1]
  e.h2 ^= Z2[p * 2 + color - 1]
  for (const q of NEAR[p]) e.near[q]--
  for (const w of CELL_WINDOWS[p]) {
    e.score -= tupleValue(e, w)
    e.win[w * 2 + color - 1]--
    e.score += tupleValue(e, w)
  }
  refreshAround(e, p)
}

function createEngine(board: ArrayLike<number>): Engine {
  const e: Engine = {
    b: new Int8Array(CELLS),
    shape: new Uint8Array(CELLS * 8),
    near: new Uint8Array(CELLS),
    win: new Uint8Array(WINDOWS * 2),
    score: 0,
    stones: 0,
    h1: 0,
    h2: 0,
    deadline: Infinity,
    nodes: 0,
  }
  for (let p = 0; p < CELLS; p++) if (board[p] === 1 || board[p] === 2) make(e, p, board[p] as Stone)
  for (let p = 0; p < CELLS; p++) if (e.b[p] === 0) for (let d = 0; d < 4; d++) refreshPoint(e, p, d)
  return e
}

/** color 在空點 p 落子的價值（綜合四個方向的棋型） */
function pointValue(e: Engine, p: number, color: Stone): number {
  const base = (color - 1) * CELLS * 4 + p * 4
  let fours = 0
  let open3 = 0
  let open4 = false
  let sum = 0
  for (let d = 0; d < 4; d++) {
    const s = e.shape[base + d]
    if (s === FIVE) return SC_FIVE
    if (s === OPEN4) open4 = true
    else if (s === FOUR) fours++
    else if (s === OPEN3) open3++
    sum += POINT[s]
  }
  if (open4 || fours >= 2) return SC_WIN4
  if (fours && open3) return SC_43
  if (open3 >= 2) return SC_33
  return sum
}

function maxShape(e: Engine, p: number, color: Stone): number {
  const base = (color - 1) * CELLS * 4 + p * 4
  return Math.max(e.shape[base], e.shape[base + 1], e.shape[base + 2], e.shape[base + 3])
}

type Gen =
  | { kind: 'win'; move: number; plies: number }
  | { kind: 'lose'; moves: number[] }
  | { kind: 'moves'; moves: number[]; forced: boolean }

/**
 * 產生候選步，同時處理必勝／必擋：
 * 能連五就贏；對方有成五點就只能擋；自己能成活四（對方又沒有四）就贏；
 * 對方有活三（下一手能成活四）時，只考慮擋點與自己的衝四反擊。
 */
function generate(e: Engine, color: Stone, limit: number, noise?: () => number): Gen {
  if (e.stones === 0) return { kind: 'moves', moves: [CENTER], forced: false }
  const opp: Stone = color === 1 ? 2 : 1
  const cand: number[] = []
  const scores: number[] = []
  let oppFive = -1
  let oppFives = 0
  let myWin4 = -1
  let oppWin4 = false
  for (let p = 0; p < CELLS; p++) {
    if (e.b[p] !== 0 || e.near[p] === 0) continue
    const mine = pointValue(e, p, color)
    if (mine >= SC_FIVE) return { kind: 'win', move: p, plies: 1 }
    const theirs = pointValue(e, p, opp)
    if (theirs >= SC_FIVE) {
      oppFives++
      oppFive = p
    } else if (theirs >= SC_WIN4) oppWin4 = true
    if (mine >= SC_WIN4) myWin4 = p
    cand.push(p)
    scores[p] = mine + theirs * 0.9 + (noise ? noise() : 0)
  }
  if (oppFives >= 2) return { kind: 'lose', moves: [oppFive] }
  if (oppFives === 1) return { kind: 'moves', moves: [oppFive], forced: true }
  if (myWin4 >= 0) return { kind: 'win', move: myWin4, plies: 3 }
  let list = cand
  if (oppWin4) list = cand.filter((p) => maxShape(e, p, opp) >= FOUR || maxShape(e, p, color) >= FOUR)
  list.sort((a, b) => scores[b] - scores[a])
  if (list.length > limit) list.length = limit
  return { kind: 'moves', moves: list, forced: false }
}

function tick(e: Engine) {
  if ((++e.nodes & 1023) === 0 && performance.now() > e.deadline) throw ABORT
}

function search(e: Engine, color: Stone, depth: number, alpha: number, beta: number, ply: number, width: number): number {
  tick(e)
  const g = generate(e, color, width)
  if (g.kind === 'win') return WIN - ply - g.plies + 1
  if (g.kind === 'lose') return -(WIN - ply - 1)
  if (g.moves.length === 0) return 0
  // 被迫擋四時不算一層，讓連續衝四的手順能算到底
  if (depth <= 0 && !g.forced) return color === 1 ? e.score : -e.score
  const next: Stone = color === 1 ? 2 : 1
  const nextDepth = g.forced ? depth : depth - 1
  let best = -Infinity
  for (const m of g.moves) {
    make(e, m, color)
    let v: number
    try {
      v = -search(e, next, nextDepth, -beta, -alpha, ply + 1, width)
    } finally {
      unmake(e, m)
    }
    if (v > best) {
      best = v
      if (v > alpha) alpha = v
      if (alpha >= beta) break
    }
  }
  return best
}

/** 在 lines through p 上找 color 的成五點 */
function findFivePoint(e: Engine, p: number, color: Stone): number {
  for (let d = 0; d < 4; d++) {
    const base = (p * 4 + d) * 8
    for (let k = 0; k < 8; k++) {
      const q = LINE[base + k]
      if (q >= 0 && e.b[q] === 0 && e.shape[(color - 1) * CELLS * 4 + q * 4 + d] === FIVE) return q
    }
  }
  return -1
}

/**
 * 連續衝四取勝（VCF）：攻方每一手都是四，守方只能擋。找到就回傳第一手，否則 -1。
 * failed 記住已證明失敗的局面，避免同一局面不同手順重複搜尋。
 */
function vcf(e: Engine, attacker: Stone, depth: number, failed: Map<number, number>, top = true): number {
  tick(e)
  const defender: Stone = attacker === 1 ? 2 : 1
  const fours: number[] = []
  const values: number[] = []
  let defenderFive = false
  for (let p = 0; p < CELLS; p++) {
    if (e.b[p] !== 0 || e.near[p] === 0) continue
    const s = maxShape(e, p, attacker)
    if (s === FIVE) return p
    if (maxShape(e, p, defender) === FIVE) defenderFive = true
    if (s >= FOUR) {
      fours.push(p)
      values[p] = pointValue(e, p, attacker)
    }
  }
  if (defenderFive || depth <= 0 || fours.length === 0) return -1
  const key = (e.h1 >>> 0) * 2097152 + (e.h2 & 0x1fffff)
  if (!top && (failed.get(key) ?? -1) >= depth) return -1
  fours.sort((a, b) => values[b] - values[a])
  for (const p of fours) {
    if (values[p] >= SC_WIN4) return p
    make(e, p, attacker)
    let ok = false
    try {
      const q = findFivePoint(e, p, attacker)
      if (q >= 0) {
        make(e, q, defender)
        try {
          ok = vcf(e, attacker, depth - 1, failed, false) >= 0
        } finally {
          unmake(e, q)
        }
      }
    } finally {
      unmake(e, p)
    }
    if (ok) return p
  }
  failed.set(key, depth)
  return -1
}

function findVcf(e: Engine, attacker: Stone, depth: number, until: number): number {
  const saved = e.deadline
  e.deadline = Math.min(saved, until)
  try {
    return vcf(e, attacker, depth, new Map())
  } catch (err) {
    if (err !== ABORT) throw err
    return -1
  } finally {
    e.deadline = saved
  }
}

type RootResult = { move: number; score: number; order: number[] }

/** 迭代加深的 alpha-beta；時間到就用最後一個完整搜完的深度的結果 */
function searchRoot(
  e: Engine,
  color: Stone,
  maxDepth: number,
  width: number,
  rootWidth: number,
  noise?: () => number,
): RootResult {
  const g = generate(e, color, rootWidth, noise)
  if (g.kind === 'win') return { move: g.move, score: WIN, order: [g.move] }
  if (g.kind === 'lose') return { move: g.moves[0], score: -WIN, order: g.moves }
  if (g.moves.length <= 1) return { move: g.moves[0] ?? -1, score: 0, order: g.moves }
  const next: Stone = color === 1 ? 2 : 1
  let order = g.moves
  let best: RootResult = { move: order[0], score: 0, order }
  for (let depth = 1; depth <= maxDepth; depth++) {
    const scores = new Map<number, number>()
    let alpha = -Infinity
    let bestMove = order[0]
    try {
      for (const m of order) {
        make(e, m, color)
        let v: number
        try {
          v = -search(e, next, depth - 1, -Infinity, -alpha, 1, width)
        } finally {
          unmake(e, m)
        }
        scores.set(m, v)
        if (v > alpha) {
          alpha = v
          bestMove = m
        }
      }
    } catch (err) {
      if (err !== ABORT) throw err
      break
    }
    order = [...order].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
    best = { move: bestMove, score: alpha, order }
    if (Math.abs(alpha) > WIN / 2) break
  }
  return best
}

function easyMove(e: Engine, color: Stone, random: () => number): number {
  if (e.stones === 0) return CENTER
  const opp: Stone = color === 1 ? 2 : 1
  let block = -1
  const cand: { p: number; v: number }[] = []
  for (let p = 0; p < CELLS; p++) {
    if (e.b[p] !== 0 || e.near[p] === 0) continue
    const mine = pointValue(e, p, color)
    if (mine >= SC_FIVE) return p
    const theirs = pointValue(e, p, opp)
    if (theirs >= SC_FIVE) block = p
    // 簡單難度只看「一手」的價值，進攻與防守都打折並加上隨機性
    const v = Math.min(mine, 3000) + Math.min(theirs, 3000) * 0.5
    cand.push({ p, v: v * (0.4 + random()) + random() * 30 })
  }
  if (block >= 0) return block
  cand.sort((a, b) => b.v - a.v)
  const top = cand.slice(0, 3)
  return top[Math.floor(random() * top.length)].p
}

export type AiOptions = {
  random?: () => number
  /** 困難難度的思考時間上限（毫秒） */
  timeLimit?: number
}

/** 電腦選一步。board：0 空、1 黑、2 白 */
export function chooseMove(board: ArrayLike<number>, color: Stone, level: Level, options: AiOptions = {}): number {
  const random = options.random ?? Math.random
  const e = createEngine(board)
  if (level === 'easy') return easyMove(e, color, random)
  if (level === 'normal') {
    // 淺層搜尋：自己一手、對方一手；同分時用小雜訊打散，避免每盤一樣
    return searchRoot(e, color, 2, 10, 10, () => random() * 20).move
  }

  const start = performance.now()
  const limit = options.timeLimit ?? 1300
  const opp: Stone = color === 1 ? 2 : 1
  e.deadline = start + limit * 0.75

  const first = generate(e, color, 16)
  if (first.kind === 'win') return first.move
  if (first.kind !== 'moves' || first.forced || first.moves.length <= 1) return first.moves[0]

  const attack = findVcf(e, color, 12, start + limit * 0.2)
  if (attack >= 0) return attack

  const root = searchRoot(e, color, 12, 10, 16)
  if (root.score > WIN / 2) return root.move

  // 最後確認：下完這手後，對方不能靠連續衝四取勝；不行就換下一個候選
  e.deadline = start + limit
  for (const m of root.order) {
    if (performance.now() > e.deadline) break
    make(e, m, color)
    const threat = findVcf(e, opp, 10, e.deadline)
    unmake(e, m)
    if (threat < 0) return m
  }
  return root.move
}
