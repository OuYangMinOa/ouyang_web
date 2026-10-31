/**
 * 魔法氣泡（ぷよぷよ通）的規則：兩顆一組落下、同色四顆以上相連就消掉、消完上面的掉下來可以再消（連鎖），
 * 分數照官方公式，對戰時分數換成干擾泡送給對手，收到的干擾泡可以用自己的連鎖抵銷。
 *
 * 和俄羅斯方塊一樣，遊戲狀態是可變物件，每一幀由畫面呼叫 `update(dt)` 推進；
 * 連鎖要讓人看得到，所以消除和掉落都是有時間的動畫（`anim`），一步一步推進。結果放進 `events`，畫面取走後決定要顯示什麼。
 *
 * 規則核心（`settle`、`findGroups`、`chainScore`…）是不改狀態的純函式，電腦玩家模擬落點也用同一套。
 */

import { withBadges } from '../shared/badges'

export const COLS = 6
export const ROWS = 12
/** 可見區上方的第 13 列：可以放氣泡，但不會被消掉 */
export const HIDDEN = 1
export const TOTAL = ROWS + HIDDEN
/** 盤面上的格子：0 空、1～4 四種顏色、5 干擾泡 */
export const COLORS = 4
export const NUISANCE = 5
/** 出生的位置：軸心在第 3 欄第 12 列，另一顆在它上面；這一格被佔住就輸了 */
export const SPAWN_X = 2
export const SPAWN_Y = HIDDEN
export const NEXT = 2

/** 另一顆相對軸心的方向：上、右、下、左 */
const DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

export type Rot = 0 | 1 | 2 | 3
export type Pair = { axis: number; child: number }
export type Piece = Pair & { x: number; y: number; rot: Rot }

/** 連鎖倍率（第 n 連鎖用索引 n − 1）、顏色數加成（索引是顏色數）、連結加成（一組幾顆） */
const CHAIN_POWER = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512]
const COLOR_BONUS = [0, 0, 3, 6, 12, 24]
function groupBonus(size: number): number {
  return size <= 4 ? 0 : size >= 11 ? 10 : size - 3
}
/** 對戰時多少分換一顆干擾泡；開打 96 秒後（加時）每 16 秒變成原本的 3/4，越打越兇 */
export const TARGET_POINTS = 70
const MARGIN_MS = 96_000
const MARGIN_STEP_MS = 16_000
/** 全消：下一次連鎖多送 30 顆（5 列）干擾泡；單人模式另外加分 */
const ALL_CLEAR_NUISANCE = 30
export const ALL_CLEAR_POINTS = 2100
/** 一回合最多落下幾顆干擾泡（5 列） */
const NUISANCE_PER_TURN = 30

export const LOCK_MS = 400
const MAX_LOCK_RESETS = 8
const SOFT_DROP_MS = 35
/** 消除時閃爍的時間；掉落每一格的時間 */
const POP_MS = 450
const FALL_MS_PER_ROW = 28
const FALL_MIN_MS = 90

/** 每下降一格的毫秒數 */
export function gravityMs(level: number): number {
  return Math.max(550 * 0.86 ** (level - 1), 30)
}

/** 對戰中某個時間點的干擾泡換算分數 */
export function targetPoints(clock: number): number {
  if (clock < MARGIN_MS) return TARGET_POINTS
  const steps = Math.floor((clock - MARGIN_MS) / MARGIN_STEP_MS) + 1
  return Math.max(1, Math.floor(TARGET_POINTS * 0.75 ** steps))
}

export function index(x: number, y: number): number {
  return y * COLS + x
}

/** 讓懸空的氣泡往下掉；回傳每顆移動過的氣泡「新位置 → 原本的列」 */
export function settle(board: Uint8Array): Map<number, number> {
  const moved = new Map<number, number>()
  for (let x = 0; x < COLS; x++) {
    let to = TOTAL - 1
    for (let y = TOTAL - 1; y >= 0; y--) {
      const c = board[index(x, y)]
      if (!c) continue
      if (y !== to) {
        board[index(x, to)] = c
        board[index(x, y)] = 0
        moved.set(index(x, to), y)
      }
      to--
    }
  }
  return moved
}

/** 可見區裡同色相連四顆以上的組（第 13 列不算） */
export function findGroups(board: Uint8Array): number[][] {
  const seen = new Uint8Array(board.length)
  const groups: number[][] = []
  for (let start = HIDDEN * COLS; start < board.length; start++) {
    const color = board[start]
    if (seen[start] || color < 1 || color > COLORS) continue
    const group = [start]
    seen[start] = 1
    for (let i = 0; i < group.length; i++) {
      const cell = group[i]
      const x = cell % COLS
      const y = (cell - x) / COLS
      for (const [dx, dy] of DIRS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= COLS || ny < HIDDEN || ny >= TOTAL) continue
        const n = index(nx, ny)
        if (!seen[n] && board[n] === color) {
          seen[n] = 1
          group.push(n)
        }
      }
    }
    if (group.length >= 4) groups.push(group)
  }
  return groups
}

/** 這些組被消掉時，旁邊會一起消掉的干擾泡 */
export function nuisanceAround(board: Uint8Array, cells: number[]): number[] {
  const out = new Set<number>()
  for (const cell of cells) {
    const x = cell % COLS
    const y = (cell - x) / COLS
    for (const [dx, dy] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || nx >= COLS || ny < HIDDEN || ny >= TOTAL) continue
      const n = index(nx, ny)
      if (board[n] === NUISANCE) out.add(n)
    }
  }
  return [...out]
}

/** 第 `chain` 連鎖消掉 `groups` 得到的分數：10 × 顆數 × (連鎖倍率 + 連結加成 + 顏色加成)，倍率在 1～999 之間 */
export function chainScore(board: Uint8Array, groups: number[][], chain: number): number {
  const popped = groups.reduce((n, g) => n + g.length, 0)
  const colors = new Set(groups.map((g) => board[g[0]])).size
  const bonus =
    CHAIN_POWER[Math.min(chain, CHAIN_POWER.length) - 1] +
    COLOR_BONUS[colors] +
    groups.reduce((n, g) => n + groupBonus(g.length), 0)
  return 10 * popped * Math.min(Math.max(bonus, 1), 999)
}

/** 某一欄最上面的空格（整欄滿了是 -1） */
export function columnTop(board: Uint8Array, x: number): number {
  let y = TOTAL - 1
  while (y >= 0 && board[index(x, y)]) y--
  return y
}

export function cellsOf(p: { x: number; y: number; rot: Rot }): [[number, number], [number, number]] {
  const [dx, dy] = DIRS[p.rot]
  return [
    [p.x, p.y],
    [p.x + dx, p.y + dy],
  ]
}

/** 盤面一片空白（全消） */
export function isEmpty(board: Uint8Array): boolean {
  return board.every((c) => c === 0)
}

/** 決定配對順序的亂數；對戰時兩邊用同一個種子，拿到一樣的氣泡 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Anim =
  /** 掉落：`from` 是每顆氣泡的「新位置 → 原本的列」（可以是負的，干擾泡從上面掉下來） */
  | { kind: 'fall'; t: number; dur: number; from: Map<number, number> }
  /** 消除：閃爍完才真的拿掉 */
  | { kind: 'pop'; t: number; dur: number; cells: number[] }

export type ChainLink = {
  kind: 'link'
  chain: number
  /** 這一連鎖的分數 */
  points: number
}

export type TurnResult = {
  kind: 'turn'
  /** 這回合打出幾連鎖（0 是沒消） */
  chain: number
  /** 抵銷完自己的干擾泡後送給對手的顆數 */
  sent: number
  allClear: boolean
}

export type GameEvent = ChainLink | TurnResult

export class Puyo {
  board = new Uint8Array(COLS * TOTAL)
  piece: Piece | null = null
  next: Pair[] = []
  over = false
  level = 1
  softDrop = false
  /** 單人模式的分數 */
  score = 0
  /** 放下了幾組、消掉幾顆有顏色的氣泡、有幾顆放在第 13 列上面消失了（上傳排行榜時給伺服器核對盤面） */
  pieces = 0
  popped = 0
  lost = 0
  /** 最大連鎖數 */
  maxChain = 0
  /** 等著落下的干擾泡 */
  pending = 0
  /** 送出的干擾泡總數 */
  sent = 0
  /** 大逃殺的徽章點數，讓送出的干擾泡變多 */
  badges = 0
  events: GameEvent[] = []
  /** 遊戲時間（毫秒） */
  clock = 0
  /** 對戰模式：分數會換成干擾泡（單人模式全消改成加分） */
  versus: boolean
  anim: Anim | null = null
  /** 目前方塊往下一格掉了多少（0～1），畫的時候讓它看起來是滑下去的 */
  fallProgress = 0

  private random: () => number
  private nuisanceRandom: () => number
  private fall = 0
  private lockTimer = 0
  private lockResets = 0
  private lowest = 0
  /** 正在結算的這回合：第幾連鎖、這回合要送出的、干擾泡是不是已經落下了 */
  private chain = 0
  private outgoing = 0
  private dropping = false
  /** 分數換干擾泡時沒用完的零頭 */
  private leftover = 0
  private allClearBonus = false

  constructor({ seed = Math.floor(Math.random() * 2 ** 32), versus = false } = {}) {
    this.random = seeded(seed)
    this.nuisanceRandom = seeded(seed ^ 0x5bd1e995)
    this.versus = versus
    this.fillQueue()
    this.spawn()
  }

  get(x: number, y: number): number {
    return this.board[index(x, y)]
  }

  private fillQueue() {
    while (this.next.length <= NEXT) {
      const color = () => 1 + Math.floor(this.random() * COLORS)
      this.next.push({ axis: color(), child: color() })
    }
  }

  private spawn() {
    const pair = this.next.shift()!
    this.fillQueue()
    this.fall = 0
    this.fallProgress = 0
    this.lockTimer = 0
    this.lockResets = 0
    this.lowest = SPAWN_Y
    if (this.get(SPAWN_X, SPAWN_Y)) {
      this.piece = null
      this.over = true
      return
    }
    this.piece = { ...pair, x: SPAWN_X, y: SPAWN_Y, rot: 0 }
  }

  /** 第 13 列上面（y < 0）可以暫時待著，只要欄位對就好 */
  private free(x: number, y: number): boolean {
    return x >= 0 && x < COLS && y < TOTAL && (y < 0 || this.board[index(x, y)] === 0)
  }

  fits(x: number, y: number, rot: Rot): boolean {
    return cellsOf({ x, y, rot }).every(([cx, cy]) => this.free(cx, cy))
  }

  private onGround(): boolean {
    const p = this.piece
    return !!p && !this.fits(p.x, p.y + 1, p.rot)
  }

  /** 在地上移動或旋轉成功：重新計算鎖定延遲（次數有上限，免得無限拖延） */
  private moved() {
    const p = this.piece!
    if (p.y > this.lowest) {
      this.lowest = p.y
      this.lockResets = 0
    }
    if (this.lockResets < MAX_LOCK_RESETS) {
      this.lockTimer = 0
      this.lockResets++
    }
  }

  move(dx: number): boolean {
    const p = this.piece
    if (!p || this.over || !this.fits(p.x + dx, p.y, p.rot)) return false
    p.x += dx
    this.moved()
    return true
  }

  /**
   * dir：1 順時針、-1 逆時針。轉過去被擋住就把軸心往反方向推一格（靠牆、踩到地板時）；
   * 兩邊都被擋住（夾在一格寬的縫裡）就直接上下對調。
   */
  rotate(dir: 1 | -1): boolean {
    const p = this.piece
    if (!p || this.over) return false
    const to = ((p.rot + dir + 4) % 4) as Rot
    const [dx, dy] = DIRS[to]
    const tries: [number, number, Rot][] = [
      [p.x, p.y, to],
      [p.x - dx, p.y - dy, to],
    ]
    if (dx !== 0) {
      const flip = ((p.rot + 2) % 4) as Rot
      tries.push([p.x, p.y, flip], [p.x, p.y - DIRS[flip][1], flip])
    }
    for (const [x, y, rot] of tries) {
      if (this.fits(x, y, rot)) {
        p.x = x
        p.y = y
        p.rot = rot
        this.moved()
        return true
      }
    }
    return false
  }

  setSoftDrop(on: boolean) {
    if (on !== this.softDrop) this.fall = 0
    this.softDrop = on
  }

  /** 直接落下：每格 1 分（和加速下落一樣） */
  hardDrop() {
    const p = this.piece
    if (!p || this.over) return
    let y = p.y
    while (this.fits(p.x, y + 1, p.rot)) y++
    this.score += y - p.y
    p.y = y
    this.lock()
  }

  /** 每一欄放下去會停在哪：畫落點提示用 */
  landing(): [[number, number, number], [number, number, number]] | null {
    const p = this.piece
    if (!p) return null
    const [[ax, ay], [cx, cy]] = cellsOf(p)
    if (ax === cx) {
      // 直的：下面那顆先落地
      const top = columnTop(this.board, ax)
      const lower = ay > cy ? 'axis' : 'child'
      return lower === 'axis'
        ? [
            [ax, top, p.axis],
            [cx, top - 1, p.child],
          ]
        : [
            [ax, top - 1, p.axis],
            [cx, top, p.child],
          ]
    }
    return [
      [ax, columnTop(this.board, ax), p.axis],
      [cx, columnTop(this.board, cx), p.child],
    ]
  }

  /** 收到對手的干擾泡：這回合結束時落下，之前打出連鎖可以抵銷 */
  receive(n: number) {
    if (n > 0 && !this.over) this.pending += n
  }

  update(dt: number) {
    if (this.over) return
    this.clock += dt
    if (this.piece) this.control(dt)
    else this.resolve(dt)
  }

  private control(dt: number) {
    const p = this.piece!
    if (this.onGround()) {
      this.fall = 0
      this.fallProgress = 0
      this.lockTimer += dt
      // 按著加速下落碰到地就直接放下
      if (this.lockTimer >= LOCK_MS || this.softDrop) this.lock()
      return
    }
    const g = gravityMs(this.level)
    const step = this.softDrop ? Math.min(g, SOFT_DROP_MS) : g
    this.fall += dt
    while (this.fall >= step) {
      this.fall -= step
      if (this.onGround()) break
      p.y++
      if (this.softDrop) this.score++
      if (p.y > this.lowest) {
        this.lowest = p.y
        this.lockResets = 0
      }
    }
    this.fallProgress = this.onGround() ? 0 : this.fall / step
  }

  private lock() {
    const p = this.piece
    if (!p) return
    for (const [i, [x, y]] of cellsOf(p).entries()) {
      const color = i === 0 ? p.axis : p.child
      if (y < 0) this.lost++
      else this.board[index(x, y)] = color
    }
    this.piece = null
    this.pieces++
    this.chain = 0
    this.outgoing = 0
    this.dropping = false
    this.startFall()
  }

  private startFall(from?: Map<number, number>) {
    const moved = from ?? settle(this.board)
    if (moved.size === 0) {
      this.anim = null
      return
    }
    let rows = 0
    for (const [cell, y] of moved) rows = Math.max(rows, Math.floor(cell / COLS) - y)
    this.anim = { kind: 'fall', t: 0, dur: Math.max(FALL_MIN_MS, rows * FALL_MS_PER_ROW), from: moved }
  }

  /** 連鎖一步一步來：等動畫跑完 → 找可以消的組 → 閃爍 → 拿掉 → 掉落 → 再找… */
  private resolve(dt: number) {
    const a = this.anim
    if (a) {
      a.t += dt
      if (a.t < a.dur) return
      this.anim = null
      if (a.kind === 'pop') {
        for (const cell of a.cells) this.board[cell] = 0
        this.startFall()
        return
      }
    }
    if (this.dropping) return this.endTurn()

    const groups = findGroups(this.board)
    if (groups.length > 0) {
      this.chain++
      this.maxChain = Math.max(this.maxChain, this.chain)
      const points = chainScore(this.board, groups, this.chain)
      const colored = groups.flat()
      this.popped += colored.length
      this.score += points
      this.attack(points)
      this.events.push({ kind: 'link', chain: this.chain, points })
      this.anim = { kind: 'pop', t: 0, dur: POP_MS, cells: [...colored, ...nuisanceAround(this.board, colored)] }
      return
    }

    // 沒有可以消的了：這回合的連鎖結束
    const allClear = this.chain > 0 && isEmpty(this.board)
    if (allClear) {
      if (this.versus) this.allClearBonus = true
      else this.score += ALL_CLEAR_POINTS
    }
    if (this.chain > 0 || this.outgoing > 0) {
      this.sent += this.outgoing
      this.events.push({ kind: 'turn', chain: this.chain, sent: this.outgoing, allClear })
    }
    this.dropping = true
    this.dropNuisance()
    if (!this.anim) this.endTurn()
  }

  /** 連鎖的分數換成干擾泡：先抵銷自己等著落下的，剩下的才送出去 */
  private attack(points: number) {
    if (!this.versus) return
    const target = targetPoints(this.clock)
    const total = points + this.leftover
    let n = Math.floor(total / target)
    this.leftover = total % target
    if (this.allClearBonus) {
      n += ALL_CLEAR_NUISANCE
      this.allClearBonus = false
    }
    n = withBadges(n, this.badges)
    const cancel = Math.min(n, this.pending)
    this.pending -= cancel
    this.outgoing += n - cancel
  }

  /** 等著的干擾泡一次最多落下 5 列：滿 6 顆的部分每欄一顆，零頭隨機挑不同的欄 */
  private dropNuisance() {
    const n = Math.min(this.pending, NUISANCE_PER_TURN)
    if (n === 0) return
    this.pending -= n
    const perColumn = new Array<number>(COLS).fill(Math.floor(n / COLS))
    const cols = [...Array(COLS).keys()]
    for (let i = cols.length - 1; i > 0; i--) {
      const j = Math.floor(this.nuisanceRandom() * (i + 1))
      ;[cols[i], cols[j]] = [cols[j], cols[i]]
    }
    for (const x of cols.slice(0, n % COLS)) perColumn[x]++
    // 從盤面上方排好隊掉下來
    const from = new Map<number, number>()
    for (let x = 0; x < COLS; x++) {
      const top = columnTop(this.board, x)
      for (let i = 0; i < perColumn[x]; i++) {
        const y = top - i
        // 疊到第 13 列上面的就消失
        if (y < 0) break
        this.board[index(x, y)] = NUISANCE
        from.set(index(x, y), -1 - i)
      }
    }
    this.startFall(from)
  }

  private endTurn() {
    this.dropping = false
    this.spawn()
  }

  /** 整個盤面（含第 13 列），由上到下每格一個字元 */
  cells(): string {
    return this.board.join('')
  }
}

/** 把一次連鎖寫成要閃過畫面的字 */
export function describeLink(link: ChainLink): string {
  return `${link.chain} 連鎖！`
}
