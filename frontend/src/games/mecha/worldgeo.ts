// 場景的網格：一直往裡面塞四邊形（不共用頂點，每個面自己的法線、UV、顏色），同一種材質的東西最後合成一個網格。
// 每個夠大的面另外在「遮蔽貼圖」上佔一格（`Atlas`、`uv1`）：載入時把整個場景的環境光遮蔽烘到那張圖上（`worldbake.ts`）。
import { BufferAttribute, BufferGeometry, Color } from 'three'
import { MAP_X, MAP_Z, topAt, type Box } from './map'
import type { Chart } from './mechgeo'
import { SIGN_COUNT } from './textures'

/** 一個角：位置和 UV */
export type Corner = [x: number, y: number, z: number, u: number, v: number]

/** 一格最長多少公尺（乘過倍率之後）：更長的面切成幾段，不然整張圖的解析度被最長的那一格限制住 */
const MAX_CHART = 72
/** 攤平後比這個還小（長的那一邊、短的那一邊）的面不排進遮蔽貼圖，當成沒被擋 */
const MIN_LONG = 0.9
const MIN_SHORT = 0.42
/** 地圖外面這麼遠以內的面才排進遮蔽貼圖（河、河岸一路畫到地平線，外面的不用烘） */
const BAKE_PAD = 24
/** 每一格四周留幾個像素（貼圖縮小、內插時才不會吃到隔壁） */
const PAD = 2

/** 遮蔽貼圖：整個場景所有的網格排在同一張圖上 */
export class Atlas {
  readonly charts: Chart[] = []
  size = 0
  /** 一公尺（乘過倍率之後）幾個像素 */
  density = 0

  /** 把所有的格子排進 `size` × `size` 的圖裡（一排一排由高到矮），找排得下的最大密度 */
  pack(size: number) {
    const charts = this.charts
    this.size = size
    for (const c of charts) c.rot = c.h > c.w
    const order = charts.map((_, i) => i).sort((a, b) => Math.min(charts[b].w, charts[b].h) - Math.min(charts[a].w, charts[a].h))
    const place = (density: number): boolean => {
      let x = 0
      let y = 0
      let shelf = 0
      for (const i of order) {
        const c = charts[i]
        const w = Math.max(2, Math.ceil(Math.max(c.w, c.h) * density)) + PAD * 2
        const h = Math.max(2, Math.ceil(Math.min(c.w, c.h) * density)) + PAD * 2
        if (w > size) return false
        if (x + w > size) {
          x = 0
          y += shelf
          shelf = 0
        }
        if (y + h > size) return false
        c.x = x + PAD
        c.y = y + PAD
        x += w
        shelf = Math.max(shelf, h)
      }
      return true
    }
    let lo = 0.02
    let hi = 64
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2
      if (place(mid)) lo = mid
      else hi = mid
    }
    place(lo)
    this.density = lo
  }
}

const white = new Color(0xffffff)

export class Mesher {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []
  col: number[] = []
  /** 每個頂點在遮蔽貼圖的哪一格（-1 是沒有）、在那一格裡的座標（公尺 × 倍率） */
  private readonly chart: number[] = []
  private readonly cu: number[] = []
  private readonly atlas: Atlas | null
  private readonly scale: number
  /** 開著的時候加進來的面不排進遮蔽貼圖（屋頂上的殘牆這種零零碎碎、又沒東西擋著的） */
  plain = false

  /**
   * `atlas` 有給的話，這個網格夠大的面都排進遮蔽貼圖；`scale` 是在那張圖上的解析度倍率
   * （大片的外牆、屋頂用小一點的，走得進去的樓板、橋用大一點的）
   */
  constructor(atlas: Atlas | null = null, scale = 1) {
    this.atlas = atlas
    this.scale = scale
  }

  /**
   * 從 p 沿著 r（往右）和 u（往上）展開的四邊形，r × u 是法線方向。
   * UV 照公尺算：(u0, v0) 起，橫的每 `us` 公尺一格、直的每 `vs` 公尺一格。`c0` 是下面兩點的顏色、`c1` 是上面的
   */
  quad(
    px: number,
    py: number,
    pz: number,
    rx: number,
    ry: number,
    rz: number,
    ux: number,
    uy: number,
    uz: number,
    us: number,
    vs: number,
    u0: number,
    v0: number,
    c0: Color,
    c1: Color = c0,
  ) {
    const ul = Math.hypot(rx, ry, rz) / us
    const vl = Math.hypot(ux, uy, uz) / vs
    this.face(
      [px, py, pz, u0, v0],
      [px + rx, py + ry, pz + rz, u0 + ul, v0],
      [px + rx + ux, py + ry + uy, pz + rz + uz, u0 + ul, v0 + vl],
      [px + ux, py + uy, pz + uz, u0, v0 + vl],
      c0,
      c1,
    )
  }

  /** 任意平的四邊形（可以是梯形、退化成三角形）：四個角照逆時針的順序，`c0` 給前兩個角、`c1` 給後兩個 */
  face(p0: Corner, p1: Corner, p2: Corner, p3: Corner, c0: Color, c1: Color = c0) {
    // 法線用兩條對角線的外積：有一個邊長是 0 也算得出來
    const ax = p2[0] - p0[0]
    const ay = p2[1] - p0[1]
    const az = p2[2] - p0[2]
    const bx = p3[0] - p1[0]
    const by = p3[1] - p1[1]
    const bz = p3[2] - p1[2]
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    const nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-9) return
    nx /= nl
    ny /= nl
    nz /= nl
    if (!this.atlas || this.plain) {
      this.emit(p0, p1, p2, p3, nx, ny, nz, c0, c0, c1, c1, -1, 0, 0, 0, 0, 0, 0, 0, 0)
      return
    }
    // 面上的兩個方向（e1 沿著第一條邊、e2 和它垂直），量出這個面攤平後多大
    let ex = p1[0] - p0[0]
    let ey = p1[1] - p0[1]
    let ez = p1[2] - p0[2]
    let el = Math.hypot(ex, ey, ez)
    if (el < 1e-6) {
      ex = p2[0] - p3[0]
      ey = p2[1] - p3[1]
      ez = p2[2] - p3[2]
      el = Math.hypot(ex, ey, ez)
    }
    ex /= el
    ey /= el
    ez /= el
    const fx = ny * ez - nz * ey
    const fy = nz * ex - nx * ez
    const fz = nx * ey - ny * ex
    const s = this.scale
    const a = (p: Corner) => ((p[0] - p0[0]) * ex + (p[1] - p0[1]) * ey + (p[2] - p0[2]) * ez) * s
    const b = (p: Corner) => ((p[0] - p0[0]) * fx + (p[1] - p0[1]) * fy + (p[2] - p0[2]) * fz) * s
    const all = [p0, p1, p2, p3]
    const w = Math.max(...all.map(a)) - Math.min(...all.map(a))
    const h = Math.max(...all.map(b)) - Math.min(...all.map(b))
    const na = Math.max(1, Math.ceil(w / MAX_CHART))
    const nb = Math.max(1, Math.ceil(h / MAX_CHART))
    const lerp = (p: Corner, q: Corner, t: number): Corner => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, p[3] + (q[3] - p[3]) * t, p[4] + (q[4] - p[4]) * t]
    const at = (u: number, v: number) => lerp(lerp(p0, p1, u), lerp(p3, p2, u), v)
    for (let j = 0; j < nb; j++) {
      for (let i = 0; i < na; i++) {
        const whole = na === 1 && nb === 1
        const q0 = whole ? p0 : at(i / na, j / nb)
        const q1 = whole ? p1 : at((i + 1) / na, j / nb)
        const q2 = whole ? p2 : at((i + 1) / na, (j + 1) / nb)
        const q3 = whole ? p3 : at(i / na, (j + 1) / nb)
        const d0 = whole ? c0 : c0.clone().lerp(c1, j / nb)
        const d1 = whole ? c1 : c0.clone().lerp(c1, (j + 1) / nb)
        const qs = [q0, q1, q2, q3]
        const as = qs.map(a)
        const bs = qs.map(b)
        const a0 = Math.min(...as)
        const b0 = Math.min(...bs)
        const cw = Math.max(...as) - a0
        const ch = Math.max(...bs) - b0
        const cx = (q0[0] + q1[0] + q2[0] + q3[0]) / 4
        const cz = (q0[2] + q1[2] + q2[2] + q3[2]) / 4
        const inside = Math.abs(cx) <= MAP_X + BAKE_PAD && Math.abs(cz) <= MAP_Z + BAKE_PAD
        let chart = -1
        if (inside && Math.max(cw, ch) >= MIN_LONG && Math.min(cw, ch) >= MIN_SHORT) {
          chart = this.atlas.charts.length
          this.atlas.charts.push({ w: cw, h: ch, x: 0, y: 0, rot: false })
        }
        this.emit(q0, q1, q2, q3, nx, ny, nz, d0, d0, d1, d1, chart, as[0] - a0, bs[0] - b0, as[1] - a0, bs[1] - b0, as[2] - a0, bs[2] - b0, as[3] - a0, bs[3] - b0)
      }
    }
  }

  private emit(
    p0: Corner,
    p1: Corner,
    p2: Corner,
    p3: Corner,
    nx: number,
    ny: number,
    nz: number,
    c0: Color,
    c1: Color,
    c2: Color,
    c3: Color,
    chart: number,
    a0: number,
    b0: number,
    a1: number,
    b1: number,
    a2: number,
    b2: number,
    a3: number,
    b3: number,
  ) {
    const corners = [p0, p1, p2, p3]
    const colors = [c0, c1, c2, c3]
    const cu = [a0, b0, a1, b1, a2, b2, a3, b3]
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const c = corners[k]
      this.pos.push(c[0], c[1], c[2])
      this.nor.push(nx, ny, nz)
      this.uv.push(c[3], c[4])
      const color = colors[k]
      this.col.push(color.r, color.g, color.b)
      if (this.atlas) {
        this.chart.push(chart)
        this.cu.push(cu[k * 2], cu[k * 2 + 1])
      }
    }
  }

  /** 方塊的四面牆（y0 到 y1），UV 沿著外圍接起來 */
  walls(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, us: number, vs: number, v0: number, c0: Color, c1: Color = c0) {
    const w = x1 - x0
    const d = z1 - z0
    const h = y1 - y0
    let u = 0
    this.quad(x0, y0, z1, w, 0, 0, 0, h, 0, us, vs, u, v0, c0, c1)
    u += w / us
    this.quad(x1, y0, z1, 0, 0, -d, 0, h, 0, us, vs, u, v0, c0, c1)
    u += d / us
    this.quad(x1, y0, z0, -w, 0, 0, 0, h, 0, us, vs, u, v0, c0, c1)
    u += w / us
    this.quad(x0, y0, z0, 0, 0, d, 0, h, 0, us, vs, u, v0, c0, c1)
  }

  /** 朝上的面 */
  top(x0: number, x1: number, z0: number, z1: number, y: number, s: number, c: Color) {
    this.quad(x0, y, z1, x1 - x0, 0, 0, 0, 0, z0 - z1, s, s, x0 / s, -z1 / s, c)
  }

  /** 朝下的面（橋面底下） */
  bottom(x0: number, x1: number, z0: number, z1: number, y: number, s: number, c: Color) {
    this.quad(x0, y, z0, x1 - x0, 0, 0, 0, 0, z1 - z0, s, s, x0 / s, z0 / s, c)
  }

  /** 整個方塊（四面牆加頂），UV 每 `s` 公尺一格 */
  box(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, s: number, c: Color, cTop: Color = c) {
    this.walls(x0, x1, z0, z1, y0, y1, s, s, y0 / s, c, cTop)
    this.top(x0, x1, z0, z1, y1, s, cTop)
  }

  /** 地圖上的方塊（頂面可以是斜的）：四面牆，`withTop` 時加上頂面 */
  solid(b: Box, s: number, c: Color, cTop: Color = c, withTop = true) {
    const pts: [number, number][] = [
      [b.x0, b.z1],
      [b.x1, b.z1],
      [b.x1, b.z0],
      [b.x0, b.z0],
    ]
    let u = 0
    for (let k = 0; k < 4; k++) {
      const [ax, az] = pts[k]
      const [bx, bz] = pts[(k + 1) % 4]
      const len = Math.hypot(bx - ax, bz - az) / s
      const ta = topAt(b, ax, az)
      const tb = topAt(b, bx, bz)
      this.face([ax, b.y0, az, u, b.y0 / s], [bx, b.y0, bz, u + len, b.y0 / s], [bx, tb, bz, u + len, tb / s], [ax, ta, az, u, ta / s], c, cTop)
      u += len
    }
    if (withTop) this.slopeTop(b, s, cTop)
  }

  /** 方塊的頂面（斜坡是斜的） */
  slopeTop(b: Box, s: number, c: Color) {
    const corner = (x: number, z: number): Corner => [x, topAt(b, x, z), z, x / s, -z / s]
    this.face(corner(b.x0, b.z1), corner(b.x1, b.z1), corner(b.x1, b.z0), corner(b.x0, b.z0), c)
  }

  /**
   * 歪著放的方塊（瓦礫、撞壞的車）：中心 (cx, cy, cz)、三個方向各一半多長，先繞 x 軸轉 `pitch`、繞 z 軸轉 `roll`，再繞 y 軸轉 `yaw`。
   * `c` 是側面、`cTop` 是頂面的顏色；`bottom` 是 false 就不畫底面（貼在地上的看不到）
   */
  obox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number, pitch: number, roll: number, s: number, c: Color, cTop: Color = c, bottom = false) {
    const cyw = Math.cos(yaw)
    const syw = Math.sin(yaw)
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    const cr = Math.cos(roll)
    const sr = Math.sin(roll)
    const at = (x: number, y: number, z: number): [number, number, number] => {
      // 繞 x
      const y1 = y * cp - z * sp
      const z1 = y * sp + z * cp
      // 繞 z
      const x2 = x * cr - y1 * sr
      const y2 = x * sr + y1 * cr
      // 繞 y
      return [cx + x2 * cyw + z1 * syw, cy + y2, cz - x2 * syw + z1 * cyw]
    }
    const v = (x: number, y: number, z: number, u: number, w: number): Corner => {
      const p = at(x * hx, y * hy, z * hz)
      return [p[0], p[1], p[2], u / s, w / s]
    }
    const w2 = hx * 2
    const h2 = hy * 2
    const d2 = hz * 2
    this.face(v(-1, -1, 1, 0, 0), v(1, -1, 1, w2, 0), v(1, 1, 1, w2, h2), v(-1, 1, 1, 0, h2), c, cTop)
    this.face(v(1, -1, 1, w2, 0), v(1, -1, -1, w2 + d2, 0), v(1, 1, -1, w2 + d2, h2), v(1, 1, 1, w2, h2), c, cTop)
    this.face(v(1, -1, -1, 0, 0), v(-1, -1, -1, w2, 0), v(-1, 1, -1, w2, h2), v(1, 1, -1, 0, h2), c, cTop)
    this.face(v(-1, -1, -1, w2, 0), v(-1, -1, 1, w2 + d2, 0), v(-1, 1, 1, w2 + d2, h2), v(-1, 1, -1, w2, h2), c, cTop)
    this.face(v(-1, 1, 1, 0, 0), v(1, 1, 1, w2, 0), v(1, 1, -1, w2, d2), v(-1, 1, -1, 0, d2), cTop)
    if (bottom) this.face(v(-1, -1, -1, 0, 0), v(1, -1, -1, w2, 0), v(1, -1, 1, w2, d2), v(-1, -1, 1, 0, d2), c)
  }

  /** 細長的鋼纜：兩片交叉的長條，從 a 拉到 b */
  cable(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, c: Color) {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.hypot(dx, dy, dz)
    // 一片和地面平行（d × 上）、一片和它垂直
    let px = -dz
    let pz = dx
    const pl = Math.hypot(px, pz) || 1
    px = (px / pl) * w
    pz = (pz / pl) * w
    this.quad(ax - px / 2, ay, az - pz / 2, dx, dy, dz, px, 0, pz, len, 1, 0, 0, c)
    let qx = dy * pz
    let qy = dz * px - dx * pz
    let qz = -dy * px
    const ql = Math.hypot(qx, qy, qz) || 1
    qx = (qx / ql) * w
    qy = (qy / ql) * w
    qz = (qz / ql) * w
    this.quad(ax - qx / 2, ay - qy / 2, az - qz / 2, dx, dy, dz, qx, qy, qz, len, 1, 0, 0, c)
  }

  /** 直立的多邊形柱（水塔、油桶）：`n` 邊，頂上封起來 */
  prism(cx: number, cz: number, r: number, y0: number, y1: number, n: number, c: Color, cTop: Color = c) {
    const at = (k: number): [number, number] => [cx + Math.cos((k / n) * Math.PI * 2) * r, cz + Math.sin((k / n) * Math.PI * 2) * r]
    for (let k = 0; k < n; k++) {
      const [ax, az] = at(k + 1)
      const [bx, bz] = at(k)
      const u = k / n
      this.face([ax, y0, az, u, 0], [bx, y0, bz, u + 1 / n, 0], [bx, y1, bz, u + 1 / n, 1], [ax, y1, az, u, 1], c, cTop)
      this.face([cx, y1, cz, 0.5, 0.5], [ax, y1, az, 0, 0], [bx, y1, bz, 1, 0], [bx, y1, bz, 1, 0], cTop)
    }
  }

  /** 掛在牆上的直式招牌：從牆面上的 (x, z) 往 (nx, nz) 伸出去 `w` 公尺、高 `h`，兩面都貼第 `i` 塊招牌；`lean` 是歪了多少（上面往旁邊偏幾公尺） */
  sign(x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, i: number, lean = 0) {
    const lx = nx * lean
    const lz = nz * lean
    const u0 = i / SIGN_COUNT
    const u1 = (i + 1) / SIGN_COUNT
    const a: Corner = [x, y, z, u0, 0]
    const b: Corner = [x + nx * w, y - lean * 0.6, z + nz * w, u1, 0]
    const c: Corner = [x + nx * w + lx, y + h - lean * 0.6, z + nz * w + lz, u1, 1]
    const d: Corner = [x + lx, y + h, z + lz, u0, 1]
    this.face(a, b, c, d, white)
    this.face([b[0], b[1], b[2], u0, 0], [a[0], a[1], a[2], u1, 0], [d[0], d[1], d[2], u1, 1], [c[0], c[1], c[2], u0, 1], white)
  }

  get empty() {
    return this.pos.length === 0
  }

  /** 這個網格的面有沒有排進遮蔽貼圖（有的話材質要照 `uv1` 取那張圖） */
  get charted() {
    return this.atlas !== null
  }

  /** 做成 BufferGeometry；有排進遮蔽貼圖的要先 `Atlas.pack` 過 */
  geometry(): BufferGeometry {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3))
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3))
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2))
    geo.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3))
    const atlas = this.atlas
    if (atlas) {
      const n = this.chart.length
      const uv1 = new Float32Array(n * 2)
      const { size, density, charts } = atlas
      for (let i = 0; i < n; i++) {
        const k = this.chart[i]
        if (k < 0) {
          // 沒有排進去的面：著色器看到負的座標就當成沒被擋
          uv1[i * 2] = uv1[i * 2 + 1] = -1
          continue
        }
        const c = charts[k]
        const cu = this.cu[i * 2] * density
        const cv = this.cu[i * 2 + 1] * density
        uv1[i * 2] = (c.x + (c.rot ? cv : cu)) / size
        uv1[i * 2 + 1] = (c.y + (c.rot ? cu : cv)) / size
      }
      geo.setAttribute('uv1', new BufferAttribute(uv1, 2))
    }
    geo.computeBoundingSphere()
    return geo
  }
}
