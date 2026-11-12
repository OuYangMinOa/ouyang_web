// 把地圖（map.ts）畫成 3D 場景：打了很久的仗的城市。煙層底下壓得很低的太陽、柏油路和磨掉大半的標線、人行道、
// 一棟棟樓頂被炸掉、窗戶破了的大樓和紅磚街屋、鐵皮倉庫、貨櫃、燒剩的車、混凝土牆、枯樹，中間一條河（石砌的河岸、河床、會流動的水面）、
// 斜張大橋（引道、橋面、護欄、橋墩、橋塔和鋼纜）、高架快速道路和交流道、人行鋼橋、鋼桁架橋、調車場的車廂和鐵軌、墊高的公園，
// 兩邊的機庫和只擋敵人的能量牆，地圖外面還有一圈燻黑的遠景大樓。
//
// 貼圖全部用 canvas 畫（textures.ts），天空是著色器（sky.ts）。同一種材質的東西合成一個網格（worldgeo.ts），一次畫完；
// 材質在貼圖上面再疊風化和破壞（worldmat.ts），整個場景的環境光遮蔽載入時烘一次（worldbake.ts）；
// 殘牆、瓦礫、殘骸、枯樹在 ruins.ts，彈坑、彈洞、噴漆在 worlddecal.ts，火、煙、火星和灰燼在 worldfx.ts。
// 這裡加的東西都只是畫面，不擋東西：碰撞、打中只看 map.ts 的方塊。
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type MeshStandardMaterialParameters,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { SunLight } from 'three/addons/lights/SunLight.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { fbm, rng } from '../racing/noise'
import {
  AVENUE_Z,
  BASE,
  BED,
  BRIDGE_W,
  crosses,
  HANGAR_H,
  MAP_X,
  MAP_Z,
  RIVER,
  WATER,
  type Box,
  type MapData,
  type Spawn,
  type Team,
} from './map'
import { GLOW, HORIZON, Sky, SUN_COLOR, SUN_DIR } from './sky'
import { TEAMS } from './spec'
import { createTextures, dataTexture, disposeTextures, setAnisotropy, SIGN_COUNT, type Surface, type WorldTextures } from './textures'
import { bakeWorld, blankBake, canBakeWorld, createBakeTargets, type WorldBakeTargets } from './worldbake'
import { collapsed, deadTree, rubble, ruinTop, wreck } from './ruins'
import { createWorldDecals, groundDecal, wallDecal, type WorldDecals } from './worlddecal'
import { Ambience } from './worldfx'
import { Atlas, Mesher } from './worldgeo'
import { flowing, GROUND_PAD, hazed, weathered, type Weather, type WorldLook } from './worldmat'
import { createWorldMasks, disposeWorldMasks, type WorldMasks } from './worldtex'

/** 店面那一層有多高 */
const SHOP_H = 5
/** 外牆貼圖一格：四個開間、四層樓 */
const CELL_W = 12
const CELL_H = 13.2
/** 店面貼圖一格：八間 */
const SHOP_W = 24
/** 太陽多亮（陰影有兩種做法，兩盞燈要一樣亮） */
const SUN_POWER = 3.7
/** 整張地圖那一層貼圖（`macroCanvas`）比地圖多畫出去多少、一公尺幾個像素 */
const MACRO_PAD = GROUND_PAD
const MACRO_PX = 2

/**
 * 陰影怎麼做：
 *   - `dynamic`：跟著鏡頭的兩層串接陰影，每一格重畫，機甲也有真的影子（近的很清楚）
 *   - `static`：整張地圖的陰影只在一開始畫一次（大樓不會動），之後不花時間；機甲用腳下的圓影子
 */
export type ShadowMode = 'dynamic' | 'static'

const white = new Color(0xffffff)
const hex = (h: number) => new Color(h)
/** 看不到的地方延伸到多遠（河、地面一路通到地平線） */
const FAR = 2000

/** 能量牆：往上流動的六角形網格，只擋敵人 */
const barrierVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const barrierFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 p = vec2(vUv.x * 28.0, vUv.y * 11.0 - uTime * 0.6);
    vec2 q = vec2(p.x + 0.5 * mod(floor(p.y), 2.0), p.y);
    vec2 f = abs(fract(q) - 0.5);
    float edge = smoothstep(0.42, 0.5, max(f.x, f.y));
    float scan = 0.5 + 0.5 * sin(vUv.y * 40.0 - uTime * 3.0);
    float fade = smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y));
    float a = (0.08 + edge * 0.45 + scan * 0.05) * fade;
    gl_FragColor = vec4(uColor, a);
  }
`

/** 整張地圖一張的貼圖：柏油深深淺淺的大色塊、車輪壓出來的痕跡、爆炸燒過的焦痕（牆腳、高架底下的陰影是另外烘的） */
function macroCanvas(map: MapData): HTMLCanvasElement {
  const wx = MAP_X + MACRO_PAD
  const wz = MAP_Z + MACRO_PAD
  const canvas = document.createElement('canvas')
  canvas.width = wx * 2 * MACRO_PX
  canvas.height = wz * 2 * MACRO_PX
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // 大色塊：小張的雜訊放大
  const nw = Math.round(wx / 4)
  const nh = Math.round(wz / 4)
  const noise = document.createElement('canvas')
  noise.width = nw
  noise.height = nh
  const nctx = noise.getContext('2d')!
  const img = nctx.createImageData(nw, nh)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const v = 128 + (fbm(x * 0.05, y * 0.05, 5, 4) - 0.5) * 84 + (fbm(x * 0.22, y * 0.22, 9, 3) - 0.5) * 44
      const i = (y * nw + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  nctx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(noise, 0, 0, canvas.width, canvas.height)

  // 之後都用世界座標畫（x 往右、z 往下）
  ctx.setTransform(MACRO_PX, 0, 0, MACRO_PX, wx * MACRO_PX, wz * MACRO_PX)
  const rect = (x0: number, x1: number, z0: number, z1: number) => ctx.fillRect(x0, z0, x1 - x0, z1 - z0)

  // 路：每個方向車輪壓得比較黑的兩道、路邊積灰比較淺
  for (const r of map.roads) {
    const lanes = Math.max(1, Math.round(r.w / 7))
    const lw = r.w / (lanes * 2)
    for (let k = 0; k < lanes * 2; k++) {
      const c = r.at - r.w / 2 + lw * (k + 0.5)
      for (const off of [-0.9, 0.9]) {
        ctx.fillStyle = 'rgba(0,0,0,0.07)'
        if (r.axis === 'x') rect(r.a, r.b, c + off - 0.45, c + off + 0.45)
        else rect(c + off - 0.45, c + off + 0.45, r.a, r.b)
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    for (const side of [-1, 1]) {
      const e = r.at + side * (r.w / 2 - 0.6)
      if (r.axis === 'x') rect(r.a, r.b, e - 0.6, e + 0.6)
      else rect(e - 0.6, e + 0.6, r.a, r.b)
    }
  }

  // 焦痕：打過仗的地方，路上、廣場上一圈圈燒黑的痕跡
  const rand = rng(90210)
  for (let i = 0; i < 150; i++) {
    const x = (rand() * 2 - 1) * (MAP_X - 30)
    const z = (rand() * 2 - 1) * (MAP_Z - 20)
    if (Math.abs(x) < RIVER + 2) continue
    const r = 2.5 + rand() * 5.5
    const g = ctx.createRadialGradient(x, z, 0, x, z, r)
    const a = 0.3 + rand() * 0.4
    g.addColorStop(0, `rgba(0,0,0,${a})`)
    g.addColorStop(0.35, `rgba(0,0,0,${a * 0.6})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - r, z - r, r * 2, r * 2)
    // 往外噴的幾道
    ctx.strokeStyle = `rgba(0,0,0,${a * 0.35})`
    for (let k = 0; k < 7; k++) {
      const t = rand() * Math.PI * 2
      const len = r * (0.8 + rand() * 0.9)
      ctx.lineWidth = 0.3 + rand() * 0.5
      ctx.beginPath()
      ctx.moveTo(x + Math.cos(t) * r * 0.2, z + Math.sin(t) * r * 0.2)
      ctx.lineTo(x + Math.cos(t) * len, z + Math.sin(t) * len)
      ctx.stroke()
    }
  }

  // 邊緣收回中間值：地圖外面是夾住邊緣那一排像素，不收的話會拉出一條條的色帶
  const edge = 24
  const fade = (x0: number, z0: number, x1: number, z1: number, gx0: number, gz0: number, gx1: number, gz1: number) => {
    const g = ctx.createLinearGradient(gx0, gz0, gx1, gz1)
    g.addColorStop(0, 'rgba(128,128,128,1)')
    g.addColorStop(1, 'rgba(128,128,128,0)')
    ctx.fillStyle = g
    ctx.fillRect(x0, z0, x1 - x0, z1 - z0)
  }
  fade(-wx, -wz, -wx + edge, wz, -wx + 2, 0, -wx + edge, 0)
  fade(wx - edge, -wz, wx, wz, wx - 2, 0, wx - edge, 0)
  fade(-wx, -wz, wx, -wz + edge, 0, -wz + 2, 0, -wz + edge)
  fade(-wx, wz - edge, wx, wz, 0, wz - 2, 0, wz - edge)
  return canvas
}

type Options = {
  /** 手機、平板：貼圖解析度砍半、陰影只畫一次 */
  mobile: boolean
  /**
   * 畫面先畫到浮點數的貼圖、最後才做色調映射（`post.ts`）。這時霧是在還沒轉成螢幕顏色之前混的，
   * 同樣的濃度看起來重很多（暗的大樓一下就被洗白），所以調淡，遠處看起來才和直接畫到螢幕上差不多
   */
  hdr: boolean
}

export class World {
  readonly scene = new Scene()
  private readonly renderer: WebGLRenderer
  private readonly disposables: { dispose(): void }[] = []
  private readonly barriers: ShaderMaterial[] = []
  private readonly sky = new Sky()
  private readonly tex: WorldTextures
  private readonly masks: WorldMasks
  private readonly decals: WorldDecals
  private readonly env: WebGLRenderTarget
  private readonly macro: Texture
  /** 烘好的環境光遮蔽：地面那一張、貼圖集（`worldbake.ts`） */
  private readonly ao: WorldBakeTargets
  private readonly atlas = new Atlas()
  /** 所有場景材質共用的參數（`worldmat.ts`） */
  private readonly look: WorldLook
  /** 還沒做成網格的：要等貼圖集排好才知道每個面在圖上的位置 */
  private pending: { mesher: Mesher; mat: Material; cast: boolean; receive: boolean; order: number }[] = []
  private readonly clock = { value: 0 }
  private readonly beacon: MeshBasicMaterial
  /** 還在閃的黃燈（路口的紅綠燈只剩這個） */
  private readonly amber: MeshBasicMaterial
  /** 火、煙柱、飄在空中的火星和灰燼（`worldfx.ts`） */
  private readonly fx: Ambience
  /** 這個場景自己的東西（大樓、地面…）：只畫一次的陰影只算它們，不算之後加進來的機甲 */
  private readonly statics = new Set<Object3D>()
  private readonly mobile: boolean
  private readonly hdr: boolean
  /** 地圖上最高的東西多高（從太陽那邊拍整張地圖時要拍到多遠） */
  private readonly top: number
  private sunDynamic: SunLight | null = null
  private sunStatic: DirectionalLight | null = null
  private mode: ShadowMode

  constructor(map: MapData, renderer: WebGLRenderer, opt: Options) {
    this.renderer = renderer
    this.mobile = opt.mobile
    this.hdr = opt.hdr
    this.top = Math.max(...map.boxes.map((b) => b.y1))
    this.mode = opt.mobile ? 'static' : 'dynamic'
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = PCFShadowMap
    const anisotropy = renderer.capabilities.getMaxAnisotropy()
    setAnisotropy(anisotropy)

    const scene = this.scene
    scene.background = new Color(HORIZON)
    scene.fog = new FogExp2(HORIZON, opt.hdr ? 0.00145 : 0.0019)
    scene.add(this.sky.mesh)
    this.env = this.sky.environment(renderer)
    scene.environment = this.env.texture
    scene.environmentIntensity = 0.85

    // 煙層底下的天光偏冷、地面反射上來的偏暖（陰影裡不會全黑）
    const hemi = new HemisphereLight(0xa6b3c4, 0x5c5148, 1.15)
    scene.add(hemi)

    this.tex = createTextures(opt.mobile)
    this.masks = createWorldMasks(opt.mobile, Math.min(8, anisotropy))
    this.decals = createWorldDecals(opt.mobile, anisotropy)
    this.macro = dataTexture(macroCanvas(map))
    this.ao = createBakeTargets(opt.mobile ? 1024 : 2048, opt.mobile ? 1 : 2)
    this.look = {
      uWMask: { value: this.masks.mask },
      uWDetail: { value: this.masks.detail },
      uMacro: { value: this.macro },
      uGroundAo: { value: this.ao.ground.texture },
      uWTime: this.clock,
      uWSun: { value: SUN_DIR },
      uWGlow: { value: new Color(GLOW) },
    }
    this.beacon = new MeshBasicMaterial({ color: 0xff3b30 })
    this.amber = new MeshBasicMaterial({ color: 0xffa51a })
    this.fx = new Ambience(this.look, opt.hdr, opt.mobile)
    this.disposables.push(this.macro, this.beacon, this.amber, this.fx, this.decals.texture)

    this.addGround(map)
    this.addRiver()
    this.addMarkings(map)
    this.addBuildings(map)
    this.addProps(map)
    this.addBridges(map)
    this.addTrees(map)
    this.addLights(map)
    this.addDecals(map)
    for (const team of [0, 1] as Team[]) this.addBase(team, map.spawns[team])
    this.flush()
    for (const o of scene.children) this.statics.add(o)
    // 火和煙不算場景自己的東西：不擋光、不拍進反射探針
    this.fx.build(scene)
    this.applyShadows()
  }

  /** 機甲在地上有沒有真的影子（有的話腳下的圓影子只留淡淡的一圈） */
  get realShadows(): boolean {
    return this.mode === 'dynamic'
  }

  /** 場景的材質：canvas 畫的那幾層貼圖（沒有就是素色），加上風化、烘好的遮蔽、霧（`worldmat.ts`） */
  private surf(s: Surface | null, w: Weather, o: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    const m = new MeshStandardMaterial({
      map: s?.map ?? null,
      normalMap: s?.normalMap ?? null,
      roughnessMap: s?.ormMap ?? null,
      metalnessMap: s?.ormMap ?? null,
      vertexColors: true,
      roughness: s?.ormMap ? 1 : 0.9,
      metalness: s?.ormMap ? 1 : 0,
      ...o,
    })
    return weathered(m, this.look, { ...w, lite: this.mobile, haze: this.hdr, hdr: this.hdr })
  }

  /** 加一個網格。`Mesher` 的先記下來，等全部加完、貼圖集排好了才做成網格（`flush`） */
  private add(source: Mesher | BufferGeometry, mat: Material, cast = true, receive = true, order = 0) {
    if (source instanceof Mesher) {
      if (source.empty) mat.dispose()
      else this.pending.push({ mesher: source, mat, cast, receive, order })
      return
    }
    const mesh = new Mesh(source, mat)
    mesh.castShadow = cast
    mesh.receiveShadow = receive
    mesh.renderOrder = order
    this.scene.add(mesh)
    this.disposables.push(source, mat)
  }

  /** 貼圖集排好、所有的網格做出來，再把整個場景的環境光遮蔽烘一次 */
  private flush() {
    this.atlas.pack(this.ao.atlas.width)
    const casters: BufferGeometry[] = []
    const charted: BufferGeometry[] = []
    for (const p of this.pending) {
      const geo = p.mesher.geometry()
      if (p.mesher.charted && p.mat instanceof MeshStandardMaterial) p.mat.aoMap = this.ao.atlas.texture
      const mesh = new Mesh(geo, p.mat)
      mesh.castShadow = p.cast
      mesh.receiveShadow = p.receive
      mesh.renderOrder = p.order
      this.scene.add(mesh)
      this.disposables.push(geo, p.mat)
      if (p.cast) casters.push(geo)
      if (p.mesher.charted) charted.push(geo)
    }
    this.pending = []
    if (canBakeWorld(this.renderer)) {
      bakeWorld(this.renderer, this.ao, { casters, charted, up: this.mobile ? 44 : 112, down: this.mobile ? 16 : 40, depthSize: this.mobile ? 2048 : 4096, top: this.top })
    } else blankBake(this.renderer, this.ao)
  }

  /** 從太陽的方向對準整張地圖的正交鏡頭（整張地圖一張的陰影貼圖用） */
  sunCamera(): OrthographicCamera {
    const cam = new OrthographicCamera()
    cam.position.copy(SUN_DIR).multiplyScalar(1200)
    cam.lookAt(0, 0, 0)
    this.fitSun(cam)
    cam.updateMatrixWorld(true)
    return cam
  }

  /** 把地圖的八個角投到太陽看過來的平面上，定出鏡頭的範圍（鏡頭在太陽那邊 1200 公尺、朝原點） */
  private fitSun(cam: OrthographicCamera) {
    const z = SUN_DIR.clone()
    const x = new Vector3(0, 1, 0).cross(z).normalize()
    const y = z.clone().cross(x)
    const lo = new Vector3(Infinity, Infinity, Infinity)
    const hi = new Vector3(-Infinity, -Infinity, -Infinity)
    const p = new Vector3()
    for (const px of [-MAP_X - 6, MAP_X + 6]) {
      for (const py of [BED - 1, this.top + 2]) {
        for (const pz of [-MAP_Z - 6, MAP_Z + 6]) {
          p.set(px, py, pz)
          const q = new Vector3(p.dot(x), p.dot(y), p.dot(z))
          lo.min(q)
          hi.max(q)
        }
      }
    }
    cam.left = lo.x
    cam.right = hi.x
    cam.bottom = lo.y
    cam.top = hi.y
    cam.near = 1200 - hi.z - 4
    cam.far = 1200 - lo.z + 4
    cam.updateProjectionMatrix()
  }

  /**
   * 只畫場景自己的東西（機甲、特效先藏起來）到 `target`：反射探針、整張地圖的陰影貼圖用。
   * `castersOnly` 只畫會擋光的；`material` 全部換成這個材質畫（拍深度）；`sunDisc` 是 false 時天空不畫日輪
   * （太陽的高光已經由平行光打了，環境貼圖裡再有一顆會亮兩次）；`face` 是立方體貼圖的哪一面
   */
  renderStatics(camera: Camera, target: WebGLRenderTarget, opt: { castersOnly?: boolean; material?: Material; sunDisc?: boolean; face?: number } = {}) {
    const hidden: Object3D[] = []
    for (const o of this.scene.children) {
      if (!o.visible) continue
      if (this.statics.has(o) && (!opt.castersOnly || o.castShadow)) continue
      o.visible = false
      hidden.push(o)
    }
    if (opt.sunDisc === false) this.sky.disc(false)
    this.renderTo(camera, target, opt.material ?? null, opt.face ?? 0)
    if (opt.sunDisc === false) this.sky.disc(true)
    for (const o of hidden) o.visible = true
  }

  /** 照鏡頭的圖層（`camera.layers`）畫到 `target`，全部換成 `material`：機甲的自陰影用 */
  renderLayer(camera: Camera, target: WebGLRenderTarget, material: Material) {
    this.renderTo(camera, target, material, 0)
  }

  private renderTo(camera: Camera, target: WebGLRenderTarget, material: Material | null, face: number) {
    const { scene, renderer } = this
    // 這一次不要重畫場景的陰影（串接陰影是照主鏡頭的視野排的，換個鏡頭畫會整個重排）
    const auto = renderer.shadowMap.autoUpdate
    const override = scene.overrideMaterial
    const before = renderer.getRenderTarget()
    renderer.shadowMap.autoUpdate = false
    scene.overrideMaterial = material
    renderer.setRenderTarget(target, face)
    renderer.render(scene, camera)
    renderer.setRenderTarget(before)
    scene.overrideMaterial = override
    renderer.shadowMap.autoUpdate = auto
  }

  /**
   * 先把整個場景畫一次（畫到 1×1 的貼圖上，什麼都看不到）：場景的陰影貼圖是第一次畫的時候才做的，
   * 還沒做就拿場景的材質去畫別的東西（反射探針），陰影那個取樣器是空的，整個畫不出來
   */
  prime() {
    const target = new WebGLRenderTarget(1, 1)
    const cam = new PerspectiveCamera(50, 1, 1, 10)
    cam.position.set(0, -500, 0)
    cam.updateMatrixWorld()
    const before = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, cam)
    this.renderer.setRenderTarget(before)
    target.dispose()
  }

  /** 天空的環境貼圖，立方體一面 `size` 像素（機甲的材質在反射探針的範圍外用） */
  skyEnvironment(size: number): WebGLRenderTarget {
    return this.sky.environment(this.renderer, size)
  }

  /** 照現在的模式放太陽：會動的串接陰影，或整張地圖只畫一次的陰影 */
  private applyShadows() {
    if (this.mode === 'dynamic') {
      if (this.sunStatic) this.scene.remove(this.sunStatic)
      if (!this.sunDynamic) {
        const sun = new SunLight(SUN_COLOR, SUN_POWER)
        sun.position.copy(SUN_DIR)
        sun.castShadow = true
        sun.shadow.mapSize.set(2048, 2048)
        // 鏡頭前面多遠以內有陰影（再遠的被霧蓋掉大半了）
        sun.shadow.camera.far = 560
        sun.shadow.bias = -0.0004
        sun.shadow.normalBias = 0.32
        sun.shadow.radius = 2
        this.sunDynamic = sun
        this.disposables.push(sun)
      }
      this.scene.add(this.sunDynamic)
      this.statics.add(this.sunDynamic)
      return
    }
    if (this.sunDynamic) this.scene.remove(this.sunDynamic)
    if (!this.sunStatic) {
      const sun = new DirectionalLight(SUN_COLOR, SUN_POWER)
      sun.position.copy(SUN_DIR).multiplyScalar(1200)
      sun.castShadow = true
      // 影子的鏡頭對準整張地圖
      this.fitSun(sun.shadow.camera)
      const size = this.mobile ? 2048 : 4096
      sun.shadow.mapSize.set(size, size)
      sun.shadow.bias = -0.0005
      sun.shadow.normalBias = this.mobile ? 0.8 : 0.45
      sun.shadow.radius = 2
      sun.shadow.autoUpdate = false
      this.sunStatic = sun
      this.disposables.push(sun)
    }
    this.scene.add(this.sunStatic, this.sunStatic.target)
    this.statics.add(this.sunStatic)
    this.statics.add(this.sunStatic.target)
    this.bake()
  }

  /** 整張地圖的陰影畫一次：先把不是場景自己的東西（機甲、特效）藏起來，免得它們的影子留在地上 */
  private bake() {
    const sun = this.sunStatic
    if (!sun) return
    const hidden: Object3D[] = []
    for (const o of this.scene.children) {
      if (this.statics.has(o) || !o.visible) continue
      o.visible = false
      hidden.push(o)
    }
    sun.shadow.needsUpdate = true
    const target = new WebGLRenderTarget(1, 1)
    const cam = new PerspectiveCamera(50, 1, 1, 10)
    cam.position.set(0, -500, 0)
    cam.updateMatrixWorld()
    const before = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, cam)
    this.renderer.setRenderTarget(before)
    target.dispose()
    for (const o of hidden) o.visible = true
  }

  /**
   * 畫面跟不上時叫這個：把會動的陰影換成只畫一次的。
   * 回傳有沒有省到東西（已經是最省的就回傳 false，呼叫的人再去降解析度）
   */
  cheaper(): boolean {
    if (this.mode !== 'dynamic') return false
    this.mode = 'static'
    this.applyShadows()
    return true
  }

  /** 河兩岸的柏油地面、各區塊的地面（人行道墊高一點，有路緣） */
  private addGround(map: MapData) {
    const t = this.tex
    const land = new Mesher()
    const ground = (surface: Surface | null, w: Weather, roughness: number) => this.surf(surface, { ground: true, ...w }, { roughness })
    land.top(-FAR, -RIVER, -FAR, FAR, 0, 16, white)
    land.top(RIVER, FAR, -FAR, FAR, 0, 16, white)
    this.add(land, this.surf(t.asphalt, { ground: true, cracks: 1, dust: 0.7, wet: 0.42 }, { roughness: 1, normalScale: new Vector2(0.28, 0.28) }), false)

    const groups: Record<string, Mesher> = {}
    const get = (k: string) => (groups[k] ??= new Mesher())
    const curb = new Color(0x9c9890)
    const promenade = new Color(0xe8e0d0)
    for (const lot of map.lots) {
      const key =
        lot.kind === 'block' || lot.kind === 'promenade'
          ? 'pavers'
          : lot.kind === 'park'
            ? 'grass'
            : lot.kind === 'plaza'
              ? 'plaza'
              : lot.kind === 'site' || lot.kind === 'railyard'
                ? 'dirt'
                : 'concrete'
      const h = lot.kind === 'apron' || lot.kind === 'parking' || lot.kind === 'railyard' ? 0.06 : 0.18
      const m = get(key)
      const s = key === 'pavers' ? 4 : key === 'dirt' ? 6 : 8
      m.top(lot.x0, lot.x1, lot.z0, lot.z1, h, s, lot.kind === 'promenade' ? promenade : white)
      get('curb').walls(lot.x0, lot.x1, lot.z0, lot.z1, 0, h, 1, 1, 0, curb)
    }
    // 機庫裡的地板
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -MAP_X : BASE.x
      const x1 = s < 0 ? -BASE.x : MAP_X
      get('concrete').top(x0, x1, -BASE.z, BASE.z, 0.05, 8, hex(0xcfcfcf))
    }
    const mats: Record<string, Material> = {
      pavers: ground(t.pavers, { cracks: 0.8, dust: 0.8, wet: 0.36 }, 0.9),
      grass: ground(t.grass, { dust: 0.5, wet: 0.25 }, 1),
      plaza: ground(t.plaza, { cracks: 0.9, dust: 0.6, wet: 0.42 }, 0.75),
      dirt: ground(t.dirt, { dust: 0.3, wet: 0.5 }, 1),
      concrete: ground(t.concrete, { cracks: 0.8, dust: 0.6, wet: 0.36 }, 0.85),
      curb: ground(null, { dust: 0.6 }, 0.9),
    }
    for (const [k, m] of Object.entries(groups)) this.add(m, mats[k], false)
  }

  /** 河：泥巴河床、兩岸的石牆、半透明會流動的水面（一路延伸到地平線） */
  private addRiver() {
    const t = this.tex
    const bed = new Mesher()
    bed.top(-RIVER, RIVER, -FAR, FAR, BED, 8, hex(0x7d7668))
    this.add(bed, this.surf(t.dirt, { ground: true, dust: 0.3, wet: 0.2 }, { roughness: 1 }), false)

    const wall = new Mesher(this.atlas, 0.6)
    const h = -BED
    const len = (FAR * 2) / h
    // 西岸的牆面向東、東岸的面向西
    wall.face([-RIVER, BED, FAR, 0, 0], [-RIVER, BED, -FAR, len, 0], [-RIVER, 0, -FAR, len, 1], [-RIVER, 0, FAR, 0, 1], white)
    wall.face([RIVER, BED, -FAR, 0, 0], [RIVER, BED, FAR, len, 0], [RIVER, 0, FAR, len, 1], [RIVER, 0, -FAR, 0, 1], white)
    this.add(wall, this.surf(t.stone, { wall: 0.7, under: 0x5f5a50 }, { roughness: 0.92 }))

    const water = new Mesher()
    water.top(-RIVER, RIVER, -FAR, FAR, WATER, 40, white)
    const mat = flowing(
      new MeshStandardMaterial({
        color: 0x2f3a33,
        normalMap: t.waterNormal,
        normalScale: new Vector2(0.14, 0.14),
        roughness: 0.1,
        metalness: 0.3,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        envMap: this.env.texture,
        envMapIntensity: 1.1,
      }),
      this.look,
      this.hdr,
    )
    this.add(water, mat, false, true, 1)
  }

  /** 路面的標線：中間的線、路口前的停止線和斑馬線；大橋橋面的分隔線和邊線 */
  private addMarkings(map: MapData) {
    // 地面上的（跟著地面那一層髒污、焦痕變暗）和高架上的分開
    const m = new Mesher()
    const high = new Mesher()
    const yellow = new Color(0xb3923a)
    const paint = new Color(0xb9b7ae)
    const y = 0.03
    const crossing = (road: MapData['roads'][number], v: number) =>
      map.roads.some((c) => crosses(road, c) && Math.abs(v - c.at) < c.w / 2 + 5.5)
    const flat = (x0: number, x1: number, z0: number, z1: number, c: Color, h = y) => (h > 1 ? high : m).top(x0, x1, z0, z1, h, 100, c)
    for (const road of map.roads) {
      const wide = road.w >= 18
      for (let a = road.a + 2; a < road.b - 2; a += 9) {
        // 大路是雙黃線（不斷），其他是白色虛線
        const b = wide ? Math.min(a + 9, road.b - 2) : a + 4.5
        if (crossing(road, a) || crossing(road, b)) continue
        if (wide) {
          for (const off of [-0.3, 0.3]) {
            if (road.axis === 'x') flat(a, b, road.at + off - 0.1, road.at + off + 0.1, yellow)
            else flat(road.at + off - 0.1, road.at + off + 0.1, a, b, yellow)
          }
        } else if (road.axis === 'x') flat(a, b, road.at - 0.12, road.at + 0.12, paint)
        else flat(road.at - 0.12, road.at + 0.12, a, b, paint)
      }
      // 大路每個方向再分兩線
      if (wide) {
        for (const off of [-road.w / 4, road.w / 4]) {
          for (let a = road.a + 2; a < road.b - 6; a += 12) {
            if (crossing(road, a) || crossing(road, a + 4)) continue
            if (road.axis === 'x') flat(a, a + 4, road.at + off - 0.1, road.at + off + 0.1, paint)
            else flat(road.at + off - 0.1, road.at + off + 0.1, a, a + 4, paint)
          }
        }
      }
    }
    // 斑馬線和停止線：路口有路的那幾邊
    for (const r of map.roads.filter((r) => r.axis === 'x')) {
      for (const c of map.roads.filter((c) => c.axis === 'z')) {
        if (!crosses(r, c)) continue
        const hw = c.w / 2
        const hz = r.w / 2
        for (const side of [-1, 1]) {
          // 南北向的街上、靠大道的那一邊
          const z = r.at + side * (hz + 2.5)
          if (z > c.a + 2 && z < c.b - 2) {
            for (let x = c.at - hw + 1; x < c.at + hw - 1; x += 1.4) flat(x, x + 0.7, z - 1.5, z + 1.5, paint)
            flat(c.at - hw + 0.6, c.at + hw - 0.6, z + side * 2.4 - 0.2, z + side * 2.4 + 0.2, paint)
          }
          // 大道上、靠街的那一邊
          const x = c.at + side * (hw + 2.5)
          if (x > r.a + 2 && x < r.b - 2) {
            for (let zz = r.at - hz + 1; zz < r.at + hz - 1; zz += 1.4) flat(x - 1.5, x + 1.5, zz, zz + 0.7, paint)
            flat(x + side * 2.4 - 0.2, x + side * 2.4 + 0.2, r.at - hz + 0.6, r.at + hz - 0.6, paint)
          }
        }
      }
    }
    // 高架的路面（大橋、快速道路）：兩邊的白線；只有一線道是中間的黃色虛線，多線道是雙黃線、車道中間的白色虛線
    for (const b of map.boxes) {
      if (b.kind !== 'deck' || !b.lanes) continue
      const top = b.y1 + 0.03
      const along = b.lanes === 'x'
      const c = along ? (b.z0 + b.z1) / 2 : (b.x0 + b.x1) / 2
      const half = (along ? b.z1 - b.z0 : b.x1 - b.x0) / 2
      const u0 = along ? b.x0 : b.z0
      const u1 = along ? b.x1 : b.z1
      /** 沿著路的一條線：v0～v1 是離中線多遠（橫向） */
      const line = (v0: number, v1: number, color: Color, dash: boolean) => {
        const seg = (a: number, e: number) => (along ? flat(a, e, c + v0, c + v1, color, top) : flat(c + v0, c + v1, a, e, color, top))
        if (!dash) seg(u0, u1)
        else for (let u = u0 + 1; u < u1 - 1; u += 9) seg(u, Math.min(u + 4.5, u1 - 1))
      }
      const per = Math.max(1, Math.floor((half - 1.7) / 4.5))
      if (per === 1) line(-0.15, 0.15, yellow, true)
      else {
        line(-0.45, -0.15, yellow, false)
        line(0.15, 0.45, yellow, false)
      }
      for (let k = 1; k < per; k++) {
        const v = 0.45 + ((half - 1.7 - 0.45) * k) / per
        line(v - 0.12, v + 0.12, paint, true)
        line(-v - 0.12, -v + 0.12, paint, true)
      }
      line(-half + 1.4, -half + 1.7, paint, false)
      line(half - 1.7, half - 1.4, paint, false)
    }
    // 調車場的鐵軌：兩條鋼軌、一根根枕木
    const steel = new Color(0x8b8f95)
    const sleeper = new Color(0x4a3a2a)
    for (const t of map.tracks) {
      for (let x = t.x0; x < t.x1 - 0.3; x += 1.6) flat(x, x + 0.35, t.z - 1.25, t.z + 1.25, sleeper, 0.07)
      flat(t.x0, t.x1, t.z - 0.82, t.z - 0.68, steel, 0.1)
      flat(t.x0, t.x1, t.z + 0.68, t.z + 0.82, steel, 0.1)
    }
    // 標線被磨掉大半、跟著路面一起裂開
    const offset = { roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }
    this.add(m, this.surf(null, { ground: true, cracks: 1, dust: 1, worn: 0.8 }, offset), false)
    this.add(high, this.surf(null, { prop: true, cracks: 1, dust: 1, worn: 0.8 }, offset), false)
  }

  /**
   * 大樓：一樓是店面，上面照種類貼玻璃帷幕、辦公室、公寓或紅磚的外牆；店面上面一圈雨遮、屋頂上的水塔和冷氣、牆上的直式招牌；
   * 地圖外面再圍一圈遠景
   */
  private addBuildings(map: MapData) {
    const t = this.tex
    const shops = new Mesher(this.atlas, 0.6)
    const styles = { glass: new Mesher(this.atlas, 0.45), office: new Mesher(this.atlas, 0.45), apartment: new Mesher(this.atlas, 0.45), brick: new Mesher(this.atlas, 0.45) }
    const roof = new Mesher(this.atlas, 0.3)
    const trim = new Mesher()
    const gear = new Mesher()
    const signs = new Mesher()
    const beacons = new Mesher()
    const debris = new Mesher()
    const ao = new Color()
    /** 這個點上面有沒有別的東西（大樓、高架）：招牌不要插進隔壁 */
    const tall = map.boxes.filter((b) => b.y1 > 5 && b.kind !== 'land' && b.kind !== 'tree')
    const taken = (x: number, z: number, self: Box) => tall.some((b) => b !== self && x > b.x0 - 0.4 && x < b.x1 + 0.4 && z > b.z0 - 0.4 && z < b.z1 + 0.4)

    for (const b of map.boxes) {
      if (b.kind === 'facade') {
        // 走得進去的大樓的牆：西岸的是紅磚廠房，東岸的是玻璃帷幕（窗戶照樓層高度對齊）
        const west = b.x1 <= 0
        const tint = west ? new Color().setHSL(0.03, 0.18, 0.86) : new Color().setHSL(0.57, 0.1, 0.9)
        ;(west ? styles.brick : styles.glass).walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, CELL_W, CELL_H, b.y0 / CELL_H, tint)
        roof.top(b.x0, b.x1, b.z0, b.z1, b.y1, 8, tint.clone().multiplyScalar(0.85))
        continue
      }
      if (b.kind !== 'building' && b.kind !== 'tower' && b.kind !== 'house') continue
      const r = rng(b.seed * 7919)
      const style =
        b.kind === 'tower'
          ? r() < 0.75
            ? 'glass'
            : 'office'
          : b.kind === 'house'
            ? r() < 0.55
              ? 'brick'
              : 'apartment'
            : r() < 0.55
              ? 'apartment'
              : 'office'
      const tint =
        style === 'brick' ? new Color().setHSL(r() * 0.08, r() * 0.25, 0.78 + r() * 0.22) : new Color().setHSL(r() * 0.12 + 0.05, r() * 0.15, 0.82 + r() * 0.18)
      const m = styles[style]
      // 貼圖位移整數格：看起來一樣，但每棟樓的窗戶各有各的開燈
      const shift = Math.floor(r() * 64)
      const w = b.x1 - b.x0
      const d = b.z1 - b.z0
      const h = b.y1 - b.y0
      // 樓頂被炸掉的：越靠近河（前線）越多
      const front = 1 - Math.min(1, Math.max(0, (Math.abs(b.x0 + b.x1) / 2 - 40) / 260))
      const ruined = r() < 0.34 + 0.42 * front
      if (b.y0 === 0) {
        // 一樓店面，底下暗一點
        ao.copy(tint).multiplyScalar(0.55)
        shops.walls(b.x0, b.x1, b.z0, b.z1, 0, SHOP_H, SHOP_W, SHOP_H, 0, ao.clone(), tint)
        m.walls(b.x0, b.x1, b.z0, b.z1, SHOP_H, b.y1, CELL_W, CELL_H, shift, tint)
        // 店面上面一圈雨遮
        const c = tint.clone().multiplyScalar(0.7)
        trim.box(b.x0 - 0.5, b.x1 + 0.5, b.z0 - 0.5, b.z1 + 0.5, SHOP_H - 0.1, SHOP_H + 0.3, 4, c)
        trim.bottom(b.x0 - 0.5, b.x1 + 0.5, b.z0 - 0.5, b.z1 + 0.5, SHOP_H - 0.1, 4, c.clone().multiplyScalar(0.7))
      } else {
        m.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, CELL_W, CELL_H, shift, tint)
      }
      roof.top(b.x0, b.x1, b.z0, b.z1, b.y1, 8, white)
      if (ruined) {
        // 留一圈高高低低的殘牆、斷掉的樓板和柱子（都在機甲上不去的屋頂上，只是畫面），屋頂上、牆腳邊散著瓦礫
        m.plain = true
        ruinTop({
          wall: m,
          core: trim,
          rebar: gear,
          x0: b.x0,
          x1: b.x1,
          z0: b.z0,
          z1: b.z1,
          y: b.y1,
          us: CELL_W,
          vs: CELL_H,
          v0: shift + (b.y1 - (b.y0 === 0 ? SHOP_H : b.y0)) / CELL_H,
          tint,
          rand: r,
          max: b.kind === 'tower' ? 10 : 7,
        })
        m.plain = false
        // 有幾棟的樓頂還在燒，一道很粗的黑煙往上冒
        if (r() < 0.085) {
          const fx = b.x0 + w * (0.25 + r() * 0.5)
          const fz = b.z0 + d * (0.25 + r() * 0.5)
          this.fx.fire(fx, b.y1 + 0.2, fz, 3.2 + r() * 1.6, b.seed, 2.2)
        }
        const chunk = style === 'brick' ? hex(0x8a5a48) : hex(0x9a958b)
        for (let k = 0; k < 2 + Math.floor((w * d) / 220); k++) rubble(debris, b.x0 + 2 + r() * (w - 4), b.z0 + 2 + r() * (d - 4), b.y1, 2.5, 7, r, chunk, 1.4, 1.6)
        if (b.y0 === 0) {
          // 掉到街上的碎塊：貼著牆腳，矮矮的一堆（機甲踩過去不會穿幫）
          for (let k = 0; k < 3; k++) {
            const side = Math.floor(r() * 4)
            const at = r()
            const px = side < 2 ? b.x0 + at * w : side === 2 ? b.x0 - 1.3 : b.x1 + 1.3
            const pz = side < 2 ? (side === 0 ? b.z0 - 1.3 : b.z1 + 1.3) : b.z0 + at * d
            if (!taken(px, pz, b)) rubble(debris, px, pz, 0.18, 1.5, 8, r, chunk, 0.8, 0.5)
          }
        }
      } else {
        // 屋頂邊緣的女兒牆（牆頂是壓頂的水泥）
        const cap = tint.clone().multiplyScalar(0.8)
        trim.walls(b.x0, b.x1, b.z0, b.z1, b.y1, b.y1 + 1.2, 4, 4, 0, cap)
        trim.walls(b.x1 - 0.4, b.x0 + 0.4, b.z1 - 0.4, b.z0 + 0.4, b.y1, b.y1 + 1.2, 4, 4, 0, cap.clone().multiplyScalar(0.8))
        for (const [x0, x1, z0, z1] of [
          [b.x0, b.x1, b.z0, b.z0 + 0.4],
          [b.x0, b.x1, b.z1 - 0.4, b.z1],
          [b.x0, b.x0 + 0.4, b.z0, b.z1],
          [b.x1 - 0.4, b.x1, b.z0, b.z1],
        ]) {
          trim.top(x0, x1, z0, z1, b.y1 + 1.2, 4, cap)
        }
      }

      // 屋頂的設備：機甲跳不上去的高樓才放（只是畫面，不擋東西）
      if (!ruined && b.y1 >= 16 && w >= 9 && d >= 9) {
        const n = 1 + Math.floor(r() * Math.min(5, (w * d) / 90))
        for (let k = 0; k < n; k++) {
          const px = b.x0 + 2.5 + r() * (w - 5)
          const pz = b.z0 + 2.5 + r() * (d - 5)
          const roll = r()
          if (roll < 0.3) {
            // 樓梯間
            const sw = Math.min(2.2, w / 4)
            trim.box(px - sw, px + sw, pz - 1.6, pz + 1.6, b.y1, b.y1 + 3, 4, tint.clone().multiplyScalar(0.9), tint)
          } else if (roll < 0.62) {
            // 不鏽鋼水塔：四支腳、一個桶
            for (const [ox, oz] of [
              [-0.8, -0.8],
              [0.8, -0.8],
              [-0.8, 0.8],
              [0.8, 0.8],
            ]) {
              gear.box(px + ox - 0.08, px + ox + 0.08, pz + oz - 0.08, pz + oz + 0.08, b.y1, b.y1 + 1.1, 2, hex(0x4a4d52))
            }
            gear.prism(px, pz, 1.05, b.y1 + 1.1, b.y1 + 3.2, 8, hex(0xc9ced4), hex(0xe6eaee))
          } else if (roll < 0.9) {
            // 冷氣主機
            const aw = 1 + r() * 1.2
            gear.box(px - aw, px + aw, pz - 0.7, pz + 0.7, b.y1 + 0.2, b.y1 + 1.5, 2.6, hex(0xa9adb1), hex(0xc2c5c8))
          } else {
            // 天線
            gear.box(px - 0.09, px + 0.09, pz - 0.09, pz + 0.09, b.y1, b.y1 + 6 + r() * 5, 2, hex(0x5b5f64))
          }
        }
      }
      // 高樓頂上的機房和航空警示燈
      if (!ruined && b.kind === 'tower' && h > 40 && w > 14 && d > 14) {
        const ix = w * 0.22
        const iz = d * 0.22
        gear.box(b.x0 + ix, b.x1 - ix, b.z0 + iz, b.z1 - iz, b.y1, b.y1 + 4.5, 3, hex(0x565b61), hex(0x70757b))
        const cx = (b.x0 + b.x1) / 2
        const cz = (b.z0 + b.z1) / 2
        gear.box(cx - 0.12, cx + 0.12, cz - 0.12, cz + 0.12, b.y1 + 4.5, b.y1 + 9, 2, hex(0x5b5f64))
        beacons.box(cx - 0.3, cx + 0.3, cz - 0.3, cz + 0.3, b.y1 + 9, b.y1 + 9.6, 1, white)
      }

      // 直式招牌：老街屋、公寓的牆上，掛在機甲頭頂以上
      if (b.y0 === 0 && b.kind !== 'tower' && b.y1 >= 13) {
        const faces: [number, number, number, number, number, number][] = [
          // [起點 x, z, 沿著牆的方向 x, z, 往外的方向 x, z]
          [b.x0, b.z1, 1, 0, 0, 1],
          [b.x1, b.z0, -1, 0, 0, -1],
          [b.x1, b.z1, 0, -1, 1, 0],
          [b.x0, b.z0, 0, 1, -1, 0],
        ]
        for (const [sx, sz, ax, az, nx, nz] of faces) {
          const len = ax !== 0 ? w : d
          for (let u = 3 + r() * 8; u < len - 2; u += 9 + r() * 12) {
            const px = sx + ax * u
            const pz = sz + az * u
            if (r() < 0.35 || taken(px + nx * 1.1, pz + nz * 1.1, b) || taken(px + nx * 2, pz + nz * 2, b)) continue
            const y0 = 6.9 + r() * 1.5
            const sh = Math.min(4.8, b.y1 - y0 - 0.5)
            // 有些被震歪了
            signs.sign(px + nx * 0.15, y0, pz + nz * 0.15, nx, nz, 1.2, sh, Math.floor(r() * SIGN_COUNT), r() < 0.3 ? 0.15 + r() * 0.4 : 0)
          }
        }
      }
    }

    // 遠景：地圖外面一圈大樓，不會走到那裡（河道留著）。用便宜的材質、不算陰影
    const far = { glass: new Mesher(), office: new Mesher() }
    const farRoof = new Mesher()
    const r = rng(777)
    for (let k = 0; k < 160; k++) {
      const a = (k / 160) * Math.PI * 2 + r() * 0.03
      const dist = 330 + r() * 280
      const cx = Math.cos(a) * dist * 1.35
      const cz = Math.sin(a) * dist
      if (Math.abs(cx) < MAP_X + 30 && Math.abs(cz) < MAP_Z + 30) continue
      const w = 20 + r() * 30
      const d = 20 + r() * 30
      if (Math.abs(cx) < RIVER + w / 2 + 20) continue
      // 三成塌得只剩半截
      const h = (30 + r() * (dist < 450 ? 90 : 160)) * (r() < 0.3 ? 0.35 + r() * 0.2 : 1)
      // 燻黑的空殼；大半的樓頂被削掉，剩下高高低低的幾截
      const tint = new Color().setHSL(0.07, 0.07, 0.2 + r() * 0.22)
      const style = r() < 0.5 ? far.glass : far.office
      const tile = Math.floor(r() * 64)
      let x0 = cx - w / 2
      let x1 = cx + w / 2
      let z0 = cz - d / 2
      let z1 = cz + d / 2
      style.walls(x0, x1, z0, z1, 0, h, CELL_W, CELL_H, tile, tint.clone().multiplyScalar(0.55), tint)
      farRoof.top(x0, x1, z0, z1, h, 8, tint)
      // 每隔幾棟有一棟在燒：很大的一道煙柱
      if (k % 19 === 7) this.fx.plume(cx, h * 0.7, cz, 46 + r() * 30, 280 + r() * 140, k, 0.1)
      if (r() < 0.65) {
        let y = h
        for (let k = 0; k < 1 + Math.floor(r() * 2); k++) {
          const kx = 0.45 + r() * 0.3
          const kz = 0.45 + r() * 0.3
          if (r() < 0.5) x1 = x0 + (x1 - x0) * kx
          else x0 = x1 - (x1 - x0) * kx
          if (r() < 0.5) z1 = z0 + (z1 - z0) * kz
          else z0 = z1 - (z1 - z0) * kz
          const rise = 5 + r() * 12
          style.walls(x0, x1, z0, z1, y, y + rise, CELL_W, CELL_H, tile, tint.clone().multiplyScalar(0.8), tint)
          farRoof.top(x0, x1, z0, z1, y + rise, 8, tint)
          y += rise
        }
      }
    }

    // 窗戶在外牆貼圖的一格（一個開間 × 一層樓）裡的範圍：每一扇破了沒、釘了木板沒、燒過沒由著色器決定
    const windows: Record<keyof typeof styles, [number, number, number, number]> = {
      glass: [0.016, 0.018, 0.984, 0.78],
      office: [0.047, 0.28, 0.953, 0.8],
      apartment: [0.12, 0.34, 0.88, 0.84],
      brick: [0.25, 0.24, 0.75, 0.8],
    }
    this.add(shops, this.surf(t.shops, { wall: 1, under: 0x7d776d, damage: 0.6 }))
    this.add(
      styles.glass,
      this.surf(t.glass, { windows: windows.glass, wall: 0.45, under: 0x3b4046, damage: 0.75 }, { envMap: this.env.texture, envMapIntensity: 1.25, normalScale: new Vector2(0.6, 0.6) }),
    )
    this.add(styles.office, this.surf(t.office, { windows: windows.office, wall: 0.9, under: 0x8b867c, damage: 0.6 }))
    this.add(styles.apartment, this.surf(t.apartment, { windows: windows.apartment, wall: 1, under: 0x8a6a58, damage: 0.6 }))
    this.add(styles.brick, this.surf(t.brick, { windows: windows.brick, wall: 0.8, under: 0x6b4a3c, damage: 0.55 }))
    this.add(roof, this.surf(t.roof, { dust: 1, cracks: 0.6, wet: 0.5 }, { roughness: 0.95 }))
    this.add(trim, this.surf(t.concrete, { prop: true, wall: 0.8, dust: 0.8 }, { roughness: 0.9 }))
    this.add(gear, this.surf(t.corrugated, { prop: true, rust: 0.7, dust: 0.6 }, { roughness: 0.5, metalness: 0.7 }))
    // 招牌沒電了，褪色、斑駁
    this.add(signs, this.surf(null, { prop: true, wall: 0.7, under: 0x4a4744 }, { map: t.signs.map, roughness: 0.6 }))
    this.add(debris, this.surf(t.concrete, { prop: true, dust: 0.6 }, { roughness: 0.95 }))
    this.add(beacons, this.beacon, false, false)
    // 遠景用便宜的材質
    const farMat = (surface: Surface) => hazed(new MeshLambertMaterial({ map: surface.map, vertexColors: true }), this.look, this.hdr)
    this.add(far.glass, farMat(t.glass), false, false)
    this.add(far.office, farMat(t.office), false, false)
    this.add(farRoof, hazed(new MeshLambertMaterial({ vertexColors: true, color: 0x6d6b68 }), this.look, this.hdr), false, false)
  }

  /** 貨櫃、倉庫、車、公車、混凝土牆、花台、噴水池、工地的柱子、碼頭吊架、河裡的駁船和水泥塊、機庫的牆 */
  private addProps(map: MapData) {
    const t = this.tex
    const metal = new Mesher(this.atlas, 0.5)
    /** 機庫的牆：還在用的，沒什麼鏽 */
    const shed = new Mesher(this.atlas, 0.5)
    const blast = new Mesher(this.atlas, 0.7)
    const plain = new Mesher(this.atlas, 0.7)
    const paint = new Mesher()
    const dark = new Mesher()
    const debris = new Mesher()
    const green = new Mesher(this.atlas, 0.5)
    const stone = new Mesher(this.atlas, 0.6)
    const containerColors = [0xb4412f, 0x2f5f8f, 0x2f7d4f, 0xc97a1e, 0x8b8f94, 0x6b3f8f, 0xd9c23a]
    const shedColors = [0xa9adb1, 0x8d969a, 0xa7765a, 0x7b8f84]
    const railColors = [0x7a3b2e, 0x3f5f4a, 0x2f4f7a, 0x8a8f94, 0xb8862f, 0x5b4636]
    for (const b of map.boxes) {
      const r = rng(b.seed * 104729)
      const y = b.y0
      const long = b.x1 - b.x0 > b.z1 - b.z0
      switch (b.kind) {
        case 'container': {
          const c = hex(containerColors[Math.floor(r() * containerColors.length)])
          metal.box(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 2.6, c.clone().multiplyScalar(0.82), c)
          break
        }
        case 'railcar': {
          // 車廂：下面黑色的底盤和輪子，上面照顏色的車身，頂上亮一點
          const c = hex(railColors[Math.floor(r() * railColors.length)])
          plain.box(b.x0 + 1.2, b.x1 - 1.2, b.z0 + 0.3, b.z1 - 0.3, y, y + 1.1, 4, hex(0x26282b))
          metal.box(b.x0, b.x1, b.z0, b.z1, y + 1.1, b.y1, 4.4, c.clone().multiplyScalar(0.8), c.clone().multiplyScalar(1.15))
          break
        }
        case 'mound':
          // 墊高的公園：石砌的擋土牆、上面是草地
          stone.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 8, 8, 0, white)
          green.top(b.x0, b.x1, b.z0, b.z1, b.y1, 8, white)
          break
        case 'warehouse': {
          const c = hex(shedColors[Math.floor(r() * shedColors.length)])
          metal.walls(b.x0, b.x1, b.z0, b.z1, 0, b.y1, 6, 6, 0, c.clone().multiplyScalar(0.7), c)
          metal.top(b.x0, b.x1, b.z0, b.z1, b.y1, 6, c.clone().multiplyScalar(0.75))
          // 屋脊的通風器
          const cx = (b.x0 + b.x1) / 2
          const cz = (b.z0 + b.z1) / 2
          if (long) metal.box(b.x0 + 2, b.x1 - 2, cz - 0.8, cz + 0.8, b.y1, b.y1 + 0.9, 3, c.clone().multiplyScalar(0.6))
          else metal.box(cx - 0.8, cx + 0.8, b.z0 + 2, b.z1 - 2, b.y1, b.y1 + 0.9, 3, c.clone().multiplyScalar(0.6))
          break
        }
        case 'hangar': {
          // 機庫的牆：灰色浪板，上面一條隊伍顏色的帶子
          const team: Team = b.x0 < 0 ? 0 : 1
          shed.box(b.x0, b.x1, b.z0, b.z1, 0, b.y1 - 3, 6, hex(0x7d8389), hex(0x9aa0a6))
          shed.box(b.x0, b.x1, b.z0, b.z1, b.y1 - 3, b.y1, 6, hex(TEAMS[team].armor))
          break
        }
        case 'car': {
          // 路上有幾台還在燒
          const burnt = wreck(paint, dark, b, r, false)
          if (burnt && b.y0 < 0.5 && Math.abs(b.x0) < BASE.x - 30 && r() < 0.15) {
            const fx = (b.x0 + b.x1) / 2
            const fz = (b.z0 + b.z1) / 2
            this.fx.fire(fx, b.y0 + 0.75, fz, 1.7 + r() * 0.9, b.seed)
            this.fx.glow(fx, b.y0 + 0.25, fz, 6, b.seed)
          }
          break
        }
        case 'bus':
          wreck(paint, dark, b, r, true)
          break
        case 'barrier':
          plain.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 2, hex(0xa9a69f), hex(0xc9c6bf))
          break
        case 'twall':
          blast.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 4.2, white)
          break
        case 'pillar':
          // 高的是碼頭的吊架（黃色鋼架），矮的是工地的柱子
          if (b.y1 >= 26) paint.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 4, hex(0x8a6a22), hex(0xa07c2a))
          else plain.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 6, hex(0xb8b4ac), hex(0xd8d4cc))
          break
        case 'planter':
          plain.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 2, hex(0xb9b4a8), hex(0xd9d4c8))
          green.top(b.x0 + 0.3, b.x1 - 0.3, b.z0 + 0.3, b.z1 - 0.3, b.y1 + 0.02, 3, white)
          break
        case 'monument':
          plain.box(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 4, hex(b.y0 === 0 ? 0xb8ad98 : 0xcfc6b4))
          break
        case 'kiosk':
          plain.box(b.x0 + 0.6, b.x1 - 0.6, b.z0 + 0.6, b.z1 - 0.6, y, b.y1 - 0.4, 3, hex(0x8b6b4a))
          paint.box(b.x0, b.x1, b.z0, b.z1, b.y1 - 0.4, b.y1, 3, hex(0x7a2e22))
          paint.bottom(b.x0, b.x1, b.z0, b.z1, b.y1 - 0.4, 3, hex(0x5a2018))
          break
        case 'crate':
          plain.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 2, hex(r() < 0.5 ? 0x9a7b4f : 0x6b7280))
          break
        case 'rubble':
          collapsed(debris, b, r, hex(0x8d8a83))
          break
        case 'barge':
          // 船身生鏽的紅褐色、上面的駕駛艙灰白色
          metal.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 4, hex(y <= BED ? 0x6e3524 : 0xd6d1c7))
          break
        default:
          break
      }
    }
    this.add(metal, this.surf(t.corrugated, { rust: 0.62, wall: 0.5, under: 0x4a3a2e, dust: 0.6 }, { roughness: 0.55, metalness: 0.55 }))
    this.add(shed, this.surf(t.corrugated, { rust: 0.24, dust: 0.3 }, { roughness: 0.55, metalness: 0.55 }))
    this.add(blast, this.surf(t.blast, { wall: 1, under: 0x5f5b54, dust: 0.6 }, { roughness: 0.9 }))
    this.add(plain, this.surf(t.concrete, { wall: 0.9, under: 0x5f5b54, dust: 0.8, cracks: 0.3 }, { roughness: 0.85 }))
    this.add(paint, this.surf(null, { prop: true, rust: 0.6, dust: 0.8 }, { roughness: 0.5, metalness: 0.4 }))
    this.add(dark, this.surf(null, { prop: true }, { roughness: 0.95 }))
    this.add(debris, this.surf(t.concrete, { prop: true, dust: 0.6 }, { roughness: 0.95 }))
    this.add(green, this.surf(t.grass, { dust: 0.5 }, { roughness: 1 }))
    this.add(stone, this.surf(t.stone, { wall: 0.8, under: 0x6b665c }, { roughness: 0.92 }))
  }

  /**
   * 橋：大橋、快速道路的橋面、坡道和交流道、護欄、橋墩、橋塔和斜張的鋼纜；人行鋼橋、鋼桁架；下河的坡道。
   * 走得進去的大樓的樓板、柱子、矮牆也在這裡（和橋一樣是水泥）
   */
  private addBridges(map: MapData) {
    const t = this.tex
    const road = new Mesher(this.atlas, 0.8)
    const concrete = new Mesher(this.atlas, 0.7)
    const steel = new Mesher(this.atlas, 0.6)
    const slab = new Mesher(this.atlas, 0.7)
    const beacons = new Mesher()
    const warm = new Color(0xe4dccd)
    const cool = new Color(0xd4d8dc)
    /** 樓板底下（天花板）：朝下的面只照得到地面反射的光，亮不亮看底下的地面（烘的時候算的） */
    const under = new Mesher(this.atlas, 0.5)
    const light = new Color(0xc9c5bd)
    const dark = new Color(0x8f8b83)
    const steelC = new Color(0x4d6a80)
    const plate = new Color(0x8a8e93)
    for (const b of map.boxes) {
      switch (b.kind) {
        case 'deck':
          // 高架的路面（大橋、快速道路、橋頭平台、停車場屋頂）、南邊的公路橋：水泥橋身、柏油路面
          if (b.y1 > 2 || Math.abs((b.z0 + b.z1) / 2 - AVENUE_Z) < 0.5) {
            concrete.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 4, 4, 0, dark, light)
            concrete.bottom(b.x0, b.x1, b.z0, b.z1, b.y0, 4, dark)
            road.top(b.x0, b.x1, b.z0, b.z1, b.y1, 16, white)
          } else {
            // 人行鋼橋：藍灰色的鋼樑、灰色的鋪板
            steel.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 4, 4, 0, steelC)
            steel.bottom(b.x0, b.x1, b.z0, b.z1, b.y0, 4, steelC)
            steel.top(b.x0, b.x1, b.z0, b.z1, b.y1, 3, plate)
          }
          break
        case 'ramp':
          // 坡道、交流道的平台：水泥的側面、柏油路面
          concrete.solid(b, 4, dark, light, false)
          road.slopeTop(b, 16, white)
          break
        case 'slipway':
          // 下河的坡道、公園的步道：整塊水泥
          concrete.solid(b, 4, dark, light)
          break
        case 'parapet':
          concrete.solid(b, 3, light)
          break
        case 'pier':
          concrete.solid(b, 4, dark, light)
          break
        case 'pylon':
          concrete.solid(b, 6, hex(0xb9b5ad), hex(0xd8d4cc))
          if (b.y0 > BED) concrete.bottom(b.x0, b.x1, b.z0, b.z1, b.y0, 6, dark)
          // 橋塔頂上的航空警示燈
          if (b.y1 > 40 && b.x1 - b.x0 < 8 && b.z1 - b.z0 < 8) {
            const cx = (b.x0 + b.x1) / 2
            const cz = (b.z0 + b.z1) / 2
            beacons.box(cx - 0.35, cx + 0.35, cz - 0.35, cz + 0.35, b.y1, b.y1 + 0.7, 1, white)
          }
          break
        case 'rail':
          steel.solid(b, 2, steelC)
          break
        case 'floor':
          // 大樓的樓板：水泥的邊和底，上面是打磨過的水泥地（西岸的偏暖、東岸的偏冷）
          concrete.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 4, 4, 0, dark, light)
          under.bottom(b.x0, b.x1, b.z0, b.z1, b.y0, 4, white)
          slab.top(b.x0, b.x1, b.z0, b.z1, b.y1, 8, b.x1 <= 0 ? warm : cool)
          break
        case 'column':
          concrete.solid(b, 4, dark, light)
          break
        case 'sill':
          concrete.solid(b, 3, light)
          break
        default:
          break
      }
    }
    // 斜張橋的鋼纜：從橋面兩邊外面的兩根塔柱拉到東西兩邊的橋面護欄（大橋的橋塔在正中間）
    const cables = new Mesher()
    const cableC = new Color(0x3d434a)
    const deckY = map.boxes.find((b) => b.kind === 'deck' && b.lanes && b.x0 < 0 && b.x1 > 0 && b.z0 < 0 && b.z1 > 0)?.y1 ?? 8
    for (const side of [-1, 1]) {
      for (const dir of [-1, 1]) {
        for (let k = 0; k < 9; k++) {
          // 每一邊各有一條被打斷了：剩下掛在塔上垂著的一截
          if ((40 + side * 3 + dir * 5 + k * 7) % 11 === 0) {
            cables.cable(dir * 2.5, 32 + k * 2.4, side * (BRIDGE_W + 2.4), dir * (4.5 + k * 0.8), 21 + k * 1.5, side * (BRIDGE_W + 1.3), 0.22, cableC)
            continue
          }
          cables.cable(dir * 2.5, 32 + k * 2.4, side * (BRIDGE_W + 2.4), dir * (12 + k * 6.2), deckY + 1.2, side * (BRIDGE_W - 0.3), 0.24, cableC)
        }
      }
    }
    this.add(road, this.surf(t.asphalt, { cracks: 1, dust: 0.6, wet: 0.4 }, { roughness: 1, normalScale: new Vector2(0.28, 0.28) }))
    this.add(concrete, this.surf(t.concrete, { wall: 0.9, under: 0x5f5b54, cracks: 0.35, dust: 0.5 }, { roughness: 0.85 }))
    this.add(steel, this.surf(t.corrugated, { rust: 0.7, dust: 0.5 }, { roughness: 0.5, metalness: 0.65 }))
    this.add(slab, this.surf(t.concrete, { cracks: 0.8, dust: 0.8 }, { roughness: 0.6 }))
    this.add(under, this.surf(null, { cracks: 0.5 }, { color: 0xb4b0a8, normalMap: t.concrete.normalMap, roughness: 0.9 }), false)
    this.add(cables, hazed(new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.5, metalness: 0.6 }), this.look, this.hdr), false, false)
    this.add(beacons, this.beacon, false, false)
  }

  /** 樹：都枯了、燒焦了，只剩樹幹和樹枝；行道樹大半連樹幹都不在了 */
  private addTrees(map: MapData) {
    const trees = map.boxes.filter((b) => b.kind === 'tree')
    // 大馬路兩旁的行道樹（只是裝飾，不擋東西）
    const deco: { x: number; y: number; z: number; s: number }[] = []
    for (const lot of map.lots) {
      if (lot.kind !== 'block') continue
      for (let x = lot.x0 + 6; x < lot.x1 - 4; x += 14) {
        deco.push({ x, y: 0, z: lot.z0 + 1.4, s: 0.8 }, { x, y: 0, z: lot.z1 - 1.4, s: 0.8 })
      }
    }
    const all = [...trees.map((b) => ({ x: (b.x0 + b.x1) / 2, y: b.y0, z: (b.z0 + b.z1) / 2, s: 1 })), ...deco]
    const rr = rng(4242)
    // 擋得住東西的那幾棵都留著（碰撞還在）；行道樹三成還立著
    const standing = all.filter((t) => t.s === 1 || rr() < 0.3)
    const mat = this.surf(null, { prop: true }, { color: 0xffffff, roughness: 1, vertexColors: false })
    const variants = [0, 1, 2].map((k) => deadTree(rng(900 + k * 37)))
    const o = new Object3D()
    const c = new Color()
    variants.forEach((geo, k) => {
      const list = standing.filter((_, i) => i % variants.length === k)
      const mesh = new InstancedMesh(geo, mat, list.length)
      list.forEach((t, i) => {
        o.position.set(t.x, t.y, t.z)
        o.rotation.y = rr() * Math.PI * 2
        const s = t.s * (0.9 + rr() * 0.4)
        o.scale.set(s, s * (0.9 + rr() * 0.3), s)
        o.updateMatrix()
        mesh.setMatrixAt(i, o.matrix)
        // 燒焦的偏黑、枯掉的偏灰褐
        mesh.setColorAt(i, rr() < 0.5 ? c.setHSL(0.07, 0.12, 0.035 + rr() * 0.03) : c.setHSL(0.08, 0.14, 0.07 + rr() * 0.05))
      })
      mesh.castShadow = true
      mesh.receiveShadow = true
      // 一棵棵散在整張地圖上，照整張地圖算要不要畫
      mesh.frustumCulled = false
      this.scene.add(mesh)
      this.disposables.push(geo, mesh)
    })
    this.disposables.push(mat)
  }

  /** 路燈和紅綠燈（只是裝飾，都沒電了）：人行道、河濱步道、高架路面的護欄上；大路口的轉角。路燈大半歪了，紅綠燈只剩幾個路口的黃燈還在閃 */
  private addLights(map: MapData) {
    const spots: { x: number; y: number; z: number; a: number }[] = []
    for (const lot of map.lots) {
      if (lot.kind === 'block') {
        for (let x = lot.x0 + 3; x < lot.x1 - 2; x += 24) {
          spots.push({ x, y: 0, z: lot.z0 + 0.6, a: Math.PI }, { x, y: 0, z: lot.z1 - 0.6, a: 0 })
        }
      } else if (lot.kind === 'promenade') {
        const west = lot.x0 < 0
        for (let z = lot.z0 + 12; z < lot.z1 - 4; z += 24) {
          spots.push({ x: west ? lot.x0 + 0.6 : lot.x1 - 0.6, y: 0, z, a: west ? Math.PI / 2 : -Math.PI / 2 })
        }
      }
    }
    // 高架的路（大橋、快速道路、停車場屋頂）：長的護欄上每隔一段一盞，燈頭朝路面那一邊（橋塔旁邊不放）
    const decks = map.boxes.filter((b) => b.kind === 'deck' && b.y1 > 2)
    const pylons = map.boxes.filter((b) => b.kind === 'pylon')
    const onDeck = (x: number, z: number, y: number) => decks.some((d) => x > d.x0 && x < d.x1 && z > d.z0 && z < d.z1 && Math.abs(d.y1 - y) < 0.5)
    for (const b of map.boxes) {
      if (b.kind !== 'parapet' || b.slope || b.y0 < 2) continue
      const alongX = b.x1 - b.x0 >= b.z1 - b.z0
      const len = alongX ? b.x1 - b.x0 : b.z1 - b.z0
      if (len < 24) continue
      const cx = (b.x0 + b.x1) / 2
      const cz = (b.z0 + b.z1) / 2
      for (let u = 9; u < len - 4; u += 18.5) {
        const x = alongX ? b.x0 + u : cx
        const z = alongX ? cz : b.z0 + u
        if (pylons.some((p) => x > p.x0 - 5 && x < p.x1 + 5 && z > p.z0 - 5 && z < p.z1 + 5)) continue
        const a = alongX ? (onDeck(x, z + 3, b.y0) ? 0 : Math.PI) : onDeck(x + 3, z, b.y0) ? Math.PI / 2 : -Math.PI / 2
        spots.push({ x, y: b.y1, z, a })
      }
    }
    const pole = new CylinderGeometry(0.1, 0.16, 8, 6)
    pole.translate(0, 4, 0)
    const arm = new CylinderGeometry(0.07, 0.07, 2.2, 5)
    arm.rotateX(Math.PI / 2)
    arm.translate(0, 7.9, 1)
    const head = new CylinderGeometry(0.22, 0.3, 0.18, 6)
    head.translate(0, 7.84, 2)
    const poleGeo = mergeGeometries([pole, arm, head])
    for (const g of [pole, arm, head]) g.dispose()
    // 燈罩底下亮著的那一面
    const bulbGeo = new CylinderGeometry(0.24, 0.24, 0.05, 6)
    bulbGeo.translate(0, 7.73, 2)
    const mat = this.surf(null, { prop: true, rust: 0.45 }, { color: 0x3f444b, roughness: 0.5, metalness: 0.6, vertexColors: false })
    const bulbMat = this.surf(null, { prop: true }, { color: 0x15171a, roughness: 0.3, vertexColors: false })
    const poles = new InstancedMesh(poleGeo, mat, spots.length)
    const bulbs = new InstancedMesh(bulbGeo, bulbMat, spots.length)
    const o = new Object3D()
    const rr = rng(7171)
    spots.forEach((s, i) => {
      o.position.set(s.x, s.y, s.z)
      // 大半都歪了，有幾根被撞得很斜
      const bend = rr() < 0.16 ? 0.14 + rr() * 0.3 : rr() * 0.05
      const dir = rr() * Math.PI * 2
      o.rotation.set(Math.cos(dir) * bend, s.a, Math.sin(dir) * bend)
      o.updateMatrix()
      poles.setMatrixAt(i, o.matrix)
      bulbs.setMatrixAt(i, o.matrix)
    })
    poles.castShadow = true
    poles.frustumCulled = false
    bulbs.frustumCulled = false
    this.scene.add(poles, bulbs)
    this.disposables.push(poleGeo, bulbGeo, mat, bulbMat, poles, bulbs)

    // 紅綠燈：兩條都夠寬的路交叉的地方，對角各一支，橫桿伸到路的上面（比機甲高）
    const frame = new Mesher()
    const lamps = new Mesher()
    const blink = new Mesher()
    const grey = hex(0x3a3f45)
    const box = hex(0x1d1f22)
    const colors = [hex(0xff3b30), hex(0xffc400), hex(0x2fd15c)]
    for (const r of map.roads.filter((r) => r.axis === 'x' && r.w >= 14)) {
      for (const c of map.roads.filter((c) => c.axis === 'z' && c.w >= 14)) {
        if (!crosses(r, c)) continue
        // T 字路口那一邊沒有路就不放
        if (c.at - c.w / 2 - 3 < r.a || c.at + c.w / 2 + 3 > r.b || r.at - r.w / 2 - 3 < c.a || r.at + r.w / 2 + 3 > c.b) continue
        // 四成的路口黃燈還在閃
        const flashing = rng(Math.round(r.at * 31 + c.at * 17) + 5000)() < 0.4
        for (const side of [-1, 1]) {
          const px = c.at + side * (c.w / 2 + 1)
          const pz = r.at + side * (r.w / 2 + 1)
          frame.box(px - 0.16, px + 0.16, pz - 0.16, pz + 0.16, 0.18, 8.2, 2, grey)
          // 橫桿沿著 z 伸到東西向那條路的上面
          const reach = Math.min(6.5, r.w / 2)
          const z0 = Math.min(pz, pz - side * reach)
          frame.box(px - 0.1, px + 0.1, z0, z0 + reach, 7.9, 8.1, 2, grey)
          const tz = pz - side * (reach - 0.6)
          frame.box(px - 0.22, px + 0.22, tz - 0.75, tz + 0.75, 7.2, 7.9, 1, box)
          for (let k = 0; k < 3; k++) {
            const lz = tz + (k - 1) * 0.46
            if (k === 1 && flashing) blink.box(px - 0.25, px + 0.25, lz - 0.15, lz + 0.15, 7.4, 7.7, 1, white)
            else lamps.box(px - 0.25, px + 0.25, lz - 0.15, lz + 0.15, 7.4, 7.7, 1, colors[k].clone().multiplyScalar(0.05))
          }
        }
      }
    }
    this.add(frame, this.surf(null, { prop: true, rust: 0.5 }, { roughness: 0.5, metalness: 0.5 }))
    this.add(lamps, hazed(new MeshBasicMaterial({ vertexColors: true }), this.look, this.hdr), false, false)
    this.add(blink, this.amber, false, false)
  }

  /**
   * 地上、牆上的痕跡（`worlddecal.ts`，一片一片半透明的貼在面上，不擋東西）：路上的彈坑、焦痕、裂開的路面、油漬，
   * 牆腳散落的碎磚，外牆被砲彈打出來的洞，混凝土牆、倉庫、河岸上噴漆的警告字
   */
  private addDecals(map: MapData) {
    const d = this.decals
    const floor = new Mesher()
    /** 不在地面上的（橋面、牆上）：遮蔽不照地面那一張 */
    const high = new Mesher()
    const r = rng(60606)
    const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)]
    const turn = () => r() * Math.PI * 2
    /** 貼著地面、擋得住東西的方塊：痕跡不要畫進去 */
    const low = map.boxes.filter((b) => b.y0 < 0.5 && b.y1 > 0.3 && b.kind !== 'land')
    const blocked = (x: number, z: number, pad: number) => low.some((b) => x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad)
    const tall = map.boxes.filter((b) => b.y1 > 6 && b.kind !== 'land' && b.kind !== 'tree')
    const hidden = (x: number, y: number, z: number) => tall.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y > b.y0 && y < b.y1)
    const scar = (m: Mesher, x: number, y: number, z: number) => {
      const roll = r()
      if (roll < 0.22) groundDecal(m, pick(d.craters), x, y + 0.01, z, 6 + r() * 6, turn())
      else if (roll < 0.36) groundDecal(m, d.scorch, x, y + 0.01, z, 4 + r() * 5, turn())
      else if (roll < 0.7) groundDecal(m, pick(d.cracks), x, y + 0.005, z, 5 + r() * 7, turn())
      else groundDecal(m, pick(d.stains), x, y, z, 2.5 + r() * 4, turn())
    }
    // 路上
    for (const road of map.roads) {
      const len = road.b - road.a
      for (let i = Math.round((len * road.w) / 380); i > 0; i--) {
        const u = road.a + r() * len
        const v = road.at + (r() - 0.5) * (road.w - 3)
        const x = road.axis === 'x' ? u : v
        const z = road.axis === 'x' ? v : u
        // 河、機庫裡不畫
        if (Math.abs(x) < RIVER + 4 || Math.abs(x) > BASE.x - 6 || blocked(x, z, 1.5)) continue
        scar(floor, x, 0.04, z)
      }
    }
    // 大橋的橋面：兩隊交火最兇的地方
    const deck = map.boxes.find((b) => b.kind === 'deck' && b.lanes && b.x0 < 0 && b.x1 > 0 && b.z0 < 0 && b.z1 > 0)
    if (deck) {
      for (let i = 0; i < 16; i++) scar(high, deck.x0 + 4 + r() * (deck.x1 - deck.x0 - 8), deck.y1 + 0.04, (r() - 0.5) * (BRIDGE_W * 2 - 10))
    }
    for (const b of map.boxes) {
      const w = b.x1 - b.x0
      const dd = b.z1 - b.z0
      /** 第 side 面牆上、沿著牆 t（0～1）的那一點和牆朝外的方向 */
      const face = (side: number, t: number): [number, number, number, number] =>
        side === 0 ? [b.x0 + t * w, b.z0, 0, -1] : side === 1 ? [b.x0 + t * w, b.z1, 0, 1] : side === 2 ? [b.x0, b.z0 + t * dd, -1, 0] : [b.x1, b.z0 + t * dd, 1, 0]
      if ((b.kind === 'building' || b.kind === 'house' || b.kind === 'tower') && b.y0 === 0) {
        // 牆腳的碎磚
        for (let k = 0; k < 2; k++) {
          if (r() < 0.5) continue
          const [x, z, nx, nz] = face(Math.floor(r() * 4), r())
          const px = x + nx * 1.7
          const pz = z + nz * 1.7
          if (!blocked(px, pz, 0.4)) groundDecal(floor, pick(d.debris), px, 0.2, pz, 3 + r() * 3, turn())
        }
        // 外牆上被砲彈打出來的洞（在店面那一層以上）
        for (let side = 0; side < 4; side++) {
          const len = side < 2 ? w : dd
          for (let k = Math.floor((len / 22) * r() * 2); k > 0; k--) {
            const size = 2.6 + r() * 2.6
            const [x, z, nx, nz] = face(side, (size / 2 + 0.5 + r() * (len - size - 1)) / len)
            const y = SHOP_H + 1 + size / 2 + r() * Math.max(0, Math.min(b.y1 - 2, 24) - SHOP_H - 2 - size)
            if (len < size + 2 || hidden(x + nx * 1.2, y, z + nz * 1.2)) continue
            wallDecal(high, pick(d.impacts), x, y, z, nx, nz, size, size)
          }
        }
      } else if ((b.kind === 'twall' && b.y0 < 0.5) || b.kind === 'warehouse') {
        // 噴漆：混凝土牆的兩面、倉庫的牆上
        const side = Math.floor(r() * 4)
        const len = side < 2 ? w : dd
        const size = b.kind === 'twall' ? Math.min(2.4, len - 0.4) : 3 + r() * 1.5
        if (size < 1.6 || r() < 0.35) continue
        const [x, z, nx, nz] = face(side, b.kind === 'twall' ? 0.5 : 0.15 + r() * 0.7)
        if (!hidden(x + nx * 1.2, 2, z + nz * 1.2)) wallDecal(high, pick(d.signs), x, b.y0 + 0.5 + size / 2 + r() * 0.5, z, nx, nz, size, size)
      }
    }
    // 河岸的石牆上很大的字，從河床、對岸都看得到
    for (const s of [-1, 1]) {
      for (let z = -MAP_Z + 40; z < MAP_Z - 40; z += 55 + r() * 60) {
        wallDecal(high, pick(d.signs), s * RIVER, BED + 4.2, z, -s, 0, 5.5, 5.5)
        if (r() < 0.6) wallDecal(high, pick(d.impacts), s * RIVER, BED + 3 + r() * 2, z + 12 + r() * 14, -s, 0, 4.5, 4.5)
      }
    }
    const film = { map: d.texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.95 }
    this.add(floor, this.surf(null, { ground: true }, film), false)
    this.add(high, this.surf(null, { prop: true }, film), false)
  }

  /** 機庫：屋頂、地上的重生點、門口的能量牆 */
  private addBase(team: Team, spawns: Spawn[]) {
    const s = team === 0 ? -1 : 1
    const color = TEAMS[team]
    const x0 = s < 0 ? -MAP_X : BASE.x
    const x1 = s < 0 ? -BASE.x : MAP_X
    const m = new Mesher(this.atlas, 0.5)
    // 屋頂（底下暗一點）
    m.box(x0, x1, -BASE.z, BASE.z, HANGAR_H - 1, HANGAR_H, 6, hex(0x55595e))
    m.bottom(x0, x1, -BASE.z, BASE.z, HANGAR_H - 1, 6, hex(0x6a6e73))
    // 屋頂的鋼樑
    for (let z = -BASE.z + 6; z < BASE.z; z += 8) {
      m.box(x0, x1, z - 0.4, z + 0.4, HANGAR_H - 2.2, HANGAR_H - 1, 2, hex(0x3c4046))
      m.bottom(x0, x1, z - 0.4, z + 0.4, HANGAR_H - 2.2, 2, hex(0x3c4046))
    }
    // 門框
    const fx = s < 0 ? -BASE.x : BASE.x
    m.box(fx - 1, fx + 1, -BASE.z - 1, -BASE.z + 1, 0, HANGAR_H, 2, hex(0x3c4046))
    m.box(fx - 1, fx + 1, BASE.z - 1, BASE.z + 1, 0, HANGAR_H, 2, hex(0x3c4046))
    m.box(fx - 1, fx + 1, -BASE.z, BASE.z, HANGAR_H - 2.5, HANGAR_H, 2, hex(color.armor))
    m.bottom(fx - 1, fx + 1, -BASE.z, BASE.z, HANGAR_H - 2.5, 2, hex(color.armor))
    this.add(m, this.surf(this.tex.concrete, { rust: 0.25, dust: 0.3 }, { roughness: 0.7, metalness: 0.3 }))

    // 重生點的發光圈、牆上和屋頂的燈條
    const glow = new Mesher()
    const c = new Color(color.glow)
    for (const { x, z } of spawns) {
      // 一個框（四條邊），中間留空
      glow.top(x - 2, x + 2, z - 2, z - 1.7, 0.08, 4, c)
      glow.top(x - 2, x + 2, z + 1.7, z + 2, 0.08, 4, c)
      glow.top(x - 2, x - 1.7, z - 1.7, z + 1.7, 0.08, 4, c)
      glow.top(x + 1.7, x + 2, z - 1.7, z + 1.7, 0.08, 4, c)
      glow.top(x - 1.7, x + 1.7, z - 1.7, z + 1.7, 0.08, 4, c.clone().multiplyScalar(0.3))
    }
    const backX = s * (MAP_X - 3.1)
    // 後牆內側的燈條（面向機庫裡面）
    glow.quad(backX, 8, s < 0 ? BASE.z - 2 : -BASE.z + 2, 0, 0, s < 0 ? -(BASE.z - 2) * 2 : (BASE.z - 2) * 2, 0, 1.2, 0, 1, 1, 0, 0, c)
    // 屋頂鋼樑底下的燈管
    const lampC = new Color(0xfff4dc)
    for (let z = -BASE.z + 6; z < BASE.z; z += 8) glow.bottom(x0 + 4, x1 - 4, z - 0.25, z + 0.25, HANGAR_H - 2.22, 4, lampC)
    const pad = new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.6, blending: AdditiveBlending, depthWrite: false })
    this.add(glow, pad, false, false)

    // 能量牆
    const geo = new PlaneGeometry(BASE.z * 2, HANGAR_H - 2.5)
    geo.rotateY(Math.PI / 2)
    geo.translate(fx, (HANGAR_H - 2.5) / 2, 0)
    const mat = new ShaderMaterial({
      vertexShader: barrierVertex,
      fragmentShader: barrierFragment,
      uniforms: { uColor: { value: new Color(color.beam) }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    })
    this.barriers.push(mat)
    this.add(geo, mat, false, false)
  }

  /**
   * 每一格：能量牆流動、河水往下游流、煙層慢慢飄、火在燒、警示燈一閃一閃，天空、火星和灰燼跟著鏡頭。
   * `scale` 是畫面高度（像素）÷（2·tan(視角/2)）
   */
  update(time: number, camera: Camera, scale: number) {
    for (const m of this.barriers) m.uniforms.uTime.value = time
    this.clock.value = time
    this.sky.update(time, camera.position.x, camera.position.y, camera.position.z)
    this.fx.update(time, camera, scale)
    const blink = (time % 1.6) / 1.6
    // 畫面有泛光時亮的那一下調得比 1 亮，才暈得開
    const gain = this.hdr ? 2.4 : 1
    this.beacon.color.setRGB(blink < 0.35 ? gain : 0.16, 0.05, 0.04)
    const flash = time % 1.1 < 0.55
    this.amber.color.setRGB(flash ? gain : 0.06, flash ? 0.6 * gain : 0.035, flash ? 0.06 : 0.005)
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    disposeTextures(this.tex)
    disposeWorldMasks(this.masks)
    this.ao.atlas.dispose()
    this.ao.ground.dispose()
    this.env.dispose()
    this.sky.dispose()
  }
}
