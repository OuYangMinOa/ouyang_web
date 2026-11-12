// 畫面效果：機槍的曳光彈、電磁砲的光束、飛彈和它的煙、迫擊砲彈、槍口火光、打中的火花、爆炸（炸飛的碎塊、地上的焦痕、
// 之後還冒一陣子的煙）、推進器的火、腳步揚起的灰塵。
// 粒子沿用 3D 賽車的 `Particles`（固定數量輪流用）。
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Scene,
} from 'three'
import { Particles } from '../racing/effects'
import { WATER } from './map'

const SMOKE = new Color(0xb9b6b0)
const DARK_SMOKE = new Color(0x55524d)
const DUST = new Color(0xa89c88)
const SPLASH = new Color(0xe4eef0)
const SPARK = new Color(0xffd27a)
const FIRE = new Color(0xff8a2a)
const FLASH = new Color(0xfff1c0)
const TRAIL = new Color(0xdedad4)
const DIRT = new Color(0x4a4238)

const rnd = (k: number) => (Math.random() - 0.5) * k

/** 爆炸、砲口之後還冒一陣子的煙：每 `gap` 秒在原地（往上 `tall` 公尺以內）冒一團，冒 `left` 秒 */
type Wisp = { x: number; y: number; z: number; left: number; acc: number; gap: number; color: Color; size: number; rise: number; spread: number; tall: number }

/** 地上的焦痕：固定幾片輪流用，`SCORCH_LIFE` 秒後淡掉 */
type Scorch = { mesh: Mesh; mat: MeshBasicMaterial; age: number }
const SCORCHES = 14
const SCORCH_LIFE = 40
const SCORCH_FADE = 8

/** 焦痕的貼圖：中間黑、往外淡掉，加上一些往外噴的條紋 */
function scorchTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  if (g) {
    const grad = g.createRadialGradient(64, 64, 3, 64, 64, 64)
    grad.addColorStop(0, 'rgba(10,8,6,0.95)')
    grad.addColorStop(0.4, 'rgba(18,14,10,0.8)')
    grad.addColorStop(0.7, 'rgba(28,22,16,0.32)')
    grad.addColorStop(1, 'rgba(28,22,16,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 128, 128)
    g.strokeStyle = 'rgba(8,6,4,0.3)'
    g.lineCap = 'round'
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2
      const r0 = 14 + Math.random() * 14
      const r1 = 36 + Math.random() * 24
      g.lineWidth = 1 + Math.random() * 3
      g.beginPath()
      g.moveTo(64 + Math.cos(a) * r0, 64 + Math.sin(a) * r0)
      g.lineTo(64 + Math.cos(a) * r1, 64 + Math.sin(a) * r1)
      g.stroke()
    }
  }
  return new CanvasTexture(c)
}

/** 曳光彈：一小段發光的線，沿著彈道飛過去；電磁砲的粗一點、長一點、快很多 */
type Tracer = {
  ox: number
  oy: number
  oz: number
  dx: number
  dy: number
  dz: number
  len: number
  t: number
  color: Color
  /** 粗細（倍數）、速度、長度 */
  w: number
  speed: number
  tail: number
}

const TRACER_SPEED = 520
const TRACER_LEN = 7
const BEAM_SPEED = 1600
const BEAM_LEN = 60
const MAX_TRACERS = 160

export class Effects {
  readonly smoke = new Particles(2000, false)
  readonly glow = new Particles(1500, true)
  /** 炸飛的碎塊：會往下掉 */
  readonly chunks = new Particles(500, false, 34)
  private readonly wisps: Wisp[] = []
  private readonly scorches: Scorch[] = []
  private readonly scorchGeo: PlaneGeometry
  private readonly scorchTex: CanvasTexture
  private scorchNext = 0
  private readonly tracerMesh: InstancedMesh
  private readonly tracers: Tracer[] = []
  private readonly missileGeo: { body: CylinderGeometry; nose: ConeGeometry; fin: BoxGeometry }
  private readonly missileMat: MeshStandardMaterial
  private readonly flameMat: MeshBasicMaterial
  private readonly tracerGeo: BoxGeometry
  private readonly tracerMat: MeshBasicMaterial
  private readonly shellGeo: { body: CylinderGeometry; nose: ConeGeometry }
  private readonly shellMat: MeshStandardMaterial
  private readonly scene: Scene
  private readonly m = new Matrix4()
  private readonly q = new Quaternion()
  private readonly v = new Vector3()
  private readonly s = new Vector3()
  private readonly up = new Vector3(0, 0, 1)
  /** 跟某個方向垂直的兩個方向（`basis` 算出來放這裡） */
  private readonly pu = new Vector3()
  private readonly pv = new Vector3()
  /** 畫面晃動（爆炸、被打中） */
  shake = 0

  /** `hdr`：畫面有泛光（`post.ts`），火光、曳光彈、飛彈的火調得比 1 亮，才暈得開 */
  constructor(scene: Scene, hdr = false) {
    this.scene = scene
    this.tracerGeo = new BoxGeometry(0.16, 0.16, 1)
    this.tracerGeo.translate(0, 0, 0.5)
    this.tracerMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: AdditiveBlending, depthWrite: false })
    this.tracerMesh = new InstancedMesh(this.tracerGeo, this.tracerMat, MAX_TRACERS)
    // 先把每一個的顏色都設好：顏色屬性一開始就在，材質不用重新編譯
    const white = new Color(0xffffff)
    for (let i = 0; i < MAX_TRACERS; i++) this.tracerMesh.setColorAt(i, white)
    this.tracerMesh.count = 0
    this.tracerMesh.frustumCulled = false
    this.missileGeo = {
      body: new CylinderGeometry(0.16, 0.16, 1.5, 8),
      nose: new ConeGeometry(0.16, 0.45, 8),
      fin: new BoxGeometry(0.6, 0.04, 0.35),
    }
    this.missileGeo.body.rotateX(Math.PI / 2)
    this.missileGeo.nose.rotateX(Math.PI / 2)
    this.missileGeo.nose.translate(0, 0, 0.97)
    this.missileGeo.fin.translate(0, 0, -0.6)
    this.missileMat = new MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.4, metalness: 0.4 })
    this.flameMat = new MeshBasicMaterial({ color: 0xffb060, transparent: true, blending: AdditiveBlending, depthWrite: false })
    this.shellGeo = { body: new CylinderGeometry(0.26, 0.2, 1.1, 10), nose: new ConeGeometry(0.26, 0.5, 10) }
    this.shellGeo.body.rotateX(Math.PI / 2)
    this.shellGeo.nose.rotateX(Math.PI / 2)
    this.shellGeo.nose.translate(0, 0, 0.8)
    this.shellMat = new MeshStandardMaterial({ color: 0x4a4f45, roughness: 0.5, metalness: 0.5 })
    this.scorchGeo = new PlaneGeometry(2, 2)
    this.scorchGeo.rotateX(-Math.PI / 2)
    this.scorchTex = scorchTexture()
    for (let i = 0; i < SCORCHES; i++) {
      const mat = new MeshBasicMaterial({ map: this.scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      const mesh = new Mesh(this.scorchGeo, mat)
      mesh.visible = false
      mesh.renderOrder = 1
      scene.add(mesh)
      this.scorches.push({ mesh, mat, age: SCORCH_LIFE })
    }
    if (hdr) {
      this.glow.gain = 2.2
      this.tracerMat.color.setScalar(3)
      this.flameMat.color.multiplyScalar(2.5)
    }
    scene.add(this.smoke.points, this.glow.points, this.chunks.points, this.tracerMesh)
  }

  /** 跟 (dx, dy, dz)（單位向量）垂直的兩個方向，放在 `pu`、`pv` */
  private basis(dx: number, dy: number, dz: number) {
    if (Math.abs(dy) > 0.9) this.pu.set(1, 0, 0)
    else this.pu.set(-dz, 0, dx)
    const k = this.pu.x * dx + this.pu.y * dy + this.pu.z * dz
    this.pu.set(this.pu.x - dx * k, this.pu.y - dy * k, this.pu.z - dz * k).normalize()
    this.pv.set(dy * this.pu.z - dz * this.pu.y, dz * this.pu.x - dx * this.pu.z, dx * this.pu.y - dy * this.pu.x)
  }

  /** 平的地面上留一片焦痕（半徑 `r`），過一陣子淡掉 */
  scorch(x: number, y: number, z: number, r: number) {
    const s = this.scorches[this.scorchNext]
    this.scorchNext = (this.scorchNext + 1) % SCORCHES
    s.age = 0
    s.mesh.position.set(x, y, z)
    s.mesh.rotation.y = Math.random() * Math.PI * 2
    s.mesh.scale.set(r, 1, r)
    s.mat.opacity = 1
    s.mesh.visible = true
  }

  /** 一發迫擊砲彈的模型（彈頭朝 +z，尾巴一點火光） */
  shellMesh(): Group {
    const g = new Group()
    g.add(new Mesh(this.shellGeo.body, this.shellMat))
    g.add(new Mesh(this.shellGeo.nose, this.shellMat))
    const flame = new Mesh(this.missileGeo.nose, this.flameMat)
    flame.rotation.y = Math.PI
    flame.scale.set(1.2, 1.2, 1.2)
    flame.position.z = -0.45
    g.add(flame)
    this.scene.add(g)
    return g
  }

  /**
   * 迫擊砲彈爆炸（幾百公尺外也要看得出來炸在哪裡）：一大片閃光、一團往上翻的火球、貼著地面往外衝的一圈灰塵（大約就是爆炸半徑）、
   * 衝到三四十公尺高的土柱、炸飛的碎塊和火星，之後原地一根黑煙柱再冒好幾秒
   */
  shellBlast(x: number, y: number, z: number) {
    this.explosion(x, y, z, 3)
    this.glow.emit(x, y + 1, z, 0, 0, 0, FLASH, 20, 80, 0.2, 1)
    this.glow.emit(x, y + 1, z, 0, 2, 0, FIRE, 11, 16, 0.45, 0.9)
    for (let i = 0; i < 16; i++) {
      this.glow.emit(x + rnd(5), y + 1, z + rnd(5), rnd(8), 18 + Math.random() * 22, rnd(8), Math.random() < 0.6 ? FIRE : FLASH, 4.5, 5, 0.7 + Math.random() * 0.5, 0.9)
    }
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2 + rnd(0.3)
      const sp = 24 + Math.random() * 22
      this.smoke.emit(x + Math.cos(a) * 1.5, y + 0.6, z + Math.sin(a) * 1.5, Math.cos(a) * sp, 0.5 + Math.random() * 3, Math.sin(a) * sp, DUST, 3.5, 7, 1.8 + Math.random() * 1.4, 0.65)
    }
    for (let i = 0; i < 40; i++) {
      this.smoke.emit(x + rnd(3), y + 0.5, z + rnd(3), rnd(8), 25 + Math.random() * 70, rnd(8), Math.random() < 0.5 ? DIRT : DARK_SMOKE, 4, 6, 2.6 + Math.random() * 2.4, 0.8)
    }
    for (let i = 0; i < 60; i++) {
      this.chunks.emit(x, y + 0.5, z, rnd(56), 20 + Math.random() * 50, rnd(56), Math.random() < 0.6 ? DIRT : DARK_SMOKE, 0.45 + Math.random() * 0.7, 0, 1.5 + Math.random() * 1.2, 1)
    }
    for (let i = 0; i < 26; i++) {
      this.glow.emit(x, y + 1, z, rnd(60), 8 + Math.random() * 44, rnd(60), SPARK, 0.5, -0.1, 0.9 + Math.random() * 0.9, 1)
    }
    this.wisps.push({ x, y: y + 0.5, z, left: 7, acc: 0, gap: 0.07, color: DARK_SMOKE, size: 4, rise: 7, spread: 4, tall: 26 })
  }

  /**
   * 迫擊砲開砲：砲口一大團火和順著砲管噴出去的火舌、煙柱，砲口往四周炸開的一圈煙，
   * 腳邊（`gx…`，站在水裡就沒有）震起來的一圈灰塵，砲口之後還冒一陣子煙
   */
  mortarFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number, gx: number, gy: number, gz: number) {
    this.glow.emit(x, y, z, dx * 10, dy * 10, dz * 10, FLASH, 7, 16, 0.14, 1)
    this.glow.emit(x, y, z, dx * 5, dy * 5, dz * 5, FIRE, 4.5, 8, 0.3, 0.95)
    for (let i = 0; i < 10; i++) {
      const sp = 12 + Math.random() * 40
      this.glow.emit(x, y, z, dx * sp + rnd(4), dy * sp + rnd(4), dz * sp + rnd(4), Math.random() < 0.5 ? FIRE : FLASH, 1.6 + Math.random(), 2, 0.18 + Math.random() * 0.25, 1)
    }
    for (let i = 0; i < 44; i++) {
      const sp = 3 + Math.random() * 34
      this.smoke.emit(x, y, z, dx * sp + rnd(6), dy * sp + rnd(6), dz * sp + rnd(6), Math.random() < 0.35 ? DARK_SMOKE : SMOKE, 2.4, 5.5, 1.8 + Math.random() * 2, 0.8)
    }
    this.basis(dx, dy, dz)
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + rnd(0.3)
      const sp = 9 + Math.random() * 8
      const c = Math.cos(a) * sp
      const s = Math.sin(a) * sp
      this.smoke.emit(x, y, z, this.pu.x * c + this.pv.x * s + dx * 2, this.pu.y * c + this.pv.y * s + dy * 2, this.pu.z * c + this.pv.z * s + dz * 2, SMOKE, 2, 5, 1.3 + Math.random() * 1, 0.7)
    }
    if (gy >= WATER) {
      for (let i = 0; i < 30; i++) {
        const a = (i / 30) * Math.PI * 2 + rnd(0.3)
        const sp = 10 + Math.random() * 10
        this.smoke.emit(gx + Math.cos(a) * 2.5, gy + 0.4, gz + Math.sin(a) * 2.5, Math.cos(a) * sp, 0.6 + Math.random() * 1.5, Math.sin(a) * sp, DUST, 2.4, 5.5, 1.5 + Math.random() * 1.2, 0.65)
      }
    }
    this.wisps.push({ x, y, z, left: 2.8, acc: 0, gap: 0.04, color: SMOKE, size: 1.4, rise: 3, spread: 0.9, tall: 0 })
  }

  /** 迫擊砲彈飛的時候尾巴的火和煙（剛出砲口那一段火比較大，看得到它飛出去） */
  shellTrail(x: number, y: number, z: number, fresh: boolean) {
    this.smoke.emit(x, y, z, rnd(0.8), 0.4, rnd(0.8), TRAIL, fresh ? 0.9 : 0.5, fresh ? 3 : 2.2, fresh ? 2.2 : 1.6, 0.55)
    this.glow.emit(x, y, z, 0, 0, 0, FIRE, fresh ? 1.5 : 0.5, -0.5, fresh ? 0.2 : 0.08, 0.9)
  }

  /** 一發飛彈的模型 */
  missileMesh(): Group {
    const g = new Group()
    g.add(new Mesh(this.missileGeo.body, this.missileMat))
    g.add(new Mesh(this.missileGeo.nose, this.missileMat))
    const fin1 = new Mesh(this.missileGeo.fin, this.missileMat)
    const fin2 = new Mesh(this.missileGeo.fin, this.missileMat)
    fin2.rotation.z = Math.PI / 2
    g.add(fin1, fin2)
    const flame = new Mesh(this.missileGeo.nose, this.flameMat)
    flame.rotation.y = Math.PI
    flame.scale.set(1.6, 1.6, 2.4)
    flame.position.z = -0.1
    g.add(flame)
    this.scene.add(g)
    return g
  }

  removeMissile(g: Group) {
    this.scene.remove(g)
  }

  /** 一發機槍（`heavy` 是電磁砲）：從 (ox…) 打到距離 `dist` 的地方 */
  tracer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, dist: number, color: Color, heavy = false) {
    if (this.tracers.length >= MAX_TRACERS) this.tracers.shift()
    this.tracers.push({
      ox,
      oy,
      oz,
      dx,
      dy,
      dz,
      len: dist,
      t: 0,
      color,
      w: heavy ? 3.6 : 1,
      speed: heavy ? BEAM_SPEED : TRACER_SPEED,
      tail: heavy ? BEAM_LEN : TRACER_LEN,
    })
    if (!heavy) {
      // 槍口火光
      this.glow.emit(ox, oy, oz, dx * 6, dy * 6, dz * 6, FLASH, 1.3, 2, 0.06, 0.9)
      this.glow.emit(ox + dx * 0.6, oy + dy * 0.6, oz + dz * 0.6, 0, 0, 0, FIRE, 0.9, 1, 0.05, 0.7)
      return
    }
    // 電磁砲：很亮的砲口閃光、砲口往四周炸開的一圈光和煙、往前噴的煙，彈道上留下一條慢慢散掉的光
    this.glow.emit(ox, oy, oz, dx * 12, dy * 12, dz * 12, FLASH, 5.5, 12, 0.12, 1)
    this.glow.emit(ox + dx, oy + dy, oz + dz, dx * 5, dy * 5, dz * 5, color, 3.6, 6, 0.22, 0.95)
    this.basis(dx, dy, dz)
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + rnd(0.3)
      const sp = 12 + Math.random() * 5
      const ux = this.pu.x * Math.cos(a) + this.pv.x * Math.sin(a)
      const uy = this.pu.y * Math.cos(a) + this.pv.y * Math.sin(a)
      const uz = this.pu.z * Math.cos(a) + this.pv.z * Math.sin(a)
      this.glow.emit(ox + dx * 0.5, oy + dy * 0.5, oz + dz * 0.5, ux * sp, uy * sp, uz * sp, color, 0.9, 1.5, 0.16 + Math.random() * 0.1, 0.9)
      this.smoke.emit(ox + dx * 0.5, oy + dy * 0.5, oz + dz * 0.5, ux * sp * 0.7 + dx * 3, uy * sp * 0.7 + dy * 3, uz * sp * 0.7 + dz * 3, SMOKE, 1.4, 4, 0.9 + Math.random() * 0.7, 0.5)
    }
    for (let i = 0; i < 12; i++) {
      const sp = 5 + Math.random() * 21
      this.smoke.emit(ox + dx * 0.8, oy + dy * 0.8, oz + dz * 0.8, dx * sp + rnd(4), dy * sp + rnd(4), dz * sp + rnd(4), SMOKE, 1.4, 4, 1 + Math.random() * 0.8, 0.5)
    }
    const n = Math.min(110, Math.floor(dist / 3.5))
    for (let i = 1; i <= n; i++) {
      const s = (i / n) * dist
      this.glow.emit(ox + dx * s, oy + dy * s, oz + dz * s, 0, 0.3, 0, color, 0.9, 1, 0.5 + Math.random() * 0.4, 0.6)
    }
  }

  /**
   * 子彈打到東西：火花；打到機甲多一點。`heavy` 是電磁砲：炸出一大團火光、四散的火花和碎塊、一大團煙（打到機甲還有火），
   * 之後還冒一下煙
   */
  impact(x: number, y: number, z: number, mech: boolean, heavy = false) {
    if (heavy) {
      this.glow.emit(x, y, z, 0, 0, 0, FLASH, 7, 24, 0.15, 1)
      this.glow.emit(x, y, z, 0, 1, 0, mech ? FIRE : FLASH, 4, 9, 0.3, 0.9)
      for (let i = 0; i < 30; i++) {
        this.glow.emit(x, y, z, rnd(44), Math.random() * 26 - 4, rnd(44), SPARK, 0.4, -0.2, 0.4 + Math.random() * 0.6, 1)
      }
      for (let i = 0; i < 16; i++) {
        this.chunks.emit(x, y, z, rnd(22), 6 + Math.random() * 18, rnd(22), mech ? DARK_SMOKE : DIRT, 0.25 + Math.random() * 0.35, 0, 0.9 + Math.random() * 0.7, 1)
      }
      for (let i = 0; i < 20; i++) {
        this.smoke.emit(x, y, z, rnd(12), 1 + Math.random() * 9, rnd(12), mech ? DARK_SMOKE : DUST, 2.8, 5, 1.4 + Math.random() * 1.4, 0.7)
      }
      if (mech) {
        for (let i = 0; i < 8; i++) this.glow.emit(x, y, z, rnd(10), Math.random() * 8, rnd(10), FIRE, 1.6, 2, 0.3 + Math.random() * 0.3, 0.9)
      }
      this.wisps.push({ x, y, z, left: mech ? 2.4 : 1.6, acc: 0, gap: 0.07, color: mech ? DARK_SMOKE : DUST, size: 1.8, rise: 4, spread: 0.8, tall: 0 })
      return
    }
    const n = mech ? 4 : 2
    for (let i = 0; i < n; i++) {
      this.glow.emit(x, y, z, (Math.random() - 0.5) * 14, Math.random() * 8, (Math.random() - 0.5) * 14, SPARK, 0.25, -0.2, 0.25, 1)
    }
    if (!mech) this.smoke.emit(x, y, z, 0, 1, 0, DUST, 0.6, 1.6, 0.6, 0.45)
    else this.glow.emit(x, y, z, 0, 0, 0, FLASH, 1.1, 3, 0.07, 0.8)
  }

  /** 飛彈尾巴的煙 */
  trail(x: number, y: number, z: number) {
    this.smoke.emit(x, y, z, (Math.random() - 0.5) * 0.6, 0.4, (Math.random() - 0.5) * 0.6, TRAIL, 0.5, 2.2, 1.6, 0.55)
    this.glow.emit(x, y, z, 0, 0, 0, FIRE, 0.5, -0.5, 0.08, 0.9)
  }

  /** 爆炸：`size` 1 是飛彈，2 是機甲 */
  explosion(x: number, y: number, z: number, size: number) {
    const n = Math.round(18 * size)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const up = Math.random()
      const sp = (4 + Math.random() * 10) * size
      this.glow.emit(x, y, z, Math.cos(a) * sp * (1 - up), up * sp, Math.sin(a) * sp * (1 - up), Math.random() < 0.5 ? FIRE : FLASH, 1.4 * size, 3 * size, 0.35 + Math.random() * 0.3, 1)
    }
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = (1 + Math.random() * 4) * size
      this.smoke.emit(x, y + Math.random() * 2, z, Math.cos(a) * sp, 1.5 + Math.random() * 3, Math.sin(a) * sp, Math.random() < 0.5 ? DARK_SMOKE : SMOKE, 2 * size, 3 * size, 1.6 + Math.random() * 1.4, 0.7)
    }
    for (let i = 0; i < 10 * size; i++) {
      this.glow.emit(x, y, z, (Math.random() - 0.5) * 30, Math.random() * 18, (Math.random() - 0.5) * 30, SPARK, 0.3, -0.1, 0.6 + Math.random() * 0.6, 1)
    }
  }

  /** 推進器的火和煙（`dir` 是噴出去的方向） */
  thrust(x: number, y: number, z: number, dx: number, dy: number, dz: number, color: Color, strong: boolean) {
    const sp = strong ? 16 : 10
    this.glow.emit(x, y, z, dx * sp, dy * sp, dz * sp, color, strong ? 1.1 : 0.8, -1.2, 0.12, 0.9)
    if (Math.random() < 0.35) this.smoke.emit(x + dx * 2, y + dy * 2, z + dz * 2, dx * 3, dy * 3 + 0.5, dz * 3, SMOKE, 0.9, 2.5, 0.8, 0.3)
  }

  /** 腳步、落地、貼地衝刺揚起的灰塵（在河裡是水花）；`y` 是腳底的高度 */
  dust(x: number, y: number, z: number, amount: number) {
    const wet = y < WATER
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2
      const c = Math.cos(a)
      const s = Math.sin(a)
      if (wet) this.smoke.emit(x + c * 1.1, WATER + 0.1, z + s * 1.1, c * 2.4, 3 + Math.random() * 3, s * 2.4, SPLASH, 0.8, 1.8, 0.6, 0.65)
      else this.smoke.emit(x + c * 1.2, y + 0.3, z + s * 1.2, c * 3, 0.8, s * 3, DUST, 1.2, 2.4, 0.9, 0.4)
    }
  }

  /** 倒下的機甲冒的黑煙 */
  wreck(x: number, y: number, z: number) {
    this.smoke.emit(x + (Math.random() - 0.5) * 2, y, z + (Math.random() - 0.5) * 2, 0, 3, 0, DARK_SMOKE, 1.4, 2.6, 2.2, 0.55)
    if (Math.random() < 0.3) this.glow.emit(x, y, z, 0, 2, 0, FIRE, 0.9, 0.5, 0.4, 0.8)
  }

  update(dt: number, scale: number) {
    this.smoke.update(dt, scale)
    this.glow.update(dt, scale)
    this.chunks.update(dt, scale)
    this.shake = Math.max(0, this.shake - dt * 2.2)
    for (let i = this.wisps.length - 1; i >= 0; i--) {
      const w = this.wisps[i]
      w.left -= dt
      w.acc += dt
      while (w.acc > w.gap) {
        w.acc -= w.gap
        this.smoke.emit(w.x + rnd(w.spread), w.y + Math.random() * w.tall, w.z + rnd(w.spread), rnd(0.8), w.rise * (0.6 + Math.random() * 0.6), rnd(0.8), w.color, w.size, w.size * 1.4, 1.6 + Math.random() * 1.2, 0.6 * Math.min(1, w.left + 0.3))
      }
      if (w.left <= 0) this.wisps.splice(i, 1)
    }
    for (const s of this.scorches) {
      if (!s.mesh.visible) continue
      s.age += dt
      if (s.age >= SCORCH_LIFE) s.mesh.visible = false
      else s.mat.opacity = Math.min(1, (SCORCH_LIFE - s.age) / SCORCH_FADE)
    }
    let n = 0
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i]
      t.t += dt * t.speed
      if (t.t - t.tail > t.len) {
        this.tracers.splice(i, 1)
        continue
      }
    }
    for (const t of this.tracers) {
      const head = Math.min(t.t, t.len)
      const tail = Math.max(0, t.t - t.tail)
      const len = head - tail
      if (len <= 0.01) continue
      this.v.set(t.ox + t.dx * tail, t.oy + t.dy * tail, t.oz + t.dz * tail)
      this.q.setFromUnitVectors(this.up, this.s.set(t.dx, t.dy, t.dz))
      this.s.set(t.w, t.w, len)
      this.m.compose(this.v, this.q, this.s)
      this.tracerMesh.setMatrixAt(n, this.m)
      this.tracerMesh.setColorAt(n, t.color)
      n++
    }
    this.tracerMesh.count = n
    this.tracerMesh.instanceMatrix.needsUpdate = true
    if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true
  }

  clear() {
    this.smoke.clear()
    this.glow.clear()
    this.chunks.clear()
    this.wisps.length = 0
    for (const s of this.scorches) s.mesh.visible = false
    this.tracers.length = 0
    this.tracerMesh.count = 0
  }

  dispose() {
    this.scene.remove(this.smoke.points, this.glow.points, this.chunks.points, this.tracerMesh)
    for (const s of this.scorches) {
      this.scene.remove(s.mesh)
      s.mat.dispose()
    }
    this.scorchGeo.dispose()
    this.scorchTex.dispose()
    this.smoke.dispose()
    this.glow.dispose()
    this.chunks.dispose()
    this.tracerMesh.dispose()
    this.tracerGeo.dispose()
    this.tracerMat.dispose()
    this.missileGeo.body.dispose()
    this.missileGeo.nose.dispose()
    this.missileGeo.fin.dispose()
    this.missileMat.dispose()
    this.flameMat.dispose()
    this.shellGeo.body.dispose()
    this.shellGeo.nose.dispose()
    this.shellMat.dispose()
  }
}
