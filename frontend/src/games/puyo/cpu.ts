import {
  COLORS,
  COLS,
  HIDDEN,
  NUISANCE,
  SPAWN_X,
  SPAWN_Y,
  TOTAL,
  cellsOf,
  chainScore,
  columnTop,
  findGroups,
  index,
  nuisanceAround,
  settle,
  type Pair,
  type Puyo,
  type Rot,
} from './engine'

/**
 * 對戰的電腦：每來一組就把所有落點（最多 22 種）都放放看，模擬連鎖，挑分數最高的。
 * 評分看三件事：現在放下去會不會打出夠大的連鎖、盤面「再補一兩顆就能引爆幾連鎖」（連鎖潛力）、形狀好不好疊。
 * 困難還會把下一組也一起考慮（22 × 22 種）。
 * 想好之後照人的方式一格一格移過去，動作的速度依難度而定。
 */

export type Difficulty = 'easy' | 'normal' | 'hard'

type Profile = {
  /** 想多久才開始動、每個動作間隔多久 */
  thinkMs: number
  moveMs: number
  /** 看連鎖潛力、多看一組 */
  potential: boolean
  lookahead: boolean
  /** 至少要幾連鎖才引爆（快輸了就不管） */
  trigger: number
  /** 評分加上的隨機雜訊，越大越常放錯 */
  noise: number
  /** 對準了就直接落下（否則按住加速下落） */
  hardDrop: boolean
}

const PROFILES: Record<Difficulty, Profile> = {
  easy: { thinkMs: 450, moveMs: 200, potential: false, lookahead: false, trigger: 2, noise: 400, hardDrop: false },
  normal: { thinkMs: 200, moveMs: 110, potential: true, lookahead: false, trigger: 4, noise: 60, hardDrop: false },
  hard: { thinkMs: 60, moveMs: 55, potential: true, lookahead: true, trigger: 6, noise: 0, hardDrop: true },
}

/** 困難多看一組時，只從這一步最好的幾個往下看 */
const LOOKAHEAD_TOP = 8

type Placement = { x: number; rot: Rot }

/** 一組可以放的所有位置；兩顆同色時上下、左右對調是一樣的 */
function placements(pair: Pair): Placement[] {
  const rots: Rot[] = pair.axis === pair.child ? [0, 1] : [0, 1, 2, 3]
  const out: Placement[] = []
  for (const rot of rots) {
    for (let x = 0; x < COLS; x++) {
      const [, [cx]] = cellsOf({ x, y: 0, rot })
      if (cx >= 0 && cx < COLS) out.push({ x, rot })
    }
  }
  return out
}

/** 從出生的那欄移得過去嗎：中間經過的欄不能疊到第 12 列 */
function reachable(board: Uint8Array, p: Placement): boolean {
  const [, [cx]] = cellsOf({ x: p.x, y: 0, rot: p.rot })
  const lo = Math.min(SPAWN_X, p.x, cx)
  const hi = Math.max(SPAWN_X, p.x, cx)
  for (let x = lo; x <= hi; x++) if (board[index(x, SPAWN_Y)]) return false
  return true
}

/** 放下去（不含連鎖）；回傳新盤面 */
function drop(board: Uint8Array, pair: Pair, p: Placement): Uint8Array {
  const b = board.slice()
  const [[ax, ay], [cx, cy]] = cellsOf({ x: p.x, y: 0, rot: p.rot })
  // 下面那顆先落地
  const order: [number, number][] =
    ax === cx && cy < ay
      ? [
          [ax, pair.axis],
          [cx, pair.child],
        ]
      : [
          [cx, pair.child],
          [ax, pair.axis],
        ]
  for (const [x, color] of order) {
    const y = columnTop(b, x)
    if (y >= 0) b[index(x, y)] = color
  }
  return b
}

/** 把連鎖跑完；回傳幾連鎖和總分 */
function resolve(board: Uint8Array): { chain: number; score: number } {
  let chain = 0
  let score = 0
  for (;;) {
    const groups = findGroups(board)
    if (groups.length === 0) return { chain, score }
    chain++
    score += chainScore(board, groups, chain)
    const cells = groups.flat()
    for (const cell of [...cells, ...nuisanceAround(board, cells)]) board[cell] = 0
    settle(board)
  }
}

const dead = (board: Uint8Array) => board[index(SPAWN_X, SPAWN_Y)] !== 0

/** 每欄疊了幾顆（含第 13 列） */
function heights(board: Uint8Array): number[] {
  return Array.from({ length: COLS }, (_, x) => TOTAL - 1 - columnTop(board, x))
}

/** 連鎖潛力：在某一欄補一或兩顆同色的，最多能引爆幾連鎖 */
function potential(board: Uint8Array): { chain: number; score: number } {
  let best = { chain: 0, score: 0 }
  for (let x = 0; x < COLS; x++) {
    for (let color = 1; color <= COLORS; color++) {
      const b = board.slice()
      for (let n = 0; n < 2; n++) {
        const y = columnTop(b, x)
        if (y < HIDDEN) break
        b[index(x, y)] = color
        if (findGroups(b).length === 0) continue
        const r = resolve(b)
        if (r.chain > best.chain || (r.chain === best.chain && r.score > best.score)) best = r
        break
      }
    }
  }
  return best
}

/** 盤面形狀：同色相鄰加分；出生那欄太高、高低差太大、干擾泡扣分 */
function shape(board: Uint8Array): number {
  let s = 0
  for (let y = HIDDEN; y < TOTAL; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = board[index(x, y)]
      if (!c) continue
      if (c === NUISANCE) {
        s -= 6
        continue
      }
      if (x + 1 < COLS && board[index(x + 1, y)] === c) s += 24
      if (y + 1 < TOTAL && board[index(x, y + 1)] === c) s += 24
    }
  }
  const h = heights(board)
  for (let x = 0; x + 1 < COLS; x++) s -= Math.max(0, Math.abs(h[x] - h[x + 1]) - 2) * 18
  if (h[SPAWN_X] >= 9) s -= (h[SPAWN_X] - 8) * 600
  s -= h.reduce((a, b) => a + b, 0) * 2
  return s
}

export class Cpu {
  private game: Puyo
  private profile: Profile
  private current: object | null = null
  private target: Placement | null = null
  private wait = 0
  private steps = 0

  constructor(game: Puyo, difficulty: Difficulty) {
    this.game = game
    this.profile = PROFILES[difficulty]
  }

  update(dt: number) {
    const g = this.game
    const p = g.piece
    if (g.over || !p) return
    if (p !== this.current) {
      this.current = p
      g.setSoftDrop(false)
      this.target = this.plan()
      this.wait = this.profile.thinkMs
      this.steps = 0
      return
    }
    this.wait -= dt
    if (this.wait > 0 || !this.target) return
    this.wait = this.profile.moveMs
    const t = this.target
    // 繞太久還沒到（被卡住了）就直接放下
    if (++this.steps > 14) return g.hardDrop()
    if (p.rot !== t.rot) {
      if (!g.rotate((t.rot - p.rot + 4) % 4 === 3 ? -1 : 1)) g.hardDrop()
      return
    }
    if (p.x !== t.x) {
      if (!g.move(Math.sign(t.x - p.x))) g.hardDrop()
      return
    }
    if (this.profile.hardDrop) g.hardDrop()
    else g.setSoftDrop(true)
  }

  /** 挑一個落點 */
  private plan(): Placement | null {
    const g = this.game
    const pair: Pair = { axis: g.piece!.axis, child: g.piece!.child }
    const next = g.next[0]
    const options = placements(pair)
      .filter((p) => reachable(g.board, p))
      .map((p) => ({ p, ...this.value(g.board, pair, p) }))
      .sort((a, b) => b.value - a.value)
    if (this.profile.lookahead && next) {
      // 多看一組：只看目前最好的幾個，這一步之後最好的下一步（全部都看太慢，手機上會卡）
      for (const o of options.slice(0, LOOKAHEAD_TOP)) {
        if (o.fired || !o.board) continue
        for (const q of placements(next)) {
          if (reachable(o.board, q)) o.value = Math.max(o.value, this.value(o.board, next, q).value)
        }
      }
    }
    let best: Placement | null = null
    let bestValue = -Infinity
    for (const o of options) {
      const v = o.value + (Math.random() - 0.5) * this.profile.noise
      if (v > bestValue) {
        bestValue = v
        best = o.p
      }
    }
    return best
  }

  private value(board: Uint8Array, pair: Pair, p: Placement): { value: number; board: Uint8Array | null; fired: boolean } {
    const b = drop(board, pair, p)
    const { chain, score } = resolve(b)
    if (dead(b)) return { value: -1e9, board: null, fired: chain > 0 }
    const h = heights(b)
    // 快被頂到或有干擾泡要落下了：能消就消
    const danger = this.game.pending >= 6 || h[SPAWN_X] >= 10 || Math.max(...h) >= 12
    let v = shape(b)
    if (this.profile.potential) {
      const pot = potential(b)
      v += pot.chain * pot.chain * 160 + pot.score / 40
    }
    if (chain > 0) {
      if (chain >= this.profile.trigger || danger) v += 100_000 + score
      else v -= (this.profile.trigger - chain) * 500
    }
    return { value: v, board: b, fired: chain > 0 }
  }
}
