import { GATE_Y, SEG_R, WORLD_W, type Peg, type Seg, type Spinner, type Track } from './tracks'

/** 固定時間步長，結果不受畫面更新率影響 */
export const DT = 1 / 240
const GRAVITY = 900
const MAX_SPEED = 650
/** 撞牆、撞釘子的反彈係數 */
const BOUNCE = 0.45
/** 彈珠互撞的反彈係數 */
const BOUNCE_BALL = 0.6
/** 閘門打開前讓彈珠先落定 */
export const SETTLE_TIME = 1.2
/** 跑太久就照目前位置排名，避免卡住的彈珠讓比賽停不下來 */
const TIME_LIMIT = 90
const STUCK_SPEED = 18
const STUCK_TIME = 1.4
/** 靜態障礙物照 y 分帶，每顆彈珠只檢查自己那一帶 */
const BAND = 48

export type Marble = {
  /** 名單裡的 id */
  id: number
  name: string
  x: number
  y: number
  vx: number
  vy: number
  /** 速度很慢持續了多久，太久就推一把 */
  still: number
  /** 第幾名抵達，還沒抵達是 0 */
  rank: number
}

type Band = { segs: Seg[]; pegs: Peg[]; spinners: Spinner[] }

/** 跟彈珠大小無關的亂數產生器，同一個 seed 會跑出同一場比賽（測試用） */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 名單人數決定彈珠大小：人多就小一點，才排得進起跑區 */
export function marbleRadius(count: number): number {
  if (count <= 16) return 9
  if (count <= 40) return 7.5
  if (count <= 80) return 6
  return 5
}

export class Race {
  readonly track: Track
  readonly r: number
  readonly marbles: Marble[]
  /** 從按下開始算起的秒數；SETTLE_TIME 之後閘門打開 */
  t = 0
  finished: Marble[] = []
  private active: Marble[]
  private bands: Band[] = []
  private random: () => number

  constructor(track: Track, entries: { id: number; name: string }[], r: number, seed = Math.random() * 2 ** 32) {
    this.track = track
    this.r = r
    this.random = mulberry32(seed)
    this.marbles = this.place(entries)
    this.active = [...this.marbles]
    this.index()
  }

  get gateOpen() {
    return this.t >= SETTLE_TIME
  }

  get over() {
    return this.active.length === 0
  }

  /** 起跑區排成格子，誰站哪一格是隨機的 */
  private place(entries: { id: number; name: string }[]): Marble[] {
    const r = this.r
    const cell = r * 2 + 3
    const cols = Math.floor((WORLD_W - 8) / cell)
    const rows = Math.ceil(entries.length / cols)
    const slots: number[] = Array.from({ length: rows * cols }, (_, i) => i)
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1))
      ;[slots[i], slots[j]] = [slots[j], slots[i]]
    }
    const left = (WORLD_W - cols * cell) / 2 + cell / 2
    return entries.map((e, i) => {
      const slot = slots[i]
      const col = slot % cols
      const row = Math.floor(slot / cols)
      return {
        id: e.id,
        name: e.name,
        x: left + col * cell + (this.random() - 0.5) * 2,
        y: GATE_Y - SEG_R - r - 1 - row * cell,
        vx: 0,
        vy: 0,
        still: 0,
        rank: 0,
      }
    })
  }

  private index() {
    const { track, r } = this
    const n = Math.ceil(track.height / BAND) + 1
    this.bands = Array.from({ length: n }, () => ({ segs: [], pegs: [], spinners: [] }))
    const add = (top: number, bottom: number, put: (b: Band) => void) => {
      const pad = r + SEG_R + 1
      const from = Math.max(0, Math.floor((top - pad) / BAND))
      const to = Math.min(n - 1, Math.floor((bottom + pad) / BAND))
      for (let i = from; i <= to; i++) put(this.bands[i])
    }
    for (const s of track.segs) add(Math.min(s.y1, s.y2), Math.max(s.y1, s.y2), (b) => b.segs.push(s))
    for (const p of track.pegs) add(p.y - p.r, p.y + p.r, (b) => b.pegs.push(p))
    for (const sp of track.spinners) add(sp.y - sp.len, sp.y + sp.len, (b) => b.spinners.push(sp))
  }

  /** 前進一個 DT */
  step() {
    const { r, track } = this
    this.t += DT
    const gateOpen = this.gateOpen
    const raceTime = this.t - SETTLE_TIME

    for (const m of this.active) {
      m.vy += GRAVITY * DT
      const speed = Math.hypot(m.vx, m.vy)
      if (speed > MAX_SPEED) {
        m.vx *= MAX_SPEED / speed
        m.vy *= MAX_SPEED / speed
      }
      m.x += m.vx * DT
      m.y += m.vy * DT

      const band = this.bands[Math.min(this.bands.length - 1, Math.max(0, Math.floor(m.y / BAND)))]
      for (const s of band.segs) hitSegment(m, s.x1, s.y1, s.x2, s.y2, r + SEG_R, 0, 0, 0)
      for (const p of band.pegs) hitCircle(m, p.x, p.y, r + p.r)
      for (const sp of band.spinners) {
        // 扇葉中心的軸
        hitCircle(m, sp.x, sp.y, r + 6)
        const angle = sp.phase + sp.speed * Math.max(0, raceTime)
        for (let k = 0; k < sp.arms; k++) {
          const a = angle + (k * 2 * Math.PI) / sp.arms
          hitSegment(m, sp.x, sp.y, sp.x + Math.cos(a) * sp.len, sp.y + Math.sin(a) * sp.len, r + SEG_R, sp.x, sp.y, gateOpen ? sp.speed : 0)
        }
      }
      if (!gateOpen) hitSegment(m, 0, GATE_Y, WORLD_W, GATE_Y, r + SEG_R, 0, 0, 0)
      // 保險：不管撞到什麼都不能穿出左右牆
      if (m.x < r) {
        m.x = r
        if (m.vx < 0) m.vx = -m.vx * BOUNCE
      } else if (m.x > WORLD_W - r) {
        m.x = WORLD_W - r
        if (m.vx > 0) m.vx = -m.vx * BOUNCE
      }
    }

    this.collideMarbles()

    let anyFinished = false
    for (const m of this.active) {
      if (m.y >= track.finishY) {
        m.rank = this.finished.length + 1
        this.finished.push(m)
        anyFinished = true
        continue
      }
      if (!gateOpen) continue
      if (Math.hypot(m.vx, m.vy) < STUCK_SPEED) {
        m.still += DT
        if (m.still > STUCK_TIME) {
          // 卡住了：往上往旁邊彈一下
          m.vx = (this.random() - 0.5) * 360
          m.vy = -180 - this.random() * 160
          m.still = 0
        }
      } else {
        m.still = 0
      }
    }
    if (anyFinished) this.active = this.active.filter((m) => m.rank === 0)

    if (gateOpen && raceTime > TIME_LIMIT && this.active.length) {
      // 時間到：還沒到的照位置排
      for (const m of [...this.active].sort((a, b) => b.y - a.y)) {
        m.rank = this.finished.length + 1
        this.finished.push(m)
      }
      this.active = []
    }
  }

  /** 照 y 排序後只比較上下相近的彈珠 */
  private collideMarbles() {
    const list = this.active
    // 幾乎已經排好，插入排序最快
    for (let i = 1; i < list.length; i++) {
      const m = list[i]
      let j = i - 1
      while (j >= 0 && list[j].y > m.y) {
        list[j + 1] = list[j]
        j--
      }
      list[j + 1] = m
    }
    const d = this.r * 2
    const d2 = d * d
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        const dy = b.y - a.y
        if (dy >= d) break
        const dx = b.x - a.x
        const dist2 = dx * dx + dy * dy
        if (dist2 >= d2) continue
        let dist = Math.sqrt(dist2)
        let nx: number
        let ny: number
        if (dist < 1e-6) {
          nx = this.random() - 0.5
          ny = 1
          dist = 0
          const len = Math.hypot(nx, ny)
          nx /= len
          ny /= len
        } else {
          nx = dx / dist
          ny = dy / dist
        }
        const push = (d - dist) / 2
        a.x -= nx * push
        a.y -= ny * push
        b.x += nx * push
        b.y += ny * push
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
        if (rel < 0) {
          const imp = (-(1 + BOUNCE_BALL) * rel) / 2
          a.vx -= imp * nx
          a.vy -= imp * ny
          b.vx += imp * nx
          b.vy += imp * ny
        }
      }
    }
  }

  /** 目前名次：已抵達的照抵達順序，其餘照誰跑得遠 */
  standings(): Marble[] {
    return [...this.finished, ...[...this.active].sort((a, b) => b.y - a.y)]
  }

  /** 還在跑的最前面那顆；鏡頭跟著它 */
  leaderY(): number {
    let y = -Infinity
    for (const m of this.active) if (m.y > y) y = m.y
    return y === -Infinity ? this.track.height : y
  }

  /** 還在跑的彈珠（畫面用） */
  running(): readonly Marble[] {
    return this.active
  }
}

/** 彈珠撞圓形障礙物 */
function hitCircle(m: Marble, cx: number, cy: number, minDist: number) {
  const dx = m.x - cx
  const dy = m.y - cy
  const d2 = dx * dx + dy * dy
  if (d2 >= minDist * minDist || d2 === 0) return
  const d = Math.sqrt(d2)
  const nx = dx / d
  const ny = dy / d
  m.x = cx + nx * minDist
  m.y = cy + ny * minDist
  const vn = m.vx * nx + m.vy * ny
  if (vn < 0) {
    m.vx -= (1 + BOUNCE) * vn * nx
    m.vy -= (1 + BOUNCE) * vn * ny
  }
}

/**
 * 彈珠撞線段（有厚度）。會轉的扇葉要算上接觸點的速度：
 * 繞 (ox, oy) 以角速度 omega 旋轉，接觸點速度是 omega × (p - o)
 */
function hitSegment(m: Marble, x1: number, y1: number, x2: number, y2: number, minDist: number, ox: number, oy: number, omega: number) {
  const ex = x2 - x1
  const ey = y2 - y1
  const len2 = ex * ex + ey * ey
  let t = len2 === 0 ? 0 : ((m.x - x1) * ex + (m.y - y1) * ey) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const qx = x1 + ex * t
  const qy = y1 + ey * t
  const dx = m.x - qx
  const dy = m.y - qy
  const d2 = dx * dx + dy * dy
  if (d2 >= minDist * minDist) return
  let nx: number
  let ny: number
  const d = Math.sqrt(d2)
  if (d < 1e-6) {
    // 剛好在線上：往線段的法線方向推
    const l = Math.sqrt(len2) || 1
    nx = -ey / l
    ny = ex / l
    if (ny > 0) {
      nx = -nx
      ny = -ny
    }
  } else {
    nx = dx / d
    ny = dy / d
  }
  m.x = qx + nx * minDist
  m.y = qy + ny * minDist
  const sx = -omega * (qy - oy)
  const sy = omega * (qx - ox)
  const vn = (m.vx - sx) * nx + (m.vy - sy) * ny
  if (vn < 0) {
    m.vx -= (1 + BOUNCE) * vn * nx
    m.vy -= (1 + BOUNCE) * vn * ny
  }
}
