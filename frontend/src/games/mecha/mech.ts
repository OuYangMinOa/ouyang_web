// 機甲的模型：全部用方塊和圓柱拼出來，不下載模型檔。這裡是共用的材質、`Rig`（每種機甲的模型都有的）和速度型「疾風」；狙擊型在 `sniper.ts`。
// 疾風參考的是厚重的老派機甲：往前傾的上半身、兩臂各一門多管速射砲、鳥腳式的反關節腿、背後兩具推進器，左肩掛飛彈艙。
// 裝甲照隊伍上色（紅隊鏽紅、藍隊鋼藍）。上半身跟著瞄準轉、手臂跟著仰角抬，腳照移動的方向走。
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three'
import type { MechBody } from './physics'
import { clamp, wrapAngle } from './physics'
import { MECHS, TEAMS } from './spec'
import type { Team } from './map'

/** 所有機甲共用的幾何和材質（每隊一份裝甲） */
export type MechKit = {
  geo: Record<string, BufferGeometry>
  armor: MeshStandardMaterial[]
  trim: MeshStandardMaterial[]
  glow: MeshBasicMaterial[]
  flame: MeshBasicMaterial[]
  metal: MeshStandardMaterial
  dark: MeshStandardMaterial
  shadow: MeshBasicMaterial
  missile: MeshStandardMaterial
  textures: CanvasTexture[]
}

/** 裝甲的貼圖：面板分割線、鉚釘、一點髒污，乘在隊伍的顏色上 */
function panelTexture(): CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#e8e8e8'
  ctx.fillRect(0, 0, size, size)
  // 髒污
  for (let i = 0; i < 900; i++) {
    const v = 200 + Math.floor(Math.random() * 55)
    ctx.fillStyle = `rgba(${v},${v},${v},0.35)`
    ctx.fillRect(Math.random() * size, Math.random() * size, 2 + Math.random() * 6, 2 + Math.random() * 6)
  }
  // 面板線
  ctx.strokeStyle = 'rgba(40,40,40,0.55)'
  ctx.lineWidth = 2
  ctx.strokeRect(6, 6, size - 12, size - 12)
  ctx.beginPath()
  ctx.moveTo(size * 0.55, 6)
  ctx.lineTo(size * 0.55, size * 0.62)
  ctx.lineTo(size - 6, size * 0.62)
  ctx.moveTo(6, size * 0.35)
  ctx.lineTo(size * 0.55, size * 0.35)
  ctx.stroke()
  // 鉚釘
  ctx.fillStyle = 'rgba(60,60,60,0.6)'
  for (const [x, y] of [
    [16, 16],
    [size - 16, 16],
    [16, size - 16],
    [size - 16, size - 16],
    [size * 0.55 + 10, size * 0.62 + 10],
  ]) {
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fill()
  }
  // 磨掉漆的邊
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fillRect(6, 6, size - 12, 3)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 4
  return tex
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

export function createMechKit(): MechKit {
  const panel = panelTexture()
  const shadowTex = shadowTexture()
  const armor = TEAMS.map(
    (t) => new MeshStandardMaterial({ color: t.armor, map: panel, roughness: 0.55, metalness: 0.35 }),
  )
  const trim = TEAMS.map((t) => new MeshStandardMaterial({ color: t.trim, map: panel, roughness: 0.6, metalness: 0.4 }))
  const glow = TEAMS.map((t) => new MeshBasicMaterial({ color: t.glow }))
  const flame = TEAMS.map(
    (t) =>
      new MeshBasicMaterial({
        color: new Color(t.glow).lerp(new Color(0xffffff), 0.25),
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
  return {
    geo,
    armor,
    trim,
    glow,
    flame,
    metal: new MeshStandardMaterial({ color: 0x8b9097, map: panel, roughness: 0.4, metalness: 0.7 }),
    dark: new MeshStandardMaterial({ color: 0x2c2e31, roughness: 0.7, metalness: 0.5 }),
    shadow: new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
    missile: new MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.4, metalness: 0.3, emissive: 0x330000 }),
    textures: [panel, shadowTex],
  }
}

export function disposeMechKit(kit: MechKit) {
  for (const g of Object.values(kit.geo)) g.dispose()
  const mats: Material[] = [...kit.armor, ...kit.trim, ...kit.glow, ...kit.flame, kit.metal, kit.dark, kit.shadow, kit.missile]
  for (const m of mats) m.dispose()
  for (const t of kit.textures) t.dispose()
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
  /** 遠的時候換成的簡單外形（腳、身體、眼睛三個方塊），第一次用到才做；`detail` 是原本的零件 */
  private proxy: Group | null = null
  private detail: Object3D[] = []
  private far = false

  constructor(kit: MechKit, team: Team, shadow: number) {
    this.team = team
    this.shadow = new Mesh(kit.geo.disc, kit.shadow)
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.scale.setScalar(shadow)
    this.shadow.renderOrder = 1
    this.root.add(this.shadow)
  }

  setTeam(kit: MechKit, team: Team) {
    if (team === this.team) return
    const from = [kit.armor[this.team], kit.trim[this.team], kit.glow[this.team], kit.flame[this.team]]
    const to = [kit.armor[team], kit.trim[team], kit.glow[team], kit.flame[team]]
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
   * 遠近切換：遠的只畫三個方塊（一台機甲有四、五十個零件，每個都是一次 draw call；30 對 30 時遠處的看不清楚，省下來）。
   * `size` 是打中範圍的大小（`MechSpec` 的 hitR、hitH）
   */
  setFar(far: boolean, kit: MechKit, size: { hitR: number; hitH: number }) {
    if (far === this.far) return
    this.far = far
    if (far && !this.proxy) {
      const r = size.hitR
      const h = size.hitH
      this.detail = this.root.children.slice()
      this.proxy = new Group()
      part(this.proxy, kit.geo.box, kit.dark, [r * 1.2, h * 0.5, r * 1.1], [0, h * 0.25, 0])
      part(this.proxy, kit.geo.box, kit.armor[this.team], [r * 2, h * 0.42, r * 1.7], [0, h * 0.7, 0])
      part(this.proxy, kit.geo.box, kit.glow[this.team], [r * 0.9, h * 0.08, 0.3], [0, h * 0.78, r * 0.86])
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

  /** 影子貼在地上，飛得越高越小 */
  protected placeShadow(b: MechBody, size: number) {
    this.shadow.position.y = 0.06 - b.y
    const height = clamp(b.y / 14, 0, 1)
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
      part(pod, disc, glow, [0.55, 0.55, 0.55], [0, 0, -1.15], [0, Math.PI, 0])
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
