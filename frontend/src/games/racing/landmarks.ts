// 讓「台北信義」一看就知道是信義區的東西：照真實比例做的台北 101（OSM 只有一疊方塊）、跨過馬路的人行空橋、
// 東南邊的四獸山和南港山（遠景），還有每個彎前面的路名牌。資料都在 osm/xinyi.json（scripts/osm-xinyi.mjs 產生）。
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
  type CanvasTexture,
  type Scene,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { rng, smoothstep } from './noise'
import type { TrackPath } from './track'

type Tex = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => CanvasTexture
type GroundAt = (x: number, z: number) => number

// ---------- 台北 101 ----------

/** 一層樓的高度和外牆貼圖一格的大小（四層樓、12 公尺寬） */
const FLOOR = 4.2
const TEX_W = 12
const TEX_H = FLOOR * 4
/** 基座（1～26 樓）的高度、八節「竹節」每節八層樓 */
const BASE_TOP = 116
const SECTION = FLOOR * 8
/** 晚上的燈色照星期幾換：週日到週六是紫、紅、橙、黃、綠、藍、靛 */
const WEEKDAY_LIGHT = [0xb46cff, 0xff5050, 0xff9a3c, 0xffde4a, 0x5ee36a, 0x4aa8ff, 0x7070ff]

/**
 * 斷面：半寬 1 的正方形，四個角各往內退兩階（101 鋸齒狀的角），從上面看是逆時針（和 city.ts 的建築輪廓一樣）。
 * 先做 (+x, +z) 那個角，再每次轉 90 度
 */
function notchedSquare(): number[] {
  const d = 0.09
  const corner = [
    [1, 1 - 2 * d],
    [1 - d, 1 - 2 * d],
    [1 - d, 1 - d],
    [1 - 2 * d, 1 - d],
    [1 - 2 * d, 1],
  ]
  const out: number[] = []
  for (let q = 0; q < 4; q++) {
    for (const [x0, z0] of corner) {
      let x = x0
      let z = z0
      for (let r = 0; r < q; r++) [x, z] = [-z, x]
      out.push(x, z)
    }
  }
  return out
}
const SQUARE = notchedSquare()

type Place = { x: number; z: number; cos: number; sin: number; base: number }

class Shell {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) {
    this.pos.push(x, y, z)
    this.nor.push(nx, ny, nz)
    this.uv.push(u, v)
  }

  geometry(): BufferGeometry {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3))
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3))
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2))
    return geo
  }
}

/** 斷面上的點 (lx, lz) 轉到世界座標 */
function world(p: Place, lx: number, lz: number): [number, number] {
  return [p.x + lx * p.cos - lz * p.sin, p.z + lx * p.sin + lz * p.cos]
}

/**
 * 一段上下大小不同的柱體：底在 y0、半寬 h0，頂在 y1、半寬 h1（h1 比較大就是往外開的竹節）。
 * `cap` 是頂上的蓋子（上一節比較寬時，露出來的那一圈平台）
 */
function prism(b: Shell, p: Place, y0: number, h0: number, y1: number, h1: number, cap: boolean) {
  const m = SQUARE.length / 2
  let along = 0
  for (let k = 0; k < m; k++) {
    const ax = SQUARE[k * 2]
    const az = SQUARE[k * 2 + 1]
    const bx = SQUARE[((k + 1) % m) * 2]
    const bz = SQUARE[((k + 1) % m) * 2 + 1]
    const len = Math.hypot(bx - ax, bz - az)
    // 這一面往外的水平方向、離中心多遠：斷面放大時這一面往外移，牆面就斜了
    const nx = (bz - az) / len
    const nz = -(bx - ax) / len
    const slope = ((ax * nx + az * nz) * (h1 - h0)) / (y1 - y0)
    const k2 = 1 / Math.hypot(1, slope)
    const wx = (nx * p.cos - nz * p.sin) * k2
    const wz = (nx * p.sin + nz * p.cos) * k2
    const wy = -slope * k2
    const u0 = along / TEX_W
    const u1 = (along + len * h1) / TEX_W
    along += len * h1
    const [a0x, a0z] = world(p, ax * h0, az * h0)
    const [b0x, b0z] = world(p, bx * h0, bz * h0)
    const [a1x, a1z] = world(p, ax * h1, az * h1)
    const [b1x, b1z] = world(p, bx * h1, bz * h1)
    const lo = p.base + y0
    const hi = p.base + y1
    b.vert(a0x, lo, a0z, wx, wy, wz, u0, y0 / TEX_H)
    b.vert(b1x, hi, b1z, wx, wy, wz, u1, y1 / TEX_H)
    b.vert(b0x, lo, b0z, wx, wy, wz, u1, y0 / TEX_H)
    b.vert(a0x, lo, a0z, wx, wy, wz, u0, y0 / TEX_H)
    b.vert(a1x, hi, a1z, wx, wy, wz, u0, y1 / TEX_H)
    b.vert(b1x, hi, b1z, wx, wy, wz, u1, y1 / TEX_H)
  }
  if (!cap) return
  // 頂蓋：從中心拉三角形到每個邊（斷面從中心看得到每一個點），貼圖用左下角的屋頂色
  const [cx, cz] = world(p, 0, 0)
  for (let k = 0; k < m; k++) {
    const [ax, az] = world(p, SQUARE[k * 2] * h1, SQUARE[k * 2 + 1] * h1)
    const [bx, bz] = world(p, SQUARE[((k + 1) % m) * 2] * h1, SQUARE[((k + 1) % m) * 2 + 1] * h1)
    const y = p.base + y1
    b.vert(cx, y, cz, 0, 1, 0, 0.01, 0.01)
    b.vert(bx, y, bz, 0, 1, 0, 0.01, 0.01)
    b.vert(ax, y, az, 0, 1, 0, 0.01, 0.01)
  }
}

/** 101 的外牆：藍綠色的玻璃、每層樓的窗間牆、細細的竪框；`lit` 只畫亮著的窗。左下角留給屋頂 */
function draw101(ctx: CanvasRenderingContext2D, lit: boolean) {
  const rand = rng(101)
  if (lit) {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 128, 128)
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, 128)
    grad.addColorStop(0, '#6fa39b')
    grad.addColorStop(1, '#4a7f79')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 128, 128)
  }
  for (let floor = 0; floor < 4; floor++) {
    const y = floor * 32
    for (let bay = 0; bay < 8; bay++) {
      if (!lit || rand() > 0.4) continue
      ctx.fillStyle = rand() < 0.6 ? '#fff3d6' : '#e2f2ff'
      ctx.fillRect(bay * 16 + 1, y + 3, 14, 21)
    }
    if (!lit) {
      ctx.fillStyle = '#a9c7c0'
      ctx.fillRect(0, y + 25, 128, 7)
    }
  }
  if (!lit) {
    ctx.fillStyle = 'rgba(225,240,235,0.45)'
    for (let x = 0; x < 128; x += 16) ctx.fillRect(x, 0, 2, 128)
    ctx.fillStyle = '#8fa8a3'
    ctx.fillRect(0, 120, 8, 8)
  }
}

export type Tower = { x: number; z: number; angle: number; half: number }

/**
 * 台北 101：往上收的基座（1～26 樓）、四面的大古錢、八節往外開的竹節、頂樓、塔尖。
 * `half` 是地面的半寬（OSM 的塔身輪廓），其他的尺寸照它等比例
 */
export function addTaipei101(scene: Scene, t: Tower, groundAt: GroundAt, night: boolean, tex: Tex) {
  const k = t.half / 27
  const p: Place = { x: t.x, z: t.z, cos: Math.cos(t.angle), sin: Math.sin(t.angle), base: groundAt(t.x, t.z) - 0.6 }
  const shell = new Shell()
  const glow = new Shell()
  const strip = (y: number, h: number) => prism(glow, p, y - 1.4, h * 1.012, y - 0.4, h * 1.012, false)

  // 基座：從地面往上收
  prism(shell, p, 0, 27 * k, BASE_TOP, 20.5 * k, true)
  strip(BASE_TOP, 20.5 * k)
  // 八節竹節：每節底下窄、上面寬（外牆往外斜大約 7 度），下一節的底縮在上一節的頂裡面
  for (let i = 0; i < 8; i++) {
    const y0 = BASE_TOP + i * SECTION
    prism(shell, p, y0, 19 * k, y0 + SECTION, 23 * k, true)
    strip(y0 + SECTION, 23 * k)
  }
  const top = BASE_TOP + 8 * SECTION
  // 觀景台那一層、頂樓、再上去的小塔
  prism(shell, p, top, 21 * k, top + 5, 21 * k, true)
  prism(shell, p, top + 5, 12 * k, top + 53, 10.5 * k, true)
  strip(top + 53, 10.5 * k)
  prism(shell, p, top + 53, 6.5 * k, top + 62, 6 * k, true)

  scene.add(
    new Mesh(
      shell.geometry(),
      new MeshLambertMaterial({
        map: tex(128, 128, (ctx) => draw101(ctx, false)),
        emissiveMap: tex(128, 128, (ctx) => draw101(ctx, true)),
        emissive: 0xffffff,
        emissiveIntensity: night ? 1 : 0.75,
      }),
    ),
  )
  // 每一節頂端的燈條：今天是星期幾就是什麼顏色
  scene.add(new Mesh(glow.geometry(), new MeshBasicMaterial({ color: WEEKDAY_LIGHT[new Date().getDay()] })))

  // 塔尖和頂上的航空警示燈
  const spireBase = top + 62
  const spire = new CylinderGeometry(0.35 * k, 1.8 * k, 60, 8).translate(t.x, p.base + spireBase + 30, t.z)
  scene.add(new Mesh(spire, new MeshLambertMaterial({ color: 0xc9d3d6 })))
  const beacon = new Mesh(new SphereGeometry(1.1, 10, 6), new MeshBasicMaterial({ color: 0xff3020 }))
  beacon.position.set(t.x, p.base + spireBase + 60.5, t.z)
  scene.add(beacon)

  // 基座頂上四面的大古錢（金色的圓，中間方孔）
  const coins: BufferGeometry[] = []
  const holes: BufferGeometry[] = []
  const y = BASE_TOP - 13
  const h = 27 * k + (20.5 * k - 27 * k) * (y / BASE_TOP)
  for (let q = 0; q < 4; q++) {
    const a = t.angle + (q * Math.PI) / 2
    // 正方形的每一面朝外是 (cos a, sin a)；圓柱轉成軸朝外
    const ox = Math.cos(a)
    const oz = Math.sin(a)
    const coin = new CylinderGeometry(5.5 * k, 5.5 * k, 0.6, 28).rotateZ(Math.PI / 2).rotateY(-a)
    coins.push(coin.translate(t.x + ox * (h + 0.6), p.base + y, t.z + oz * (h + 0.6)))
    const hole = new BoxGeometry(0.2, 3 * k, 3 * k).rotateY(-a)
    holes.push(hole.translate(t.x + ox * (h + 0.95), p.base + y, t.z + oz * (h + 0.95)))
  }
  scene.add(new Mesh(mergeGeometries(coins), new MeshLambertMaterial({ color: 0xd9b45a, emissive: 0x6a4a10 })))
  scene.add(new Mesh(mergeGeometries(holes), new MeshLambertMaterial({ color: 0x3d5f5a })))
}

// ---------- 人行空橋 ----------

/** 空橋：二樓高的玻璃走廊，下緣離地面這麼高 */
const SKYWAY_LOW = 5.6
const SKYWAY_HIGH = 9.4
/** 空橋走道的地板離地面多高（上面站觀眾） */
export const SKYWAY_DECK = SKYWAY_LOW + 0.8

export type Skyway = { half: number; pts: Float32Array }

/**
 * 跨過馬路的人行空橋：橋面板、兩側的玻璃、屋頂和柱子（柱子不立在賽道上）。
 * 回傳「這個位置的上方有沒有空橋」，路燈、行道樹不要放在空橋底下
 */
export function addSkyways(scene: Scene, track: TrackPath, list: Skyway[], groundAt: GroundAt, night: boolean) {
  const frame: BufferGeometry[] = []
  const glass: BufferGeometry[] = []
  const segs: number[][] = []
  for (const { half, pts } of list) {
    let carry = 8
    for (let k = 0; k + 2 < pts.length; k += 2) {
      const ax = pts[k]
      const az = pts[k + 1]
      const bx = pts[k + 2]
      const bz = pts[k + 3]
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 0.3) continue
      segs.push([ax, az, bx, bz, half])
      const heading = Math.atan2(bx - ax, bz - az)
      const mx = (ax + bx) / 2
      const mz = (az + bz) / 2
      const g = groundAt(mx, mz)
      // 前後多出半個寬度，轉折的地方才接得起來
      const l = len + half
      const put = (geo: BufferGeometry, y: number) => geo.rotateY(heading).translate(mx, g + y, mz)
      frame.push(put(new BoxGeometry(half * 2, 0.8, l), SKYWAY_LOW + 0.4))
      frame.push(put(new BoxGeometry(half * 2 + 0.6, 0.4, l), SKYWAY_HIGH))
      for (const side of [-1, 1]) {
        glass.push(put(new BoxGeometry(0.15, SKYWAY_HIGH - SKYWAY_LOW - 1, len).translate(side * (half - 0.1), 0, 0), (SKYWAY_HIGH + SKYWAY_LOW + 0.8) / 2))
      }
      // 柱子：大約 22 公尺一根
      let s = carry
      for (; s < len; s += 22) {
        const x = ax + ((bx - ax) * s) / len
        const z = az + ((bz - az) * s) / len
        if (track.nearest(x, z).dist < track.wall + 2) continue
        const base = groundAt(x, z)
        frame.push(new CylinderGeometry(0.5, 0.55, SKYWAY_LOW + 0.6, 8).translate(x, base + (SKYWAY_LOW + 0.6) / 2 - 0.6, z))
      }
      carry = s - len
    }
  }
  if (frame.length) {
    scene.add(new Mesh(mergeGeometries(frame), new MeshLambertMaterial({ color: 0xdfe3e8 })))
    frame.forEach((g) => g.dispose())
  }
  if (glass.length) {
    scene.add(
      new Mesh(
        mergeGeometries(glass),
        new MeshLambertMaterial({
          color: 0x9ec8dc,
          emissive: 0xbfd8e6,
          emissiveIntensity: night ? 0.7 : 0.45,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        }),
      ),
    )
    glass.forEach((g) => g.dispose())
  }
  return (x: number, z: number, pad = 2) => {
    for (const [ax, az, bx, bz, half] of segs) {
      const dx = bx - ax
      const dz = bz - az
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
      if (Math.hypot(x - ax - t * dx, z - az - t * dz) < half + pad) return true
    }
    return false
  }
}

// ---------- 遠景的山 ----------

export type Relief = { credit: string; x0: number; z0: number; cell: number; cols: number; rows: number; data: string }

const FOREST_LOW = new Color(0x3f5d38)
const FOREST_HIGH = new Color(0x2a4228)
const SUNLIT = new Color(0xffc9a0)

/**
 * 四獸山、南港山：真實的地形高度（一格 2 公尺），顏色直接算好（森林的綠、照到夕陽的那面偏暖、越遠越霧），
 * 不吃場景的霧：霧在 1.6 公里就全白了，山在一到五公里外。高度 0 的地方壓到地面底下藏起來
 */
export function addRelief(scene: Scene, r: Relief, center: [number, number], haze: Color, sunDir: Vector3) {
  const bytes = Uint8Array.from(atob(r.data), (ch) => ch.charCodeAt(0))
  const { cols, rows, cell } = r
  const pos = new Float32Array(cols * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const k = row * cols + col
      pos.set([r.x0 + col * cell, bytes[k] * 2 - 3, r.z0 + row * cell], k * 3)
    }
  }
  const index: number[] = []
  for (let row = 0; row + 1 < rows; row++) {
    for (let col = 0; col + 1 < cols; col++) {
      const a = row * cols + col
      // 四個角都是平地的格子不畫
      if (!(bytes[a] || bytes[a + 1] || bytes[a + cols] || bytes[a + cols + 1])) continue
      index.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1)
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setIndex(index)
  geo.computeVertexNormals()
  const nor = geo.getAttribute('normal') as BufferAttribute
  const col = new Float32Array(cols * rows * 3)
  const c = new Color()
  const sun = sunDir.clone().normalize()
  for (let k = 0; k < cols * rows; k++) {
    const h = bytes[k] * 2
    const x = pos[k * 3]
    const z = pos[k * 3 + 2]
    const lit = Math.max(0, nor.getX(k) * sun.x + nor.getY(k) * sun.y + nor.getZ(k) * sun.z)
    c.lerpColors(FOREST_LOW, FOREST_HIGH, smoothstep(40, 300, h))
    c.multiplyScalar(0.55 + 0.9 * lit).lerp(SUNLIT, lit * 0.12)
    const d = Math.hypot(x - center[0], z - center[1])
    c.lerp(haze, 0.12 + 0.5 * smoothstep(800, 6000, d))
    col.set([c.r, c.g, c.b], k * 3)
  }
  geo.setAttribute('color', new BufferAttribute(col, 3))
  scene.add(new Mesh(geo, new MeshBasicMaterial({ vertexColors: true, fog: false })))
}

// ---------- 路名牌 ----------

/** 綠底白字的路名牌：中文路名、英文路名、往哪邊轉的箭頭 */
function drawSign(ctx: CanvasRenderingContext2D, zh: string, en: string, left: boolean) {
  ctx.fillStyle = '#0d6b3d'
  ctx.fillRect(0, 0, 512, 192)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 6
  ctx.strokeRect(10, 10, 492, 172)
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  const font = '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", "Heiti TC", sans-serif'
  const textX = left ? 150 : 34
  ctx.textAlign = 'left'
  ctx.font = `bold ${zh.length > 4 ? 72 : 88}px ${font}`
  ctx.fillText(zh, textX, 76, 330)
  ctx.font = `bold 34px ${font}`
  ctx.fillText(en, textX + 2, 148, 330)
  // 箭頭
  ctx.save()
  ctx.translate(left ? 80 : 432, 96)
  if (left) ctx.scale(-1, 1)
  ctx.beginPath()
  ctx.moveTo(-44, -14)
  ctx.lineTo(8, -14)
  ctx.lineTo(8, -42)
  ctx.lineTo(50, 0)
  ctx.lineTo(8, 42)
  ctx.lineTo(8, 14)
  ctx.lineTo(-44, 14)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** 每個彎前面 40 公尺，右邊立一支桿子，橫臂伸到路上掛路名牌（轉進去的那條路） */
export function addSigns(scene: Scene, track: TrackPath, signs: (string | number)[][], tex: Tex) {
  const poleMat = new MeshLambertMaterial({ color: 0x8c949c })
  const backMat = new MeshLambertMaterial({ color: 0x6f767c })
  for (const [jx, jz, zh, en] of signs) {
    const corner = track.nearest(Number(jx), Number(jz)).i
    const left = track.curv[corner] > 0
    const i = track.indexAt(corner * track.step - 40)
    const tx = track.tx[i]
    const tz = track.tz[i]
    const lat = -(track.wall + 1)
    const x = track.px[i] + tz * lat
    const z = track.pz[i] - tx * lat
    const group = new Group()
    group.position.set(x, track.roadY(i, lat), z)
    // 本地的 +z 朝著開過來的車，+x 是路的右邊
    group.rotation.y = Math.atan2(-tx, -tz)
    const pole = new Mesh(new CylinderGeometry(0.16, 0.2, 7.6, 8).translate(0, 3.8, 0), poleMat)
    // 牌子掛在右側車道的正上方
    const arm = new Mesh(new BoxGeometry(7.6, 0.2, 0.2).translate(-3.7, 7.3, 0), poleMat)
    const map = tex(512, 192, (ctx) => drawSign(ctx, String(zh), String(en), left))
    const plate = new Mesh(
      new PlaneGeometry(5.2, 1.95),
      new MeshLambertMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.35 }),
    )
    plate.position.set(-5.2, 6.1, 0.09)
    const back = new Mesh(new BoxGeometry(5.3, 2.05, 0.12).translate(-5.2, 6.1, 0), backMat)
    group.add(pole, arm, back, plate)
    scene.add(group)
  }
}
