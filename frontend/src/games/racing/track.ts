// 賽道的幾何資料：把控制點連成的曲線每 2 公尺取一個點，記下位置、切線與彎度。
// 車子用它查「我在賽道的哪裡、偏離中心多少」；電腦對手的行車線和建議速度也在這裡先算好。
import { CatmullRomCurve3, Vector3 } from 'three'
import { clamp, wrapAngle } from './noise'
import { CAR } from './spec'
import type { TrackDef } from './tracks'

export type TrackLoc = {
  /** 最近的取樣點（下次從這附近找） */
  i: number
  /** 沿著賽道的距離，0～length */
  s: number
  /** 偏離中心線的距離，左正右負 */
  lat: number
  y: number
  tx: number
  tz: number
}

export function newLoc(): TrackLoc {
  return { i: 0, s: 0, lat: 0, y: 0, tx: 0, tz: 1 }
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

    // 沿著行車線的彎度 → 能過彎的速度，再從後往前推「要在這裡開始煞車」
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
      speed[i] = Math.min(CAR.maxSpeed * 1.1, Math.sqrt((CAR.latAcc * AI_GRIP) / k))
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

  heightAt(s: number): number {
    const u = (((s % this.length) + this.length) % this.length) / this.step
    const i = Math.floor(u) % this.n
    const f = u - Math.floor(u)
    return this.py[i] + (this.py[(i + 1) % this.n] - this.py[i]) * f
  }

  /** 取樣點 i 附近的值，用距離內插 */
  sampleArray(arr: Float32Array, s: number): number {
    const u = (((s % this.length) + this.length) % this.length) / this.step
    const i = Math.floor(u) % this.n
    const f = u - Math.floor(u)
    return arr[i] + (arr[(i + 1) % this.n] - arr[i]) * f
  }

  /**
   * 找 (x, z) 在賽道上的位置。從 `out.i` 附近找，所以賽道兩段靠得很近時也不會跳到另一段；
   * 離得太遠（剛重生、出界）才整條找一遍。
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
        const d = dx * dx + dz * dz
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
    out.y = this.heightAt(s)
    out.tx = tx
    out.tz = tz
  }

  /** 在 (x, z) 離賽道中心線最近的距離與那裡的路面高度（建地形用，比較慢） */
  nearest(x: number, z: number): { dist: number; y: number; i: number } {
    const { n, px, pz } = this
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < n; i += 3) {
      const dx = x - px[i]
      const dz = z - pz[i]
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    for (let k = -3; k <= 3; k++) {
      const i = (best + k + n) % n
      const dx = x - px[i]
      const dz = z - pz[i]
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return { dist: Math.sqrt(bestD), y: this.py[best], i: best }
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
