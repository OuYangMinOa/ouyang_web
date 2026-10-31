/**
 * 俄羅斯方塊的規則：SRS 旋轉與踢牆、7-bag、Hold、鎖定延遲、各種方塊的 spin、連擊與 Back-to-Back，
 * 以及大逃殺用的攻擊行數和待升垃圾行。
 *
 * 遊戲狀態是可變物件，每一幀由畫面呼叫 `update(dt)` 推進；鎖定方塊的結果放進 `events`，
 * 畫面取走後決定要不要顯示、送出攻擊。
 */

export const COLS = 10
export const ROWS = 20
/** 可見區上方的緩衝列，方塊在這裡出生 */
export const HIDDEN = 4
const TOTAL = ROWS + HIDDEN

export type Kind = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z'
export const KINDS: Kind[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z']
/** 盤面上的格子：0 空、1～7 對應 KINDS、8 垃圾行 */
export const GARBAGE = 8

type Rot = 0 | 1 | 2 | 3
export type Piece = { kind: Kind; rot: Rot; x: number; y: number }

/** 出生時的樣子；其他三個方向由這個在外框裡順時針轉出來 */
const SHAPES: Record<Kind, string[]> = {
  I: ['....', 'XXXX', '....', '....'],
  J: ['X..', 'XXX', '...'],
  L: ['..X', 'XXX', '...'],
  O: ['XX', 'XX'],
  S: ['.XX', 'XX.', '...'],
  T: ['.X.', 'XXX', '...'],
  Z: ['XX.', '.XX', '...'],
}

type Cell = [number, number]

const CELLS: Record<Kind, Cell[][]> = Object.fromEntries(
  KINDS.map((kind) => {
    const rows = SHAPES[kind]
    const n = rows.length
    let cells: Cell[] = []
    rows.forEach((row, y) => [...row].forEach((c, x) => c === 'X' && cells.push([x, y])))
    const all: Cell[][] = []
    for (let r = 0; r < 4; r++) {
      all.push(cells)
      cells = cells.map(([x, y]) => [n - 1 - y, x])
    }
    return [kind, all]
  }),
) as Record<Kind, Cell[][]>

export function pieceCells(kind: Kind, rot: number): Cell[] {
  return CELLS[kind][rot]
}

// SRS 踢牆表（y 往上為正，套用時反過來）；key 是「原方向 → 新方向」
const KICKS_JLSTZ: Record<string, Cell[]> = {
  '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
}
const KICKS_I: Record<string, Cell[]> = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
}

/** 普通消行、spin、T-Spin Mini 送出的行數（索引是消了幾行） */
const ATTACK_NORMAL = [0, 0, 1, 2, 4]
/** T-Spin 和其他方塊的 spin 一樣多；只有 I 能 spin 消四行 */
const ATTACK_SPIN = [0, 2, 4, 6, 8]
const ATTACK_MINI = [0, 0, 1]
/** 連擊加成：第 n 次連續消行（第一次是 0） */
const COMBO = [0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5]
const PERFECT_CLEAR = 10

/** 單人模式的分數（官方規則，再乘上等級）：普通消行、spin、T-Spin Mini（索引是消了幾行） */
const SCORE_NORMAL = [0, 100, 300, 500, 800]
const SCORE_SPIN = [400, 800, 1200, 1600, 2000]
const SCORE_MINI = [100, 200, 400]
const SCORE_PERFECT = [0, 800, 1200, 1800, 2000]
/** 每次連擊多 50 × 連擊數；B2B 乘 1.5；加速下落每格 1 分、直接落下每格 2 分 */
const SCORE_COMBO = 50

export const LOCK_MS = 500
const MAX_LOCK_RESETS = 15
const SOFT_DROP_MS = 30
/** 收到的垃圾行等這麼久才會升上來，之前消行可以抵銷 */
export const GARBAGE_DELAY_MS = 2000
/** 一次鎖定最多升幾行垃圾，其餘留到下一塊 */
const GARBAGE_PER_LOCK = 8
export const PREVIEW = 5

/** 每下降一格的毫秒數；比官方曲線平緩，最高級也還玩得下去 */
export function gravityMs(level: number): number {
  return Math.max(1000 * 0.82 ** (level - 1), 30)
}

/** 徽章數（0～4），每個讓攻擊多 25%；點數門檻和後端一樣 */
export function badgeCount(points: number): number {
  return [2, 6, 14, 30].filter((step) => points >= step).length
}

export type Garbage = { lines: number; readyAt: number; hole: number }

export type LockResult = {
  lines: number
  /** 用旋轉卡進去再消行：T 用三角規則，其他方塊（O 除外）是轉進去後左、右、上都動不了 */
  spin: 'none' | 'mini' | 'full'
  piece: Kind
  b2b: boolean
  combo: number
  perfect: boolean
  /** 加上徽章加成後的攻擊 */
  attack: number
  /** 抵銷待升垃圾後真正送出去的行數 */
  sent: number
  /** 這次消行得到的分數（已乘上等級，不含下落的分數） */
  points: number
}

export class Tetris {
  board = new Uint8Array(COLS * TOTAL)
  piece: Piece | null = null
  next: Kind[] = []
  hold: Kind | null = null
  holdUsed = false
  over = false
  level = 1
  /** 大逃殺的徽章點數，由伺服器告知 */
  badges = 0
  softDrop = false
  lines = 0
  /** 單人模式的分數 */
  score = 0
  /** 放下了幾塊（上傳排行榜時給伺服器核對盤面） */
  pieces = 0
  sent = 0
  garbage: Garbage[] = []
  events: LockResult[] = []
  /** 遊戲時間（毫秒），垃圾行何時升上來以這個為準 */
  clock = 0

  private bag: Kind[] = []
  private fall = 0
  private lockTimer = 0
  private lockResets = 0
  private lowest = 0
  /** 最後一個成功的動作是旋轉，以及用了第幾個踢牆位置（判斷 spin） */
  private lastKick = -1
  private combo = -1
  private b2b = false

  private random: () => number

  constructor(random: () => number = Math.random) {
    this.random = random
    this.fillQueue()
    this.spawn()
  }

  get(x: number, y: number): number {
    return this.board[y * COLS + x]
  }

  private fillQueue() {
    while (this.next.length <= PREVIEW) {
      if (this.bag.length === 0) {
        this.bag = [...KINDS]
        for (let i = this.bag.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1))
          ;[this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]]
        }
      }
      this.next.push(this.bag.pop()!)
    }
  }

  private fits(kind: Kind, rot: number, x: number, y: number): boolean {
    return pieceCells(kind, rot).every(([cx, cy]) => {
      const px = x + cx
      const py = y + cy
      return px >= 0 && px < COLS && py >= 0 && py < TOTAL && this.board[py * COLS + px] === 0
    })
  }

  private spawn(kind: Kind = this.takeNext()) {
    const x = kind === 'O' ? 4 : 3
    const y = kind === 'I' ? HIDDEN - 2 : HIDDEN - 1
    this.fall = 0
    this.lockTimer = 0
    this.lockResets = 0
    this.lastKick = -1
    // 出生的位置被堵住就往上一格試，還是不行就輸了
    for (const dy of [0, -1]) {
      if (this.fits(kind, 0, x, y + dy)) {
        this.piece = { kind, rot: 0, x, y: y + dy }
        this.lowest = y + dy
        return
      }
    }
    this.piece = null
    this.over = true
  }

  private takeNext(): Kind {
    const kind = this.next.shift()!
    this.fillQueue()
    return kind
  }

  private onGround(): boolean {
    const p = this.piece
    return !!p && !this.fits(p.kind, p.rot, p.x, p.y + 1)
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
    if (!p || this.over || !this.fits(p.kind, p.rot, p.x + dx, p.y)) return false
    p.x += dx
    this.lastKick = -1
    this.moved()
    return true
  }

  /** dir：1 順時針、-1 逆時針 */
  rotate(dir: 1 | -1): boolean {
    const p = this.piece
    if (!p || this.over || p.kind === 'O') return false
    const to = ((p.rot + dir + 4) % 4) as Rot
    const kicks = (p.kind === 'I' ? KICKS_I : KICKS_JLSTZ)[`${p.rot}${to}`]
    for (let i = 0; i < kicks.length; i++) {
      const [kx, ky] = kicks[i]
      if (this.fits(p.kind, to, p.x + kx, p.y - ky)) {
        p.x += kx
        p.y -= ky
        p.rot = to
        this.lastKick = i
        this.moved()
        return true
      }
    }
    return false
  }

  ghostY(): number {
    const p = this.piece
    if (!p) return 0
    let y = p.y
    while (this.fits(p.kind, p.rot, p.x, y + 1)) y++
    return y
  }

  setSoftDrop(on: boolean) {
    // 照原本重力累積的時間不能拿來算加速後的格數，否則按下的瞬間會一口氣掉好幾格
    if (on !== this.softDrop) this.fall = 0
    this.softDrop = on
  }

  hardDrop() {
    const p = this.piece
    if (!p || this.over) return
    const y = this.ghostY()
    if (y !== p.y) this.lastKick = -1
    this.score += (y - p.y) * 2
    p.y = y
    this.lock()
  }

  holdPiece() {
    const p = this.piece
    if (!p || this.over || this.holdUsed) return
    const swap = this.hold
    this.hold = p.kind
    this.holdUsed = true
    this.spawn(swap ?? this.takeNext())
  }

  /** 收到攻擊：同一次攻擊的洞在同一欄 */
  receive(lines: number) {
    if (lines <= 0) return
    this.garbage.push({ lines, readyAt: this.clock + GARBAGE_DELAY_MS, hole: Math.floor(this.random() * COLS) })
  }

  pending(): number {
    return this.garbage.reduce((sum, g) => sum + g.lines, 0)
  }

  update(dt: number) {
    if (this.over || !this.piece) return
    this.clock += dt
    if (this.onGround()) {
      this.fall = 0
      this.lockTimer += dt
      if (this.lockTimer >= LOCK_MS) this.lock()
      return
    }
    const g = gravityMs(this.level)
    const step = this.softDrop ? Math.min(g, SOFT_DROP_MS) : g
    this.fall += dt
    while (this.fall >= step && this.piece) {
      this.fall -= step
      if (this.onGround()) break
      this.piece.y++
      this.lastKick = -1
      if (this.softDrop) this.score++
      if (this.piece.y > this.lowest) {
        this.lowest = this.piece.y
        this.lockResets = 0
      }
    }
  }

  private spin(): LockResult['spin'] {
    const p = this.piece!
    if (this.lastKick < 0 || p.kind === 'O') return 'none'
    // L、J、S、Z、I：最後一個動作是旋轉，而且卡在原地不能往左、右、上移動
    if (p.kind !== 'T') {
      const stuck = [
        [-1, 0],
        [1, 0],
        [0, -1],
      ].every(([dx, dy]) => !this.fits(p.kind, p.rot, p.x + dx, p.y + dy))
      return stuck ? 'full' : 'none'
    }
    // T：旋轉進到三個角都被擋住的位置；前方兩角都擋住（或用了最後一個踢牆）才算完整 T-Spin
    const cx = p.x + 1
    const cy = p.y + 1
    const blocked = (x: number, y: number) => x < 0 || x >= COLS || y >= TOTAL || (y >= 0 && this.get(x, y) !== 0)
    // 依序是左上、右上、右下、左下
    const corners = [
      blocked(cx - 1, cy - 1),
      blocked(cx + 1, cy - 1),
      blocked(cx + 1, cy + 1),
      blocked(cx - 1, cy + 1),
    ]
    if (corners.filter(Boolean).length < 3) return 'none'
    const front = [corners[p.rot], corners[(p.rot + 1) % 4]]
    return (front[0] && front[1]) || this.lastKick === 4 ? 'full' : 'mini'
  }

  private lock() {
    const p = this.piece
    if (!p) return
    const spin = this.spin()
    let visible = false
    for (const [cx, cy] of pieceCells(p.kind, p.rot)) {
      const y = p.y + cy
      this.board[y * COLS + p.x + cx] = KINDS.indexOf(p.kind) + 1
      if (y >= HIDDEN) visible = true
    }
    this.piece = null
    this.pieces++
    // 整塊鎖在可見區上方：輸了
    if (!visible) {
      this.over = true
      return
    }

    let lines = 0
    for (let y = TOTAL - 1; y >= 0; ) {
      let full = true
      for (let x = 0; x < COLS; x++) if (this.get(x, y) === 0) full = false
      if (full) {
        this.board.copyWithin(COLS, 0, y * COLS)
        this.board.fill(0, 0, COLS)
        lines++
      } else {
        y--
      }
    }

    let attack = 0
    let b2b = false
    const perfect = lines > 0 && this.board.every((c) => c === 0)
    if (lines > 0) {
      attack = (spin === 'full' ? ATTACK_SPIN : spin === 'mini' ? ATTACK_MINI : ATTACK_NORMAL)[lines] ?? 0
      const difficult = lines === 4 || spin !== 'none'
      b2b = difficult && this.b2b
      if (b2b) attack += 1
      this.b2b = difficult
      this.combo++
      attack += COMBO[Math.min(this.combo, COMBO.length - 1)]
      if (perfect) attack += PERFECT_CLEAR
      attack = Math.floor((attack * (4 + badgeCount(this.badges))) / 4)
    } else {
      this.combo = -1
    }

    let points = (spin === 'full' ? SCORE_SPIN : spin === 'mini' ? SCORE_MINI : SCORE_NORMAL)[lines] ?? 0
    if (b2b) points = Math.floor(points * 1.5)
    if (lines > 0) points += SCORE_COMBO * this.combo
    if (perfect) points += SCORE_PERFECT[lines]
    points *= this.level
    this.score += points

    let sent = attack
    if (lines > 0) {
      // 消行先抵銷待升的垃圾，剩下的才送出去
      while (sent > 0 && this.garbage.length > 0) {
        const cancel = Math.min(sent, this.garbage[0].lines)
        sent -= cancel
        this.garbage[0].lines -= cancel
        if (this.garbage[0].lines === 0) this.garbage.shift()
      }
    } else {
      this.riseGarbage()
    }

    this.lines += lines
    this.sent += sent
    this.events.push({ lines, spin, piece: p.kind, b2b, combo: this.combo, perfect, attack, sent, points })
    this.holdUsed = false
    if (!this.over) this.spawn()
  }

  /** 沒有消行時，到時間的垃圾行從底部升上來 */
  private riseGarbage() {
    let budget = GARBAGE_PER_LOCK
    while (budget > 0 && this.garbage.length > 0 && this.garbage[0].readyAt <= this.clock) {
      const g = this.garbage[0]
      const n = Math.min(g.lines, budget)
      budget -= n
      g.lines -= n
      if (g.lines === 0) this.garbage.shift()
      // 最上面被推出去的列有東西就輸了
      for (let i = 0; i < n * COLS; i++) if (this.board[i] !== 0) this.over = true
      this.board.copyWithin(0, n * COLS)
      for (let y = TOTAL - n; y < TOTAL; y++) {
        for (let x = 0; x < COLS; x++) this.board[y * COLS + x] = x === g.hole ? 0 : GARBAGE
      }
    }
  }

  /** 整個盤面（含上方看不到的列），由上到下每格一個字元 */
  cells(): string {
    return this.board.join('')
  }

  /** 給其他玩家看的盤面：可見的 20 列，由上到下 */
  snapshot(): string {
    let out = ''
    for (let i = HIDDEN * COLS; i < TOTAL * COLS; i++) out += this.board[i]
    return out
  }
}

/** 把一次鎖定的結果寫成要閃過畫面的字，沒有值得一提的就是 null */
export function describe(r: LockResult): string | null {
  const parts: string[] = []
  if (r.perfect) parts.push('PERFECT CLEAR')
  if (r.spin !== 'none') {
    const n = ['', ' SINGLE', ' DOUBLE', ' TRIPLE', ' QUAD'][r.lines] ?? ''
    parts.push(`${r.piece}-SPIN${r.spin === 'mini' ? ' MINI' : ''}${n}`)
  } else if (r.lines === 4) {
    parts.push('TETRIS')
  }
  if (r.b2b) parts.push('B2B')
  if (r.combo >= 1) parts.push(`${r.combo} COMBO`)
  return parts.length ? parts.join(' · ') : null
}
