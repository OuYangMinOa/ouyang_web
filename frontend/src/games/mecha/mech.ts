// 機甲的模型：全部用方塊和圓柱拼出來，不下載模型檔。這裡是共用的材質、`Rig`（每種機甲的模型都有的）和速度型「疾風」；狙擊型在 `sniper.ts`。
// 疾風參考的是厚重的老派機甲：往前傾的上半身、兩臂各一門多管速射砲、鳥腳式的反關節腿、背後兩具推進器，左肩掛飛彈艙。
// 裝甲照隊伍上色（紅隊鏽紅、藍隊鋼藍）。上半身跟著瞄準轉、手臂跟著仰角抬，腳照移動的方向走。
//
// 模型檔用 `part()` 一塊一塊擺零件只是在「描述」機甲長怎樣；真正拿來畫的是 `assemble` 做出來的：
// 零件倒角、同一個關節的合成一個網格（`mechgeo.ts`）、噴上標誌（`mechdecal.ts`）、套上分層的材質（`mechmat.ts`），
// 每一種機甲第一次做出來時烘一張遮蔽貼圖（`mechbake.ts`）。陰影和反射另外算（`mechlight.ts`）。
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three'
import { bakeOcclusion, canBake, type BakePiece } from './mechbake'
import { buildParts, LAYER, packCharts, Soup, toGeometry, type Chart, type PartSpec } from './mechgeo'
import { planDecals } from './mechdecal'
import { MECH_LAYER, type MechLighting } from './mechlight'
import { createBodyMaterial, createLook, type BodyMaterial, type MechLook } from './mechmat'
import { createMechTextures, disposeMechTextures, type MechTextures } from './mechtex'
import type { MechBody } from './physics'
import { clamp, newBody, wrapAngle } from './physics'
import { MECHS, TEAMS, type MechKind } from './spec'
import type { Team } from './map'

/**
 * 一種機甲（或偵察機）拿來畫的東西，第一台做出來時算好，之後每一台共用：
 * 每個關節一個合併好的網格、每隊一個材質、烘好的遮蔽貼圖
 */
export type Blueprint = {
  geos: BufferGeometry[]
  mats: BodyMaterial[]
  /** 遠處用的簡化版：整台（站好的姿勢）合成一個網格，沒有倒角，一次 draw call；材質少一層 */
  far: BufferGeometry
  farMats: BodyMaterial[]
  ao: WebGLRenderTarget | null
}

/** 所有機甲共用的幾何和材質（每隊一份裝甲） */
export type MechKit = {
  /**
   * `part()` 擺零件用的單位幾何和材質。裝甲、副色、鋼、骨架這四種只是記號（哪個零件是哪一層）：
   * 模型組好後 `assemble` 會把用它們擺的零件換成合併、倒角過的網格和真正的材質（`Blueprint`）
   */
  geo: Record<string, BufferGeometry>
  armor: MeshStandardMaterial[]
  trim: MeshStandardMaterial[]
  glow: MeshBasicMaterial[]
  /** 推進器噴嘴裡的餘燼：和 `glow` 同一個顏色，暗很多（鏡頭一直在機甲後面，太亮會一直有兩顆燈在畫面中間） */
  ember: MeshBasicMaterial[]
  flame: MeshBasicMaterial[]
  metal: MeshStandardMaterial
  dark: MeshStandardMaterial
  shadow: MeshBasicMaterial
  missile: MeshStandardMaterial
  /** 飛彈艙裡露出來的彈頭（`part()` 用圓錐加 `missile` 擺的會換成這個幾何和材質） */
  warhead: MeshStandardMaterial
  textures: CanvasTexture[]
  /** 機甲材質的細節貼圖和共用的參數 */
  detail: MechTextures
  look: MechLook
  blueprints: Map<string, Blueprint>
  /** 烘遮蔽貼圖用；沒有（測試）就不烘 */
  renderer: WebGLRenderer | null
  /** 手機：貼圖小一半、材質少一層 */
  lite: boolean
  /** 機甲專用的陰影和反射探針（`mechlight.ts`）；沒有就用場景的 */
  light: MechLighting | null
}

/**
 * 飛彈的彈頭：和 `geo.cone` 一樣寬的那頭在原點、尖端沿著 -y（半徑 0.5、長 1，照 `part()` 的大小放大），
 * 尖拱形的頭、後面一小段彈體；尖端紅色、中間一圈深色的環（頂點顏色）
 */
function warheadGeometry(): LatheGeometry {
  const profile: Vector2[] = []
  // 尖拱：從尖端（y = -1）彎到最粗的地方（y = -0.42），再直直到底
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    profile.push(new Vector2(0.5 * Math.sin((t * Math.PI) / 2) ** 0.8, -1 + t * 0.58))
  }
  profile.push(new Vector2(0.5, -0.3), new Vector2(0.46, -0.28), new Vector2(0.46, -0.2), new Vector2(0.5, -0.18), new Vector2(0.5, 0))
  const geo = new LatheGeometry(profile, 16)
  const pos = geo.attributes.position
  const colors: number[] = []
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    if (y < -0.74) colors.push(0.62, 0.08, 0.05)
    else if (y > -0.3 && y < -0.17) colors.push(0.07, 0.07, 0.08)
    else colors.push(0.78, 0.79, 0.8)
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3))
  return geo
}

/**
 * 彈藥箱旁邊掛的迫擊砲彈：和 `geo.cyl` 一樣以原點為中心、沿著 y（半徑 0.5、長 1），上面是尖拱形的彈頭；
 * 彈體橄欖綠、一圈黃色的識別帶、引信是鋼的顏色（頂點顏色）
 */
function shellGeometry(): LatheGeometry {
  const profile: Vector2[] = [new Vector2(0.0, -0.5), new Vector2(0.44, -0.5), new Vector2(0.5, -0.44), new Vector2(0.5, 0.08)]
  for (let i = 1; i <= 7; i++) {
    const t = i / 7
    profile.push(new Vector2(0.5 * Math.cos((t * Math.PI) / 2) ** 0.7 + 0.04 * t, 0.08 + t * 0.42))
  }
  const geo = new LatheGeometry(profile, 14)
  const pos = geo.attributes.position
  const colors: number[] = []
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    if (y > 0.38) colors.push(0.5, 0.5, 0.52)
    else if (y > -0.02 && y < 0.1) colors.push(0.7, 0.55, 0.08)
    else colors.push(0.17, 0.2, 0.14)
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3))
  return geo
}

/** 機甲底下的圓形影子 */
function shadowTexture(): CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(0,0,0,0.55)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

export function createMechKit(renderer: WebGLRenderer | null = null, lite = false, light: MechLighting | null = null): MechKit {
  const shadowTex = shadowTexture()
  const detail = createMechTextures(lite, renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 1)
  const armor = TEAMS.map((t) => new MeshStandardMaterial({ color: t.armor, roughness: 0.5, metalness: 0.1 }))
  const trim = TEAMS.map((t) => new MeshStandardMaterial({ color: t.trim, roughness: 0.55, metalness: 0.1 }))
  // 有泛光（桌機）時發光的地方比 1 亮很多，暈得開；沒有的話只亮一點，不然整塊變白
  const glow = TEAMS.map((t) => new MeshBasicMaterial({ color: new Color(t.glow).multiplyScalar(light ? 5 : 1.5) }))
  const ember = TEAMS.map((t) => new MeshBasicMaterial({ color: new Color(t.glow).multiplyScalar(0.5) }))
  const flame = TEAMS.map(
    (t) =>
      new MeshBasicMaterial({
        color: new Color(t.glow).lerp(new Color(0xffffff), 0.25).multiplyScalar(light ? 2.4 : 1),
        transparent: true,
        opacity: 0.85,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      }),
  )
  const geo: Record<string, BufferGeometry> = {
    box: new BoxGeometry(1, 1, 1),
    cyl: new CylinderGeometry(0.5, 0.5, 1, 12),
    cyl6: new CylinderGeometry(0.5, 0.5, 1, 6),
    nozzle: new CylinderGeometry(0.42, 0.3, 1, 12, 1, true),
    cone: new ConeGeometry(0.5, 1, 12, 1, true),
    disc: new CircleGeometry(0.5, 16),
  }
  // 火焰：圓錐倒過來，寬的那頭在原點、尖端沿著 -y 長出去
  geo.cone.rotateX(Math.PI)
  geo.cone.translate(0, -0.5, 0)
  geo.warhead = warheadGeometry()
  geo.shell = shellGeometry()
  return {
    geo,
    armor,
    trim,
    glow,
    ember,
    flame,
    metal: new MeshStandardMaterial({ color: 0x8b9097, roughness: 0.4, metalness: 0.7 }),
    dark: new MeshStandardMaterial({ color: 0x2c2e31, roughness: 0.7, metalness: 0.5 }),
    // 有真的影子時這片圓影子畫淡一點（當成機甲壓在地上的那一圈暗），沒有時是唯一的影子
    shadow: new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
    missile: new MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.4, metalness: 0.3, emissive: 0x330000 }),
    warhead: new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.32, metalness: 0.15 }),
    textures: [shadowTex],
    detail,
    look: createLook(detail),
    blueprints: new Map(),
    renderer,
    lite,
    light,
  }
}

export function disposeMechKit(kit: MechKit) {
  for (const g of Object.values(kit.geo)) g.dispose()
  const mats: Material[] = [...kit.armor, ...kit.trim, ...kit.glow, ...kit.ember, ...kit.flame, kit.metal, kit.dark, kit.shadow, kit.missile, kit.warhead]
  for (const m of mats) m.dispose()
  for (const t of kit.textures) t.dispose()
  for (const bp of kit.blueprints.values()) {
    for (const g of bp.geos) g.dispose()
    for (const m of bp.mats) m.dispose()
    bp.far.dispose()
    for (const m of bp.farMats) m.dispose()
    bp.ao?.dispose()
  }
  kit.blueprints.clear()
  disposeMechTextures(kit.detail)
}

const ONE = new Vector3(1, 1, 1)

/** `part()` 擺的一個零件換成要做的幾何：哪種形狀、哪一層材質；液壓桿拆成套筒、鍍鉻的桿和一圈擋環 */
function partSpecs(kit: MechKit, mesh: Mesh, groupWorld: Matrix4): PartSpec[] {
  const mat = mesh.material as Material
  const layer = mat === kit.metal ? LAYER.metal : mat === kit.dark ? LAYER.dark : kit.trim.includes(mat as MeshStandardMaterial) ? LAYER.trim : LAYER.armor
  const local = new Matrix4().compose(mesh.position, mesh.quaternion, ONE)
  const world = groupWorld.clone().multiply(local)
  const size: [number, number, number] = [mesh.scale.x, mesh.scale.y, mesh.scale.z]
  const g = mesh.geometry
  if (g === kit.geo.box) return [{ shape: 'box', size, local, world, layer }]
  if (g === kit.geo.nozzle) return [{ shape: 'nozzle', size, local, world, layer }]
  if (g === kit.geo.cyl) return [{ shape: 'cyl', size, local, world, layer }]
  // 六角柱：粗的、長的是液壓桿，細的是天線
  const d = Math.max(size[0], size[2])
  const len = size[1]
  if (d < 0.1 || len < 0.75) return [{ shape: 'rod', size, local, world, layer: LAYER.metal }]
  const along = (y: number) => {
    const m = local.clone().multiply(new Matrix4().makeTranslation(0, y, 0))
    return { local: m, world: groupWorld.clone().multiply(m) }
  }
  return [
    { shape: 'cyl', size: [d * 1.2, len * 0.54, d * 1.2], layer: LAYER.dark, ...along(-len * 0.23) },
    { shape: 'cyl', size: [d * 1.5, 0.06, d * 1.5], layer: LAYER.metal, ...along(len * 0.04) },
    { shape: 'cyl', size: [d * 0.62, len * 0.5, d * 0.62], layer: LAYER.chrome, ...along(len * 0.25) },
    { shape: 'cyl', size: [d * 1.1, 0.07, d * 1.1], layer: LAYER.metal, ...along(len * 0.5 - 0.035) },
  ]
}

function isSolid(kit: MechKit, o: Object3D): o is Mesh {
  if (!(o instanceof Mesh)) return false
  const m = o.material as Material
  const g = o.geometry
  if (g !== kit.geo.box && g !== kit.geo.cyl && g !== kit.geo.cyl6 && g !== kit.geo.nozzle) return false
  return m === kit.metal || m === kit.dark || kit.armor.includes(m as MeshStandardMaterial) || kit.trim.includes(m as MeshStandardMaterial)
}

/** 每個有實心零件的關節（照固定的順序走，同一種機甲每一台都一樣） */
function solidGroups(kit: MechKit, root: Object3D): { node: Object3D; parts: Mesh[] }[] {
  const out: { node: Object3D; parts: Mesh[] }[] = []
  root.traverse((node) => {
    const parts = node.children.filter((c) => isSolid(kit, c)) as Mesh[]
    if (parts.length) out.push({ node, parts })
  })
  return out
}

function hashText(s: string): number {
  let h = 7
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return Math.abs(h) % 9973
}

/**
 * 把 `root` 底下用 `part()` 擺好的實心零件（裝甲、副色、鋼、骨架）換成合併、倒角過的網格，每個關節一個。
 * 同一個 `key`（哪一種機甲）第一次呼叫時做幾何、烘遮蔽貼圖，之後的每一台直接共用。
 * `pose` 把模型擺成站好的樣子（`deployed` 是變身後）：算每個零件離地多高、哪一面朝上、烘遮蔽時零件之間的位置都照這個姿勢。
 * 關節的 `userData.solo` 是「變身時會大搬家的」（堡壘型的重機槍和盾、砲擊型的砲管、支架）：它們照變身後的樣子、只算自己擋自己，
 * 也不會在別的零件上留下影子
 */
export function assemble(kit: MechKit, key: string, root: Object3D, team: Team, pose?: (deployed: boolean) => void): Blueprint {
  const groups = solidGroups(kit, root)
  let bp = kit.blueprints.get(key)
  if (!bp) {
    const solo = groups.map(({ node }) => {
      for (let o: Object3D | null = node; o && o !== root; o = o.parent) if (o.userData.solo) return true
      return false
    })
    const snapshot = (deployed: boolean) => {
      pose?.(deployed)
      root.updateMatrixWorld(true)
      return groups.map((g) => g.node.matrixWorld.clone())
    }
    const rest = snapshot(false)
    const open = pose && solo.some(Boolean) ? snapshot(true) : rest
    if (open !== rest) {
      pose?.(false)
      root.updateMatrixWorld(true)
    }
    const charts: Chart[] = []
    const seed = hashText(key)
    const specs = groups.map((g, i) => g.parts.flatMap((m) => partSpecs(kit, m, solo[i] ? open[i] : rest[i])))
    // 哪些面噴標誌：主體和變身時大搬家的那一組分開看（各自照自己的姿勢看有沒有被擋住）
    for (const lone of [false, true]) {
      planDecals(
        key,
        specs.filter((_, i) => solo[i] === lone).flat(),
        kit.detail.decals,
        seed + (lone ? 1 : 0),
      )
    }
    const firsts: number[] = []
    const soups = specs.map((list, i) => {
      firsts.push(charts.length)
      return buildParts(list, charts, seed + i * 17)
    })
    // 遠處用的簡化版：所有關節照站好的姿勢合成一個網格（`root` 這時在原點，世界座標就是整台機甲的座標）
    const farSoup = new Soup()
    specs.forEach((list, i) => buildParts(list, charts, seed + i * 17, { soup: farSoup, firstChart: firsts[i], into: rest[i] }))
    const size = kit.lite ? 512 : 1024
    const density = packCharts(charts, size)
    const geos = soups.map((s) => toGeometry(s, charts, size, density))
    const far = toGeometry(farSoup, charts, size, density)
    // 烘遮蔽貼圖：主體一組，變身時大搬家的另一組（照變身後的樣子）
    const sets: BakePiece[][] = [[], []]
    groups.forEach((_, i) => sets[solo[i] ? 1 : 0].push({ geo: geos[i], world: solo[i] ? open[i] : rest[i] }))
    const ao = kit.renderer && canBake(kit.renderer) ? bakeOcclusion(kit.renderer, sets, size, kit.lite ? 128 : 288, kit.lite ? 512 : 1024) : null
    const material = (far: boolean) =>
      TEAMS.map((t) =>
        createBodyMaterial({ look: kit.look, textures: kit.detail, armor: t.armor, trim: t.trim, ao: ao?.texture ?? null, lite: kit.lite, light: kit.light, far }),
      )
    bp = { geos, mats: material(false), far, farMats: material(true), ao }
    kit.blueprints.set(key, bp)
  }
  // 飛彈艙裡露出來的彈頭、彈藥箱旁邊的砲彈：換成尖拱形的幾何和自己的材質
  root.traverse((o) => {
    if (!(o instanceof Mesh) || o.material !== kit.missile) return
    if (o.geometry === kit.geo.cone) o.geometry = kit.geo.warhead
    else if (o.geometry === kit.geo.cyl) o.geometry = kit.geo.shell
    else return
    o.material = kit.warhead
  })
  groups.forEach((g, i) => {
    for (const m of g.parts) g.node.remove(m)
    const mesh = new Mesh(bp.geos[i], bp.mats[team])
    mesh.castShadow = true
    // 有機甲專用的陰影時不吃場景的陰影（材質自己算），另外放進自陰影那一層
    mesh.receiveShadow = !kit.light
    if (kit.light) mesh.layers.enable(MECH_LAYER)
    g.node.add(mesh)
  })
  return bp
}

/** 在 `parent` 底下放一個零件：幾何、材質、大小、位置、轉角 */
export function part(
  parent: Object3D,
  geo: BufferGeometry,
  mat: Material,
  size: [number, number, number],
  pos: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
): Mesh {
  const m = new Mesh(geo, mat)
  // 裝甲、骨架會擋光、照得到影子；發光的零件和火焰不會
  m.castShadow = m.receiveShadow = mat instanceof MeshStandardMaterial
  m.scale.set(...size)
  m.position.set(...pos)
  m.rotation.set(...rot)
  parent.add(m)
  return m
}

/** 每一種機甲的模型都有的：換隊伍顏色、肩上的飛彈、開火、槍口和飛彈艙的位置、照身體的狀態擺姿勢 */
export abstract class Rig {
  readonly root = new Group()
  team: Team
  protected readonly missiles: Mesh[] = []
  protected readonly shadow: Mesh
  /** 遠的時候換成的簡單外形（整台合成一個網格，不動），第一次用到才做；`detail` 是原本的零件 */
  private proxy: Group | null = null
  private detail: Object3D[] = []
  private far = false
  /** 這一種機甲合併好的網格和材質（`finish` 之後才有） */
  private blueprint: Blueprint | null = null
  /** 腳下的地面多高（圓影子貼在這裡）；還不知道是 NaN */
  private floor = NaN

  constructor(kit: MechKit, team: Team, shadow: number) {
    this.team = team
    this.shadow = new Mesh(kit.geo.disc, kit.shadow)
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.scale.setScalar(shadow)
    this.shadow.renderOrder = 1
    this.root.add(this.shadow)
  }

  /**
   * 每一種機甲的建構式最後呼叫：把用 `part()` 擺好的零件換成合併、倒角過的網格（`assemble`）。
   * 這一種的第一台順便把模型擺成站好的樣子，量每個零件的位置、烘遮蔽貼圖
   */
  protected finish(kit: MechKit, kind: MechKind) {
    const rest = newBody(this.team, kind, 0, 0, 0)
    this.blueprint = assemble(kit, kind, this.root, this.team, (deployed) => {
      rest.deployed = deployed
      rest.deploy = deployed ? 1 : 0
      this.pose(rest, false, 0)
    })
  }

  setTeam(kit: MechKit, team: Team) {
    if (team === this.team) return
    const from: Material[] = [kit.armor[this.team], kit.trim[this.team], kit.glow[this.team], kit.ember[this.team], kit.flame[this.team]]
    const to: Material[] = [kit.armor[team], kit.trim[team], kit.glow[team], kit.ember[team], kit.flame[team]]
    if (this.blueprint) {
      from.push(this.blueprint.mats[this.team], this.blueprint.farMats[this.team])
      to.push(this.blueprint.mats[team], this.blueprint.farMats[team])
    }
    this.root.traverse((o) => {
      if (!(o instanceof Mesh)) return
      const i = from.indexOf(o.material)
      if (i >= 0) o.material = to[i]
    })
    this.team = team
  }

  /** 剩幾發飛彈：肩上的彈頭跟著少 */
  setMissiles(n: number) {
    this.missiles.forEach((m, i) => (m.visible = i < n))
  }

  setVisible(on: boolean) {
    this.root.visible = on
  }

  /**
   * 遠近切換：遠的換成簡化版，整台站著不動、合成一個網格，一次 draw call（近的每個關節各一次，30 對 30 時省很多）；
   * 材質、遮蔽、標誌都和近的一樣，只是沒有倒角、關節不動。發光的零件不在那個網格裡，另外放一小條隊伍顏色的燈。
   * `size` 是打中範圍的大小（`MechSpec` 的 hitR、hitH）
   */
  setFar(far: boolean, kit: MechKit, size: { hitR: number; hitH: number }) {
    if (far === this.far) return
    this.far = far
    if (far && !this.proxy && this.blueprint) {
      this.detail = this.root.children.slice()
      this.proxy = new Group()
      const mesh = new Mesh(this.blueprint.far, this.blueprint.farMats[this.team])
      mesh.castShadow = true
      mesh.receiveShadow = !kit.light
      this.proxy.add(mesh)
      part(this.proxy, kit.geo.box, kit.glow[this.team], [size.hitR * 0.7, size.hitH * 0.05, 0.2], [0, size.hitH * 0.74, size.hitR * 0.8])
      this.root.add(this.proxy)
    }
    for (const c of this.detail) c.visible = !far
    if (this.proxy) this.proxy.visible = far
  }

  /** 遠的時候：只擺位置、朝瞄準的方向（不用算關節） */
  poseFar(b: MechBody) {
    this.root.position.set(b.x, b.y, b.z)
    this.root.rotation.y = b.aimYaw
  }

  /**
   * 影子貼在腳下的地上，飛得越高越小。地面多高照最後一次站在地上時的高度（橋上、河床裡的地面不是 0）；
   * 在空中時不知道底下的地面多高，就當成還在起跳的那個高度
   */
  protected placeShadow(b: MechBody, size: number) {
    if (b.onGround || Number.isNaN(this.floor)) this.floor = b.y
    const above = Math.max(0, b.y - this.floor)
    this.shadow.position.y = 0.06 - above
    const height = clamp(above / 14, 0, 1)
    this.shadow.scale.setScalar(size * (1 - height * 0.5))
  }

  /** 第 `side` 門砲開了一發 */
  abstract fire(side: number): void
  /** 槍口的世界座標（`side` 0 是左邊） */
  abstract muzzle(side: number, out: Vector3): Vector3
  /** 飛彈艙的世界座標 */
  abstract podPosition(out: Vector3): Vector3
  /** 照身體的狀態擺姿勢；`dt` 是這一格的秒數 */
  abstract pose(b: MechBody, firing: boolean, dt: number): void
}

type Leg = { hip: Group; knee: Group; ankle: Group }

/** 上半身往前駝的角度 */
const HUNCH = 0.12

/** 速度型「疾風」的模型和要動的關節 */
export class MechModel extends Rig {
  /** 上半身（跟著瞄準轉）的軸心在腰上 */
  private readonly hips = new Group()
  private readonly torso = new Group()
  private readonly arms: Group[] = []
  private readonly barrels: Group[] = []
  private readonly legs: Leg[] = []
  private readonly flames: Mesh[] = []
  private readonly flameCores: Mesh[] = []
  private readonly footFlames: Mesh[] = []
  /** 槍口（模型座標，給 `muzzle` 算世界座標用） */
  private readonly muzzles: Object3D[] = []
  private readonly pod: Object3D
  /** 手臂開火後退的量、槍管轉的角度 */
  private recoil = [0, 0]
  private spin = 0
  private spinSpeed = 0
  /** 衝刺時上半身往前壓的量（平滑過的） */
  private lean = 0
  private air = 0
  private flicker = 0

  constructor(kit: MechKit, team: Team) {
    super(kit, team, 5.2)
    const armor = kit.armor[team]
    const trim = kit.trim[team]
    const glow = kit.glow[team]
    const { box, cyl, cyl6, nozzle, cone, disc } = kit.geo

    // 腰：骨盆和兩條腿都掛在這裡（走路時上下晃）
    this.hips.position.y = 3.35
    this.root.add(this.hips)
    part(this.hips, box, kit.dark, [1.5, 0.75, 1.2], [0, 0, 0])
    part(this.hips, box, trim, [1.8, 0.35, 0.9], [0, -0.2, 0.15])

    for (const s of [-1, 1]) {
      const hip = new Group()
      hip.position.set(s * 0.95, 0, 0)
      this.hips.add(hip)
      part(hip, cyl, kit.metal, [0.62, 0.5, 0.62], [0, 0, 0], [0, 0, Math.PI / 2])
      // 大腿：往下前方
      part(hip, box, armor, [0.62, 1.75, 0.8], [0, -0.85, 0])
      part(hip, box, trim, [0.7, 0.5, 0.9], [0, -0.35, 0.05])
      const knee = new Group()
      knee.position.set(0, -1.7, 0)
      hip.add(knee)
      part(knee, cyl, kit.metal, [0.55, 0.62, 0.55], [0, 0, 0], [0, 0, Math.PI / 2])
      // 膝蓋的護甲往前凸
      part(knee, box, armor, [0.7, 0.75, 0.55], [0, 0.05, 0.35], [-0.3, 0, 0])
      // 小腿：往下後方
      part(knee, box, kit.dark, [0.42, 1.95, 0.5], [0, -0.95, 0])
      part(knee, box, armor, [0.55, 1.2, 0.35], [0, -0.75, 0.3])
      // 液壓桿
      part(knee, cyl6, kit.metal, [0.12, 1.6, 0.12], [0, -0.9, -0.35])
      const ankle = new Group()
      ankle.position.set(0, -1.9, 0)
      knee.add(ankle)
      part(ankle, cyl, kit.metal, [0.42, 0.5, 0.42], [0, 0, 0], [0, 0, Math.PI / 2])
      // 腳掌：往前的兩根爪、往後的一根
      part(ankle, box, kit.dark, [0.95, 0.32, 1.1], [0, -0.42, 0.25])
      part(ankle, box, armor, [0.85, 0.28, 0.9], [0, -0.2, 0.35])
      part(ankle, box, kit.dark, [0.28, 0.25, 0.9], [-0.28, -0.46, 1.15], [0.15, 0, 0])
      part(ankle, box, kit.dark, [0.28, 0.25, 0.9], [0.28, -0.46, 1.15], [0.15, 0, 0])
      part(ankle, box, kit.dark, [0.3, 0.25, 0.6], [0, -0.46, -0.55], [-0.2, 0, 0])
      // 腳底的小噴嘴：衝刺時噴火（像貼地滑行）
      const ff = part(ankle, cone, kit.flame[team], [0.4, 1.4, 0.4], [0, -0.35, -0.75], [1.16, 0, 0])
      ff.visible = false
      this.footFlames.push(ff)
      this.legs.push({ hip, knee, ankle })
    }

    // 上半身：軸心在骨盆上面
    this.torso.position.y = 3.75
    this.root.add(this.torso)
    const body = new Group()
    body.rotation.x = HUNCH
    this.torso.add(body)
    // 主體、往前斜的胸甲、駕駛艙
    part(body, box, armor, [2.5, 1.5, 2.5], [0, 0.95, -0.15])
    part(body, box, armor, [2.1, 1.05, 1.5], [0, 0.85, 1.35], [0.38, 0, 0])
    part(body, box, trim, [2.2, 0.4, 1.7], [0, 0.32, 1.1], [-0.15, 0, 0])
    part(body, box, glow, [1.1, 0.16, 0.08], [0, 1.18, 2.02], [0.38, 0, 0])
    part(body, box, kit.dark, [1.5, 0.5, 0.2], [0, 0.6, 2.08], [0.1, 0, 0])
    // 背上的裝甲板和散熱片
    part(body, box, trim, [2.3, 0.35, 2.3], [0, 1.83, -0.2], [0.05, 0, 0])
    for (const x of [-0.6, -0.2, 0.2, 0.6]) part(body, box, kit.dark, [0.12, 0.25, 1.2], [x, 2.05, -0.35])
    // 側面的進氣口
    for (const s of [-1, 1]) part(body, box, kit.dark, [0.15, 0.6, 1.0], [s * 1.28, 0.9, 0.4])
    // 天線
    part(body, cyl6, kit.metal, [0.06, 1.5, 0.06], [0.8, 2.4, -0.9], [-0.35, 0, 0.1])

    // 背後的兩具推進器（Shift 衝刺、空白鍵飛行時噴火）
    for (const s of [-1, 1]) {
      const pod = new Group()
      pod.position.set(s * 0.78, 1.15, -1.55)
      // 噴嘴朝後下方
      pod.rotation.x = -0.55
      body.add(pod)
      part(pod, cyl, trim, [0.78, 1.5, 0.78], [0, 0, 0], [Math.PI / 2, 0, 0])
      part(pod, nozzle, kit.dark, [1, 0.5, 1], [0, 0, -0.95], [-Math.PI / 2, 0, 0])
      part(pod, disc, kit.ember[team], [0.55, 0.55, 0.55], [0, 0, -1.15], [0, Math.PI, 0])
      // 火焰往後長（圓錐沿著 -y，轉成 -z）
      const f = part(pod, cone, kit.flame[team], [0.62, 3, 0.62], [0, 0, -1.15], [Math.PI / 2, 0, 0])
      const core = part(pod, cone, kit.flame[team], [0.32, 1.6, 0.32], [0, 0, -1.15], [Math.PI / 2, 0, 0])
      f.visible = core.visible = false
      this.flames.push(f)
      this.flameCores.push(core)
    }

    // 左肩上的飛彈艙：兩發，射掉就看不到彈頭
    const pod = new Group()
    pod.position.set(-1.05, 2.05, -0.1)
    body.add(pod)
    part(pod, box, trim, [1.0, 0.75, 1.45], [0, 0, 0])
    part(pod, box, kit.dark, [0.9, 0.6, 0.1], [0, 0, 0.75])
    for (const x of [-0.22, 0.22]) {
      // 彈頭：圓錐的底在艙口、尖端朝前
      const m = part(pod, cone, kit.missile, [0.22, 0.45, 0.22], [x, 0, 0.8], [-Math.PI / 2, 0, 0])
      this.missiles.push(m)
    }
    this.pod = pod

    // 兩臂：肩甲、上臂、砲身、四管的速射砲（開火時轉）
    for (const s of [-1, 1]) {
      const shoulder = part(body, box, armor, [0.95, 1.05, 1.35], [s * 1.6, 1.1, 0.15])
      shoulder.rotation.z = s * -0.12
      const arm = new Group()
      arm.position.set(s * 1.95, 0.95, 0.2)
      body.add(arm)
      part(arm, cyl, kit.metal, [0.55, 0.4, 0.55], [0, 0, 0], [0, 0, Math.PI / 2])
      part(arm, box, kit.dark, [0.6, 0.7, 1.1], [s * 0.1, -0.35, 0.35])
      part(arm, box, armor, [0.8, 0.85, 1.7], [s * 0.1, -0.45, 1.45])
      part(arm, box, trim, [0.84, 0.3, 1.2], [s * 0.1, -0.05, 1.3])
      // 彈鏈箱
      part(arm, box, kit.dark, [0.45, 0.55, 0.8], [s * 0.55, -0.55, 1.2])
      const barrel = new Group()
      barrel.position.set(s * 0.1, -0.45, 2.3)
      arm.add(barrel)
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2
        part(barrel, cyl, kit.metal, [0.14, 1.9, 0.14], [Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.95], [Math.PI / 2, 0, 0])
      }
      part(barrel, cyl, kit.dark, [0.55, 0.22, 0.55], [0, 0, 0.35], [Math.PI / 2, 0, 0])
      part(barrel, cyl, kit.dark, [0.5, 0.14, 0.5], [0, 0, 1.75], [Math.PI / 2, 0, 0])
      const muzzle = new Group()
      muzzle.position.set(s * 0.1, -0.45, 4.05)
      arm.add(muzzle)
      this.arms.push(arm)
      this.barrels.push(barrel)
      this.muzzles.push(muzzle)
    }
    this.finish(kit, 'speed')
  }

  /** 第 `side` 支手臂開了一槍：往後退一下 */
  fire(side: number) {
    this.recoil[side] = 1
    this.spinSpeed = 30
  }

  /** 槍口的世界座標（`side` 0 是左手） */
  muzzle(side: number, out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return this.muzzles[side].getWorldPosition(out)
  }

  /** 飛彈艙的世界座標 */
  podPosition(out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return this.pod.getWorldPosition(out)
  }

  /** 照身體的狀態擺姿勢；`dt` 是這一格的秒數 */
  pose(b: MechBody, firing: boolean, dt: number) {
    this.root.position.set(b.x, b.y, b.z)
    this.root.rotation.y = b.legs
    this.placeShadow(b, 5.2)

    const speed = Math.hypot(b.vx, b.vz)
    this.lean += ((b.boosting ? 1 : 0) - this.lean) * Math.min(1, dt * 6)
    this.air += ((b.onGround ? 0 : 1) - this.air) * Math.min(1, dt * 8)

    // 上半身轉向瞄準的方向（相對於腳），往前壓
    const twist = wrapAngle(b.aimYaw - b.legs)
    this.torso.rotation.set(this.lean * 0.22 - b.aimPitch * 0.25, twist, 0, 'YXZ')
    for (let i = 0; i < 2; i++) {
      this.recoil[i] = Math.max(0, this.recoil[i] - dt * 9)
      const arm = this.arms[i]
      // 手臂補上剩下的仰角：腰、駝背和手臂加起來剛好是瞄準的仰角
      arm.rotation.x = -b.aimPitch * 0.75 - HUNCH - this.lean * 0.22
      arm.position.z = 0.2 - this.recoil[i] * 0.25
    }
    this.spinSpeed = firing ? 30 : this.spinSpeed * Math.exp(-2.5 * dt)
    this.spin += this.spinSpeed * dt
    for (const barrel of this.barrels) barrel.rotation.z = this.spin

    // 腿：走路的相位擺動大腿，小腿反著彎，腳掌保持水平
    const walking = b.onGround && !b.boosting ? clamp(speed / MECHS.speed.walk, 0, 1) : 0
    const crouch = this.lean * (b.onGround ? 1 : 0)
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i]
      const phase = b.stride + (i === 0 ? 0 : Math.PI)
      const swing = Math.sin(phase) * 0.55 * walking
      const lift = Math.max(0, Math.cos(phase)) * 0.55 * walking
      const thigh = -0.6 - swing - crouch * 0.35 - this.air * 0.35 + b.landed * -0.3
      const knee = 1.3 + lift + crouch * 0.55 + this.air * 0.5 + b.landed * 0.5
      leg.hip.rotation.x = thigh
      leg.knee.rotation.x = knee
      leg.ankle.rotation.x = -(thigh + knee) + this.air * 0.3
    }
    // 走路時上下晃、衝刺時壓低
    const bob = Math.abs(Math.sin(b.stride)) * 0.12 * walking
    this.hips.position.y = 3.35 - crouch * 0.4 - b.landed * 0.35 + bob
    this.torso.position.y = 3.75 - crouch * 0.45 - b.landed * 0.4 + bob

    // 推進器的火焰：衝刺時長、飛行時短一點，閃爍
    this.flicker += dt * 40
    const thrust = b.boosting ? 1 : b.hovering ? 0.65 : 0
    for (let i = 0; i < this.flames.length; i++) {
      const on = thrust > 0
      const f = this.flames[i]
      const core = this.flameCores[i]
      f.visible = core.visible = on
      if (!on) continue
      const k = 0.85 + Math.sin(this.flicker + i * 1.7) * 0.15
      f.scale.set(0.62, 3.2 * thrust * k + 0.4, 0.62)
      core.scale.set(0.34, 1.8 * thrust * k + 0.3, 0.34)
    }
    for (const ff of this.footFlames) {
      ff.visible = b.boosting && b.onGround
      if (ff.visible) ff.scale.set(0.4, 1.2 + Math.sin(this.flicker * 1.3) * 0.3, 0.4)
    }
  }
}
