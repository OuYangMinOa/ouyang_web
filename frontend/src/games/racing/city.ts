// 「台北信義」賽道的城市：OpenStreetMap 的建築輪廓往上長成大樓，街道和綠地鋪在地面，大馬路兩旁種行道樹。
// 資料是 scripts/osm-xinyi.mjs 產生的 osm/xinyi.json（© OpenStreetMap 貢獻者，ODbL）。
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  ShapeUtils,
  Vector2,
  type CanvasTexture,
  type Scene,
} from 'three'
import { rng } from './noise'
import type { TrackPath } from './track'

/** osm/xinyi.json 的格式：座標都是公寸的整數，一串點的第一點是絕對座標、後面是和前一點的差 */
export type CityData = {
  credit: string
  date: string
  origin: number[]
  /** 賽道的控制點 [x, z]（公尺） */
  track: number[][]
  /** [高度, 離地高度, ...輪廓]，輪廓從上面看是逆時針（x 往東、z 往南） */
  buildings: number[][]
  /** [半寬, ...中心線] */
  streets: number[][]
  parks: number[][]
  trees: number[]
}

type Tex = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => CanvasTexture
type GroundAt = (x: number, z: number) => number

/** 外牆貼圖一格的大小：四個開間、四層樓 */
const CELL_W = 12
const CELL_H = 13.2
/** 這麼高以上的建築畫成玻璃帷幕大樓，矮的是貼磁磚的公寓 */
const TOWER = 50
/** 101 在座標原點附近：塔身是藍綠色的玻璃 */
const TAIPEI_101 = 70
const TAIPEI_101_TINT = 0x9fd6c8

/** 玻璃大樓的色調（乘在藍灰色的玻璃上）、公寓的磁磚顏色 */
const GLASS = [0xffffff, 0xdfe8f0, 0xcfe0e8, 0xeee6d8, 0xd2e2dc, 0xc4cfdc]
const TILE = [0xe8e2d6, 0xd8cdb8, 0xc9c2b5, 0xb8b0a5, 0xd9c3a5, 0xc8ccd0, 0xe0d5c3]

function unpack(a: number[], from = 0): Float32Array {
  const out = new Float32Array(a.length - from)
  let x = 0
  let z = 0
  for (let i = from; i < a.length; i += 2) {
    x += a[i]
    z += a[i + 1]
    out[i - from] = x / 10
    out[i - from + 1] = z / 10
  }
  return out
}

/** 一直往裡面塞三角形的網格；`tri` 會把三角形轉成朝上（或朝指定的法線） */
class Builder {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []
  col: number[] = []

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: Color) {
    this.pos.push(x, y, z)
    this.nor.push(nx, ny, nz)
    this.uv.push(u, v)
    this.col.push(c.r, c.g, c.b)
  }

  /** 平放的三角形，自動調成從上面看是正面 */
  flat(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, y: (x: number, z: number) => number, c: Color) {
    const up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0
    const pts = up ? [ax, az, bx, bz, cx, cz] : [ax, az, cx, cz, bx, bz]
    for (let k = 0; k < 6; k += 2) this.vert(pts[k], y(pts[k], pts[k + 1]), pts[k + 1], 0, 1, 0, 0.01, 0.01, c)
  }

  geometry(): BufferGeometry {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3))
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3))
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2))
    geo.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3))
    return geo
  }
}

/** 把一個環三角化，回傳三角形的頂點索引 */
function triangulate(ring: Float32Array): number[][] {
  const pts: Vector2[] = []
  for (let k = 0; k < ring.length; k += 2) pts.push(new Vector2(ring[k], ring[k + 1]))
  return ShapeUtils.triangulateShape(pts, [])
}

/** 均勻的格子：快速找某個點附近有哪些東西 */
class Grid<T> {
  private cells = new Map<number, T[]>()
  private readonly size: number
  constructor(size: number) {
    this.size = size
  }
  private key(cx: number, cz: number) {
    return (cx + 1000) * 4096 + (cz + 1000)
  }
  add(minX: number, minZ: number, maxX: number, maxZ: number, item: T) {
    for (let cx = Math.floor(minX / this.size); cx <= Math.floor(maxX / this.size); cx++) {
      for (let cz = Math.floor(minZ / this.size); cz <= Math.floor(maxZ / this.size); cz++) {
        const k = this.key(cx, cz)
        const list = this.cells.get(k)
        if (list) list.push(item)
        else this.cells.set(k, [item])
      }
    }
  }
  at(x: number, z: number): T[] {
    return this.cells.get(this.key(Math.floor(x / this.size), Math.floor(z / this.size))) ?? []
  }
}

function insideRing(x: number, z: number, ring: Float32Array): boolean {
  let hit = false
  const m = ring.length / 2
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const ax = ring[i * 2]
    const az = ring[i * 2 + 1]
    const bx = ring[j * 2]
    const bz = ring[j * 2 + 1]
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) hit = !hit
  }
  return hit
}

function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax
  const dz = bz - az
  const len = dx * dx + dz * dz
  const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len)) : 0
  return Math.hypot(x - ax - t * dx, z - az - t * dz)
}

/**
 * 公寓的外牆：淺色的磁磚底（乘上每棟的顏色）、一層兩扇窗加上窗台；`lit` 只畫亮著的窗（自發光）。
 * 左下角要留底色：屋頂的貼圖座標指在那裡
 */
function drawTile(ctx: CanvasRenderingContext2D, lit: boolean) {
  const rand = rng(23)
  ctx.fillStyle = lit ? '#000000' : '#dcdcdc'
  ctx.fillRect(0, 0, 128, 128)
  const warm = ['#ffd58a', '#ffe7b8', '#fff1d0', '#ffcf9a']
  for (let floor = 0; floor < 4; floor++) {
    const y = 6 + floor * 32
    if (!lit) {
      // 每層樓之間的橫帶
      ctx.fillStyle = '#c4c4c4'
      ctx.fillRect(0, y + 22, 128, 4)
    }
    for (let col = 0; col < 8; col++) {
      if (col % 4 === 3) continue
      const on = rand() < 0.38
      const color = warm[Math.floor(rand() * warm.length)]
      const x = 4 + col * 16
      if (lit) {
        if (!on) continue
        ctx.fillStyle = color
        ctx.fillRect(x, y, 11, 17)
      } else {
        ctx.fillStyle = '#6d6a64'
        ctx.fillRect(x - 1, y - 1, 13, 19)
        ctx.fillStyle = on ? '#9a8a6a' : '#3f4752'
        ctx.fillRect(x, y, 11, 17)
      }
    }
  }
}

/** 玻璃帷幕：藍灰色的玻璃、每層樓的窗間牆和直條的竪框，亮燈的是一整個開間 */
function drawGlass(ctx: CanvasRenderingContext2D, lit: boolean) {
  const rand = rng(41)
  if (lit) {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 128, 128)
  } else {
    const grad = ctx.createLinearGradient(0, 0, 128, 128)
    grad.addColorStop(0, '#6f86a0')
    grad.addColorStop(1, '#4d6079')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 128, 128)
  }
  for (let floor = 0; floor < 4; floor++) {
    const y = floor * 32
    for (let bay = 0; bay < 4; bay++) {
      if (!lit || rand() > 0.45) continue
      ctx.fillStyle = rand() < 0.5 ? '#fff6e0' : '#e4f0ff'
      ctx.fillRect(bay * 32 + 2, y + 3, 28, 22)
    }
    if (!lit) {
      ctx.fillStyle = '#b9c1cb'
      ctx.fillRect(0, y + 26, 128, 6)
    }
  }
  if (!lit) {
    ctx.fillStyle = 'rgba(210,220,230,0.55)'
    for (let x = 0; x < 128; x += 16) ctx.fillRect(x, 0, 2, 128)
  }
  // 左下角給屋頂用的灰色
  if (!lit) {
    ctx.fillStyle = '#b9c1cb'
    ctx.fillRect(0, 120, 8, 8)
  }
}

export function addCity(scene: Scene, track: TrackPath, data: CityData, groundAt: GroundAt, night: boolean, tex: Tex) {
  const buildings = data.buildings.map((b) => ({ h: b[0] / 10, minH: b[1] / 10, ring: unpack(b, 2) }))
  const streets = data.streets.map((s) => ({ half: s[0] / 10, pts: unpack(s, 1) }))

  addBuildings(scene, buildings, groundAt, night, tex)
  addGround(scene, streets, data.parks.map((p) => unpack(p)), groundAt)
  addTrees(scene, track, buildings, streets, unpack(data.trees), groundAt)
}

type Building = { h: number; minH: number; ring: Float32Array }
type Street = { half: number; pts: Float32Array }

function addBuildings(scene: Scene, list: Building[], groundAt: GroundAt, night: boolean, tex: Tex) {
  const glass = new Builder()
  const tile = new Builder()
  const color = new Color()
  const roof = new Color()
  list.forEach(({ h, minH, ring }, index) => {
    const m = ring.length / 2
    let cx = 0
    let cz = 0
    for (let k = 0; k < m; k++) {
      cx += ring[k * 2]
      cz += ring[k * 2 + 1]
    }
    cx /= m
    cz /= m
    const base = groundAt(cx, cz)
    // 貼地的建築往下多畫一點，免得地面有起伏時看到縫
    const bottom = minH > 0 ? base + minH : base - 0.6
    const top = base + h
    const pick = rng(index * 7 + 3)
    const is101 = Math.hypot(cx, cz) < TAIPEI_101 && h > 60
    const tower = h >= TOWER || is101
    const b = tower ? glass : tile
    const palette = tower ? GLASS : TILE
    color.setHex(is101 ? TAIPEI_101_TINT : palette[Math.floor(pick() * palette.length)])
    roof.copy(color).multiplyScalar(0.72)

    // 外牆：每個邊一面，法線朝外（輪廓是逆時針，往外是 (dz, -dx)）
    let along = pick() * CELL_W
    const v0 = (bottom - base) / CELL_H
    const v1 = h / CELL_H
    for (let k = 0; k < m; k++) {
      const ax = ring[k * 2]
      const az = ring[k * 2 + 1]
      const bx = ring[((k + 1) % m) * 2]
      const bz = ring[((k + 1) % m) * 2 + 1]
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 0.01) continue
      const nx = (bz - az) / len
      const nz = -(bx - ax) / len
      const u0 = along / CELL_W
      const u1 = (along + len) / CELL_W
      along += len
      b.vert(ax, bottom, az, nx, 0, nz, u0, v0, color)
      b.vert(bx, top, bz, nx, 0, nz, u1, v1, color)
      b.vert(bx, bottom, bz, nx, 0, nz, u1, v0, color)
      b.vert(ax, bottom, az, nx, 0, nz, u0, v0, color)
      b.vert(ax, top, az, nx, 0, nz, u0, v1, color)
      b.vert(bx, top, bz, nx, 0, nz, u1, v1, color)
    }
    // 屋頂
    for (const [i, j, k] of triangulate(ring)) {
      b.flat(ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1], ring[k * 2], ring[k * 2 + 1], () => top, roof)
    }
  })
  const glow = night ? 1 : 0.8
  for (const [b, draw] of [
    [glass, drawGlass],
    [tile, drawTile],
  ] as const) {
    if (!b.pos.length) continue
    scene.add(
      new Mesh(
        b.geometry(),
        new MeshLambertMaterial({
          map: tex(128, 128, (ctx) => draw(ctx, false)),
          vertexColors: true,
          emissiveMap: tex(128, 128, (ctx) => draw(ctx, true)),
          emissive: 0xffffff,
          emissiveIntensity: glow,
        }),
      ),
    )
  }
}

/** 街道（柏油）和綠地鋪在地面上，比地形高一點點 */
function addGround(scene: Scene, streets: Street[], parks: Float32Array[], groundAt: GroundAt) {
  const b = new Builder()
  const asphalt = new Color(0x55565c)
  const green = [new Color(0x5d8a4a), new Color(0x6b9450), new Color(0x557f47)]
  const parkY = (x: number, z: number) => groundAt(x, z) + 0.05
  parks.forEach((ring, index) => {
    const c = green[index % green.length]
    for (const [i, j, k] of triangulate(ring)) {
      b.flat(ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1], ring[k * 2], ring[k * 2 + 1], parkY, c)
    }
  })
  // 街道：沿著中心線的帶子，轉折的地方斜接（太尖的轉角限制長度）
  const streetY = (x: number, z: number) => groundAt(x, z) + 0.1
  for (const { half, pts } of streets) {
    const m = pts.length / 2
    const side: number[] = []
    for (let i = 0; i < m; i++) {
      const x = pts[i * 2]
      const z = pts[i * 2 + 1]
      let tx = 0
      let tz = 0
      let sx = 0
      let sz = 0
      for (const j of [i - 1, i]) {
        if (j < 0 || j + 1 >= m) continue
        const dx = pts[(j + 1) * 2] - pts[j * 2]
        const dz = pts[(j + 1) * 2 + 1] - pts[j * 2 + 1]
        const len = Math.hypot(dx, dz) || 1
        tx += dx / len
        tz += dz / len
        sx = dx / len
        sz = dz / len
      }
      const tl = Math.hypot(tx, tz) || 1
      tx /= tl
      tz /= tl
      // 斜接的長度：半寬除以轉角一半的餘弦
      const miter = half / Math.max(0.5, tx * sx + tz * sz)
      side.push(x - tz * miter, z + tx * miter, x + tz * miter, z - tx * miter)
    }
    for (let i = 0; i + 1 < m; i++) {
      const [ax, az, bx, bz] = side.slice(i * 4, i * 4 + 4)
      const [cx, cz, dx, dz] = side.slice(i * 4 + 4, i * 4 + 8)
      b.flat(ax, az, bx, bz, dx, dz, streetY, asphalt)
      b.flat(ax, az, dx, dz, cx, cz, streetY, asphalt)
    }
  }
  scene.add(
    new Mesh(
      b.geometry(),
      new MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    ),
  )
}

/**
 * 行道樹：OSM 有標的樹，加上大馬路（半寬 6 公尺以上）兩旁每 12 公尺一棵。
 * 離賽道太近、在別條路上（路口）、在建築裡面的不種
 */
function addTrees(scene: Scene, track: TrackPath, buildings: Building[], streets: Street[], osmTrees: Float32Array, groundAt: GroundAt) {
  const near = 420
  const blocked = new Grid<Building | Street>(40)
  for (const item of [...buildings, ...streets]) {
    const pts = 'ring' in item ? item.ring : item.pts
    const pad = 'half' in item ? item.half : 0
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    for (let k = 0; k < pts.length; k += 2) {
      minX = Math.min(minX, pts[k])
      maxX = Math.max(maxX, pts[k])
      minZ = Math.min(minZ, pts[k + 1])
      maxZ = Math.max(maxZ, pts[k + 1])
    }
    blocked.add(minX - pad, minZ - pad, maxX + pad, maxZ + pad, item)
  }
  const free = (x: number, z: number) => {
    for (const item of blocked.at(x, z)) {
      if ('ring' in item) {
        if (item.minH === 0 && insideRing(x, z, item.ring)) return false
        continue
      }
      const p = item.pts
      for (let k = 0; k + 2 < p.length; k += 2) {
        if (segDist(x, z, p[k], p[k + 1], p[k + 2], p[k + 3]) < item.half + 0.8) return false
      }
    }
    const d = track.nearest(x, z).dist
    return d > track.wall + 2 && d < near
  }

  const spots: [number, number][] = []
  for (let k = 0; k < osmTrees.length; k += 2) {
    if (free(osmTrees[k], osmTrees[k + 1])) spots.push([osmTrees[k], osmTrees[k + 1]])
  }
  for (const { half, pts } of streets) {
    if (half < 6) continue
    let carry = 6
    for (let k = 0; k + 2 < pts.length; k += 2) {
      const ax = pts[k]
      const az = pts[k + 1]
      const dx = pts[k + 2] - ax
      const dz = pts[k + 3] - az
      const len = Math.hypot(dx, dz)
      if (len < 0.01) continue
      const nx = dz / len
      const nz = -dx / len
      let s = carry
      for (; s < len; s += 12) {
        for (const side of [-1, 1]) {
          const off = (half + 1.6) * side
          const x = ax + (dx / len) * s + nx * off
          const z = az + (dz / len) * s + nz * off
          if (free(x, z)) spots.push([x, z])
        }
      }
      carry = s - len
    }
  }
  if (!spots.length) return

  const rand = rng(77)
  const trunk = new CylinderGeometry(0.18, 0.26, 2.6, 5).translate(0, 1.3, 0)
  const crown = new IcosahedronGeometry(2.4, 0).translate(0, 4, 0)
  const trunks = new InstancedMesh(trunk, new MeshLambertMaterial({ color: 0x5e4632 }), spots.length)
  const crowns = new InstancedMesh(crown, new MeshLambertMaterial({ color: 0xffffff, flatShading: true }), spots.length)
  const dummy = new Object3D()
  const leaf = new Color()
  spots.forEach(([x, z], i) => {
    const s = 0.75 + rand() * 0.5
    dummy.position.set(x, groundAt(x, z), z)
    dummy.rotation.set(0, rand() * Math.PI * 2, 0)
    dummy.scale.set(s, s * (0.85 + rand() * 0.3), s)
    dummy.updateMatrix()
    trunks.setMatrixAt(i, dummy.matrix)
    crowns.setMatrixAt(i, dummy.matrix)
    crowns.setColorAt(i, leaf.setHex(0x4f7d3f).offsetHSL((rand() - 0.5) * 0.05, (rand() - 0.5) * 0.15, (rand() - 0.5) * 0.12))
  })
  scene.add(trunks, crowns)
}
