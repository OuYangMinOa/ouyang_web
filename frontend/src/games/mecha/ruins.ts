// 打了很久的仗之後的樣子（都只是畫面，不擋東西：碰撞、打中只看 map.ts 的方塊）：
//   - 大樓的頂被炸掉：屋頂以上留著高高低低的殘牆（接著底下那一面牆的窗戶往上畫）、斷掉的樓板、露出鋼筋的柱子
//   - 瓦礫堆：歪七扭八的水泥塊、磚塊
//   - 車、公車：燒得只剩殼，或是丟在路邊積了一層灰，玻璃都破了
//   - 枯樹：只剩樹幹和樹枝
import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three'
import type { Box } from './map'
import type { Corner, Mesher } from './worldgeo'

type Rand = () => number

/** 殘牆多厚 */
const WALL_T = 0.45
/** 一段殘牆多寬（外牆貼圖的一個開間） */
const BAY = 3

export type RuinTop = {
  /** 外牆那個網格（殘牆的外面接著貼同一張外牆貼圖）、牆的內側和斷面、露出來的鋼筋 */
  wall: Mesher
  core: Mesher
  rebar: Mesher
  x0: number
  x1: number
  z0: number
  z1: number
  /** 屋頂的高度 */
  y: number
  /** 外牆貼圖一格多寬、多高（公尺），屋頂那裡的 v 座標 */
  us: number
  vs: number
  v0: number
  tint: Color
  rand: Rand
  /** 最高留幾公尺 */
  max: number
}

/** 被炸掉的樓頂：沿著屋頂的四邊留一圈高高低低的殘牆，裡面幾片斷掉的樓板、幾根柱子 */
export function ruinTop(o: RuinTop) {
  const { wall, core, rebar, y, us, vs, v0, tint, rand, max } = o
  const inner = tint.clone().multiplyScalar(0.62)
  const cut = tint.clone().multiplyScalar(0.78)
  const steel = new Color(0x2a2522)
  const edges: [number, number, number, number, number, number][] = [
    [o.x0, o.z1, o.x1, o.z1, 0, 1],
    [o.x1, o.z1, o.x1, o.z0, 1, 0],
    [o.x1, o.z0, o.x0, o.z0, 0, -1],
    [o.x0, o.z0, o.x0, o.z1, -1, 0],
  ]
  const pick = () => (rand() < 0.3 ? 0 : max * (0.15 + 0.85 * rand() * rand()))
  let u = 0
  let prev = rand() < 0.75 ? max * (0.45 + 0.55 * rand()) : 0
  for (const [ax, az, bx, bz, nx, nz] of edges) {
    const len = Math.hypot(bx - ax, bz - az)
    const n = Math.max(1, Math.round(len / BAY))
    const seg = len / n
    const dx = (bx - ax) / len
    const dz = (bz - az) / len
    // 上一段的右邊多高（一開始當成沒有：轉角兩邊的牆各自收頭）
    let last = 0
    let lastB: [number, number] | null = null
    for (let i = 0; i < n; i++) {
      // 大多接著上一段的高度（斷口是一階一階的），偶爾整個斷開；這一段的頂稍微斜一點
      let hl = rand() < 0.42 ? pick() : prev
      let hr = Math.max(0, Math.min(max, hl + (rand() - 0.5) * (rand() < 0.2 ? 4 : 1.2)))
      // 轉角通常留得比較高
      if (i === 0 && rand() < 0.6) hl = Math.max(hl, max * (0.4 + 0.6 * rand()))
      if (i === n - 1 && rand() < 0.6) hr = Math.max(hr, max * (0.4 + 0.6 * rand()))
      prev = hr
      const x0 = ax + dx * seg * i
      const z0 = az + dz * seg * i
      const x1 = ax + dx * seg * (i + 1)
      const z1 = az + dz * seg * (i + 1)
      const ix0 = x0 - nx * WALL_T
      const iz0 = z0 - nz * WALL_T
      const ix1 = x1 - nx * WALL_T
      const iz1 = z1 - nz * WALL_T
      const empty = hl < 0.35 && hr < 0.35
      // 上一段比這一段高：補上一段右邊的斷面
      if (lastB && last > (empty ? 0 : hl) + 0.25) {
        const [px, pz] = lastB
        core.face([px, y, pz, 0, 0], [px - nx * WALL_T, y, pz - nz * WALL_T, 0.12, 0], [px - nx * WALL_T, y + last, pz - nz * WALL_T, 0.12, last / 4], [px, y + last, pz, 0, last / 4], cut)
      }
      if (empty) {
        last = 0
        lastB = null
        u += seg
        continue
      }
      const ua = u / us
      const ub = (u + seg) / us
      // 外面：接著底下那面牆的窗戶
      wall.face([x0, y, z0, ua, v0], [x1, y, z1, ub, v0], [x1, y + hr, z1, ub, v0 + hr / vs], [x0, y + hl, z0, ua, v0 + hl / vs], tint)
      // 裡面、頂上的斷面
      core.face([ix1, y, iz1, 0, 0], [ix0, y, iz0, seg / 4, 0], [ix0, y + hl, iz0, seg / 4, hl / 4], [ix1, y + hr, iz1, 0, hr / 4], inner)
      core.face([x0, y + hl, z0, 0, 0], [x1, y + hr, z1, seg / 4, 0], [ix1, y + hr, iz1, seg / 4, 0.12], [ix0, y + hl, iz0, 0, 0.12], cut)
      // 這一段比上一段高：補左邊的斷面
      if (hl > last + 0.25) core.face([ix0, y, iz0, 0, 0], [x0, y, z0, 0.12, 0], [x0, y + hl, z0, 0.12, hl / 4], [ix0, y + hl, iz0, 0, hl / 4], cut)
      // 牆頂露出來的鋼筋
      if (Math.max(hl, hr) > 1.5 && rand() < 0.5) {
        const t = hl > hr ? 0.15 : 0.85
        const h = hl + (hr - hl) * t
        const rx = x0 + (x1 - x0) * t - nx * WALL_T * 0.5
        const rz = z0 + (z1 - z0) * t - nz * WALL_T * 0.5
        for (let k = 0; k < 3; k++) {
          const ox = (rand() - 0.5) * 0.5
          const oz = (rand() - 0.5) * 0.3
          rebar.box(rx + ox - 0.025, rx + ox + 0.025, rz + oz - 0.025, rz + oz + 0.025, y + h - 0.2, y + h + 0.35 + rand() * 0.9, 1, steel)
        }
      }
      // 還連在牆上的一截樓板
      if (Math.min(hl, hr) > 3.7 && rand() < 0.55) {
        const deep = 1.2 + rand() * 3.2
        const sx0 = Math.min(x0, x1, x0 - nx * deep, x1 - nx * deep)
        const sx1 = Math.max(x0, x1, x0 - nx * deep, x1 - nx * deep)
        const sz0 = Math.min(z0, z1, z0 - nz * deep, z1 - nz * deep)
        const sz1 = Math.max(z0, z1, z0 - nz * deep, z1 - nz * deep)
        core.box(sx0, sx1, sz0, sz1, y + 3.0, y + 3.3, 4, inner, cut)
        core.bottom(sx0, sx1, sz0, sz1, y + 3.0, 4, inner)
      }
      last = hr
      lastB = [x1, z1]
      u += seg
    }
    if (lastB && last > 0.35) {
      const [px, pz] = lastB
      core.face([px, y, pz, 0, 0], [px - nx * WALL_T, y, pz - nz * WALL_T, 0.12, 0], [px - nx * WALL_T, y + last, pz - nz * WALL_T, 0.12, last / 4], [px, y + last, pz, 0, last / 4], cut)
    }
  }
  // 裡面還立著的幾根柱子，頂上露出鋼筋
  const w = o.x1 - o.x0
  const d = o.z1 - o.z0
  const columns = Math.min(6, Math.floor((w * d) / 170))
  for (let k = 0; k < columns; k++) {
    const px = o.x0 + 3 + rand() * (w - 6)
    const pz = o.z0 + 3 + rand() * (d - 6)
    const h = 1 + rand() * rand() * (max - 1)
    core.box(px - 0.3, px + 0.3, pz - 0.3, pz + 0.3, y, y + h, 4, inner, cut)
    for (let j = 0; j < 4; j++) {
      const ox = (j % 2 ? 0.18 : -0.18) + (rand() - 0.5) * 0.08
      const oz = (j < 2 ? 0.18 : -0.18) + (rand() - 0.5) * 0.08
      rebar.box(px + ox - 0.025, px + ox + 0.025, pz + oz - 0.025, pz + oz + 0.025, y + h, y + h + 0.3 + rand() * 0.9, 1, steel)
    }
  }
}

/**
 * 一堆瓦礫：歪七扭八的板塊和小碎塊，散在 (x, z) 四周 `radius` 公尺內，底在高度 y。
 * `big` 是塊頭的倍率；`tall` 是最高堆到多高（地上那些不擋東西的要矮，機甲才不會穿過去）
 */
export function rubble(m: Mesher, x: number, z: number, y: number, radius: number, count: number, rand: Rand, color: Color, big = 1, tall = 0.6) {
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2
    const d = radius * Math.sqrt(rand())
    const slab = rand() < 0.45
    const hx = (slab ? 0.35 + rand() * 0.8 : 0.1 + rand() * 0.24) * big
    const hz = slab ? hx * (0.5 + rand() * 0.6) : hx * (0.7 + rand() * 0.6)
    const hy = slab ? (0.06 + rand() * 0.09) * big : hx * (0.6 + rand() * 0.5)
    let pitch = (rand() - 0.5) * (slab ? 0.8 : 1.5)
    let roll = (rand() - 0.5) * (slab ? 0.8 : 1.5)
    // 斜到超過高度的上限就放平一點
    const rise = () => hy + hx * Math.abs(Math.sin(roll)) + hz * Math.abs(Math.sin(pitch))
    while (rise() * 1.5 > tall && (Math.abs(pitch) > 0.05 || Math.abs(roll) > 0.05)) {
      pitch *= 0.6
      roll *= 0.6
    }
    const c = color.clone().multiplyScalar(0.62 + rand() * 0.5)
    m.obox(x + Math.cos(a) * d, y + rise() * 0.55, z + Math.sin(a) * d, hx, hy, hz, rand() * Math.PI, pitch, roll, 2, c, c.clone().multiplyScalar(1.12))
  }
}

/** 塌在河裡的一大塊（地圖上擋得住東西的那幾個方塊）：一塊斜的大板子，四周散著小塊，都在方塊的範圍裡 */
export function collapsed(m: Mesher, b: Box, rand: Rand, color: Color) {
  const w = b.x1 - b.x0
  const d = b.z1 - b.z0
  const h = b.y1 - b.y0
  const cx = (b.x0 + b.x1) / 2
  const cz = (b.z0 + b.z1) / 2
  const lean = 0.06 + rand() * 0.08
  m.obox(cx, b.y0 + h * 0.5, cz, w * 0.47, h * 0.46, d * 0.47, 0, (rand() < 0.5 ? -1 : 1) * lean, (rand() < 0.5 ? -1 : 1) * lean, 3, color.clone().multiplyScalar(0.8), color)
  rubble(m, cx, cz, b.y0, Math.min(w, d) * 0.5, 9, rand, color, 1.3, h * 0.9)
}

const CAR_PAINT = [0xcfcfc9, 0x2b2b2e, 0x8f2a22, 0x2f4f8a, 0x8a9096, 0x5f666e, 0x1f5f58, 0xb9ab88]

/**
 * 路邊的車、公車變成殘骸，照原本那個方塊的大小畫（`long` 是車身沿著 x 還是 z）：
 * 一半燒得焦黑、輪胎都沒了，整台坐在地上；另一半只是丟在那裡，褪色、積灰、輪胎沒氣。玻璃都破了，看進去是黑的。
 * `body` 是車殼（會生鏽的那個材質）、`dark` 是輪胎、窗戶的洞、底盤。回傳是不是燒過的
 */
export function wreck(body: Mesher, dark: Mesher, b: Box, rand: Rand, bus: boolean): boolean {
  const long = b.x1 - b.x0 > b.z1 - b.z0
  const len = long ? b.x1 - b.x0 : b.z1 - b.z0
  const wid = long ? b.z1 - b.z0 : b.x1 - b.x0
  const top = b.y1 - b.y0
  const cx = (b.x0 + b.x1) / 2
  const cz = (b.z0 + b.z1) / 2
  const burnt = rand() < 0.55
  const flip = rand() < 0.5 ? 1 : -1
  // 一邊的輪胎沒了，車身歪一點
  const roll = (rand() - 0.5) * (burnt ? 0.09 : 0.05)
  const pitch = (rand() - 0.5) * 0.04
  const sink = burnt ? 0.2 : 0.06
  const paint = new Color(bus ? (rand() < 0.5 ? 0x2f6a45 : 0xb5651d) : CAR_PAINT[Math.floor(rand() * CAR_PAINT.length)])
  const shell = burnt ? new Color().setHSL(0.05 + rand() * 0.03, 0.25 + rand() * 0.2, 0.07 + rand() * 0.06) : paint.clone().lerp(new Color(0x6f6a62), 0.35)
  const roofC = shell.clone().multiplyScalar(burnt ? 0.8 : 1.1)
  const hole = new Color(0x050505)
  const tyre = new Color(burnt ? 0x0c0b0a : 0x141516)
  /** 車子自己的座標（l 沿著車身、s 橫的、h 往上）換成世界座標，順便歪一下 */
  const at = (l: number, h: number, s: number): [number, number, number] => {
    const y = h - sink + s * Math.sin(roll) + l * Math.sin(pitch)
    return long ? [cx + l * flip, b.y0 + y, cz + s] : [cx + s, b.y0 + y, cz + l * flip]
  }
  const v = (l: number, h: number, s: number, tu: number, tv: number): Corner => {
    const p = at(l, h, s)
    return [p[0], p[1], p[2], tu / 4, tv / 4]
  }
  /** 四個角照從外面看逆時針的順序；`long` 是 false 時座標對調過（鏡像了），頂點的順序要反過來 */
  const quad = (m: Mesher, p: [number, number, number][], c: Color, c2: Color = c) => {
    const k = (i: number): Corner => v(p[i][0], p[i][1], p[i][2], p[i][0] + p[i][2], p[i][1])
    const mirrored = (long ? 1 : -1) * flip < 0
    if (mirrored) m.face(k(1), k(0), k(3), k(2), c, c2)
    else m.face(k(0), k(1), k(2), k(3), c, c2)
  }
  const hl = len / 2
  const hw = wid / 2
  const y0 = bus ? 0.4 : 0.3
  const y1 = bus ? 1.45 : 0.95
  const yt = top
  // 車身下半：四面加上面
  quad(body, [[-hl, y0, hw], [hl, y0, hw], [hl, y1, hw], [-hl, y1, hw]], shell.clone().multiplyScalar(0.8), shell)
  quad(body, [[hl, y0, -hw], [-hl, y0, -hw], [-hl, y1, -hw], [hl, y1, -hw]], shell.clone().multiplyScalar(0.8), shell)
  quad(body, [[hl, y0, hw], [hl, y0, -hw], [hl, y1, -hw], [hl, y1, hw]], shell.clone().multiplyScalar(0.8), shell)
  quad(body, [[-hl, y0, -hw], [-hl, y0, hw], [-hl, y1, hw], [-hl, y1, -hw]], shell.clone().multiplyScalar(0.8), shell)
  quad(body, [[-hl, y1, hw], [hl, y1, hw], [hl, y1, -hw], [-hl, y1, -hw]], shell)
  // 車廂：往上收窄，前後擋風玻璃是斜的；窗戶是黑的洞
  const f0 = bus ? hl - 0.1 : hl * 0.42
  const r0 = bus ? -hl + 0.1 : -hl * 0.62
  const f1 = bus ? hl - 0.25 : hl * 0.18
  const r1 = bus ? -hl + 0.2 : -hl * 0.45
  const w0 = hw - 0.06
  const w1 = hw - (bus ? 0.1 : 0.22)
  const pillar = bus ? 0.25 : 0.1
  const sides: [number, number, number][][] = [
    [[r0, y1, w0], [f0, y1, w0], [f1, yt, w1], [r1, yt, w1]],
    [[f0, y1, -w0], [r0, y1, -w0], [r1, yt, -w1], [f1, yt, -w1]],
    [[f0, y1, w0], [f0, y1, -w0], [f1, yt, -w1], [f1, yt, w1]],
    [[r0, y1, -w0], [r0, y1, w0], [r1, yt, w1], [r1, yt, -w1]],
  ]
  for (const s of sides) {
    quad(body, s, shell, roofC)
    // 窗戶的洞：往裡縮一圈、往外浮一點點
    const cxs = (s[0][0] + s[1][0] + s[2][0] + s[3][0]) / 4
    const cys = (s[0][1] + s[1][1] + s[2][1] + s[3][1]) / 4
    const czs = (s[0][2] + s[1][2] + s[2][2] + s[3][2]) / 4
    const out = 0.015
    const ox = Math.abs(s[0][0] - s[1][0]) < 0.01 ? Math.sign(cxs) * out : 0
    const oz = ox === 0 ? Math.sign(czs) * out : 0
    const inset = (p: [number, number, number]): [number, number, number] => {
      const k = 1 - pillar / Math.max(0.3, Math.hypot(p[0] - cxs, p[2] - czs))
      return [cxs + (p[0] - cxs) * k + ox, cys + (p[1] - cys) * 0.72, czs + (p[2] - czs) * k + oz]
    }
    quad(dark, s.map(inset), hole)
  }
  quad(body, [[r1, yt, w1], [f1, yt, w1], [f1, yt, -w1], [r1, yt, -w1]], roofC)
  // 輪子：燒過的只剩輪圈，矮一截
  const wr = bus ? 0.48 : 0.34
  const wh = burnt ? wr * 1.1 : wr * 1.7
  for (const fl of bus ? [-0.33, 0.33] : [-0.3, 0.3]) {
    for (const side of [-1, 1]) {
      const l = fl * len
      const s0 = side * (hw - 0.24)
      const s1 = side * (hw + 0.02)
      const a = Math.min(s0, s1)
      const c = Math.max(s0, s1)
      quad(dark, [[l - wr, 0, c], [l + wr, 0, c], [l + wr, wh, c], [l - wr, wh, c]], tyre)
      quad(dark, [[l + wr, 0, a], [l - wr, 0, a], [l - wr, wh, a], [l + wr, wh, a]], tyre)
      quad(dark, [[l + wr, 0, c], [l + wr, 0, a], [l + wr, wh, a], [l + wr, wh, c]], tyre)
      quad(dark, [[l - wr, 0, a], [l - wr, 0, c], [l - wr, wh, c], [l - wr, wh, a]], tyre)
    }
  }
  // 底盤（車身底下看得到的那一片黑）
  quad(dark, [[-hl + 0.2, y0, hw - 0.1], [-hl + 0.2, y0, -hw + 0.1], [hl - 0.2, y0, -hw + 0.1], [hl - 0.2, y0, hw - 0.1]], hole)
  return burnt
}

const P = new Vector3()
const Q = new Vector3()
const U = new Vector3()
const V = new Vector3()
const T = new Vector3()

/** 沿著一串點的管子（樹幹、樹枝）：每個點一圈 `sides` 邊，半徑照 `radii`，尾端收成一個尖 */
function limb(pos: number[], nor: number[], idx: number[], pts: Vector3[], radii: number[], sides: number) {
  const base = pos.length / 3
  for (let i = 0; i < pts.length; i++) {
    T.copy(pts[Math.min(i + 1, pts.length - 1)]).sub(pts[Math.max(i - 1, 0)]).normalize()
    U.set(Math.abs(T.y) > 0.9 ? 1 : 0, Math.abs(T.y) > 0.9 ? 0 : 1, 0).cross(T).normalize()
    V.copy(T).cross(U)
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2
      P.copy(U).multiplyScalar(Math.cos(a)).addScaledVector(V, Math.sin(a))
      Q.copy(pts[i]).addScaledVector(P, radii[i])
      pos.push(Q.x, Q.y, Q.z)
      nor.push(P.x, P.y, P.z)
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const a = base + i * sides + k
      const b = base + i * sides + ((k + 1) % sides)
      idx.push(a, b, a + sides, b, b + sides, a + sides)
    }
  }
}

/** 一棵枯樹：樹幹（有點彎）、幾根往上岔的樹枝、樹枝上再岔出去的細枝。樹幹的底在原點 */
export function deadTree(rand: Rand): BufferGeometry {
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  const height = 5 + rand() * 2.2
  const trunk: Vector3[] = []
  const radii: number[] = []
  const lean = new Vector3((rand() - 0.5) * 0.35, 1, (rand() - 0.5) * 0.35)
  const segs = 4
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    trunk.push(new Vector3(lean.x * height * t * t + (i ? (rand() - 0.5) * 0.2 : 0), height * t, lean.z * height * t * t + (i ? (rand() - 0.5) * 0.2 : 0)))
    radii.push(0.36 - 0.24 * t)
  }
  limb(pos, nor, idx, trunk, radii, 6)
  const branches = 5 + Math.floor(rand() * 3)
  for (let i = 0; i < branches; i++) {
    const t = 0.38 + 0.6 * ((i + rand() * 0.6) / branches)
    const k = Math.min(segs - 1, Math.floor(t * segs))
    const from = trunk[k].clone().lerp(trunk[k + 1], t * segs - k)
    const az = (i / branches) * Math.PI * 2 * 1.618 + rand() * 0.8
    const up = 0.45 + rand() * 0.5
    const dir = new Vector3(Math.cos(az) * Math.cos(up), Math.sin(up), Math.sin(az) * Math.cos(up))
    const len = (1.6 + rand() * 2.2) * (1.15 - t * 0.5)
    const r0 = 0.13 * (1.2 - t * 0.6)
    const mid = from.clone().addScaledVector(dir, len * 0.5).add(new Vector3((rand() - 0.5) * 0.4, rand() * 0.3, (rand() - 0.5) * 0.4))
    const end = mid.clone().addScaledVector(dir, len * 0.5).add(new Vector3((rand() - 0.5) * 0.5, 0.2 + rand() * 0.5, (rand() - 0.5) * 0.5))
    limb(pos, nor, idx, [from, mid, end], [r0, r0 * 0.6, 0.02], 4)
    const twigs = 1 + Math.floor(rand() * 2)
    for (let j = 0; j < twigs; j++) {
      const start = (j ? mid : from).clone().lerp(j ? end : mid, 0.4 + rand() * 0.5)
      const ta = az + (rand() - 0.5) * 2.2
      const tdir = new Vector3(Math.cos(ta) * 0.7, 0.5 + rand() * 0.5, Math.sin(ta) * 0.7).normalize()
      limb(pos, nor, idx, [start, start.clone().addScaledVector(tdir, 0.7 + rand() * 1.1)], [r0 * 0.4, 0.012], 3)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  return geo
}
