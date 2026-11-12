// 機甲拿來畫的網格。模型檔（mech.ts、sniper.ts…）還是用 `part()` 一塊一塊擺方塊和圓柱，這裡把它們換成真正的幾何：
//   - 每個方塊、圓柱的邊都倒角。倒角上的法線從這一面慢慢轉到隔壁那一面，照起來像圓角，邊上才抓得到高光
//   - 同一個關節底下的零件合成一個網格（一台機甲從七、八十次 draw call 變成十幾次）
//   - 每個頂點除了位置和法線，還帶著材質要用的資料：
//       uv      照公尺算的貼圖座標（細節貼圖不會被零件的大小拉長；直立的面 v 朝上，水漬才會往下流）
//       uv1     遮蔽貼圖的座標：每個面在整張圖上有自己的一格（`packCharts` 排的）
//       aEdge   離這個面四個邊各多遠（公尺）：掉漆、磨亮從邊開始
//       aLayer  哪一層材質、這個零件的亂數、面夠不夠大（小零件不畫面板線）、是不是直立的面
//       aHeight 站好時離地多高：越低灰塵越厚
//       aDecal、aDecalUv 這個面上噴的標誌：在標誌圖上的哪一格、這一點在那一格裡的哪裡（`mechdecal.ts` 決定哪個面噴什麼）
import { BufferAttribute, BufferGeometry, type Matrix4, Vector3 } from 'three'

/** 材質的層：主裝甲的漆、副色的漆、沒上漆的鋼、發黑處理的骨架、鍍鉻的液壓桿 */
export const LAYER = { armor: 0, trim: 1, metal: 2, dark: 3, chrome: 4 } as const

/** 方塊；圓柱（軸是 y）；細桿（天線）；噴嘴（上寬下窄、兩頭開口的厚壁圓錐筒） */
export type Shape = 'box' | 'cyl' | 'rod' | 'nozzle'

export type PartSpec = {
  shape: Shape
  /** 方塊：長寬高。圓柱、細桿：x、z 方向的直徑和 y 方向的長。噴嘴：照原本的單位噴嘴放大的倍數 */
  size: [number, number, number]
  /** 零件座標 → 關節座標（只有轉和移） */
  local: Matrix4
  /** 零件座標 → 站好時的世界座標（哪一邊朝上、離地多高） */
  world: Matrix4
  layer: number
  /** 方塊的六個面（照 `boxFaces` 的順序）各噴什麼標誌；沒有就不噴 */
  decals?: (Decal | null)[]
}

/**
 * 噴在一個面上的標誌：`rect` 是標誌圖上的範圍（貼圖座標，左下到右上）；(cx, cy) 是標誌的中心在面上的位置
 * （公尺，面的中心是原點，u 往右、v 往上）、w 和 h 是標誌多大；`turn` 是轉 90 度（直的面上橫的標誌）
 */
export type Decal = { rect: [number, number, number, number]; cx: number; cy: number; w: number; h: number; turn?: boolean }

/** 方塊的一個面：法線和面上兩個方向（零件座標的單位向量，u × v = n，v 是比較朝上的那個）、三個方向各一半多長 */
export type BoxFace = { n: number[]; u: number[]; v: number[]; hn: number; hu: number; hv: number }

/** 遮蔽貼圖上的一格：一個面攤平後的大小（公尺），排好後在圖上的位置（像素）、有沒有轉 90 度 */
export type Chart = { w: number; h: number; x: number; y: number; rot: boolean }

/** 還沒變成 BufferGeometry 的頂點資料 */
export class Soup {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []
  edge: number[] = []
  lay: number[] = []
  hgt: number[] = []
  /** 每個頂點在哪一格、格子裡的座標（公尺） */
  chart: number[] = []
  cu: number[] = []
  /** 標誌：在圖上的範圍、這一點在標誌裡的位置（0～1 以外是標誌外面） */
  decal: number[] = []
  duv: number[] = []
  idx: number[] = []

  get vertices() {
    return this.pos.length / 3
  }
}

/** 「這個方向沒有邊」 */
const NONE = 1e3

const P = new Vector3()
const N = new Vector3()
const W = new Vector3()
const A = new Vector3()
const B = new Vector3()
const C = new Vector3()

function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const smooth = (lo: number, hi: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/** 一個面（遮蔽貼圖上的一格）正在加頂點時共用的資料 */
type Face = { part: PartSpec; chart: number; rand: number; panel: number; streak: number; layer: number; decal: Decal | null }

class Writer {
  readonly soup: Soup
  readonly charts: Chart[]
  /** 簡化版：不倒角、圓柱切少一點（遠處看不出來） */
  readonly simple: boolean
  /** 簡化版不排新的格子，沿用精細版排好的：下一個面用第幾格 */
  private reuse: number
  /** 頂點再套這個矩陣（簡化版把所有關節合成一個網格，零件要換到整台機甲的座標） */
  private readonly into: Matrix4 | null

  constructor(soup: Soup, charts: Chart[], far: FarBuild | null = null) {
    this.soup = soup
    this.charts = charts
    this.simple = far !== null
    this.reuse = far ? far.firstChart : -1
    this.into = far ? far.into : null
  }

  face(part: PartSpec, w: number, h: number, rand: number, panel: number, streak: number, decal: Decal | null = null): Face {
    if (this.reuse >= 0) return { part, chart: this.reuse++, rand, panel, streak, layer: part.layer, decal }
    this.charts.push({ w, h, x: 0, y: 0, rot: false })
    return { part, chart: this.charts.length - 1, rand, panel, streak, layer: part.layer, decal }
  }

  /** 加一個頂點：位置、法線是零件座標；(u, v) 是貼圖座標（公尺）、(cu, cv) 是這一格裡的座標（公尺）、e 是離四個邊多遠 */
  vert(f: Face, px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number, cu: number, cv: number, e0: number, e1: number, e2: number, e3: number): number {
    const s = this.soup
    const i = s.vertices
    W.set(px, py, pz).applyMatrix4(f.part.world)
    P.set(px, py, pz).applyMatrix4(f.part.local)
    N.set(nx, ny, nz).transformDirection(f.part.local)
    if (this.into) {
      P.applyMatrix4(this.into)
      N.transformDirection(this.into)
    }
    s.pos.push(P.x, P.y, P.z)
    s.nor.push(N.x, N.y, N.z)
    s.uv.push(u, v)
    s.edge.push(e0, e1, e2, e3)
    s.lay.push(f.layer, f.rand, f.panel, f.streak)
    s.hgt.push(W.y)
    s.chart.push(f.chart)
    s.cu.push(cu, cv)
    const d = f.decal
    if (d) {
      // (cu, cv) 的原點在這一格的左下角；換成以面的中心為原點，再換成標誌裡的位置
      const c = this.charts[f.chart]
      const fu = cu - c.w / 2 - d.cx
      const fv = cv - c.h / 2 - d.cy
      s.decal.push(d.rect[0], d.rect[1], d.rect[2], d.rect[3])
      if (d.turn) s.duv.push(fv / d.w + 0.5, 0.5 - fu / d.h)
      else s.duv.push(fu / d.w + 0.5, fv / d.h + 0.5)
    } else {
      s.decal.push(0, 0, 0, 0)
      s.duv.push(-1, -1)
    }
    return i
  }

  /** 三角形：照頂點的法線決定哪一面朝外 */
  tri(a: number, b: number, c: number) {
    const { pos, nor, idx } = this.soup
    A.set(pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2])
    B.set(pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2])
    C.set(nor[a * 3] + nor[b * 3] + nor[c * 3], nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1], nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2])
    if (A.cross(B).dot(C) >= 0) idx.push(a, b, c)
    else idx.push(a, c, b)
  }

  quad(a: number, b: number, c: number, d: number) {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }
}

/** 倒角多寬：大的裝甲板 3 公分多，薄的、小的照最短那一邊縮 */
function bevelOf(min: number, max = 0.032): number {
  return Math.max(0.003, Math.min(max, min * 0.18))
}

/** 方塊的六個面（固定的順序：+x、-x、+y、-y、+z、-z）。面上比較朝上的方向（照站好時的世界座標）當 v，貼圖、標誌才是正的 */
export function boxFaces(part: PartSpec): BoxFace[] {
  const half = [part.size[0] / 2, part.size[1] / 2, part.size[2] / 2]
  const m = part.world.elements
  const out: BoxFace[] = []
  for (let a = 0; a < 3; a++) {
    for (const s of [1, -1]) {
      const b = (a + 1) % 3
      const d = (a + 2) % 3
      const upB = m[b * 4 + 1]
      const upD = m[d * 4 + 1]
      const vAxis = Math.abs(upB) >= Math.abs(upD) ? b : d
      const vSign = (vAxis === b ? upB : upD) >= 0 ? 1 : -1
      const uAxis = vAxis === b ? d : b
      const n = [0, 0, 0]
      n[a] = s
      const v = [0, 0, 0]
      v[vAxis] = vSign
      // u = v × n，這樣 u × v = n（從外面看是逆時針）
      const u = [v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]]
      out.push({ n, u, v, hn: half[a], hu: half[uAxis], hv: half[vAxis] })
    }
  }
  return out
}

/** 方塊：六個面各自一格；每一格是裡面的平面加上外面一圈倒角（到倒角的中線為止，另一半屬於隔壁的面） */
function box(w: Writer, part: PartSpec, seed: number) {
  const c = bevelOf(Math.min(...part.size))
  const rand = hash(seed)
  const m = part.world.elements
  boxFaces(part).forEach(({ n, u, v, hn, hu, hv }, faceNo) => {
    {
      const iu = hu - c
      const iv = hv - c
      const up = Math.abs(n[0] * m[1] + n[1] * m[5] + n[2] * m[9])
      const face = w.face(part, hu * 2, hv * 2, rand, smooth(0.3, 0.75, Math.min(hu, hv) * 2), 1 - up, part.decals?.[faceNo] ?? null)
      const ou = hash(seed * 7 + faceNo) * 9
      const ov = hash(seed * 13 + faceNo) * 9
      const put = (pn: number, pu: number, pv: number, nn: number, nu: number, nv: number, fu: number, fv: number, e: number[]) =>
        w.vert(
          face,
          n[0] * pn + u[0] * pu + v[0] * pv,
          n[1] * pn + u[1] * pu + v[1] * pv,
          n[2] * pn + u[2] * pu + v[2] * pv,
          n[0] * nn + u[0] * nu + v[0] * nv,
          n[1] * nn + u[1] * nu + v[1] * nv,
          n[2] * nn + u[2] * nu + v[2] * nv,
          fu + ou,
          fv + ov,
          fu + hu,
          fv + hv,
          e[0],
          e[1],
          e[2],
          e[3],
        )
      if (w.simple) {
        // 簡化版：一個面就是四個角
        const flat = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([su, sv]) => put(hn, su * hu, sv * hv, 1, 0, 0, su * hu, sv * hv, [su > 0 ? hu * 2 : 0, sv > 0 ? hv * 2 : 0, su > 0 ? 0 : hu * 2, sv > 0 ? 0 : hv * 2]))
        w.quad(flat[0], flat[1], flat[2], flat[3])
        return
      }
      const inner: number[] = []
      const midU: number[] = []
      const midV: number[] = []
      const corner: number[] = []
      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const e = [su > 0 ? iu * 2 : 0, sv > 0 ? iv * 2 : 0, su > 0 ? 0 : iu * 2, sv > 0 ? 0 : iv * 2]
        inner.push(put(hn, su * iu, sv * iv, 1, 0, 0, su * iu, sv * iv, e))
        midU.push(put(hn - c / 2, su * (iu + c / 2), sv * iv, 1, su, 0, su * (iu + c * 0.7), sv * iv, e))
        midV.push(put(hn - c / 2, su * iu, sv * (iv + c / 2), 1, 0, sv, su * iu, sv * (iv + c * 0.7), e))
        corner.push(put(hn - (c * 2) / 3, su * (iu + c / 3), sv * (iv + c / 3), 1, su, sv, su * (iu + c * 0.5), sv * (iv + c * 0.5), e))
      }
      w.quad(inner[0], inner[1], inner[2], inner[3])
      w.quad(midV[0], midV[1], inner[1], inner[0])
      w.quad(midU[1], midU[2], inner[2], inner[1])
      w.quad(midV[2], midV[3], inner[3], inner[2])
      w.quad(midU[3], midU[0], inner[0], inner[3])
      for (let k = 0; k < 4; k++) {
        w.tri(inner[k], midU[k], corner[k])
        w.tri(inner[k], corner[k], midV[k])
      }
    }
  })
}

/** 圓柱一圈切幾段：照粗細，8～24 */
function segments(r: number): number {
  return Math.max(8, Math.min(24, Math.round((Math.PI * 2 * r) / 0.085 / 2) * 2))
}

/** 圓柱（軸是 y，可以是橢圓）：側面一格（攤開）、上下蓋各一格；兩頭的邊倒角 */
function cylinder(w: Writer, part: PartSpec, seed: number, maxBevel = 0.028) {
  const rx = part.size[0] / 2
  const rz = part.size[2] / 2
  const len = part.size[1]
  const r = Math.min(rx, rz)
  // 簡化版不倒角、切少一點
  const c = w.simple ? 0 : bevelOf(Math.min(r, len / 2) * 2, maxBevel)
  const n = w.simple ? Math.min(10, segments(Math.max(rx, rz))) : segments(Math.max(rx, rz))
  const around = Math.PI * (rx + rz)
  const rand = hash(seed)
  const axisUp = Math.abs(part.world.elements[5])
  const ou = hash(seed * 7) * 9
  const ov = hash(seed * 13) * 9
  const cos: number[] = []
  const sin: number[] = []
  /** 橢圓上往外的方向 */
  const nrx: number[] = []
  const nrz: number[] = []
  for (let j = 0; j <= n; j++) {
    const t = (j / n) * Math.PI * 2
    cos.push(Math.cos(t))
    sin.push(Math.sin(t))
    const l = Math.hypot(cos[j] / rx, sin[j] / rz)
    nrx.push(cos[j] / rx / l)
    nrz.push(sin[j] / rz / l)
  }

  // 側面：四圈（下面倒角的中線、下緣、上緣、上面倒角的中線）；簡化版只有上下兩圈
  const side = w.face(part, around, len, rand, smooth(0.3, 0.75, Math.min(around / 2, len)), axisUp)
  const tall = len - c * 2
  const rows = [
    { y: -len / 2 + c / 2, shrink: c / 2, ny: -1, cv: c * 0.3, t: 0 },
    { y: -len / 2 + c, shrink: 0, ny: 0, cv: c, t: 0 },
    { y: len / 2 - c, shrink: 0, ny: 0, cv: len - c, t: tall },
    { y: len / 2 - c / 2, shrink: c / 2, ny: 1, cv: len - c * 0.3, t: tall },
  ].slice(w.simple ? 1 : 0, w.simple ? 3 : 4)
  const ring: number[][] = []
  for (const row of rows) {
    const list: number[] = []
    for (let j = 0; j <= n; j++) {
      const a = (j / n) * around
      list.push(
        w.vert(side, cos[j] * (rx - row.shrink), row.y, sin[j] * (rz - row.shrink), nrx[j], row.ny, nrz[j], a + ou, row.y + ov, a, row.cv, NONE, row.t, NONE, tall - row.t),
      )
    }
    ring.push(list)
  }
  for (let k = 0; k + 1 < ring.length; k++) for (let j = 0; j < n; j++) w.quad(ring[k][j], ring[k][j + 1], ring[k + 1][j + 1], ring[k + 1][j])

  // 上下蓋：中心、裡面一圈、倒角的中線（簡化版沒有倒角那一圈）
  for (const s of [1, -1]) {
    const cap = w.face(part, rx * 2, rz * 2, rand, smooth(0.3, 0.75, r * 2), 1 - axisUp)
    const cu = hash(seed * 17 + s) * 9
    const cv = hash(seed * 19 + s) * 9
    const mid = w.vert(cap, 0, (s * len) / 2, 0, 0, s, 0, cu, cv, rx, rz, r - c, NONE, NONE, NONE)
    const inner: number[] = []
    const outer: number[] = []
    for (let j = 0; j <= n; j++) {
      const x = cos[j] * (rx - c)
      const z = sin[j] * (rz - c)
      inner.push(w.vert(cap, x, (s * len) / 2, z, 0, s, 0, x + cu, z + cv, x + rx, z + rz, 0, NONE, NONE, NONE))
      if (w.simple) continue
      const fx = cos[j] * (rx - c * 0.3)
      const fz = sin[j] * (rz - c * 0.3)
      outer.push(w.vert(cap, cos[j] * (rx - c / 2), s * (len / 2 - c / 2), sin[j] * (rz - c / 2), nrx[j], s, nrz[j], fx + cu, fz + cv, fx + rx, fz + rz, 0, NONE, NONE, NONE))
    }
    for (let j = 0; j < n; j++) {
      w.tri(mid, inner[j], inner[j + 1])
      if (!w.simple) w.quad(inner[j], outer[j], outer[j + 1], inner[j + 1])
    }
  }
}

/** 噴嘴：上寬下窄的厚壁圓錐筒（原本的單位噴嘴上半徑 0.42、下半徑 0.3、高 1），外面、裡面、上下兩圈唇各一格 */
function nozzle(w: Writer, part: PartSpec, seed: number) {
  const k = (part.size[0] + part.size[2]) / 2
  const top = 0.42 * k
  const bottom = 0.3 * k
  const len = part.size[1]
  const wall = Math.min(0.07, bottom * 0.3)
  const n = w.simple ? 10 : 20
  const rand = hash(seed)
  const slant = Math.hypot(len, top - bottom)
  const around = Math.PI * (top + bottom)
  const slope = (top - bottom) / len
  const ou = hash(seed * 7) * 9
  const ov = hash(seed * 13) * 9
  const axisUp = Math.abs(part.world.elements[5])
  const outside = w.face(part, around, slant, rand, 0, axisUp)
  const inside = w.face(part, around, slant, rand, 0, axisUp)
  const lipTop = w.face(part, top * 2, top * 2, rand, 0, 1 - axisUp)
  const lipBottom = w.face(part, bottom * 2, bottom * 2, rand, 0, 1 - axisUp)
  const rows: number[][] = [[], [], [], [], [], [], [], []]
  for (let j = 0; j <= n; j++) {
    const t = (j / n) * Math.PI * 2
    const cs = Math.cos(t)
    const sn = Math.sin(t)
    const a = (j / n) * around
    // 外面：下、上
    rows[0].push(w.vert(outside, cs * bottom, -len / 2, sn * bottom, cs, -slope, sn, a + ou, ov, a, 0, NONE, 0, NONE, slant))
    rows[1].push(w.vert(outside, cs * top, len / 2, sn * top, cs, -slope, sn, a + ou, slant + ov, a, slant, NONE, slant, NONE, 0))
    // 裡面：法線朝軸心
    rows[2].push(w.vert(inside, cs * (bottom - wall), -len / 2, sn * (bottom - wall), -cs, slope, -sn, a + ou + 3, ov, a, 0, NONE, 0, NONE, slant))
    rows[3].push(w.vert(inside, cs * (top - wall), len / 2, sn * (top - wall), -cs, slope, -sn, a + ou + 3, slant + ov, a, slant, NONE, slant, NONE, 0))
    // 上下的唇
    rows[4].push(w.vert(lipTop, cs * top, len / 2, sn * top, 0, 1, 0, cs * top + ou, sn * top + ov, cs * top + top, sn * top + top, 0, NONE, NONE, NONE))
    rows[5].push(w.vert(lipTop, cs * (top - wall), len / 2, sn * (top - wall), 0, 1, 0, cs * (top - wall) + ou, sn * (top - wall) + ov, cs * (top - wall) + top, sn * (top - wall) + top, 0, NONE, NONE, NONE))
    rows[6].push(w.vert(lipBottom, cs * bottom, -len / 2, sn * bottom, 0, -1, 0, cs * bottom + ou, sn * bottom + ov, cs * bottom + bottom, sn * bottom + bottom, 0, NONE, NONE, NONE))
    rows[7].push(
      w.vert(lipBottom, cs * (bottom - wall), -len / 2, sn * (bottom - wall), 0, -1, 0, cs * (bottom - wall) + ou, sn * (bottom - wall) + ov, cs * (bottom - wall) + bottom, sn * (bottom - wall) + bottom, 0, NONE, NONE, NONE),
    )
  }
  for (let j = 0; j < n; j++) {
    for (const r of [0, 2, 4, 6]) w.quad(rows[r][j], rows[r][j + 1], rows[r + 1][j + 1], rows[r + 1][j])
  }
}

/**
 * 做遠處用的簡化版：頂點寫進 `soup`（所有關節合成一個網格）、套上 `into`（關節座標 → 整台機甲的座標），
 * 遮蔽貼圖的格子沿用精細版排好的（從 `firstChart` 開始，順序一樣）
 */
export type FarBuild = { soup: Soup; firstChart: number; into: Matrix4 }

/**
 * 把一個關節底下的零件做成頂點資料；`charts` 是這一種機甲所有關節共用的（排在同一張遮蔽貼圖上）。
 * `seed` 決定每個零件的亂數（同一種機甲每次都一樣）。`far` 有給就是做簡化版
 */
export function buildParts(parts: PartSpec[], charts: Chart[], seed: number, far: FarBuild | null = null): Soup {
  const soup = far ? far.soup : new Soup()
  const w = new Writer(soup, charts, far)
  parts.forEach((part, i) => {
    const s = seed * 131 + i + 1
    if (part.shape === 'box') box(w, part, s)
    else if (part.shape === 'nozzle') nozzle(w, part, s)
    else cylinder(w, part, s, part.shape === 'rod' ? 0.012 : 0.028)
  })
  return soup
}

/** 每一格四周留幾個像素（貼圖縮小時才不會吃到隔壁） */
const PAD = 2

/**
 * 把所有的格子排進 `size` × `size` 的圖裡（一排一排由高到矮），回傳一公尺幾個像素（找排得下的最大值）。
 * 直的格子轉 90 度躺著排，比較不浪費
 */
export function packCharts(charts: Chart[], size: number): number {
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
  let lo = 0.5
  let hi = 600
  for (let k = 0; k < 22; k++) {
    const mid = (lo + hi) / 2
    if (place(mid)) lo = mid
    else hi = mid
  }
  place(lo)
  return lo
}

/** 頂點資料 → BufferGeometry；`density` 是 `packCharts` 回傳的一公尺幾個像素 */
export function toGeometry(soup: Soup, charts: Chart[], size: number, density: number): BufferGeometry {
  const n = soup.vertices
  const uv1 = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const c = charts[soup.chart[i]]
    const cu = soup.cu[i * 2] * density
    const cv = soup.cu[i * 2 + 1] * density
    uv1[i * 2] = (c.x + (c.rot ? cv : cu)) / size
    uv1[i * 2 + 1] = (c.y + (c.rot ? cu : cv)) / size
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(soup.pos), 3))
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(soup.nor), 3))
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(soup.uv), 2))
  geo.setAttribute('uv1', new BufferAttribute(uv1, 2))
  geo.setAttribute('aEdge', new BufferAttribute(new Float32Array(soup.edge), 4))
  geo.setAttribute('aLayer', new BufferAttribute(new Float32Array(soup.lay), 4))
  geo.setAttribute('aHeight', new BufferAttribute(new Float32Array(soup.hgt), 1))
  geo.setAttribute('aDecal', new BufferAttribute(new Float32Array(soup.decal), 4))
  geo.setAttribute('aDecalUv', new BufferAttribute(new Float32Array(soup.duv), 2))
  geo.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(soup.idx) : new Uint16Array(soup.idx), 1))
  geo.computeBoundingSphere()
  geo.computeBoundingBox()
  return geo
}
