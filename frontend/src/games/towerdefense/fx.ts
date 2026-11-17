import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Scene,
} from 'three'

/**
 * 迷宮塔防的特效：砲彈、閃電、爆炸的圈、打倒時噴出來的碎片、煙、光暈。
 * 全部只用四種形狀（方塊、球、平放的圈、永遠面向鏡頭的光暈），每種一個 InstancedMesh，再多特效也只有四個 draw call；
 * 每一個可以有自己的顏色和透明度（`instanceAlpha`，Three.js 內建的只有顏色，透明度是自己加進著色器的）。
 * 光暈是疊加上去的（越疊越亮），晚上（深色主題）特別明顯。
 */

type Point = [number, number, number]

const BOX = 0
const BALL = 1
const RING = 2
const GLOW = 3

type Item = {
  shape: 0 | 1 | 2 | 3
  age: number
  life: number
  from: Point
  /** 飛向哪裡：每一格重新問一次，目標在動也追得到 */
  to: (() => Point) | null
  /** 拋物線的高度（火砲） */
  arc: number
  vel: Point
  gravity: number
  /** 速度每秒剩幾成（煙會慢下來） */
  drag: number
  /** 大小：開始和結束 */
  s0: Point
  s1: Point
  /** 方塊沿著飛行方向擺（箭、曳光）；不沿著的自己轉 */
  along: boolean
  quat: Quaternion | null
  color: Color
  a0: number
  a1: number
  /** 砲彈後面拖的尾巴：顏色、多粗、每隔幾秒留一顆 */
  trail: { color: Color; size: number; every: number; next: number } | null
  done: (() => void) | null
}

const CAPACITY = [640, 420, 160, 280]
const UP = new Vector3(0, 1, 0)
const FORWARD = new Vector3(0, 0, 1)

function alphaMaterial(glow: CanvasTexture | null): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ transparent: true, depthWrite: false })
  if (glow) {
    material.map = glow
    material.blending = AdditiveBlending
  }
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float instanceAlpha;\nvarying float vInstanceAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceAlpha = instanceAlpha;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vInstanceAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vInstanceAlpha;')
  }
  return material
}

/** 中間亮、往外淡掉的圓 */
function glowTexture(): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.3, 'rgba(255,255,255,0.5)')
    g.addColorStop(0.65, 'rgba(255,255,255,0.12)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  return new CanvasTexture(canvas)
}

export class Effects {
  private readonly meshes: InstancedMesh[]
  private readonly alphas: InstancedBufferAttribute[]
  private readonly solid = alphaMaterial(null)
  /** 光暈的貼圖（塔頭上那一團光也用這一張） */
  readonly glowMap = glowTexture()
  private readonly shine = alphaMaterial(this.glowMap)
  private items: Item[] = []
  private readonly m = new Matrix4()
  private readonly p = new Vector3()
  private readonly s = new Vector3()
  private readonly q = new Quaternion()
  private readonly dir = new Vector3()
  private readonly scene: Scene
  /** 系統設定了「減少動態效果」：不噴碎片、不冒煙 */
  private readonly calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  /** 光暈要多亮：亮色主題的底色已經很亮，疊太多會變成一團白 */
  glowScale = 1

  constructor(scene: Scene) {
    this.scene = scene
    const shapes: BufferGeometry[] = [
      new BoxGeometry(1, 1, 1),
      new SphereGeometry(1, 10, 8),
      new RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2),
      new PlaneGeometry(2, 2),
    ]
    this.alphas = []
    this.meshes = shapes.map((geometry, i) => {
      const alpha = new InstancedBufferAttribute(new Float32Array(CAPACITY[i]).fill(1), 1)
      alpha.setUsage(DynamicDrawUsage)
      geometry.setAttribute('instanceAlpha', alpha)
      this.alphas.push(alpha)
      const mesh = new InstancedMesh(geometry, i === GLOW ? this.shine : this.solid, CAPACITY[i])
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      mesh.setColorAt(0, new Color(1, 1, 1))
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.renderOrder = i === GLOW ? 6 : 5
      scene.add(mesh)
      return mesh
    })
  }

  private add(item: Partial<Item> & Pick<Item, 'shape' | 'life' | 'from' | 's0' | 'color'>) {
    if (this.items.length > 1300) return
    this.items.push({
      age: 0,
      to: null,
      arc: 0,
      vel: [0, 0, 0],
      gravity: 0,
      drag: 1,
      s1: item.s0,
      along: false,
      quat: null,
      a0: 1,
      a1: 1,
      trail: null,
      done: null,
      ...item,
    })
  }

  /**
   * 一發砲彈從 `from` 飛向 `to`（會跟著目標），`life` 秒後到；`ball` 是圓的（火砲、冰、毒），不然是一支箭。
   * `trail` 是後面拖的尾巴的顏色（沒有就不拖）
   */
  shot(from: Point, to: () => Point, life: number, color: number, size: number, ball: boolean, arc: number, done: () => void, trail: number | null = null) {
    this.add({
      shape: ball ? BALL : BOX,
      life,
      from,
      to,
      arc,
      s0: ball ? [size, size, size] : [size * 0.35, size * 0.35, size * 3.2],
      along: !ball,
      color: new Color(color),
      trail: trail === null || this.calm ? null : { color: new Color(trail), size: size * 0.8, every: 0.03, next: 0 },
      done,
    })
  }

  /** 一條馬上就到的線（重弩的曳光、閃電的一段），慢慢變細消失 */
  beam(a: Point, b: Point, color: number, width: number, life: number) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (length < 0.01) return
    this.dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize()
    this.add({
      shape: BOX,
      life,
      from: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
      s0: [width, width, length],
      s1: [width * 0.2, width * 0.2, length],
      quat: new Quaternion().setFromUnitVectors(FORWARD, this.dir),
      color: new Color(color),
      a0: 1,
      a1: 0,
    })
  }

  /** 閃電：依序經過每一個點，中間歪來歪去；每個落點亮一下 */
  lightning(points: Point[], color: number) {
    for (let i = 0; i + 1 < points.length; i++) {
      const [a, b] = [points[i], points[i + 1]]
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      const pieces = Math.max(2, Math.min(5, Math.round(length * 2.2)))
      let last = a
      for (let k = 1; k <= pieces; k++) {
        const t = k / pieces
        const jitter = k === pieces ? 0 : 0.16
        const next: Point = [
          a[0] + (b[0] - a[0]) * t + (Math.random() - 0.5) * jitter,
          a[1] + (b[1] - a[1]) * t + (Math.random() - 0.5) * jitter,
          a[2] + (b[2] - a[2]) * t + (Math.random() - 0.5) * jitter,
        ]
        this.beam(last, next, color, 0.06, 0.2)
        last = next
      }
      this.flash(b, 0.2, color, 0.18)
      this.glow(b, 0.5, color, 0.22, 0.8)
    }
  }

  /** 貼著地面往外擴的一圈（爆炸、冰霜的範圍、蓋塔）；`a0` 是一開始多不透明 */
  ring(x: number, z: number, radius: number, color: number, life: number, y = 0.04, a0 = 0.9) {
    this.add({
      shape: RING,
      life,
      from: [x, y, z],
      s0: [radius * 0.25, 1, radius * 0.25],
      s1: [radius, 1, radius],
      color: new Color(color),
      a0,
      a1: 0,
    })
  }

  /** 一閃就消失的光球 */
  flash(at: Point, radius: number, color: number, life: number) {
    this.add({
      shape: BALL,
      life,
      from: at,
      s0: [radius * 0.4, radius * 0.4, radius * 0.4],
      s1: [radius, radius, radius],
      color: new Color(color),
      a0: 0.85,
      a1: 0,
    })
  }

  /** 一團光暈（永遠面向鏡頭，疊加上去）：砲口的火光、落點、閃電 */
  glow(at: Point, radius: number, color: number, life: number, strength = 1) {
    this.add({
      shape: GLOW,
      life,
      from: at,
      s0: [radius * 0.55, radius * 0.55, 1],
      s1: [radius, radius, 1],
      color: new Color(color),
      a0: Math.min(1, strength * this.glowScale),
      a1: 0,
    })
  }

  /** 噴出來的碎片 */
  burst(at: Point, color: number, count: number, speed: number, size: number) {
    if (this.calm) return
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const out = (0.4 + Math.random() * 0.6) * speed
      this.add({
        shape: BOX,
        life: 0.45 + Math.random() * 0.25,
        from: [at[0], at[1], at[2]],
        vel: [Math.cos(angle) * out, speed * (0.9 + Math.random() * 0.8), Math.sin(angle) * out],
        gravity: 9,
        s0: [size, size, size],
        s1: [size * 0.3, size * 0.3, size * 0.3],
        quat: new Quaternion().setFromAxisAngle(UP, angle),
        color: new Color(color),
        a0: 1,
        a1: 0.2,
      })
    }
  }

  /** 四散的小火花（箭射中、閃電打到） */
  sparks(at: Point, color: number, count: number, speed: number) {
    if (this.calm) return
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const out = (0.5 + Math.random() * 0.5) * speed
      this.add({
        shape: BALL,
        life: 0.18 + Math.random() * 0.14,
        from: [at[0], at[1], at[2]],
        vel: [Math.cos(angle) * out, (Math.random() - 0.2) * speed, Math.sin(angle) * out],
        gravity: 5,
        s0: [0.035, 0.035, 0.035],
        s1: [0.01, 0.01, 0.01],
        color: new Color(color),
        a0: 1,
        a1: 0,
      })
    }
  }

  /** 一團一團慢慢散開、往上飄的煙（砲口、爆炸、塔被拆掉、怪物被打倒） */
  smoke(at: Point, color: number, count: number, size: number, spread = 0.6) {
    if (this.calm) return
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2
      const out = Math.random() * spread
      const s = size * (0.7 + Math.random() * 0.6)
      this.add({
        shape: BALL,
        life: 0.5 + Math.random() * 0.35,
        from: [at[0], at[1], at[2]],
        vel: [Math.cos(angle) * out, 0.5 + Math.random() * 0.6, Math.sin(angle) * out],
        drag: 0.06,
        s0: [s * 0.5, s * 0.5, s * 0.5],
        s1: [s * 1.5, s * 1.5, s * 1.5],
        color: new Color(color),
        a0: 0.5,
        a1: 0,
      })
    }
  }

  /** 往上飄的小光點（升級、號角、中毒冒的泡） */
  rise(x: number, z: number, color: number, count: number, radius = 0.34, y = 0.1, speed = 1.6, size = 0.07) {
    if (this.calm) return
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4
      this.add({
        shape: BALL,
        life: 0.7,
        from: [x + Math.cos(angle) * radius, y, z + Math.sin(angle) * radius],
        vel: [0, speed, 0],
        s0: [size, size, size],
        s1: [size * 0.3, size * 0.3, size * 0.3],
        color: new Color(color),
        a0: 1,
        a1: 0,
      })
    }
  }

  /** 打倒怪物跳出來的金幣：往上彈一下再掉下來 */
  coin(at: Point) {
    if (this.calm) return
    this.add({
      shape: BALL,
      life: 0.55,
      from: [at[0], at[1], at[2]],
      vel: [(Math.random() - 0.5) * 0.6, 2.6, (Math.random() - 0.5) * 0.6],
      gravity: 8,
      s0: [0.085, 0.085, 0.03],
      s1: [0.085, 0.085, 0.03],
      quat: new Quaternion().setFromAxisAngle(UP, Math.random() * Math.PI),
      color: new Color(0xffd23f),
      a0: 1,
      a1: 0.5,
    })
  }

  update(dt: number, camera: Camera) {
    const counts = [0, 0, 0, 0]
    const keep: Item[] = []
    const born: Item[] = []
    for (const it of this.items) {
      it.age += dt
      const t = Math.min(1, it.age / it.life)
      const { p, s, q, m } = this
      if (it.to) {
        const target = it.to()
        p.set(
          it.from[0] + (target[0] - it.from[0]) * t,
          it.from[1] + (target[1] - it.from[1]) * t + Math.sin(t * Math.PI) * it.arc,
          it.from[2] + (target[2] - it.from[2]) * t,
        )
        if (it.along) {
          this.dir.set(target[0] - it.from[0], target[1] - it.from[1], target[2] - it.from[2])
          if (this.dir.lengthSq() > 1e-6) q.setFromUnitVectors(FORWARD, this.dir.normalize())
        } else q.identity()
        if (it.trail && it.age >= it.trail.next && t < 1) {
          it.trail.next = it.age + it.trail.every
          const size = it.trail.size
          born.push({
            shape: BALL,
            age: 0,
            life: 0.28,
            from: [p.x, p.y, p.z],
            to: null,
            arc: 0,
            vel: [0, 0.15, 0],
            gravity: 0,
            drag: 1,
            s0: [size, size, size],
            s1: [size * 0.2, size * 0.2, size * 0.2],
            along: false,
            quat: null,
            color: it.trail.color,
            a0: 0.55,
            a1: 0,
            trail: null,
            done: null,
          })
        }
      } else {
        it.vel[1] -= it.gravity * dt
        if (it.drag < 1) {
          const k = Math.pow(it.drag, dt)
          it.vel[0] *= k
          it.vel[2] *= k
        }
        it.from[0] += it.vel[0] * dt
        it.from[1] = Math.max(0.03, it.from[1] + it.vel[1] * dt)
        it.from[2] += it.vel[2] * dt
        p.set(it.from[0], it.from[1], it.from[2])
        if (it.shape === GLOW) q.copy(camera.quaternion)
        else if (it.quat) q.copy(it.quat)
        else q.identity()
      }
      s.set(
        it.s0[0] + (it.s1[0] - it.s0[0]) * t,
        it.s0[1] + (it.s1[1] - it.s0[1]) * t,
        it.s0[2] + (it.s1[2] - it.s0[2]) * t,
      )
      const i = counts[it.shape]
      if (i < CAPACITY[it.shape]) {
        const mesh = this.meshes[it.shape]
        mesh.setMatrixAt(i, m.compose(p, q, s))
        mesh.setColorAt(i, it.color)
        this.alphas[it.shape].setX(i, it.a0 + (it.a1 - it.a0) * t)
        counts[it.shape] = i + 1
      }
      if (it.age < it.life) keep.push(it)
      else it.done?.()
    }
    this.items = keep.length + born.length > 1300 ? keep : keep.concat(born)
    this.meshes.forEach((mesh, i) => {
      // 只把用到的那一段送給顯示卡
      const changed = counts[i] > 0 || mesh.count > 0
      mesh.count = counts[i]
      if (!changed) return
      mesh.instanceMatrix.clearUpdateRanges()
      mesh.instanceMatrix.addUpdateRange(0, counts[i] * 16)
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) {
        mesh.instanceColor.clearUpdateRanges()
        mesh.instanceColor.addUpdateRange(0, counts[i] * 3)
        mesh.instanceColor.needsUpdate = true
      }
      this.alphas[i].clearUpdateRanges()
      this.alphas[i].addUpdateRange(0, counts[i])
      this.alphas[i].needsUpdate = true
    })
  }

  /** 換場地、換局：還在飛的都不要了（砲彈的 `done` 也不呼叫） */
  clear() {
    this.items = []
  }

  dispose() {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
      mesh.dispose()
    }
    this.solid.dispose()
    this.shine.dispose()
    this.glowMap.dispose()
  }
}
