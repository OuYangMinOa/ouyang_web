// 賽道的幾何資料：把控制點連成的曲線每 2 公尺取一個點，記下位置、切線、彎度、坡度和彎道的傾斜。
// 車子用它查「我在賽道的哪裡、偏離中心多少、路面多高」；電腦對手的行車線和建議速度也在這裡先算好。
// 賽道可以從自己上方跨過去（立體交叉）：找位置時只在上一次的附近找，所以不會跳到另一層。
import { CatmullRomCurve3, Vector3 } from 'three'
import { clamp, smoothstep, wrapAngle } from './noise'
import { CAR } from './spec'
import type { TrackDef } from './tracks'

/** 重力（公尺／秒²） */
export const GRAVITY = 9.8
/** 傾斜的彎道幫忙過彎的倍率：照物理是重力 × 坡度，遊戲裡放大一點，才感覺得出來 */
export const BANK_GRIP = 2
/** 路面比這條賽道自己的地形高出這麼多，就當成橋：下面不填土，改用橋墩撐著 */
const BRIDGE_GAP = 1.5
/** 立體交叉時上下兩層至少要差這麼多（公尺） */
const CROSS_GAP = 4

export type TrackLoc = {
  /** 最近的取樣點（下次從這附近找） */
  i: number
  /** 沿著賽道的距離，0～length */
  s: number
  /** 偏離中心線的距離，左正右負 */
  lat: number
  /** 這個位置的路面高度（含彎道的傾斜） */
  y: number
  tx: number
  tz: number
  /** 沿著賽道往前的坡度（高度／距離），上坡是正的 */
  grade: number
  /** 路面的橫向坡度：往左每公尺高多少（左彎時右邊高，是負的） */
  bank: number
  /** 坡度往前每公尺變多少：負的是坡頂（路面往下彎） */
  vcurv: number
}

export function newLoc(): TrackLoc {
  return { i: 0, s: 0, lat: 0, y: 0, tx: 0, tz: 1, grade: 0, bank: 0, vcurv: 0 }
}

export type TrackPoint = { x: number; y: number; z: number; tx: number; tz: number }

/** 電腦開車時預留的抓地力，不會剛好貼著極限開 */
const AI_GRIP = 0.9
const AI_BRAKE = CAR.brake * 0.55

export class TrackPath {
  readonly n: number
  readonly length: number
  readonly step: number
  readonly halfWidth: number
  /** 中心線到護欄的距離 */
  readonly wall: number
  readonly px: Float32Array
  readonly py: Float32Array
  readonly pz: Float32Array
  readonly tx: Float32Array
  readonly tz: Float32Array
  /** 帶正負號的彎度（1/公尺），左彎是正的 */
  readonly curv: Float32Array
  /** 沿著賽道的坡度（高度／距離） */
  readonly grade: Float32Array
  /** 橫向坡度：往左每公尺高多少 */
  readonly bank: Float32Array
  /** 1 = 這一點是橋（跨過另一段路，或比地面高出一截），下面不填土 */
  readonly bridge: Uint8Array
  /** 電腦的行車線：每個取樣點偏離中心多少（外－內－外） */
  readonly line: Float32Array
  /** 電腦在每個取樣點的建議速度 */
  readonly speed: Float32Array
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  private readonly tmp: TrackPoint = { x: 0, y: 0, z: 0, tx: 0, tz: 1 }

  constructor(def: TrackDef) {
    const curve = new CatmullRomCurve3(
      def.points.map(([x, z, y]) => new Vector3(x, y, z)),
      true,
      'centripetal',
    )
    const n = Math.max(64, Math.round(curve.getLength() / 2))
    const pts = curve.getSpacedPoints(n)
    // 路面上的小隆起：沿著賽道的距離換算成取樣點，疊一個餘弦形狀的鼓包
    const approxStep = curve.getLength() / n
    for (const [at, len, height] of def.bumps ?? []) {
      for (let i = 0; i < n; i++) {
        let d = i * approxStep - at
        if (d > (n * approxStep) / 2) d -= n * approxStep
        if (Math.abs(d) < len / 2) pts[i].y += height * 0.5 * (1 + Math.cos((2 * Math.PI * d) / len))
      }
    }
    pts[n].y = pts[0].y
    this.n = n
    this.halfWidth = def.halfWidth
    this.wall = def.halfWidth + def.runoff
    this.px = new Float32Array(n)
    this.py = new Float32Array(n)
    this.pz = new Float32Array(n)
    let length = 0
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      this.px[i] = p.x
      this.py[i] = p.y
      this.pz[i] = p.z
      length += p.distanceTo(pts[i + 1])
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minZ = Math.min(minZ, p.z)
      maxZ = Math.max(maxZ, p.z)
    }
    this.length = length
    this.step = length / n
    this.minX = minX
    this.maxX = maxX
    this.minZ = minZ
    this.maxZ = maxZ

    // 切線：前後兩點的差
    this.tx = new Float32Array(n)
    this.tz = new Float32Array(n)
    const heading = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n
      const b = (i + 1) % n
      const dx = this.px[b] - this.px[a]
      const dz = this.pz[b] - this.pz[a]
      const d = Math.hypot(dx, dz) || 1
      this.tx[i] = dx / d
      this.tz[i] = dz / d
      heading[i] = Math.atan2(dx, dz)
    }
    this.curv = curvature(heading, this.step, n)

    // 坡度：前後兩點的高度差
    this.grade = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      this.grade[i] = (this.py[(i + 1) % n] - this.py[(i - 1 + n) % n]) / (2 * this.step)
    }

    // 彎道的傾斜：越急的彎越斜（外側高），再沿著賽道抹平，進彎前慢慢斜起來
    const maxBank = Math.tan(((def.bank ?? 0) * Math.PI) / 180)
    let bank = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      bank[i] = -Math.sign(this.curv[i]) * maxBank * smoothstep(0.003, 0.02, Math.abs(this.curv[i]))
    }
    const w = Math.max(1, Math.round(14 / this.step))
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let sum = 0
        for (let k = -w; k <= w; k++) sum += bank[(i + k + n) % n]
        next[i] = sum / (2 * w + 1)
      }
      bank = next
    }
    this.bank = bank

    // 橋：從另一段路的上方跨過去，或是比這條賽道自己的地形高出一截（市區的高架橋）
    this.bridge = new Uint8Array(n)
    const skip = Math.ceil((this.wall * 6) / this.step)
    const cross = (this.wall * 2 + 4) ** 2
    const crossings = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (def.terrain(this.px[i], this.pz[i], 0, this.py[i]) < this.py[i] - BRIDGE_GAP) this.bridge[i] = 1
      for (let j = 0; j < n; j++) {
        const gap = Math.abs(i - j)
        if (Math.min(gap, n - gap) < skip || this.py[i] - this.py[j] < CROSS_GAP) continue
        const dx = this.px[i] - this.px[j]
        const dz = this.pz[i] - this.pz[j]
        if (dx * dx + dz * dz < cross) {
          crossings[i] = 1
          break
        }
      }
    }
    // 跨過去的那段橋往前後各多延伸一些，橋頭的土坡才不會擠到底下那條路
    const pad = Math.ceil((this.wall * 2 + 20) / this.step)
    for (let i = 0; i < n; i++) {
      if (!crossings[i]) continue
      for (let k = -pad; k <= pad; k++) this.bridge[(i + k + n) % n] = 1
    }

    // 行車線：把中心線像橡皮筋一樣拉緊（每點往前後鄰點的中點靠），限制在路面內
    const lim = def.halfWidth - 1.8
    const line = new Float32Array(n)
    for (const [k, iterations] of [
      [14, 260],
      [5, 120],
    ]) {
      for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
          const a = (i - k + n) % n
          const b = (i + k) % n
          const mx = (this.px[a] + this.tz[a] * line[a] + this.px[b] + this.tz[b] * line[b]) / 2
          const mz = (this.pz[a] - this.tx[a] * line[a] + this.pz[b] - this.tx[b] * line[b]) / 2
          const l = (mx - this.px[i]) * this.tz[i] - (mz - this.pz[i]) * this.tx[i]
          line[i] = clamp(line[i] + (l - line[i]) * 0.6, -lim, lim)
        }
      }
    }
    this.line = line

    // 沿著行車線的彎度 → 綜合型能過彎的速度，再從後往前推「要在這裡開始煞車」
    const lineHeading = new Float32Array(n)
    const seg = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n
      const b = (i + 1) % n
      const ax = this.px[a] + this.tz[a] * line[a]
      const az = this.pz[a] - this.tx[a] * line[a]
      const bx = this.px[b] + this.tz[b] * line[b]
      const bz = this.pz[b] - this.tx[b] * line[b]
      lineHeading[i] = Math.atan2(bx - ax, bz - az)
      seg[i] = Math.hypot(bx - ax, bz - az) / 2
    }
    const lineCurv = curvature(lineHeading, this.step, n)
    const speed = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const k = Math.max(Math.abs(lineCurv[i]), 1e-5)
      // 往彎內傾斜的路面可以壓得更快
      const assist = Math.max(0, -this.bank[i] * Math.sign(lineCurv[i])) * GRAVITY * BANK_GRIP
      // 不在這裡限極速：各車種的極速不同，電腦開車時再照自己的車限
      speed[i] = Math.min(CAR.maxSpeed * 2, Math.sqrt((CAR.latAcc * AI_GRIP + assist) / k))
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const next = speed[(i + 1) % n]
        speed[i] = Math.min(speed[i], Math.sqrt(next * next + 2 * AI_BRAKE * seg[i]))
      }
    }
    this.speed = speed
  }

  /** 距離 s 最近的取樣點 */
  indexAt(s: number): number {
    const u = (((s % this.length) + this.length) % this.length) / this.step
    return Math.floor(u) % this.n
  }

  /** 沿著賽道距離 s 的中心點與切線（內插）；回傳的物件會被下一次呼叫覆寫 */
  pointAt(s: number, out: TrackPoint = this.tmp): TrackPoint {
    const u = (((s % this.length) + this.length) % this.length) / this.step
    const i = Math.floor(u) % this.n
    const j = (i + 1) % this.n
    const f = u - Math.floor(u)
    out.x = this.px[i] + (this.px[j] - this.px[i]) * f
    out.y = this.py[i] + (this.py[j] - this.py[i]) * f
    out.z = this.pz[i] + (this.pz[j] - this.pz[i]) * f
    const tx = this.tx[i] + (this.tx[j] - this.tx[i]) * f
    const tz = this.tz[i] + (this.tz[j] - this.tz[i]) * f
    const d = Math.hypot(tx, tz) || 1
    out.tx = tx / d
    out.tz = tz / d
    return out
  }

  /** 中心線在距離 s 的高度：用坡度做三次內插，坡度是連續的，車子過坡頂時才不會一格一格地抖 */
  heightAt(s: number): number {
    const u = (((s % this.length) + this.length) % this.length) / this.step
    const i = Math.floor(u) % this.n
    const j = (i + 1) % this.n
    const f = u - Math.floor(u)
    const f2 = f * f
    const f3 = f2 * f
    return (
      (2 * f3 - 3 * f2 + 1) * this.py[i] +
      (f3 - 2 * f2 + f) * this.step * this.grade[i] +
      (-2 * f3 + 3 * f2) * this.py[j] +
      (f3 - f2) * this.step * this.grade[j]
    )
  }

  /** 取樣點 i、偏離中心 lat 的路面高度（含傾斜；護欄外面照護欄那裡的高度） */
  roadY(i: number, lat: number): number {
    return this.py[i] + this.bank[i] * clamp(lat, -this.wall, this.wall)
  }

  /** 取樣點 i 附近的值，用距離內插 */
  sampleArray(arr: Float32Array, s: number): number {
    const u = (((s % this.length) + this.length) % this.length) / this.step
    const i = Math.floor(u) % this.n
    const f = u - Math.floor(u)
    return arr[i] + (arr[(i + 1) % this.n] - arr[i]) * f
  }

  /**
   * 找 (x, z) 在賽道上的位置。從 `out.i` 附近找，所以賽道兩段靠得很近（或上下交叉）時也不會跳到另一段；
   * 離得太遠（剛重生、網路延遲跳了一大段）才整條找一遍，這時高度和 `out.y` 差很多的那一層不算近。
   */
  locate(x: number, z: number, out: TrackLoc) {
    const { n, px, pz } = this
    let best = out.i
    let bestD = Infinity
    for (let k = -24; k <= 24; k++) {
      const i = (out.i + k + n) % n
      const dx = x - px[i]
      const dz = z - pz[i]
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (bestD > this.wall * this.wall * 6) {
      for (let i = 0; i < n; i++) {
        const dx = x - px[i]
        const dz = z - pz[i]
        const dy = Math.max(0, Math.abs(this.py[i] - out.y) - 2)
        const d = dx * dx + dz * dz + dy * dy * 16
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
    }
    const tx = this.tx[best]
    const tz = this.tz[best]
    const dx = x - px[best]
    const dz = z - pz[best]
    const along = dx * tx + dz * tz
    let s = best * this.step + along
    if (s < 0) s += this.length
    else if (s >= this.length) s -= this.length
    out.i = best
    out.s = s
    out.lat = dx * tz - dz * tx
    out.grade = this.sampleArray(this.grade, s)
    out.bank = this.sampleArray(this.bank, s)
    const gi = this.indexAt(s)
    out.vcurv = (this.grade[(gi + 1) % n] - this.grade[gi]) / this.step
    out.y = this.heightAt(s) + out.bank * clamp(out.lat, -this.wall, this.wall)
    out.tx = tx
    out.tz = tz
  }

  /**
   * 在 (x, z) 離賽道中心線最近的距離、那裡的路面高度（含傾斜，護欄外面照護欄的高度）。
   * 建地形、擺東西用，比較慢。`ground` 是 true 時不算橋：地形要貼著橋底下的路或原本的地面
   */
  nearest(x: number, z: number, ground = false): { dist: number; y: number; i: number } {
    const { n, px, pz } = this
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < n; i += 3) {
      if (ground && this.bridge[i]) continue
      const dx = x - px[i]
      const dz = z - pz[i]
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) return { dist: Infinity, y: 0, i: 0 }
    const center = best
    for (let k = -3; k <= 3; k++) {
      const i = (center + k + n) % n
      if (ground && this.bridge[i]) continue
      const dx = x - px[i]
      const dz = z - pz[i]
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    const lat = (x - px[best]) * this.tz[best] - (z - pz[best]) * this.tx[best]
    return { dist: Math.sqrt(bestD), y: this.roadY(best, lat), i: best }
  }

  /** (x, z) 的正上方有沒有橋（橋面比 y 高出 `clear` 公尺以上）：路燈、擺設不要放在橋下 */
  under(x: number, z: number, y: number, clear = 2): boolean {
    const r = (this.wall + 3) ** 2
    for (let i = 0; i < this.n; i++) {
      if (!this.bridge[i] || this.py[i] < y + clear) continue
      const dx = x - this.px[i]
      const dz = z - this.pz[i]
      if (dx * dx + dz * dz < r) return true
    }
    return false
  }
}

/** 每個點的車頭方向變化率，再做幾次平均去掉鋸齒 */
function curvature(heading: Float32Array, step: number, n: number): Float32Array {
  let curv = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = heading[(i - 2 + n) % n]
    const b = heading[(i + 2) % n]
    curv[i] = wrapAngle(b - a) / (4 * step)
  }
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let k = -2; k <= 2; k++) sum += curv[(i + k + n) % n]
      next[i] = sum / 5
    }
    curv = next
  }
  return curv
}
