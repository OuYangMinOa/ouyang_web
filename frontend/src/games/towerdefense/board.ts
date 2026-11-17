import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three'
import { tileAt, type MapSpec } from './online'
import { biomeOf, groundOf, mix, rgba, tweak, type Biome, type Ground, type Theme } from './palette'
import {
  ACCENT_TINTS,
  accentGeometry,
  bushGeometry,
  crystalGeometry,
  daisGeometry,
  obeliskGeometry,
  pebbleGeometry,
  reedGeometry,
  rockGeometry,
  treeGeometry,
  tuftGeometry,
} from './scenery'

/**
 * 迷宮塔防的場地：一座浮在網頁底色上的小島。
 *
 * - 上面是畫出來的地面（一張畫布貼圖）：可以蓋塔的格子是一塊一塊的草皮，入口、出口是石板路，岩石底下是土，
 *   有的岩石換成池塘（一樣不能蓋、不能走，只是看起來不一樣，見 `PONDS`）。
 * - 可以蓋塔的範圍外面留一圈（`RIM`），長樹、灌木、草和小花；怪物和塔都到不了那裡，只是讓場地看起來有個地方。
 * - 側面是土層和岩層，底下一圈淡淡的影子。
 * - 入口是地上的漩渦和兩根石柱，出口是石階上的大水晶（漏怪時會閃紅，`hit`）。
 *
 * 一格是 1 個單位，場地中心在原點，x 往右、z 往下（對應格子的 x、y）。顏色全部從主題來，換主題就整個重做。
 */

/** 可以蓋塔的範圍外面留多寬（格）；島的邊緣是歪歪的，實際是 0.75～1.45 */
export const RIM = 1
/** 地面的貼圖比可以蓋塔的範圍每邊多畫多寬（要蓋得住歪出去的邊緣） */
const PAD = RIM + 0.5

/** 哪幾格的「岩石」畫成池塘（只是外觀，規則一樣）：[x, y] */
const PONDS: Record<string, [number, number][]> = {
  plains: [
    [14, 3],
    [14, 4],
  ],
  forks: [[4, 7]],
}

/** 這張地圖哪幾格是池塘（選單上的地圖縮圖也用） */
export function pondCells(map: MapSpec): Set<number> {
  return new Set((PONDS[map.id] ?? []).map(([x, y]) => y * map.w + x).filter((c) => tileAt(map, c) === 'rock'))
}

type Options = {
  anisotropy: number
  /** 手機：貼圖小一點、擺設少一點 */
  coarse: boolean
  /** 系統設定了「減少動態效果」：樹不搖 */
  calm: boolean
}

type Spinner = { mesh: Mesh | Sprite; spin: number; bob: number; y: number; phase: number }
type Crystal = { x: number; z: number; core: Mesh; halo: Mesh; glow: Sprite; flash: number }

/** 決定性的亂數：同一張地圖每次長得一樣 */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashText(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + k, y)
  ctx.arcTo(x + w, y, x + w, y + h, k)
  ctx.arcTo(x + w, y + h, x, y + h, k)
  ctx.arcTo(x, y + h, x, y, k)
  ctx.arcTo(x, y, x + w, y, k)
  ctx.closePath()
}

/** 中間亮、往外淡掉的圓（光暈、地上的影子共用的貼圖） */
function radialTexture(stops: [number, string][], size = 128): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    for (const [at, color] of stops) gradient.addColorStop(at, color)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, size, size)
  }
  return new CanvasTexture(canvas)
}

/** 入口地上的漩渦：三條往中心捲的光帶 */
function vortexTexture(): CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const c = size / 2
    const glow = ctx.createRadialGradient(c, c, 0, c, c, c)
    glow.addColorStop(0, 'rgba(255,255,255,0.95)')
    glow.addColorStop(0.25, 'rgba(255,255,255,0.5)')
    glow.addColorStop(0.7, 'rgba(255,255,255,0.16)')
    glow.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, size, size)
    ctx.lineCap = 'round'
    for (let arm = 0; arm < 3; arm++) {
      for (let i = 0; i < 44; i++) {
        const t = i / 44
        const r = 6 + t * 54
        const a = arm * ((Math.PI * 2) / 3) + t * 4.2
        const r2 = 6 + ((i + 1) / 44) * 54
        const a2 = arm * ((Math.PI * 2) / 3) + ((i + 1) / 44) * 4.2
        ctx.strokeStyle = `rgba(255,255,255,${0.9 * (1 - t) ** 1.2})`
        ctx.lineWidth = 7 * (1 - t) + 1.5
        ctx.beginPath()
        ctx.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r)
        ctx.lineTo(c + Math.cos(a2) * r2, c + Math.sin(a2) * r2)
        ctx.stroke()
      }
    }
  }
  return new CanvasTexture(canvas)
}

/** 樹、灌木、草會跟著風搖：越高的地方晃越多，根部不動 */
function swaying(material: MeshStandardMaterial, time: { value: number }): MeshStandardMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  float swayAt = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3;
#else
  float swayAt = 0.0;
#endif
  float swayBy = transformed.y * (0.25 + transformed.y) * 0.07;
  transformed.x += sin(uTime * 1.5 + swayAt) * swayBy;
  transformed.z += cos(uTime * 1.1 + swayAt * 1.3) * swayBy * 0.7;`,
      )
  }
  return material
}

export class Board {
  readonly group = new Group()
  /** 整座島（含外面那一圈）的半寬、半高，鏡頭照這個把場地放進畫面 */
  readonly hw: number
  readonly hh: number
  /** 入口、出口在世界座標的位置（特效用） */
  readonly spawns: [number, number][] = []
  readonly exits: [number, number][] = []
  private readonly map: MapSpec
  private readonly biome: Biome
  private readonly ground: Ground
  private readonly theme: Theme
  private readonly options: Options
  private readonly random: () => number
  private readonly owned: { dispose(): void }[] = []
  private readonly spinners: Spinner[] = []
  private readonly crystals: Crystal[] = []
  private readonly windTime = { value: 0 }
  private readonly exitColor: Color
  private readonly badColor: Color
  /** 水晶的光暈多亮：亮色主題的底色已經很亮，加太多會變成一團白 */
  private readonly glowStrength: number
  private readonly m = new Matrix4()
  private readonly p = new Vector3()
  private readonly s = new Vector3()
  private readonly q = new Quaternion()
  private readonly e = new Euler()
  private readonly c = new Color()

  constructor(map: MapSpec, theme: Theme, options: Options) {
    this.map = map
    this.theme = theme
    this.options = options
    this.biome = biomeOf(map.id)
    this.ground = groundOf(theme, this.biome)
    this.random = seeded(hashText(map.id))
    this.hw = map.w / 2 + RIM + 0.35
    this.hh = map.h / 2 + RIM + 0.35
    this.exitColor = theme.exit.clone()
    this.badColor = theme.bad.clone()
    this.glowStrength = theme.dark ? 0.8 : 0.36

    const ponds = pondCells(map)
    const edge = this.outline()
    this.buildIsland(edge, ponds)
    this.buildObstacles(ponds)
    this.buildScenery(edge)
    this.buildGates()
  }

  private keep<T extends { dispose(): void }>(item: T): T {
    this.owned.push(item)
    return item
  }

  private center(cell: number): [number, number] {
    const { w, h } = this.map
    return [(cell % w) + 0.5 - w / 2, Math.floor(cell / w) + 0.5 - h / 2]
  }

  /** 入口、出口往場地外面的方向（在邊上才有） */
  private outward(cell: number): [number, number] {
    const { w, h } = this.map
    const [x, y] = [cell % w, Math.floor(cell / w)]
    if (x === 0) return [-1, 0]
    if (x === w - 1) return [1, 0]
    if (y === 0) return [0, -1]
    if (y === h - 1) return [0, 1]
    return [0, 0]
  }

  /** 島的輪廓：圓角的長方形，邊緣歪來歪去。從上面看是逆時針（+x 往 −z 繞） */
  private outline(): { x: number; z: number }[] {
    const { map, random } = this
    const [hw, hh] = [map.w / 2 + RIM, map.h / 2 + RIM]
    const r = Math.min(2.2, hw * 0.5, hh * 0.5)
    const step = 0.45
    const pts: { x: number; y: number; nx: number; ny: number }[] = []
    const line = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number) => {
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step))
      for (let i = 0; i < n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, nx, ny })
    }
    const arc = (cx: number, cy: number, from: number) => {
      const n = Math.max(3, Math.round(((Math.PI / 2) * r) / step))
      for (let i = 0; i < n; i++) {
        const a = from + ((Math.PI / 2) * i) / n
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) })
      }
    }
    line(hw, -(hh - r), hw, hh - r, 1, 0)
    arc(hw - r, hh - r, 0)
    line(hw - r, hh, -(hw - r), hh, 0, 1)
    arc(-(hw - r), hh - r, Math.PI / 2)
    line(-hw, hh - r, -hw, -(hh - r), -1, 0)
    arc(-(hw - r), -(hh - r), Math.PI)
    line(-(hw - r), -hh, hw - r, -hh, 0, -1)
    arc(hw - r, -(hh - r), Math.PI * 1.5)
    const waves: [number, number, number][] = [
      [3, 0.15, random() * 6.283],
      [7, 0.1, random() * 6.283],
      [12, 0.06, random() * 6.283],
      [19, 0.035, random() * 6.283],
    ]
    return pts.map((p, i) => {
      const t = (i / pts.length) * Math.PI * 2
      let d = 0.1
      for (const [times, amount, phase] of waves) d += amount * Math.sin(t * times + phase)
      return { x: p.x + p.nx * d, z: -(p.y + p.ny * d) }
    })
  }

  // ---------- 地面和側面 ----------

  private buildIsland(edge: { x: number; z: number }[], ponds: Set<number>) {
    const { map, ground, options, random } = this
    const px = options.coarse ? 64 : 96
    const [tw, th] = [map.w + PAD * 2, map.h + PAD * 2]
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(tw * px)
    canvas.height = Math.round(th * px)
    const ctx = canvas.getContext('2d')
    if (ctx) this.paint(ctx, px, ponds)
    const texture = this.keep(new CanvasTexture(canvas))
    texture.colorSpace = SRGBColorSpace
    texture.anisotropy = options.anisotropy

    // 上面：從中心往輪廓拉的扇形，貼圖照 x、z 對上去
    const n = edge.length
    const position = new Float32Array((n + 1) * 3)
    const normal = new Float32Array((n + 1) * 3)
    const uv = new Float32Array((n + 1) * 2)
    const index: number[] = []
    normal[1] = 1
    uv[0] = uv[1] = 0.5
    edge.forEach((p, i) => {
      const o = (i + 1) * 3
      position[o] = p.x
      position[o + 2] = p.z
      normal[o + 1] = 1
      uv[(i + 1) * 2] = p.x / tw + 0.5
      uv[(i + 1) * 2 + 1] = 0.5 - p.z / th
      index.push(0, i + 1, ((i + 1) % n) + 1)
    })
    const topGeometry = this.keep(new BufferGeometry())
    topGeometry.setAttribute('position', new BufferAttribute(position, 3))
    topGeometry.setAttribute('normal', new BufferAttribute(normal, 3))
    topGeometry.setAttribute('uv', new BufferAttribute(uv, 2))
    topGeometry.setIndex(index)
    const top = new Mesh(topGeometry, this.keep(new MeshStandardMaterial({ map: texture, roughness: 1 })))
    top.receiveShadow = true
    this.group.add(top)

    // 側面：草皮的邊、土層、岩層，一圈一圈往下、往裡收
    const out = edge.map((_, i) => {
      const a = edge[(i + n - 1) % n]
      const b = edge[(i + 1) % n]
      const [tx, tz] = [b.x - a.x, b.z - a.z]
      const len = Math.hypot(tx, tz) || 1
      return { x: -tz / len, z: tx / len }
    })
    const wobble = (amount: number) => {
      const [p1, p2] = [random() * 6.283, random() * 6.283]
      return edge.map((_, i) => {
        const t = (i / n) * Math.PI * 2
        return (Math.sin(t * 5 + p1) * 0.6 + Math.sin(t * 11 + p2) * 0.4) * amount + (random() - 0.5) * amount * 0.7
      })
    }
    const rings: { y: number[]; inset: number[] }[] = [
      { y: edge.map(() => 0), inset: edge.map(() => 0) },
      { y: edge.map(() => -0.13), inset: edge.map(() => -0.05) },
      { y: edge.map(() => -0.19), inset: edge.map(() => 0.05) },
      { y: wobble(0.1).map((v) => -0.66 + v), inset: wobble(0.07).map((v) => 0.2 + v) },
      { y: wobble(0.14).map((v) => -1.2 + v), inset: wobble(0.13).map((v) => 0.62 + v) },
      { y: wobble(0.18).map((v) => -1.75 + v), inset: wobble(0.25).map((v) => 1.5 + v) },
    ]
    const lip = tweak(ground.rim, 0, 0.02, -0.07)
    const bands = [lip, tweak(lip, 0, 0, -0.1), ground.soil, mix(ground.soil, ground.stone, 0.55), tweak(ground.stone, 0, 0, -0.08)]
    const cliffPosition: number[] = []
    const cliffColor: number[] = []
    const at = (ring: number, i: number): [number, number, number] => {
      const k = i % n
      const r = rings[ring]
      return [edge[k].x - out[k].x * r.inset[k], r.y[k], edge[k].z - out[k].z * r.inset[k]]
    }
    for (let ring = 0; ring + 1 < rings.length; ring++) {
      for (let i = 0; i < n; i++) {
        const [a, b, c, d] = [at(ring, i), at(ring, i + 1), at(ring + 1, i + 1), at(ring + 1, i)]
        // 每一片的深淺差一點，才看得出一塊一塊的岩面
        const shade = ring < 2 ? 0 : (random() - 0.5) * 0.09
        this.c.setStyle(tweak(bands[ring], 0, 0, shade))
        for (const v of [a, d, b, b, d, c]) {
          cliffPosition.push(...v)
          cliffColor.push(this.c.r, this.c.g, this.c.b)
        }
      }
    }
    const cliffGeometry = this.keep(new BufferGeometry())
    cliffGeometry.setAttribute('position', new BufferAttribute(new Float32Array(cliffPosition), 3))
    cliffGeometry.setAttribute('color', new BufferAttribute(new Float32Array(cliffColor), 3))
    cliffGeometry.computeVertexNormals()
    const cliff = new Mesh(
      cliffGeometry,
      this.keep(new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, side: DoubleSide })),
    )
    cliff.receiveShadow = true
    this.group.add(cliff)

    // 底下那一圈淡淡的影子：看起來是浮在桌面上面一點點
    const shade = this.keep(
      radialTexture([
        [0, 'rgba(0,0,0,0.55)'],
        [0.45, 'rgba(0,0,0,0.3)'],
        [1, 'rgba(0,0,0,0)'],
      ]),
    )
    const under = new Mesh(
      this.keep(new PlaneGeometry(tw * 1.5, th * 1.75).rotateX(-Math.PI / 2)),
      this.keep(new MeshBasicMaterial({ map: shade, transparent: true, depthWrite: false, opacity: this.theme.dark ? 0.75 : 0.42 })),
    )
    under.position.y = -2.3
    under.renderOrder = -1
    this.group.add(under)
  }

  /** 把地面畫到貼圖上 */
  private paint(ctx: CanvasRenderingContext2D, px: number, ponds: Set<number>) {
    const { map, ground, biome, theme } = this
    // 畫的東西用自己的亂數，才不會因為多畫一筆，周圍的樹就全部換位置
    const random = seeded(hashText(`${map.id}:paint`))
    const [tw, th] = [(map.w + PAD * 2) * px, (map.h + PAD * 2) * px]
    const [ox, oy] = [PAD * px, PAD * px]
    const [fw, fh] = [map.w * px, map.h * px]
    ctx.lineCap = 'round'

    // 外面那一圈：一片深一點的草地，深淺不均
    ctx.fillStyle = ground.rim
    ctx.fillRect(0, 0, tw, th)
    const blotch = (x: number, y: number, r: number, color: string, alpha: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, rgba(color, alpha))
      g.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
    const light = tweak(ground.rim, 0, 0.02, theme.dark ? 0.035 : 0.05)
    const shadowy = tweak(ground.rim, 0, 0, -0.05)
    for (let i = 0; i < 260; i++) blotch(random() * tw, random() * th, px * (0.5 + random() * 1.3), random() < 0.5 ? light : shadowy, 0.55)
    const blade = (x: number, y: number, color: string, size: number) => {
      const lean = (random() - 0.5) * 0.7
      const len = px * size * (0.7 + random() * 0.6)
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, px * 0.03)
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + Math.sin(lean) * len, y - Math.cos(lean) * len)
      ctx.stroke()
    }
    const rimBlades = [tweak(ground.rim, 0, 0.03, -0.08), tweak(ground.rim, 0, 0.03, 0.07)]
    for (let i = 0; i < (tw * th - fw * fh) / (px * px) * 9; i++) blade(random() * tw, random() * th, rimBlades[i % 2], 0.13)

    // 入口、出口的石板路一路鋪到島的邊緣
    const mortar = tweak(ground.walk, 0, -0.02, theme.dark ? -0.07 : -0.13)
    const cobbles = (x0: number, y0: number, w: number, h: number) => {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x0, y0, w, h)
      ctx.clip()
      ctx.fillStyle = mortar
      ctx.fillRect(x0, y0, w, h)
      const size = px / 3.1
      const cols = Math.ceil(w / size) + 1
      const rows = Math.ceil(h / size)
      for (let j = 0; j < rows; j++) {
        for (let i = -1; i < cols; i++) {
          const gap = Math.max(1, size * 0.09)
          const sx = x0 + (i + (j % 2 ? 0.5 : 0)) * size + gap + (random() - 0.5) * gap
          const sy = y0 + j * size + gap + (random() - 0.5) * gap
          ctx.fillStyle = tweak(ground.walk, 0, 0, (random() - 0.5) * 0.07)
          roundRect(ctx, sx, sy, size - gap * 2, size - gap * 2, size * 0.28)
          ctx.fill()
          ctx.fillStyle = 'rgba(255,255,255,0.1)'
          roundRect(ctx, sx + size * 0.1, sy + size * 0.08, size * 0.45, size * 0.14, size * 0.07)
          ctx.fill()
        }
      }
      ctx.restore()
    }
    const gates = new Set<number>()
    for (const [spawn, exit] of map.routes) gates.add(spawn).add(exit)
    for (const cell of gates) {
      const [x, y] = [cell % map.w, Math.floor(cell / map.w)]
      const [dx, dy] = this.outward(cell)
      if (dx) cobbles(dx < 0 ? 0 : ox + (x + 1) * px, oy + y * px, dx < 0 ? ox : tw - ox - (x + 1) * px, px)
      if (dy) cobbles(ox + x * px, dy < 0 ? 0 : oy + (y + 1) * px, px, dy < 0 ? oy : th - oy - (y + 1) * px)
    }

    // 可以蓋塔的範圍：底下一塊深色的框（格子之間的縫看到的就是它），外面一圈陰影
    const frame = px * 0.09
    ctx.save()
    ctx.shadowColor = `rgba(0,0,0,${theme.dark ? 0.5 : 0.28})`
    ctx.shadowBlur = px * 0.45
    ctx.fillStyle = tweak(ground.line, 0, 0, -0.05)
    roundRect(ctx, ox - frame, oy - frame, fw + frame * 2, fh + frame * 2, px * 0.22)
    ctx.fill()
    ctx.restore()
    ctx.fillStyle = ground.line
    ctx.fillRect(ox, oy, fw, fh)

    const gap = Math.max(1, px * 0.035)
    const tileBlades = [
      [tweak(ground.tileA, 0, 0.04, -0.075), tweak(ground.tileA, 0, 0.03, 0.06)],
      [tweak(ground.tileB, 0, 0.04, -0.075), tweak(ground.tileB, 0, 0.03, 0.06)],
    ]
    const dots = biome === 'canyon' ? [tweak(ground.walk, 0, 0, -0.16), tweak(ground.walk, 0, 0, 0.1)] : ['#fffdf2', '#ffe27a', '#ffc2d8']
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const cell = y * map.w + x
        const tile = tileAt(map, cell)
        const [x0, y0] = [ox + x * px, oy + y * px]
        if (tile === 'walk') {
          cobbles(x0, y0, px, px)
          continue
        }
        const which = (x + y) % 2
        ctx.fillStyle = tweak(which ? ground.tileA : ground.tileB, 0, 0, (random() - 0.5) * 0.022)
        roundRect(ctx, x0 + gap, y0 + gap, px - gap * 2, px - gap * 2, px * 0.15)
        ctx.fill()
        // 左上亮、右下暗：每一格像一塊微微鼓起來的草皮
        const bevel = ctx.createLinearGradient(x0, y0, x0 + px, y0 + px)
        bevel.addColorStop(0, `rgba(255,255,255,${theme.dark ? 0.07 : 0.13})`)
        bevel.addColorStop(0.5, 'rgba(255,255,255,0)')
        bevel.addColorStop(1, `rgba(0,0,0,${theme.dark ? 0.16 : 0.09})`)
        ctx.fillStyle = bevel
        ctx.fill()
        if (tile === 'rock') {
          if (!ponds.has(cell)) blotch(x0 + px / 2, y0 + px / 2, px * 0.66, ground.dirt, 0.95)
          continue
        }
        const blades = Math.floor(random() * 4.6)
        for (let b = 0; b < blades; b++) {
          blade(x0 + px * (0.16 + random() * 0.68), y0 + px * (0.3 + random() * 0.55), tileBlades[which][b % 2], 0.11)
        }
        if (random() < 0.075) {
          const n = 1 + Math.floor(random() * 2)
          for (let i = 0; i < n; i++) {
            ctx.fillStyle = dots[Math.floor(random() * dots.length)]
            ctx.globalAlpha = theme.dark ? 0.55 : 0.9
            ctx.beginPath()
            ctx.arc(x0 + px * (0.2 + random() * 0.6), y0 + px * (0.2 + random() * 0.6), px * (0.028 + random() * 0.014), 0, Math.PI * 2)
            ctx.fill()
            ctx.globalAlpha = 1
          }
        }
      }
    }
    // 整片再蓋幾塊很淡的深淺，才不會每一格都一模一樣
    for (let i = 0; i < 40; i++) {
      blotch(ox + random() * fw, oy + random() * fh, px * (1.5 + random() * 2.5), random() < 0.5 ? '#ffffff' : '#000000', theme.dark ? 0.035 : 0.045)
    }

    this.paintPonds(ctx, px, ponds, random)

    // 入口：燒黑的一圈，上面是 3D 的漩渦；出口：一圈石板
    for (const cell of gates) {
      const [x, y] = [cell % map.w, Math.floor(cell / map.w)]
      const [cx, cy] = [ox + (x + 0.5) * px, oy + (y + 0.5) * px]
      const isSpawn = map.routes.some((r) => r[0] === cell)
      if (isSpawn) blotch(cx, cy, px * 0.6, '#1a1024', theme.dark ? 0.7 : 0.5)
      ctx.strokeStyle = rgba(`#${(isSpawn ? theme.spawn : theme.exit).getHexString()}`, 0.55)
      ctx.lineWidth = Math.max(1.5, px * 0.045)
      ctx.beginPath()
      ctx.arc(cx, cy, px * 0.44, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  private paintPonds(ctx: CanvasRenderingContext2D, px: number, ponds: Set<number>, random: () => number) {
    if (!ponds.size) return
    const { map, ground, theme } = this
    const [ox, oy] = [PAD * px, PAD * px]
    const centers = [...ponds].map((cell) => [ox + ((cell % map.w) + 0.5) * px, oy + (Math.floor(cell / map.w) + 0.5) * px] as const)
    // 相鄰的池塘格連成一片：每格一個圓，相鄰的中間再補一塊
    const shape = (r: number) => {
      ctx.beginPath()
      for (const [x, y] of centers) {
        ctx.moveTo(x + r, y)
        ctx.arc(x, y, r, 0, Math.PI * 2)
      }
      for (const cell of ponds) {
        for (const next of [cell + 1, cell + map.w]) {
          if (!ponds.has(next) || (next === cell + 1 && next % map.w === 0)) continue
          const [x, y] = [ox + ((cell % map.w) + 0.5) * px, oy + (Math.floor(cell / map.w) + 0.5) * px]
          if (next === cell + 1) ctx.rect(x, y - r, px, r * 2)
          else ctx.rect(x - r, y, r * 2, px)
        }
      }
    }
    ctx.fillStyle = tweak(ground.walk, 0, -0.03, theme.dark ? -0.04 : -0.02)
    shape(px * 0.49)
    ctx.fill()
    ctx.fillStyle = tweak(ground.water, 0, 0, -0.1)
    shape(px * 0.43)
    ctx.fill()
    ctx.fillStyle = ground.water
    shape(px * 0.38)
    ctx.fill()
    for (const [x, y] of centers) {
      const g = ctx.createRadialGradient(x - px * 0.1, y - px * 0.12, 0, x, y, px * 0.4)
      g.addColorStop(0, `rgba(255,255,255,${theme.dark ? 0.16 : 0.3})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - px / 2, y - px / 2, px, px)
      // 水波
      ctx.strokeStyle = `rgba(255,255,255,${theme.dark ? 0.22 : 0.45})`
      ctx.lineWidth = Math.max(1, px * 0.025)
      for (let i = 0; i < 2; i++) {
        const [wx, wy] = [x + (random() - 0.5) * px * 0.4, y + (random() - 0.5) * px * 0.4]
        ctx.beginPath()
        ctx.arc(wx, wy, px * (0.07 + random() * 0.05), Math.PI * 1.1, Math.PI * 1.9)
        ctx.stroke()
      }
      // 荷葉：缺一角的圓
      const [lx, ly, lr, turn] = [x + (random() - 0.5) * px * 0.42, y + (random() - 0.5) * px * 0.42, px * (0.07 + random() * 0.03), random() * 6.283]
      ctx.fillStyle = tweak(ground.tileA, 0.02, 0.06, theme.dark ? 0.02 : -0.12)
      ctx.beginPath()
      ctx.moveTo(lx, ly)
      ctx.arc(lx, ly, lr, turn, turn + Math.PI * 1.75)
      ctx.closePath()
      ctx.fill()
    }
  }

  // ---------- 格子裡的岩石、池塘邊的東西 ----------

  private instances(geometry: BufferGeometry, material: Material, count: number, shadow: boolean): InstancedMesh {
    const mesh = new InstancedMesh(this.keep(geometry), material, Math.max(1, count))
    mesh.count = 0
    mesh.castShadow = shadow
    mesh.receiveShadow = true
    this.group.add(mesh)
    return mesh
  }

  private put(mesh: InstancedMesh, x: number, y: number, z: number, yaw: number, sx: number, sy: number, tint?: number) {
    const i = mesh.count++
    this.q.setFromEuler(this.e.set(0, yaw, 0))
    mesh.setMatrixAt(i, this.m.compose(this.p.set(x, y, z), this.q, this.s.set(sx, sy, sx)))
    mesh.setColorAt(i, this.c.set(tint ?? 0xffffff))
  }

  private buildObstacles(ponds: Set<number>) {
    const { map, ground, biome, random } = this
    const rocks: number[] = []
    for (let c = 0; c < map.w * map.h; c++) if (tileAt(map, c) === 'rock' && !ponds.has(c)) rocks.push(c)
    const stone = this.keep(new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0.02 }))
    const moss = biome === 'forest' ? 0x5d8f4a : biome === 'meadow' ? 0x86b25c : null
    const variants = [0, 1, 2].map((v) => this.instances(rockGeometry(v, moss), stone, rocks.length, true))
    // 峽谷的岩壁高一點、大一點，連起來像一道稜線
    const big = biome === 'canyon' ? 1.18 : 1
    for (const cell of rocks) {
      const [x, z] = this.center(cell)
      const size = (0.98 + random() * 0.26) * big
      this.put(variants[Math.floor(random() * 3)], x, 0, z, random() * Math.PI * 2, size, size * (0.92 + random() * 0.38) * big, ground.rockTint)
    }
    if (ponds.size) {
      const pebbles = this.instances(pebbleGeometry(), stone, ponds.size * 3, false)
      const reeds = this.instances(
        reedGeometry(),
        swaying(this.keep(new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })), this.windTime),
        ponds.size * 3,
        false,
      )
      for (const cell of ponds) {
        const [x, z] = this.center(cell)
        for (let i = 0; i < 3; i++) {
          const angle = random() * Math.PI * 2
          const [px, pz] = [x + Math.cos(angle) * 0.4, z + Math.sin(angle) * 0.4]
          if (i < 2) this.put(reeds, px, 0, pz, random() * 6.283, 0.9 + random() * 0.5, 0.9 + random() * 0.6)
          else this.put(pebbles, px, 0, pz, random() * 6.283, 0.8 + random() * 0.5, 0.8 + random() * 0.4, ground.rockTint)
        }
      }
    }
  }

  // ---------- 周圍的樹、灌木、草、小花 ----------

  private buildScenery(edge: { x: number; z: number }[]) {
    const { map, biome, ground, options, random } = this
    const [fw, fh] = [map.w / 2, map.h / 2]
    const inside = (x: number, z: number) => {
      let hit = false
      for (let i = 0, j = edge.length - 1; i < edge.length; j = i++) {
        const [a, b] = [edge[i], edge[j]]
        if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit
      }
      return hit
    }
    // 離島的邊緣多遠（到輪廓上最近的點）
    const toEdge = (x: number, z: number) => edge.reduce((d, p) => Math.min(d, Math.hypot(p.x - x, p.z - z)), 99)
    // 離可以蓋塔的範圍多遠（負的是在裡面）
    const toField = (x: number, z: number) => Math.max(Math.abs(x) - fw, Math.abs(z) - fh)
    // 入口、出口的石板路上不要長東西
    const roads = [...new Set(map.routes.flat())].map((cell) => ({ at: this.center(cell), out: this.outward(cell) }))
    const onRoad = (x: number, z: number, clear: number) =>
      roads.some(({ at, out }) => {
        const along = (x - at[0]) * out[0] + (z - at[1]) * out[1]
        const across = Math.abs((x - at[0]) * out[1] - (z - at[1]) * out[0])
        return along > -0.5 && across < clear
      })
    const taken: [number, number, number][] = []
    /** 找一個放得下的位置：離邊緣、離場地都夠遠，不和別的東西疊在一起 */
    const place = (clearEdge: number, clearField: number, clearRoad: number, radius: number): [number, number] | null => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const x = (random() * 2 - 1) * (fw + PAD)
        const z = (random() * 2 - 1) * (fh + PAD)
        if (toField(x, z) < clearField || !inside(x, z) || toEdge(x, z) < clearEdge || onRoad(x, z, clearRoad)) continue
        if (taken.some(([tx, tz, tr]) => Math.hypot(tx - x, tz - z) < tr + radius)) continue
        taken.push([x, z, radius])
        return [x, z]
      }
      return null
    }

    const around = (map.w + map.h) * 2
    const few = options.coarse ? 0.6 : 1
    const leaf = () => swaying(this.keep(new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })), this.windTime)
    const stone = this.keep(new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 }))
    const leaves = options.calm ? this.keep(new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })) : leaf()

    // 樹：種在外圈靠外面的地方，才不會擋到最旁邊那一排格子
    const treeCount = Math.round(around * (biome === 'canyon' ? 0.22 : 0.42) * few)
    const trees = [0, 1].map((v) => this.instances(treeGeometry(biome, v), leaves, treeCount, true))
    for (let i = 0; i < treeCount; i++) {
      const at = place(0.2, 0.42, 0.75, 0.42)
      if (!at) continue
      const size = 0.82 + random() * 0.42
      this.put(trees[random() < 0.6 ? 0 : 1], at[0], 0, at[1], random() * 6.283, size, size * (0.9 + random() * 0.25))
    }
    const bushCount = Math.round(around * 0.34 * few)
    const bushes = this.instances(bushGeometry(biome), leaves, bushCount, true)
    for (let i = 0; i < bushCount; i++) {
      const at = place(0.16, 0.24, 0.6, 0.26)
      if (!at) continue
      const size = 0.8 + random() * 0.55
      this.put(bushes, at[0], 0, at[1], random() * 6.283, size, size * (0.85 + random() * 0.3))
    }
    const rockCount = Math.round(around * (biome === 'canyon' ? 0.3 : 0.14) * few)
    const boulders = this.instances(rockGeometry(1, null), stone, rockCount, true)
    for (let i = 0; i < rockCount; i++) {
      const at = place(0.2, 0.3, 0.65, 0.3)
      if (!at) continue
      const size = 0.35 + random() * 0.4
      this.put(boulders, at[0], 0, at[1], random() * 6.283, size, size * (0.8 + random() * 0.5), ground.rockTint)
    }
    const accentCount = Math.round(around * 0.55 * few)
    const accents = this.instances(accentGeometry(biome), leaves, accentCount, false)
    const tints = ACCENT_TINTS[biome]
    for (let i = 0; i < accentCount; i++) {
      const at = place(0.1, 0.12, 0.55, 0.1)
      if (!at) continue
      const size = 0.85 + random() * 0.6
      this.put(accents, at[0], 0, at[1], random() * 6.283, size, size, tints[Math.floor(random() * tints.length)])
    }
    const tuftCount = Math.round(around * 1.5 * few)
    const tufts = this.instances(tuftGeometry(biome), leaves, tuftCount, false)
    for (let i = 0; i < tuftCount; i++) {
      const at = place(0.06, 0.1, 0.55, 0.07)
      if (!at) continue
      const size = 0.75 + random() * 0.7
      this.put(tufts, at[0], 0, at[1], random() * 6.283, size, size * (0.8 + random() * 0.5))
    }
    const pebbleCount = Math.round(around * 0.3 * few)
    const pebbles = this.instances(pebbleGeometry(), stone, pebbleCount, false)
    for (let i = 0; i < pebbleCount; i++) {
      const at = place(0.06, 0.1, 0.2, 0.1)
      if (!at) continue
      const size = 0.6 + random() * 0.8
      this.put(pebbles, at[0], 0, at[1], random() * 6.283, size, size, ground.rockTint)
    }
  }

  // ---------- 入口和出口 ----------

  private buildGates() {
    const { map, theme } = this
    const glowMap = this.keep(
      radialTexture([
        [0, 'rgba(255,255,255,1)'],
        [0.25, 'rgba(255,255,255,0.45)'],
        [0.6, 'rgba(255,255,255,0.1)'],
        [1, 'rgba(255,255,255,0)'],
      ]),
    )
    const glowSprite = (color: Color, size: number, strength: number) => {
      const sprite = new Sprite(
        this.keep(
          new SpriteMaterial({
            map: glowMap,
            color: color.clone().multiplyScalar(strength),
            blending: AdditiveBlending,
            transparent: true,
            depthWrite: false,
          }),
        ),
      )
      sprite.scale.set(size, size, 1)
      return sprite
    }
    const stone = this.keep(new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }))
    const spawns = [...new Set(map.routes.map((r) => r[0]))]
    const exits = [...new Set(map.routes.map((r) => r[1]))]

    // 入口：地上的漩渦、兩圈往上飄的光環，後面兩根石柱
    const vortexMap = this.keep(vortexTexture())
    const vortexGeometry = this.keep(new CircleGeometry(0.47, 32).rotateX(-Math.PI / 2))
    const vortexMaterial = this.keep(new MeshBasicMaterial({ map: vortexMap, color: theme.spawn, transparent: true, depthWrite: false }))
    const ringGeometry = this.keep(new TorusGeometry(0.34, 0.028, 6, 28).rotateX(Math.PI / 2))
    const ringMaterial = this.keep(new MeshBasicMaterial({ color: theme.spawn, transparent: true, opacity: 0.85 }))
    const tipMaterial = this.keep(new MeshBasicMaterial({ color: theme.spawn }))
    const tipGeometry = this.keep(crystalGeometry().scale(0.16, 0.16, 0.16))
    const obelisks = this.instances(obeliskGeometry(), stone, spawns.length * 2, true)
    for (const cell of spawns) {
      const [x, z] = this.center(cell)
      this.spawns.push([x, z])
      const vortex = new Mesh(vortexGeometry, vortexMaterial)
      vortex.position.set(x, 0.03, z)
      vortex.renderOrder = 1
      this.group.add(vortex)
      this.spinners.push({ mesh: vortex, spin: -1.5, bob: 0, y: 0.03, phase: 0 })
      for (let k = 0; k < 2; k++) {
        const ring = new Mesh(ringGeometry, ringMaterial)
        ring.position.set(x, 0.3 + k * 0.36, z)
        ring.scale.setScalar(1 - k * 0.28)
        this.group.add(ring)
        this.spinners.push({ mesh: ring, spin: k ? -0.8 : 0.8, bob: 0.07, y: ring.position.y, phase: k * 1.7 })
      }
      const glow = glowSprite(theme.spawn, 1.9, theme.dark ? 0.75 : 0.3)
      glow.position.set(x, 0.45, z)
      this.group.add(glow)
      this.spinners.push({ mesh: glow, spin: 0, bob: 0.05, y: 0.45, phase: 0.6 })
      const [dx, dz] = this.outward(cell)
      for (const side of [-1, 1]) {
        if (!dx && !dz) continue
        const [px, pz] = [x + dx * 0.78 - dz * side * 0.56, z + dz * 0.78 + dx * side * 0.56]
        this.put(obelisks, px, 0, pz, 0.3 * side, 1.05, 1.05)
        const tip = new Mesh(tipGeometry, tipMaterial)
        tip.position.set(px, 0.82, pz)
        this.group.add(tip)
        this.spinners.push({ mesh: tip, spin: 1.4 * side, bob: 0.04, y: 0.82, phase: side })
      }
    }

    // 出口：石階上一顆慢慢轉的大水晶
    const dais = this.instances(daisGeometry(), stone, exits.length, true)
    const crystal = this.keep(crystalGeometry())
    const haloGeometry = this.keep(new RingGeometry(0.47, 0.56, 36).rotateX(-Math.PI / 2))
    for (const cell of exits) {
      const [x, z] = this.center(cell)
      this.exits.push([x, z])
      this.put(dais, x, 0, z, Math.PI / 8, 1, 1)
      const core = new Mesh(
        crystal,
        this.keep(
          new MeshStandardMaterial({ color: theme.exit, emissive: theme.exit, emissiveIntensity: theme.dark ? 0.85 : 0.55, roughness: 0.25, metalness: 0.1, flatShading: true }),
        ),
      )
      core.position.set(x, 0.98, z)
      core.castShadow = true
      this.group.add(core)
      this.spinners.push({ mesh: core, spin: 0.7, bob: 0.07, y: 0.98, phase: 0 })
      const halo = new Mesh(haloGeometry, this.keep(new MeshBasicMaterial({ color: theme.exit, transparent: true, opacity: 0.75, depthWrite: false })))
      halo.position.set(x, 0.035, z)
      halo.renderOrder = 1
      this.group.add(halo)
      const glow = glowSprite(theme.exit, 2.3, this.glowStrength)
      glow.position.set(x, 0.95, z)
      this.group.add(glow)
      this.crystals.push({ x, z, core, halo, glow, flash: 0 })
    }
  }

  // ---------- 每一格 ----------

  update(dt: number, time: number) {
    this.windTime.value = time
    for (const d of this.spinners) {
      if (d.spin) d.mesh.rotation.y += d.spin * dt
      if (d.bob) d.mesh.position.y = d.y + Math.sin(time * 1.8 + d.phase) * d.bob
    }
    for (const k of this.crystals) {
      k.flash = Math.max(0, k.flash - dt * 2.2)
      const material = k.core.material as MeshStandardMaterial
      // 被打到：閃一下紅、脹大一點點再縮回來
      this.c.copy(this.exitColor).lerp(this.badColor, k.flash)
      material.color.copy(this.c)
      material.emissive.copy(this.c)
      ;(k.halo.material as MeshBasicMaterial).color.copy(this.c)
      const pulse = 1 + Math.sin(time * 2.4) * 0.05 + k.flash * 0.3
      k.core.scale.setScalar(1 + k.flash * 0.22)
      k.halo.scale.setScalar(pulse)
      k.glow.material.color.copy(this.c).multiplyScalar(this.glowStrength * (1 + k.flash * 1.5 + Math.sin(time * 2.4) * 0.12))
    }
  }

  /** 怪物走到出口了：離那裡最近的水晶閃一下紅 */
  hit(x: number, z: number) {
    let best: Crystal | null = null
    for (const k of this.crystals) if (!best || Math.hypot(k.x - x, k.z - z) < Math.hypot(best.x - x, best.z - z)) best = k
    if (best) best.flash = 1
  }

  dispose() {
    for (const item of this.owned) item.dispose()
    for (const child of this.group.children) if (child instanceof InstancedMesh) child.dispose()
    this.group.clear()
  }
}

