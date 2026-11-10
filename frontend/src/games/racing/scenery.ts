// 賽道旁邊的熱鬧：看台和觀眾、彎道外面的人群、廣告看板、護欄上的廣告布條、看台屋頂的旗子，
// 還有每條賽道自己的點綴（海上的帆船、燈塔、沙灘傘，峽谷的熱氣球，夜城的探照燈，信義空橋上的人）。
// 觀眾會跳、會舉手，鏡頭跟著的那台車開過去時附近的人特別激動，看台上不時有人浪；
// 動作都在 vertex shader 裡算（InstancedMesh + onBeforeCompile），每個畫面只改兩個 uniform。
// 位置都是照賽道自動找的：離每一段路都夠遠、不在橋下、地面和路面差不多高、不壓到建築和水面。
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  type CanvasTexture,
  type Scene,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { ADS, atlas, Quads, type Cell } from './ads'
import { SKYWAY_DECK } from './landmarks'
import { rng } from './noise'
import { frameAt, place, Solids, type Frame } from './solids'
import type { TrackPath } from './track'
import type { TrackDef } from './tracks'

type Tex = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => CanvasTexture
type GroundAt = (x: number, z: number) => number

export type SceneryOptions = {
  night: boolean
  /** 地上有東西（城市的建築）：人不能站、看台不能蓋 */
  blocked?: (x: number, z: number) => boolean
  /** 上面有東西（空橋）：看台、看板不能蓋 */
  covered?: (x: number, z: number) => boolean
  /** 水面的高度：低於它的地方不放 */
  water?: number
  wallHeight: number
  /** 城市的人行空橋（信義）：上面站人 */
  skyways?: { half: number; pts: Float32Array }[]
}

export type Scenery = {
  /** (x, z) 半徑 r 以內有沒有被看台、看板佔了：樹、大樓、路燈不要放在這裡 */
  occupied: (x: number, z: number, r: number) => boolean
  /** 每個畫面：時間（秒）和鏡頭跟著的那台車的位置 */
  update: (time: number, x: number, z: number) => void
}

// ---------- 會動的材質 ----------

type Uniforms = { uTime: { value: number }; uFocus: { value: Vector2 } }

/**
 * Lambert 材質加上一段 vertex shader：`motion` 在 begin_vertex 之後改 `transformed`（可以用 uTime、uFocus、
 * instanceMatrix、aPart）。頂點的 aPart 大於 0.5 的部分才乘上每個 instance 的顏色（衣服、船身），其他保持原色（臉、褲子）
 */
function animated(
  uniforms: Uniforms,
  key: string,
  motion: string,
  { extra = '', double = false, glow = 0 }: { extra?: string; double?: boolean; glow?: number } = {},
): MeshLambertMaterial {
  const mat = new MeshLambertMaterial({ vertexColors: true })
  if (double) mat.side = DoubleSide
  mat.onBeforeCompile = (shader) => {
    // 夜裡自己亮一點（看台的燈照著），不然在暗處只剩黑影
    if (glow > 0) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vColor.rgb * ${glow.toFixed(2)};`,
      )
    }
    shader.uniforms.uTime = uniforms.uTime
    shader.uniforms.uFocus = uniforms.uFocus
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aPart;
        uniform float uTime;
        uniform vec2 uFocus;
        ${extra}
        float hash12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          vColor = vec4( 1.0 );
        #endif
        #ifdef USE_COLOR
          vColor.rgb *= color;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, step( 0.5, aPart ) );
        #endif`,
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n{\n${motion}\n}`)
  }
  mat.customProgramCacheKey = () => `${key}:${glow}`
  return mat
}

/** 幾塊小模型合成一個，每塊有自己的顏色和 aPart（1 是要乘上 instance 顏色的部分） */
function pieces(list: [BufferGeometry, number, number][]): BufferGeometry {
  const c = new Color()
  // 全部有索引才能照原樣合起來，不然都換成沒有索引的
  const indexed = list.every(([g]) => g.index)
  const parts = list.map(([g0, hex, part]) => {
    const g = indexed || !g0.index ? g0 : g0.toNonIndexed()
    if (g !== g0) g0.dispose()
    g.deleteAttribute('uv')
    const n = g.getAttribute('position').count
    c.setHex(hex)
    const col = new Float32Array(n * 3)
    for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3)
    g.setAttribute('color', new BufferAttribute(col, 3))
    g.setAttribute('aPart', new BufferAttribute(new Float32Array(n).fill(part), 1))
    return g
  })
  const merged = mergeGeometries(parts)
  for (const g of parts) g.dispose()
  return merged
}

// ---------- 觀眾 ----------

/** 站著的人：褲子、上衣、頭、舉起來的兩隻手（平常放下來，在 shader 裡往下移 0.5 公尺） */
function personGeometry(): BufferGeometry {
  return pieces([
    [new BoxGeometry(0.32, 0.82, 0.2).translate(0, 0.41, 0), 0x2f3a52, 0],
    [new BoxGeometry(0.44, 0.62, 0.26).translate(0, 1.13, 0), 0xffffff, 1],
    [new BoxGeometry(0.22, 0.25, 0.22).translate(0, 1.58, 0), 0xd9a982, 0],
    [new BoxGeometry(0.11, 0.56, 0.11).translate(-0.29, 1.72, 0), 0xffffff, 2],
    [new BoxGeometry(0.11, 0.56, 0.11).translate(0.29, 1.72, 0), 0xffffff, 2],
  ])
}

const SHIRTS = [
  0xe63946, 0xf1faee, 0x457b9d, 0xffb703, 0x2a9d8f, 0xf4a261, 0x8338ec, 0x06d6a0, 0xef476f, 0xffffff, 0x2b2d42, 0xff8fab,
  0x3a86ff, 0xfb5607,
]

/** 一個觀眾：腳底的位置、朝向、大小，`wave` 是人浪的位置（沿著賽道的距離；不參加人浪是 -1） */
type Person = { x: number; y: number; z: number; rot: number; s: number; wave: number }

// 平常三成的人在跳、揮手；鏡頭跟著的車開到 20～70 公尺內時幾乎大家都跳起來。
// 人浪：看台上一段一段站起來舉手，大約 15 公尺寬，每秒往前跑 15 公尺，約 17 秒一次
const CROWD_MOTION = /* glsl */ `
  vec2 wp = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
  float near = 1.0 - smoothstep(20.0, 70.0, distance(wp, uFocus));
  float r = aSeed.y;
  float cheer = step(0.72 - near * 0.62, r) * max(0.0, sin(uTime * (6.0 + r * 5.0) + r * 50.0));
  float w = aSeed.x < 0.0 ? 1.0 : fract(uTime * 0.06 - aSeed.x * 0.004);
  float wave = smoothstep(0.0, 0.025, w) * (1.0 - smoothstep(0.025, 0.06, w));
  float up = max(cheer, wave);
  transformed.y += up * 0.16 + step(1.5, aPart) * (up - 1.0) * 0.5;
`

function addCrowd(scene: Scene, people: Person[], uniforms: Uniforms, seed: number, night: boolean) {
  if (!people.length) return
  const rand = rng(seed)
  const geo = personGeometry()
  const mesh = new InstancedMesh(
    geo,
    animated(uniforms, 'racing-crowd', CROWD_MOTION, { extra: 'attribute vec2 aSeed;', glow: night ? 0.3 : 0 }),
    people.length,
  )
  const seeds = new Float32Array(people.length * 2)
  const dummy = new Object3D()
  const color = new Color()
  people.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z)
    dummy.rotation.set(0, p.rot, 0)
    dummy.scale.set(p.s, p.s * (0.9 + rand() * 0.18), p.s)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
    mesh.setColorAt(i, color.setHex(SHIRTS[Math.floor(rand() * SHIRTS.length)]))
    seeds[i * 2] = p.wave
    seeds[i * 2 + 1] = rand()
  })
  geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 2))
  mesh.computeBoundingSphere()
  scene.add(mesh)
}

// ---------- 被佔走的地方 ----------

/** 一塊塊長方形（看台、看板）：樹、大樓、路燈不要放進來 */
class Zones {
  private readonly list: { x: number; z: number; ax: number; az: number; nx: number; nz: number; hu: number; hv: number }[] = []

  add(f: Frame, u0: number, u1: number, v0: number, v1: number) {
    const [x, z] = place(f, (u0 + u1) / 2, (v0 + v1) / 2)
    this.list.push({ x, z, ax: f.ax, az: f.az, nx: f.nx, nz: f.nz, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2 })
  }

  hit(x: number, z: number, r: number): boolean {
    for (const b of this.list) {
      const dx = x - b.x
      const dz = z - b.z
      if (Math.abs(dx * b.ax + dz * b.az) < b.hu + r && Math.abs(dx * b.nx + dz * b.nz) < b.hv + r) return true
    }
    return false
  }
}

// ---------- 看台 ----------

/** 看台一排的深度、每排高多少、前緣離護欄多遠 */
const ROW = 0.9
const RISE = 0.55
const STAND_GAP = 2.4
/** 屋頂往賽道那邊伸出去多少（不能碰到護欄外 1.2 公尺的路燈和起跑門的柱子） */
const OVERHANG = 1.0

export function addScenery(
  scene: Scene,
  track: TrackPath,
  def: TrackDef,
  groundAt: GroundAt,
  opts: SceneryOptions,
  tex: Tex,
): Scenery {
  const uniforms: Uniforms = { uTime: { value: 0 }, uFocus: { value: new Vector2(1e6, 1e6) } }
  const zones = new Zones()
  const people: Person[] = []
  const flags: { x: number; y: number; z: number; color: string }[] = []
  const beams: { mesh: Mesh; tilt: number; speed: number; phase: number }[] = []
  const solid = new Solids()
  const glow = new Solids()
  const boards = atlas(tex, 2, 4, 512, 256)
  const strips = atlas(tex, 2, 8, 512, 64)
  const boardQuads = new Quads()
  const stripQuads = new Quads()
  const rand = rng(def.id.length * 131 + 7)
  const night = opts.night
  const L = track.length
  const { px, pz, tx, tz } = track

  const concrete = night ? 0x454957 : 0xc4c7cd
  const roofColor = night ? 0x2c2e38 : 0xeceef0
  const seats = [def.theme.curb[0], night ? 0x30323c : 0xdedede]

  /** 一塊地方能不能用：每一點都離賽道夠遠、不在橋下、不壓到建築和水、沒被佔走；回傳地面最低和最高 */
  const area = (f: Frame, u0: number, u1: number, v0: number, v1: number, needSky: boolean) => {
    let lo = Infinity
    let hi = -Infinity
    const nu = Math.max(1, Math.ceil((u1 - u0) / 3))
    for (let a = 0; a <= nu; a++) {
      for (const v of [v0, (v0 + v1) / 2, v1]) {
        const [x, z] = place(f, u0 + ((u1 - u0) * a) / nu, v)
        if (track.nearest(x, z).dist < track.wall + 1.2) return null
        const g = groundAt(x, z)
        if (track.under(x, z, g, 1)) return null
        if (opts.blocked?.(x, z) || (needSky && opts.covered?.(x, z))) return null
        if (opts.water !== undefined && g < opts.water + 0.4) return null
        if (zones.hit(x, z, 1)) return null
        lo = Math.min(lo, g)
        hi = Math.max(hi, g)
      }
    }
    return { lo, hi }
  }

  /** 沿著賽道的距離差（繞一圈的） */
  const gap = (a: number, b: number) => {
    const d = Math.abs(a - b) % L
    return Math.min(d, L - d)
  }

  /** 第 i 點附近 ±half 公尺有沒有橋（看台、人群不要放在高架旁邊） */
  const nearBridge = (i: number, half: number) => {
    const k = Math.ceil(half / track.step)
    for (let d = -k; d <= k; d++) if (track.bridge[(i + d + track.n) % track.n]) return true
    return false
  }

  const box = (g: Solids, f: Frame, w: number, h: number, d: number, u: number, y: number, v: number, color: number) => {
    g.add(new BoxGeometry(w, h, d).translate(u, y, v).rotateY(f.rot).translate(f.x, 0, f.z), color)
  }

  /** 本地座標換成世界座標 [x, y, z] */
  const at = (f: Frame, u: number, y: number, v: number) => {
    const [x, z] = place(f, u, v)
    return [x, y, z]
  }

  /** 在第 i 點、side 那一邊蓋一座 len 公尺長、rows 排的看台；成功回傳 true */
  const stand = (i: number, side: number, len: number, rows: number, main: boolean) => {
    if (nearBridge(i, len / 2 + 6)) return false
    const f = frameAt(px[i], pz[i], tx[i], tz[i], side, track.wall + STAND_GAP)
    const depth = rows * ROW + 0.4
    const ok = area(f, -len / 2 - 0.5, len / 2 + 0.5, -OVERHANG, depth, true)
    if (!ok) return false
    const road = track.roadY(i, side * track.wall)
    // 地面比路面高太多（山坡）會把看台埋起來、低太多（路堤）看台會懸空
    if (ok.hi > road + 0.6 || ok.lo < road - 5) return false
    zones.add(f, -len / 2 - 0.5, len / 2 + 0.5, -OVERHANG - 0.5, depth + 0.5)
    const bottom = ok.lo - 0.6
    // 第一排比路面高 0.9 公尺，看得到護欄後面的路
    const base = road + 0.9
    const roofY = base + (rows - 1) * RISE + 3.2
    for (let k = 0; k < rows; k++) {
      const top = base + k * RISE
      box(solid, f, len, top - bottom, ROW, 0, (top + bottom) / 2, k * ROW + ROW / 2, seats[k % 2])
    }
    // 前面的矮牆（貼布條）、後牆、兩側的牆、屋頂和屋簷
    const wallTop = base + 0.95
    box(solid, f, len, wallTop - bottom, 0.25, 0, (wallTop + bottom) / 2, -0.125, concrete)
    box(solid, f, len, roofY - bottom, 0.3, 0, (roofY + bottom) / 2, rows * ROW + 0.15, concrete)
    for (const e of [-1, 1]) {
      box(solid, f, 0.35, roofY - bottom, depth + 0.1, e * (len / 2 + 0.17), (roofY + bottom) / 2, depth / 2 - 0.05, concrete)
    }
    const roofD = depth + OVERHANG
    box(solid, f, len + 1.2, 0.35, roofD, 0, roofY + 0.17, depth - roofD / 2, roofColor)
    const fasciaH = main ? 1.6 : 1.2
    box(solid, f, len + 1.2, fasciaH, 0.2, 0, roofY + 0.35 - fasciaH / 2 + 0.3, -OVERHANG + 0.1, concrete)
    // 屋簷下的燈（夜裡）
    if (night || def.theme.lamps) {
      box(glow, f, len, 0.22, 0.35, 0, roofY - 0.11, -OVERHANG + 0.5, 0xfff1d0)
      box(glow, f, len, 0.18, 0.3, 0, roofY - 0.09, depth * 0.55, 0xfff1d0)
    }

    // 屋簷和矮牆上的廣告：從賽道看過去是正面（+u 在左邊，所以左下角是 u 大的那頭）
    const ads = (y0: number, h: number, v: number, half: number, cells: Cell[], quads: Quads) => {
      const n = Math.max(1, Math.round((half * 2) / (h * (cells === boards.cells ? 2 : 8))))
      const w = (half * 2) / n
      for (let k = 0; k < n; k++) {
        const ua = half - k * w
        const ub = ua - w
        const cell = cells[Math.floor(rand() * cells.length)]
        quads.quad(at(f, ua, y0, v), at(f, ub, y0, v), at(f, ub, y0 + h, v), at(f, ua, y0 + h, v), cell)
      }
    }
    ads(roofY + 0.35 - fasciaH + 0.3 + 0.08, fasciaH - 0.16, -OVERHANG - 0.005, len / 2 + 0.5, strips.cells, stripQuads)
    ads(base + 0.05, 0.85, -0.255, len / 2, strips.cells, stripQuads)
    // 兩側的牆外面各一張大看板（沿著賽道開過來先看到的那面）
    const bw = Math.min(depth * 0.86, (roofY - base) * 1.4)
    const bh = bw / 2
    const by = roofY - 0.4 - bh
    const bv = depth / 2 - 0.05
    for (const e of [-1, 1]) {
      const u = e * (len / 2 + 0.36)
      // 左下角、右下角的 v：從 +u 那頭看過去右手邊是賽道（v 小的那邊），-u 那頭反過來
      const left = bv + (e * bw) / 2
      const right = bv - (e * bw) / 2
      const cell = boards.cells[Math.floor(rand() * boards.cells.length)]
      boardQuads.quad(at(f, u, by, left), at(f, u, by, right), at(f, u, by + bh, right), at(f, u, by + bh, left), cell)
    }
    // 護欄內側也掛布條（看台前面那一段）
    wallBanner(i, side, len)

    // 屋頂前緣一排旗子
    for (let u = -len / 2 + 2; u <= len / 2 - 2; u += main ? 5 : 7) {
      const [x, z] = place(f, u, -OVERHANG + 0.4)
      solid.add(new CylinderGeometry(0.05, 0.06, 3.4, 5).translate(x, roofY + 0.35 + 1.7, z), 0xd8d8d8)
      flags.push({ x, y: roofY + 0.35 + 3.3, z, color: ADS[Math.floor(rand() * ADS.length)].bg })
    }

    // 觀眾：一排一排站好，偶爾空位
    for (let k = 0; k < rows; k++) {
      const v = k * ROW + 0.45
      for (let u = -len / 2 + 0.5; u <= len / 2 - 0.5; u += 0.7) {
        if (rand() < 0.14) continue
        const [x, z] = place(f, u + (rand() - 0.5) * 0.18, v + (rand() - 0.5) * 0.12)
        // 人浪照沿著賽道的距離跑（看台在左邊時本地 +u 是往回）
        const s = i * track.step - side * u
        people.push({ x, y: base + k * RISE, z, rot: f.rot + Math.PI + (rand() - 0.5) * 0.6, s: 0.92 + rand() * 0.16, wave: ((s % L) + L) % L })
      }
    }
    return true
  }

  /** 第 i 點前後 len 公尺的護欄內側（賽道那面）貼一段廣告布條 */
  const wallBanner = (i: number, side: number, len: number) => {
    const h = opts.wallHeight - 0.18
    const seg = h * 8
    const n = Math.max(1, Math.round(len / seg))
    const lat = side * (track.wall - 0.03)
    const s0 = i * track.step - (n * seg) / 2
    for (let k = 0; k < n; k++) {
      const a = track.indexAt(s0 + k * seg)
      const b = track.indexAt(s0 + (k + 1) * seg)
      const pa = [px[a] + tz[a] * lat, track.roadY(a, lat) + 0.08, pz[a] - tx[a] * lat]
      const pb = [px[b] + tz[b] * lat, track.roadY(b, lat) + 0.08, pz[b] - tx[b] * lat]
      const up = (p: number[]) => [p[0], p[1] + h, p[2]]
      const cell = strips.cells[Math.floor(rand() * strips.cells.length)]
      // 從賽道看左邊的護欄，往前是右手邊；右邊的護欄反過來
      if (side > 0) stripQuads.quad(pa, pb, up(pb), up(pa), cell)
      else stripQuads.quad(pb, pa, up(pa), up(pb), cell)
    }
  }

  // 起跑直線：起跑線後面一點（不要碰到起跑門的柱子），兩邊都試
  const placed: number[] = []
  for (const s of [26, 34, 18]) {
    const i = track.indexAt(s)
    let any = false
    for (const side of [-1, 1]) any = stand(i, side, 44, 8, true) || stand(i, side, 30, 7, true) || any
    if (any) {
      placed.push(s)
      break
    }
  }

  // 急彎的外側再蓋兩座小一點的
  const corners: number[] = []
  for (let i = 0; i < track.n; i += 2) corners.push(i)
  corners.sort((a, b) => Math.abs(track.curv[b]) - Math.abs(track.curv[a]))
  let extra = 0
  for (const i of corners) {
    if (extra >= 2 || Math.abs(track.curv[i]) < 1 / 140) break
    const s = i * track.step
    if (placed.some((p) => gap(p, s) < 160)) continue
    const side = track.curv[i] > 0 ? -1 : 1
    if (stand(i, side, 36, 6, false) || stand(i, side, 24, 5, false)) {
      placed.push(s)
      extra++
    }
  }

  // 彎道外側站在路邊看的人（沒有看台），也照彎的急緩挑
  const spots: number[] = []
  for (const i of corners) {
    if (spots.length >= 7 || Math.abs(track.curv[i]) < 1 / 220) break
    const s = i * track.step
    if (placed.some((p) => gap(p, s) < 60) || spots.some((p) => gap(p, s) < 90)) continue
    if (nearBridge(i, 20)) continue
    const side = track.curv[i] > 0 ? -1 : 1
    const before = people.length
    roadside(i, side)
    if (people.length - before > 12) spots.push(s)
    else people.length = before
  }

  function roadside(i: number, side: number) {
    const f = frameAt(px[i], pz[i], tx[i], tz[i], side, track.wall + 1.6)
    const road = track.roadY(i, side * track.wall)
    const half = 14 + rand() * 10
    for (let row = 0; row < 3; row++) {
      for (let u = -half; u <= half; u += 0.75) {
        if (rand() < 0.3 + row * 0.12) continue
        const [x, z] = place(f, u + (rand() - 0.5) * 0.3, row * 0.9 + (rand() - 0.5) * 0.3)
        if (track.nearest(x, z).dist < track.wall + 1.2) continue
        const g = groundAt(x, z)
        if (g > road + 1.5 || g < road - 2.5 || track.under(x, z, g, 1)) continue
        if (opts.blocked?.(x, z) || zones.hit(x, z, 0.3)) continue
        if (opts.water !== undefined && g < opts.water + 0.3) continue
        people.push({ x, y: g, z, rot: f.rot + Math.PI + (rand() - 0.5) * 0.9, s: 0.9 + rand() * 0.2, wave: -1 })
      }
    }
  }

  // 廣告看板：大約每 170 公尺一面，左右輪流，斜斜地朝著開過來的車
  const every = 170
  for (let s = 70, k = 0; s < L - 40; s += every, k++) {
    const i = track.indexAt(s)
    if (nearBridge(i, 8) || placed.some((p) => gap(p, s) < 40)) continue
    for (const side of k % 2 ? [1, -1] : [-1, 1]) {
      const f = frameAt(px[i], pz[i], tx[i], tz[i], side, track.wall + 3.4)
      const ok = area(f, -4.6, 4.6, -0.6, 1.6, true)
      if (!ok) continue
      const road = track.roadY(i, side * track.wall)
      if (ok.hi > road + 2 || ok.lo < road - 4) continue
      zones.add(f, -4.6, 4.6, -0.8, 1.8)
      billboard(f, side, ok.lo)
      break
    }
  }

  function billboard(f: Frame, side: number, ground: number) {
    // 板子正面朝賽道、往開過來的方向轉 35 度
    const turn = -side * 0.6
    const g: Frame = { ...f, rot: f.rot + turn }
    const c = Math.cos(g.rot)
    const sn = Math.sin(g.rot)
    g.ax = c
    g.az = -sn
    g.nx = sn
    g.nz = c
    const bottom = ground + 2.6
    const w = 8.4
    const h = 4.2
    for (const e of [-1, 1]) {
      const [x, z] = place(g, e * w * 0.32, 0.25)
      solid.add(new CylinderGeometry(0.16, 0.2, bottom + 0.6 - ground, 6).translate(x, (bottom + 0.6 + ground) / 2 - 0.3, z), 0x6b6f78)
    }
    box(solid, g, w + 0.3, h + 0.3, 0.3, 0, bottom + h / 2, 0.2, night ? 0x24262e : 0xe8e8e8)
    const cell = boards.cells[Math.floor(rand() * boards.cells.length)]
    const y1 = bottom + h
    boardQuads.quad(at(g, w / 2, bottom, 0.04), at(g, -w / 2, bottom, 0.04), at(g, -w / 2, y1, 0.04), at(g, w / 2, y1, 0.04), cell)
    // 背面也貼一張（另一個方向開過來看得到）
    const back = boards.cells[Math.floor(rand() * boards.cells.length)]
    boardQuads.quad(at(g, -w / 2, bottom, 0.36), at(g, w / 2, bottom, 0.36), at(g, w / 2, y1, 0.36), at(g, -w / 2, y1, 0.36), back)
    if (night) box(glow, g, w, 0.12, 0.4, 0, y1 + 0.3, -0.25, 0xfff1d0)
  }

  /** 空橋上靠著兩邊玻璃往下看的人（只站在賽道上方那一段） */
  function skywayCrowd(list: { half: number; pts: Float32Array }[]) {
    for (const { half, pts } of list) {
      for (let k = 0; k + 2 < pts.length; k += 2) {
        const ax = pts[k]
        const az = pts[k + 1]
        const dx = pts[k + 2] - ax
        const dz = pts[k + 3] - az
        const len = Math.hypot(dx, dz)
        if (len < 0.5) continue
        const ux = dx / len
        const uz = dz / len
        for (let s = 0.4; s < len; s += 0.65) {
          const cx = ax + ux * s
          const cz = az + uz * s
          if (track.nearest(cx, cz).dist > track.wall + 4) continue
          for (const e of [-1, 1]) {
            if (rand() < 0.35) continue
            const off = e * (half - 0.45)
            const x = cx + uz * off
            const z = cz - ux * off
            people.push({ x, y: groundAt(cx, cz) + SKYWAY_DECK, z, rot: Math.atan2(uz * e, -ux * e), s: 0.92 + rand() * 0.16, wave: -1 })
          }
        }
      }
    }
  }

  /** 找符合條件的地點：在賽道範圍外圍 `from`～`to` 公尺內亂數找 */
  const search = (count: number, from: number, to: number, test: (x: number, z: number, g: number) => boolean) => {
    const cx = (track.minX + track.maxX) / 2
    const cz = (track.minZ + track.maxZ) / 2
    const rx = (track.maxX - track.minX) / 2
    const rz = (track.maxZ - track.minZ) / 2
    const out: [number, number, number][] = []
    for (let k = 0; k < count * 40 && out.length < count; k++) {
      const a = rand() * Math.PI * 2
      const d = from + rand() * (to - from)
      const x = cx + Math.cos(a) * (rx + d)
      const z = cz + Math.sin(a) * (rz + d)
      const g = groundAt(x, z)
      if (test(x, z, g)) out.push([x, z, g])
    }
    return out
  }

  /** 海上的帆船：慢慢上下晃 */
  function boats() {
    if (opts.water === undefined) return
    const water = opts.water
    // 霧在一公里左右就全白了：放在離賽道一、兩百公尺的海上才看得到
    const spots = search(16, -40, 260, (x, z, g) => g < water - 1.5 && track.nearest(x, z).dist > 60)
    if (!spots.length) return
    const sail = new BufferGeometry()
    sail.setAttribute('position', new BufferAttribute(new Float32Array([0, 1.4, 0.3, 0, 8.6, 0.3, 0, 1.6, -3.2]), 3))
    sail.computeVertexNormals()
    const geo = pieces([
      [new BoxGeometry(2.2, 1.1, 7).translate(0, 0.2, 0), 0xffffff, 1],
      [new BoxGeometry(1.6, 0.8, 2.4).translate(0, 1.1, -0.8), 0xf2f2f2, 0],
      [new CylinderGeometry(0.07, 0.09, 8, 5).translate(0, 4.8, 0.4), 0xdddddd, 0],
      [sail, 0xfafafa, 0],
    ])
    const motion = /* glsl */ `
      float ph = hash12(vec2(instanceMatrix[3].x, instanceMatrix[3].z)) * 6.28;
      transformed.y += sin(uTime * 1.1 + ph) * 0.22;
      transformed.y += transformed.x * sin(uTime * 0.9 + ph * 1.7) * 0.04;
    `
    const mesh = new InstancedMesh(geo, animated(uniforms, 'racing-boat', motion, { double: true }), spots.length)
    const dummy = new Object3D()
    const color = new Color()
    const hulls = [0xffffff, 0x1d3557, 0xc1121f, 0xffffff, 0x2a9d8f]
    spots.forEach(([x, z], k) => {
      dummy.position.set(x, water - 0.1, z)
      dummy.rotation.set(0, rand() * Math.PI * 2, 0)
      dummy.scale.setScalar(1.1 + rand() * 0.7)
      dummy.updateMatrix()
      mesh.setMatrixAt(k, dummy.matrix)
      mesh.setColorAt(k, color.setHex(hulls[k % hulls.length]))
    })
    mesh.frustumCulled = false
    scene.add(mesh)
  }

  /** 海邊的燈塔：找靠海、離賽道有點距離的高地 */
  function lighthouse() {
    if (opts.water === undefined) return
    const water = opts.water
    // 在賽道外圍每 15 公尺找一點：地面比海面高 2～25 公尺、40 公尺內有海、離賽道 60～260 公尺，挑最靠近賽道的
    let best: [number, number, number] | null = null
    let bestD = Infinity
    for (let x = track.minX - 260; x <= track.maxX + 260; x += 15) {
      for (let z = track.minZ - 260; z <= track.maxZ + 260; z += 15) {
        const g = groundAt(x, z)
        if (g < water + 2 || g > water + 25) continue
        const d = track.nearest(x, z).dist
        if (d < 60 || d > 260 || d > bestD) continue
        let sea = false
        for (let a = 0; a < 8 && !sea; a++) sea = groundAt(x + Math.cos(a * 0.785) * 40, z + Math.sin(a * 0.785) * 40) < water
        if (!sea || zones.hit(x, z, 6)) continue
        best = [x, z, g]
        bestD = d
      }
    }
    if (!best) return
    const [x, z, g] = best
    const put = (geo: BufferGeometry, y: number, color: number) => solid.add(geo.translate(x, g + y, z), color)
    put(new CylinderGeometry(3.4, 3.8, 1.2, 12), 0.3, 0x9a968c)
    for (let k = 0; k < 4; k++) {
      const r0 = 2.3 - k * 0.18
      put(new CylinderGeometry(r0 - 0.18, r0, 4.5, 12), 0.9 + k * 4.5 + 2.25, k % 2 ? 0xc8202a : 0xf6f6f2)
    }
    put(new CylinderGeometry(2.2, 2.2, 0.4, 12), 19.2, 0x2b2b2b)
    put(new ConeGeometry(1.5, 1.6, 12), 22.6, 0xc8202a)
    glow.add(new CylinderGeometry(1.15, 1.15, 2.2, 10).translate(x, g + 20.7, z), 0xfff2b8)
    put(new BoxGeometry(6, 3.2, 4.4), 1.6, 0xf1efe8)
    zones.add(frameAt(x, z, 1, 0, 1, 0), -5, 5, -5, 5)
  }

  /** 沙灘傘（傘下面站一兩個人） */
  function umbrellas() {
    if (opts.water === undefined) return
    const water = opts.water
    // 只放在沙灘上（地形的顏色：靠海的低地、離賽道 50 公尺以外）
    const spots = search(46, 0, 260, (x, z, g) => g > water + 0.15 && g < 0.25 && track.nearest(x, z).dist > 56)
    if (!spots.length) return
    const canopy = new ConeGeometry(1.6, 0.7, 8, 1, true).translate(0, 2.35, 0).toNonIndexed()
    const n = canopy.getAttribute('position').count
    const geo = pieces([
      [canopy, 0xffffff, 0],
      [new CylinderGeometry(0.04, 0.04, 2.4, 4).translate(0, 1.2, 0).toNonIndexed(), 0xdddddd, 0],
    ])
    // 一片彩色一片白：圓錐每一片是兩個三角形（一個是頂點那裡的退化三角形）
    const parts = geo.getAttribute('aPart') as BufferAttribute
    for (let k = 0; k < n; k++) parts.setX(k, Math.floor(k / 6) % 2)
    const mesh = new InstancedMesh(geo, animated(uniforms, 'racing-static', ''), spots.length)
    const dummy = new Object3D()
    const color = new Color()
    const tops = [0xe63946, 0x1d6fd8, 0xffc300, 0x06a77d]
    spots.forEach(([x, z, g], k) => {
      dummy.position.set(x, g, z)
      dummy.rotation.set((rand() - 0.5) * 0.2, rand() * Math.PI, (rand() - 0.5) * 0.2)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      mesh.setMatrixAt(k, dummy.matrix)
      mesh.setColorAt(k, color.setHex(tops[k % tops.length]))
      const crowd = Math.floor(rand() * 3)
      for (let p = 0; p < crowd; p++) {
        const a = rand() * Math.PI * 2
        people.push({ x: x + Math.cos(a) * 1.1, y: g, z: z + Math.sin(a) * 1.1, rot: rand() * 6.28, s: 0.9 + rand() * 0.2, wave: -1 })
      }
    })
    scene.add(mesh)
  }

  /** 峽谷上空的熱氣球：條紋的球皮、吊籃，慢慢飄 */
  function balloons() {
    // 霧 880 公尺就全白：飄在賽道外圍幾百公尺內、比地面高 50～130 公尺，從賽道上抬頭看得到
    const spots = search(10, -80, 240, (x, z) => track.nearest(x, z).dist > 60)
    if (!spots.length) return
    const prof = [
      [0.9, 0],
      [1.7, 2],
      [4.6, 6],
      [7.2, 11],
      [8, 15],
      [7.4, 19],
      [5.2, 22],
      [2.4, 23.6],
      [0.01, 24],
    ].map(([r, y]) => new Vector2(r, y))
    const env = new LatheGeometry(prof, 16).toNonIndexed()
    // 一條彩色一條白色（LatheGeometry 的面照著一圈一圈的順序排：每一圈 (點數 - 1) × 2 個三角形）
    const perSeg = (prof.length - 1) * 2 * 3
    const n = env.getAttribute('position').count
    const tint = new Float32Array(n)
    for (let k = 0; k < n; k++) tint[k] = Math.floor(k / perSeg) % 2 ? 1 : 0
    const ropes: [BufferGeometry, number, number][] = []
    for (const [rx, rz] of [
      [0.55, 0.55],
      [-0.55, 0.55],
      [0.55, -0.55],
      [-0.55, -0.55],
    ]) {
      ropes.push([new CylinderGeometry(0.03, 0.03, 3.2, 3).translate(rx, -1.6, rz), 0x3a2a1a, 0])
    }
    const geo = pieces([[env, 0xffffff, 0], [new BoxGeometry(1.4, 1.1, 1.4).translate(0, -3.6, 0), 0x7a5230, 0], ...ropes])
    const parts = geo.getAttribute('aPart') as BufferAttribute
    for (let k = 0; k < n; k++) parts.setX(k, tint[k])
    const motion = /* glsl */ `
      float ph = hash12(vec2(instanceMatrix[3].x, instanceMatrix[3].z)) * 6.28;
      transformed.y += sin(uTime * 0.35 + ph) * 1.2;
      transformed.x += sin(uTime * 0.05 + ph) * 10.0;
      transformed.z += cos(uTime * 0.04 + ph * 1.3) * 10.0;
    `
    const mesh = new InstancedMesh(geo, animated(uniforms, 'racing-balloon', motion), spots.length)
    const dummy = new Object3D()
    const color = new Color()
    const skins = [0xe63946, 0xffb703, 0x3a86ff, 0x8338ec, 0x06d6a0, 0xfb5607, 0xff006e]
    spots.forEach(([x, z, g], k) => {
      dummy.position.set(x, Math.max(g, 0) + 50 + rand() * 80, z)
      dummy.rotation.set(0, rand() * Math.PI, 0)
      dummy.scale.setScalar(0.85 + rand() * 0.4)
      dummy.updateMatrix()
      mesh.setMatrixAt(k, dummy.matrix)
      mesh.setColorAt(k, color.setHex(skins[k % skins.length]))
    })
    mesh.frustumCulled = false
    scene.add(mesh)
  }

  /** 夜城的探照燈：從起跑直線附近的地面往天空掃 */
  function searchlights() {
    const geo = new ConeGeometry(16, 420, 20, 1, true).rotateX(Math.PI).translate(0, 210, 0)
    const mat = new ShaderMaterial({
      uniforms: { uColor: { value: new Color(0xbfe3ff) } },
      vertexShader: /* glsl */ `
        varying float vT;
        void main() {
          vT = uv.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vT;
        void main() {
          gl_FragColor = vec4(uColor * pow(vT, 2.2) * 0.16, 1.0);
        }
      `,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    })
    const p0 = track.pointAt(0)
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4
      const x = p0.x + Math.cos(a) * 140
      const z = p0.z + Math.sin(a) * 140
      if (track.nearest(x, z).dist < track.wall + 6) continue
      const mesh = new Mesh(geo, mat)
      mesh.position.set(x, groundAt(x, z), z)
      mesh.frustumCulled = false
      scene.add(mesh)
      beams.push({ mesh, tilt: 0.32 + k * 0.06, speed: 0.25 + k * 0.07, phase: k * 2.1 })
    }
  }

  // 每條賽道自己的點綴
  for (const kind of def.decor ?? []) {
    if (kind === 'skywayCrowd' && opts.skyways) skywayCrowd(opts.skyways)
    else if (kind === 'boats') boats()
    else if (kind === 'lighthouse') lighthouse()
    else if (kind === 'umbrellas') umbrellas()
    else if (kind === 'balloons') balloons()
    else if (kind === 'searchlights') searchlights()
  }

  // ---------- 建網格 ----------

  addCrowd(scene, people, uniforms, def.id.length * 17 + 3, night)
  if (flags.length) addFlags(scene, flags, uniforms, night)
  const solids = solid.mesh(new MeshLambertMaterial({ vertexColors: true, emissive: night ? 0x1c1e28 : 0x000000 }))
  if (solids) scene.add(solids)
  const lights = glow.mesh(new MeshBasicMaterial({ vertexColors: true }))
  if (lights) scene.add(lights)
  const b = boardQuads.mesh(boards.map, night)
  if (b) scene.add(b)
  const st = stripQuads.mesh(strips.map, night)
  if (st) scene.add(st)

  return {
    occupied: (x, z, r) => zones.hit(x, z, r),
    update: (time, x, z) => {
      uniforms.uTime.value = time
      uniforms.uFocus.value.set(x, z)
      for (const beam of beams) {
        const a = time * beam.speed + beam.phase
        beam.mesh.rotation.set(Math.sin(a) * beam.tilt, 0, Math.cos(a * 0.8) * beam.tilt)
      }
    },
  }
}

/** 看台屋頂的旗子：照同一個風向飄，越靠旗尾擺得越大 */
function addFlags(scene: Scene, list: { x: number; y: number; z: number; color: string }[], uniforms: Uniforms, night: boolean) {
  const geo = new PlaneGeometry(1.5, 0.95, 8, 1).translate(0.75, -0.475, 0)
  const n = geo.getAttribute('position').count
  geo.setAttribute('color', new BufferAttribute(new Float32Array(n * 3).fill(1), 3))
  geo.setAttribute('aPart', new BufferAttribute(new Float32Array(n).fill(1), 1))
  const motion = /* glsl */ `
    float fx = position.x;
    float ph = hash12(vec2(instanceMatrix[3].x, instanceMatrix[3].z)) * 6.28;
    transformed.z += sin(fx * 3.2 - uTime * 7.0 + ph) * fx * 0.14;
    transformed.y -= fx * fx * 0.03;
  `
  const mesh = new InstancedMesh(geo, animated(uniforms, 'racing-flag', motion, { double: true, glow: night ? 0.35 : 0 }), list.length)
  const dummy = new Object3D()
  const color = new Color()
  list.forEach((f, k) => {
    dummy.position.set(f.x, f.y, f.z)
    dummy.rotation.set(0, 0.8 + Math.sin(k * 1.7) * 0.12, 0)
    dummy.updateMatrix()
    mesh.setMatrixAt(k, dummy.matrix)
    mesh.setColorAt(k, color.set(f.color === 'checker' ? '#f5f5f5' : f.color))
  })
  scene.add(mesh)
}
