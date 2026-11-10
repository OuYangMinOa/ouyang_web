// 「台北信義」賽道的城市：OpenStreetMap 的建築輪廓往上長成大樓，街道和綠地鋪在地面，大馬路兩旁種行道樹。
// 101、人行空橋、遠景的山、路名牌在 landmarks.ts。
// 資料是 scripts/osm-xinyi.mjs 產生的 osm/xinyi.json（© OpenStreetMap 貢獻者，ODbL）。
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  ShapeUtils,
  Vector2,
  Vector3,
  type CanvasTexture,
  type Scene,
} from 'three'
import { addRelief, addSigns, addSkyways, addTaipei101, type Relief, type Tower } from './landmarks'
import { rng } from './noise'
import { Solids } from './solids'
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
  /** 人行空橋 [半寬, ...中心線] */
  skyways: number[][]
  /** 每個彎轉進去的路：[路口 x, z（公尺）, 路名, 英文路名] */
  signs: (string | number)[][]
  /** 遠景的山的高度 */
  relief: Relief
}

/** 場景的光線：遠景的山自己算顏色，要知道霧的顏色和太陽從哪邊照 */
export type CityLook = { haze: number; sunDir: [number, number, number] }

type Tex = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => CanvasTexture
type GroundAt = (x: number, z: number) => number

/** 外牆貼圖一格的大小：四個開間、四層樓 */
const CELL_W = 12
const CELL_H = 13.2
/** 這麼高以上的建築畫成玻璃帷幕大樓，矮的是貼磁磚的公寓 */
const TOWER = 50

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

/** 綠色調的玻璃帷幕：每層樓一條淺色的窗間牆、細細的竪框（信義很多大樓是這種） */
function drawGlassTeal(ctx: CanvasRenderingContext2D, lit: boolean) {
  const rand = rng(53)
  ctx.fillStyle = '#000000'
  if (lit) {
    ctx.fillRect(0, 0, 128, 128)
    for (let floor = 0; floor < 4; floor++) {
      for (let bay = 0; bay < 4; bay++) {
        if (rand() > 0.4) continue
        ctx.fillStyle = rand() < 0.6 ? '#fff1d6' : '#dcecff'
        ctx.fillRect(bay * 32 + 1, floor * 32 + 2, 30, 23)
      }
    }
    return
  }
  const grad = ctx.createLinearGradient(0, 0, 0, 128)
  grad.addColorStop(0, '#4f7f7c')
  grad.addColorStop(1, '#2c5052')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  for (let floor = 0; floor < 4; floor++) {
    ctx.fillStyle = '#a9b8b4'
    ctx.fillRect(0, floor * 32 + 25, 128, 7)
  }
  ctx.fillStyle = 'rgba(190,210,205,0.7)'
  for (let x = 0; x < 128; x += 32) ctx.fillRect(x, 0, 2, 128)
  ctx.fillStyle = '#a9b8b4'
  ctx.fillRect(0, 120, 8, 8)
}

/** 銀白色的格子框、深藍色的窗：方方正正的辦公大樓 */
function drawGlassGrid(ctx: CanvasRenderingContext2D, lit: boolean) {
  const rand = rng(61)
  ctx.fillStyle = lit ? '#000000' : '#d5dadf'
  ctx.fillRect(0, 0, 128, 128)
  for (let floor = 0; floor < 4; floor++) {
    for (let col = 0; col < 8; col++) {
      const x = col * 16 + 3
      const y = floor * 32 + 3
      const on = rand() < 0.42
      if (lit) {
        if (!on) continue
        ctx.fillStyle = rand() < 0.5 ? '#ffeccc' : '#e6f0ff'
      } else ctx.fillStyle = col % 2 ? '#3e5670' : '#34495f'
      ctx.fillRect(x, y, 11, 23)
    }
  }
}

/** 台灣的老公寓：磁磚牆、裝了鐵窗的窗戶，有的窗下掛著冷氣機 */
function drawConcrete(ctx: CanvasRenderingContext2D, lit: boolean) {
  const rand = rng(71)
  ctx.fillStyle = lit ? '#000000' : '#d6d2c8'
  ctx.fillRect(0, 0, 128, 128)
  for (let floor = 0; floor < 4; floor++) {
    const y = floor * 32
    for (let col = 0; col < 4; col++) {
      const x = col * 32 + 5
      const on = rand() < 0.4
      const ac = rand() < 0.45
      if (lit) {
        if (on) {
          ctx.fillStyle = rand() < 0.7 ? '#ffd9a0' : '#f4f6ff'
          ctx.fillRect(x, y + 6, 22, 15)
          ctx.fillStyle = '#000000'
          for (let gx = x + 2; gx < x + 22; gx += 4) ctx.fillRect(gx, y + 6, 1, 15)
        }
        continue
      }
      // 鐵窗：突出來一點的框和一根根直條
      ctx.fillStyle = '#7d8186'
      ctx.fillRect(x - 2, y + 4, 26, 19)
      ctx.fillStyle = on ? '#8f8670' : '#3b4249'
      ctx.fillRect(x, y + 6, 22, 15)
      ctx.fillStyle = '#9ea3a8'
      for (let gx = x + 2; gx < x + 22; gx += 4) ctx.fillRect(gx, y + 6, 1, 15)
      if (ac) {
        ctx.fillStyle = '#efefea'
        ctx.fillRect(x + 6, y + 24, 12, 6)
        ctx.fillStyle = '#b5b5b0'
        ctx.fillRect(x + 7, y + 25, 4, 4)
      }
    }
    if (!lit) {
      ctx.fillStyle = '#c4bfb4'
      ctx.fillRect(0, y + 30, 128, 2)
    }
  }
  if (!lit) {
    ctx.fillStyle = '#d6d2c8'
    ctx.fillRect(0, 120, 8, 8)
  }
}

/** 一串點的外框 */
function bounds(pts: Float32Array): [number, number, number, number] {
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
  return [minX, minZ, maxX, maxZ]
}

/**
 * 看台、觀眾不能放的地方（scenery.ts）：`blocked` 是在貼地的建築裡面，`covered` 是在空橋底下；
 * `skyways` 是空橋的中心線（上面站觀眾）
 */
export function cityObstacles(data: CityData) {
  const grid = new Grid<Float32Array>(40)
  for (const b of data.buildings) {
    if (b[1] / 10 >= 3) continue
    const ring = unpack(b, 2)
    const [x0, z0, x1, z1] = bounds(ring)
    grid.add(x0, z0, x1, z1, ring)
  }
  const skyways = data.skyways.map((s) => ({ half: s[0] / 10, pts: unpack(s, 1) }))
  return {
    blocked: (x: number, z: number) => grid.at(x, z).some((ring) => insideRing(x, z, ring)),
    covered: (x: number, z: number) =>
      skyways.some(({ half, pts }) => {
        for (let k = 0; k + 2 < pts.length; k += 2) {
          if (segDist(x, z, pts[k], pts[k + 1], pts[k + 2], pts[k + 3]) < half + 2) return true
        }
        return false
      }),
    skyways,
  }
}

/**
 * 蓋整座城市。回傳「這個位置的上方有沒有空橋」，路燈不要立在空橋底下。
 * `occupied` 是看台、看板佔走的地方，行道樹不要種在那裡
 */
export function addCity(
  scene: Scene,
  track: TrackPath,
  data: CityData,
  groundAt: GroundAt,
  night: boolean,
  look: CityLook,
  tex: Tex,
  occupied: (x: number, z: number, r: number) => boolean,
): (x: number, z: number) => boolean {
  const buildings = data.buildings.map((b) => ({ h: b[0] / 10, minH: b[1] / 10, ring: unpack(b, 2) }))
  const streets = data.streets.map((s) => ({ half: s[0] / 10, pts: unpack(s, 1) }))

  // 101 在 OSM 是好幾個方塊疊起來的，換成照真實比例做的
  const tower = find101(buildings)
  addBuildings(scene, track, buildings, groundAt, night, tex, tower?.parts)
  if (tower) addTaipei101(scene, tower.tower, groundAt, night, tex)
  addGround(scene, streets, data.parks.map((p) => unpack(p)), groundAt)
  const overhead = addSkyways(
    scene,
    track,
    data.skyways.map((s) => ({ half: s[0] / 10, pts: unpack(s, 1) })),
    groundAt,
    night,
  )
  addTrees(scene, track, buildings, streets, unpack(data.trees), groundAt, (x, z) => overhead(x, z) || occupied(x, z, 2.5))
  addSigns(scene, track, data.signs, tex)
  const center: [number, number] = [(track.minX + track.maxX) / 2, (track.minZ + track.maxZ) / 2]
  addRelief(scene, data.relief, center, new Color(look.haze), new Vector3(...look.sunDir))
  return (x, z) => overhead(x, z, 3)
}

/**
 * 找 101：最高、貼地的那個 part 是塔身，從它的輪廓量出方向（邊的角度以 90 度為週期平均）和地面的半寬。
 * 塔身附近 100 公尺以上的 part（觀景台、頂樓、塔尖、基座的裝飾）都不畫
 */
function find101(list: Building[]): { tower: Tower; parts: Set<Building> } | null {
  const body = list.filter((b) => b.h >= 300 && b.minH === 0).sort((a, b) => b.h - a.h)[0]
  if (!body) return null
  const ring = body.ring
  const m = ring.length / 2
  let cx = 0
  let cz = 0
  let sx = 0
  let sy = 0
  for (let k = 0; k < m; k++) {
    const ax = ring[k * 2]
    const az = ring[k * 2 + 1]
    const dx = ring[((k + 1) % m) * 2] - ax
    const dz = ring[((k + 1) % m) * 2 + 1] - az
    const len = Math.hypot(dx, dz)
    const a = Math.atan2(dz, dx) * 4
    sx += Math.cos(a) * len
    sy += Math.sin(a) * len
    cx += ax / m
    cz += az / m
  }
  const angle = Math.atan2(sy, sx) / 4
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  let u0 = Infinity
  let u1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (let k = 0; k < m; k++) {
    const dx = ring[k * 2] - cx
    const dz = ring[k * 2 + 1] - cz
    const u = dx * cos + dz * sin
    const v = -dx * sin + dz * cos
    u0 = Math.min(u0, u)
    u1 = Math.max(u1, u)
    v0 = Math.min(v0, v)
    v1 = Math.max(v1, v)
  }
  const uc = (u0 + u1) / 2
  const vc = (v0 + v1) / 2
  const x = cx + uc * cos - vc * sin
  const z = cz + uc * sin + vc * cos
  const half = Math.max(u1 - u0, v1 - v0) / 2
  const parts = new Set(
    list.filter((b) => {
      if (b.h < 100) return false
      const n = b.ring.length / 2
      let bx = 0
      let bz = 0
      for (let k = 0; k < n; k++) {
        bx += b.ring[k * 2] / n
        bz += b.ring[k * 2 + 1] / n
      }
      return Math.hypot(bx - x, bz - z) < half * 1.6
    }),
  )
  return { tower: { x, z, angle, half }, parts }
}

type Building = { h: number; minH: number; ring: Float32Array }
type Street = { half: number; pts: Float32Array }

/** 外牆的樣式：玻璃大樓三種、公寓兩種 */
const GLASS_DRAW = [drawGlass, drawGlassTeal, drawGlassGrid]
const TILE_DRAW = [drawTile, drawConcrete]
/** 頂樓加蓋的鐵皮屋（藍、綠、白、鏽紅…）、不鏽鋼水塔、屋頂設備 */
const SHEET = [0x3d6fb6, 0x7fae8a, 0xd0d3d6, 0x9a5a3c, 0x4b8f8c, 0x6a86a8]
const STEEL = 0xd5d9de
const MACHINE = 0x9ea4aa
/** 離賽道這麼遠以內的建築才放屋頂上的東西（再遠看不到） */
const ROOF_NEAR = 380

/** 把輪廓往上長成牆，貼圖照實際尺寸重複；`along` 是外牆貼圖的起點（每棟錯開） */
function extrude(b: Builder, ring: Float32Array, bottom: number, top: number, base: number, color: Color, roof: Color, along: number) {
  const m = ring.length / 2
  const v0 = (bottom - base) / CELL_H
  const v1 = (top - base) / CELL_H
  // 外牆：每個邊一面，法線朝外（輪廓是逆時針，往外是 (dz, -dx)）
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
  for (const [i, j, k] of triangulate(ring)) {
    b.flat(ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1], ring[k * 2], ring[k * 2 + 1], () => top, roof)
  }
}

/** 輪廓的面積，和照最長的邊量出來的方向、外框的中心與長寬（屋頂上擺東西用） */
function shape(ring: Float32Array) {
  const m = ring.length / 2
  let area = 0
  let cx = 0
  let cz = 0
  let best = 0
  let angle = 0
  for (let k = 0; k < m; k++) {
    const ax = ring[k * 2]
    const az = ring[k * 2 + 1]
    const bx = ring[((k + 1) % m) * 2]
    const bz = ring[((k + 1) % m) * 2 + 1]
    area += ax * bz - bx * az
    cx += ax / m
    cz += az / m
    const len = Math.hypot(bx - ax, bz - az)
    if (len > best) {
      best = len
      angle = Math.atan2(bz - az, bx - ax)
    }
  }
  const ux = Math.cos(angle)
  const uz = Math.sin(angle)
  let u0 = Infinity
  let u1 = -Infinity
  let w0 = Infinity
  let w1 = -Infinity
  for (let k = 0; k < m; k++) {
    const dx = ring[k * 2] - cx
    const dz = ring[k * 2 + 1] - cz
    const u = dx * ux + dz * uz
    const w = -dx * uz + dz * ux
    u0 = Math.min(u0, u)
    u1 = Math.max(u1, u)
    w0 = Math.min(w0, w)
    w1 = Math.max(w1, w)
  }
  const mu = (u0 + u1) / 2
  const mw = (w0 + w1) / 2
  return {
    area: Math.abs(area) / 2,
    x: cx + mu * ux - mw * uz,
    z: cz + mu * uz + mw * ux,
    ux,
    uz,
    lu: u1 - u0,
    lw: w1 - w0,
  }
}

function addBuildings(
  scene: Scene,
  track: TrackPath,
  list: Building[],
  groundAt: GroundAt,
  night: boolean,
  tex: Tex,
  skip?: Set<Building>,
) {
  const glass = GLASS_DRAW.map(() => new Builder())
  const tile = TILE_DRAW.map(() => new Builder())
  const roofs = new Solids()
  const lights = new Solids()
  const color = new Color()
  const roof = new Color()
  const crown = new Color()
  const sheetTop = new Color()
  list.forEach((building, index) => {
    if (skip?.has(building)) return
    const { h, minH, ring } = building
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
    const tower = h >= TOWER
    const style = pick()
    const b = tower ? glass[style < 0.45 ? 0 : style < 0.75 ? 1 : 2] : tile[style < 0.6 ? 0 : 1]
    const palette = tower ? GLASS : TILE
    color.setHex(palette[Math.floor(pick() * palette.length)])
    roof.copy(color).multiplyScalar(0.72)
    extrude(b, ring, bottom, top, base, color, roof, pick() * CELL_W)

    // 屋頂上的東西：只放離賽道近的建築（part 不放：101 那種疊起來的）
    if (minH > 0 || track.nearest(cx, cz).dist > ROOF_NEAR) return
    const sh = shape(ring)
    /** 屋頂上本地座標 (u 沿著最長的邊, w 往旁邊) 的點 */
    const at = (u: number, w: number): [number, number] => [sh.x + u * sh.ux - w * sh.uz, sh.z + u * sh.uz + w * sh.ux]
    const inside = (u: number, w: number) => {
      const [x, z] = at(u, w)
      return insideRing(x, z, ring)
    }
    /** 中心在 (u, w)、半長 hu、半寬 hw 的方塊整個在屋頂上 */
    const fits = (hu: number, hw: number, u = 0, w = 0) =>
      inside(u, w) && inside(u - hu, w - hw) && inside(u + hu, w - hw) && inside(u + hu, w + hw) && inside(u - hu, w + hw)
    // BoxGeometry 的 x 轉到 (ux, uz)
    const heading = -Math.atan2(sh.uz, sh.ux)
    const box = (bw: number, bh: number, bd: number, u: number, w: number, y: number, hex: number) => {
      const [x, z] = at(u, w)
      roofs.add(new BoxGeometry(bw, bh, bd).rotateY(heading).translate(x, y + bh / 2, z), hex)
    }
    if (tower) {
      // 頂樓往內縮一圈的機房（很多大樓頂上那一截），再放幾個設備；很高的有避雷針和紅燈
      let roofTop = top
      if (sh.area > 150 && pick() < 0.7) {
        const s = 0.72 + pick() * 0.12
        const inset = new Float32Array(ring.length)
        let ok = true
        for (let k = 0; k < m && ok; k++) {
          inset[k * 2] = sh.x + (ring[k * 2] - sh.x) * s
          inset[k * 2 + 1] = sh.z + (ring[k * 2 + 1] - sh.z) * s
          ok = insideRing(inset[k * 2], inset[k * 2 + 1], ring)
        }
        if (ok) {
          const ch = 4 + pick() * 6
          crown.copy(color).multiplyScalar(0.86)
          extrude(b, inset, top - 0.2, top + ch, base, crown, roof, pick() * CELL_W)
          roofTop = top + ch
        }
      }
      const units = 1 + Math.floor(pick() * 3)
      for (let k = 0; k < units; k++) {
        const u = (pick() - 0.5) * sh.lu * 0.35
        const w = (pick() - 0.5) * sh.lw * 0.35
        if (fits(1.2, 1.2, u, w)) box(2.4, 1.4, 2.4, u, w, roofTop, MACHINE)
      }
      if (h > 110) {
        const mast = 6 + pick() * 8
        roofs.add(new CylinderGeometry(0.14, 0.22, mast, 6).translate(sh.x, roofTop + mast / 2, sh.z), MACHINE)
        lights.add(new BoxGeometry(0.6, 0.6, 0.6).translate(sh.x, roofTop + mast + 0.2, sh.z), 0xff3030)
      }
      return
    }
    if (sh.area < 60) return
    // 頂樓加蓋：佔屋頂一半左右的鐵皮屋，水塔常常再放在它上面
    let tankY = top
    let spread = 0.3
    if (h < 40 && pick() < 0.38) {
      for (const k of [0.55, 0.42]) {
        const hu = (sh.lu * k) / 2
        const hw = (sh.lw * k) / 2
        if (hu < 1.5 || hw < 1.5 || !fits(hu, hw)) continue
        const sheet = SHEET[Math.floor(pick() * SHEET.length)]
        box(hu * 2, 2.6, hw * 2, 0, 0, top, sheet)
        box(hu * 2 + 0.4, 0.16, hw * 2 + 0.4, 0, 0, top + 2.6, sheetTop.setHex(sheet).lerp(new Color(0xffffff), 0.35).getHex())
        tankY = top + 2.76
        spread = k * 0.6
        break
      }
    }
    // 不鏽鋼水塔：一兩個，站在矮矮的架子上
    if (pick() < 0.7) {
      const tanks = sh.area > 220 && pick() < 0.5 ? 2 : 1
      for (let k = 0; k < tanks; k++) {
        const u = (pick() - 0.5) * sh.lu * spread
        const w = (pick() - 0.5) * sh.lw * spread
        const r = 0.7 + pick() * 0.35
        if (!fits(r, r, u, w)) continue
        const [x, z] = at(u, w)
        roofs.add(new BoxGeometry(r * 1.7, 0.5, r * 1.7).rotateY(heading).translate(x, tankY + 0.25, z), MACHINE)
        roofs.add(new CylinderGeometry(r, r, 1.6, 10).translate(x, tankY + 1.3, z), STEEL)
        roofs.add(new CylinderGeometry(r * 0.96, r, 0.25, 10).translate(x, tankY + 2.2, z), STEEL)
      }
    }
  })
  const glow = night ? 1 : 0.8
  for (const [builders, draws] of [
    [glass, GLASS_DRAW],
    [tile, TILE_DRAW],
  ] as const) {
    builders.forEach((b, k) => {
      if (!b.pos.length) return
      scene.add(
        new Mesh(
          b.geometry(),
          new MeshLambertMaterial({
            map: tex(128, 128, (ctx) => draws[k](ctx, false)),
            vertexColors: true,
            emissiveMap: tex(128, 128, (ctx) => draws[k](ctx, true)),
            emissive: 0xffffff,
            emissiveIntensity: glow,
          }),
        ),
      )
    })
  }
  const roofMesh = roofs.mesh(new MeshLambertMaterial({ vertexColors: true }))
  if (roofMesh) scene.add(roofMesh)
  const lightMesh = lights.mesh(new MeshBasicMaterial({ vertexColors: true }))
  if (lightMesh) scene.add(lightMesh)
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
function addTrees(
  scene: Scene,
  track: TrackPath,
  buildings: Building[],
  streets: Street[],
  osmTrees: Float32Array,
  groundAt: GroundAt,
  overhead: (x: number, z: number) => boolean,
) {
  const near = 420
  const blocked = new Grid<Building | Street>(40)
  for (const item of [...buildings, ...streets]) {
    const pts = 'ring' in item ? item.ring : item.pts
    const pad = 'half' in item ? item.half : 0
    const [minX, minZ, maxX, maxZ] = bounds(pts)
    blocked.add(minX - pad, minZ - pad, maxX + pad, maxZ + pad, item)
  }
  const free = (x: number, z: number) => {
    if (overhead(x, z)) return false
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
