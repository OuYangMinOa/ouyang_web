// 畫面效果：機槍的曳光彈、電磁砲的光束、飛彈和它的煙、迫擊砲彈和地上的落點圈、槍口火光、打中的火花、爆炸、推進器的火、腳步揚起的灰塵。
// 粒子沿用 3D 賽車的 `Particles`（固定數量輪流用）。
import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
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
  readonly smoke = new Particles(1400, false)
  readonly glow = new Particles(1200, true)
  private readonly tracerMesh: InstancedMesh
  private readonly tracers: Tracer[] = []
  private readonly missileGeo: { body: CylinderGeometry; nose: ConeGeometry; fin: BoxGeometry }
  private readonly missileMat: MeshStandardMaterial
  private readonly flameMat: MeshBasicMaterial
  private readonly tracerGeo: BoxGeometry
  private readonly tracerMat: MeshBasicMaterial
  private readonly shellGeo: { body: CylinderGeometry; nose: ConeGeometry }
  private readonly shellMat: MeshStandardMaterial
  /** 地上的圈：半徑 1 的環和裡面淡淡的一片，照顏色各一份材質 */
  private readonly ringGeo: { ring: RingGeometry; fill: CircleGeometry }
  private readonly ringMats = new Map<number, { ring: MeshBasicMaterial; fill: MeshBasicMaterial }>()
  private readonly scene: Scene
  private readonly m = new Matrix4()
  private readonly q = new Quaternion()
  private readonly v = new Vector3()
  private readonly s = new Vector3()
  private readonly up = new Vector3(0, 0, 1)
  /** 畫面晃動（爆炸、被打中） */
  shake = 0

  constructor(scene: Scene) {
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
    this.ringGeo = { ring: new RingGeometry(0.88, 1, 48), fill: new CircleGeometry(1, 48) }
    this.ringGeo.ring.rotateX(-Math.PI / 2)
    this.ringGeo.fill.rotateX(-Math.PI / 2)
    scene.add(this.smoke.points, this.glow.points, this.tracerMesh)
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

  /** 地上的圈（迫擊砲的落點、砲彈落下前的警告）：半徑 1，用 `scale` 放大；`color` 一樣的共用材質 */
  marker(color: number): Group {
    let mats = this.ringMats.get(color)
    if (!mats) {
      const base = { color, transparent: true, depthWrite: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 }
      mats = { ring: new MeshBasicMaterial({ ...base, opacity: 0.9 }), fill: new MeshBasicMaterial({ ...base, opacity: 0.16 }) }
      this.ringMats.set(color, mats)
    }
    const g = new Group()
    const ring = new Mesh(this.ringGeo.ring, mats.ring)
    const fill = new Mesh(this.ringGeo.fill, mats.fill)
    ring.renderOrder = fill.renderOrder = 2
    g.add(fill, ring)
    this.scene.add(g)
    return g
  }

  /** 迫擊砲彈爆炸：比飛彈大一圈、揚起一大片灰塵 */
  shellBlast(x: number, y: number, z: number) {
    this.explosion(x, y, z, 1.9)
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 6 + Math.random() * 9
      this.smoke.emit(x + Math.cos(a) * 2, y + 0.4, z + Math.sin(a) * 2, Math.cos(a) * sp, 1 + Math.random() * 2, Math.sin(a) * sp, DUST, 2.6, 4, 1.4 + Math.random(), 0.6)
    }
  }

  /** 迫擊砲開砲：砲口一團火和往上衝的煙 */
  mortarFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
    this.glow.emit(x, y, z, dx * 8, dy * 8, dz * 8, FLASH, 3.4, 5, 0.12, 1)
    this.glow.emit(x, y, z, dx * 4, dy * 4, dz * 4, FIRE, 2.4, 3, 0.2, 0.9)
    for (let i = 0; i < 10; i++) {
      const sp = 2 + Math.random() * 6
      this.smoke.emit(x, y, z, dx * sp + (Math.random() - 0.5) * 3, dy * sp + Math.random(), dz * sp + (Math.random() - 0.5) * 3, SMOKE, 1.6, 4, 1.2 + Math.random() * 0.8, 0.55)
    }
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
      w: heavy ? 2.6 : 1,
      speed: heavy ? BEAM_SPEED : TRACER_SPEED,
      tail: heavy ? BEAM_LEN : TRACER_LEN,
    })
    if (!heavy) {
      // 槍口火光
      this.glow.emit(ox, oy, oz, dx * 6, dy * 6, dz * 6, FLASH, 1.3, 2, 0.06, 0.9)
      this.glow.emit(ox + dx * 0.6, oy + dy * 0.6, oz + dz * 0.6, 0, 0, 0, FIRE, 0.9, 1, 0.05, 0.7)
      return
    }
    // 電磁砲：很亮的砲口閃光、往兩邊噴的煙，彈道上留下一條慢慢散掉的光
    this.glow.emit(ox, oy, oz, dx * 10, dy * 10, dz * 10, FLASH, 3.2, 4, 0.1, 1)
    this.glow.emit(ox + dx, oy + dy, oz + dz, dx * 4, dy * 4, dz * 4, color, 2.2, 3, 0.16, 0.9)
    for (let i = 0; i < 8; i++) {
      const sp = 3 + Math.random() * 5
      this.smoke.emit(ox + dx * 0.8, oy + dy * 0.8, oz + dz * 0.8, dx * sp + (Math.random() - 0.5) * 4, dy * sp + Math.random() * 1.5, dz * sp + (Math.random() - 0.5) * 4, SMOKE, 1.2, 3.5, 0.9 + Math.random() * 0.6, 0.5)
    }
    const n = Math.min(90, Math.floor(dist / 4))
    for (let i = 1; i <= n; i++) {
      const s = (i / n) * dist
      this.glow.emit(ox + dx * s, oy + dy * s, oz + dz * s, 0, 0.3, 0, color, 0.7, 0.8, 0.35 + Math.random() * 0.25, 0.55)
    }
  }

  /** 子彈打到東西：火花；打到機甲多一點；`heavy` 是電磁砲，炸出一大團 */
  impact(x: number, y: number, z: number, mech: boolean, heavy = false) {
    if (heavy) {
      this.glow.emit(x, y, z, 0, 0, 0, FLASH, 3, 6, 0.12, 1)
      for (let i = 0; i < 14; i++) {
        this.glow.emit(x, y, z, (Math.random() - 0.5) * 30, Math.random() * 16, (Math.random() - 0.5) * 30, SPARK, 0.35, -0.2, 0.4 + Math.random() * 0.4, 1)
      }
      for (let i = 0; i < 6; i++) {
        this.smoke.emit(x, y, z, (Math.random() - 0.5) * 4, 1 + Math.random() * 2, (Math.random() - 0.5) * 4, mech ? DARK_SMOKE : DUST, 1.6, 3, 1 + Math.random() * 0.8, 0.55)
      }
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
    this.shake = Math.max(0, this.shake - dt * 2.2)
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
    this.tracers.length = 0
    this.tracerMesh.count = 0
  }

  dispose() {
    this.scene.remove(this.smoke.points, this.glow.points, this.tracerMesh)
    this.smoke.dispose()
    this.glow.dispose()
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
    this.ringGeo.ring.dispose()
    this.ringGeo.fill.dispose()
    for (const m of this.ringMats.values()) {
      m.ring.dispose()
      m.fill.dispose()
    }
  }
}
