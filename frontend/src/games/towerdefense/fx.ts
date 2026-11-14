import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Scene,
} from 'three'

/**
 * 迷宮塔防的特效：砲彈、閃電、爆炸的圈、打倒時噴出來的碎片。
 * 全部只用三種形狀（方塊、球、平放的圈），每種一個 InstancedMesh，再多特效也只有三個 draw call；
 * 每一個可以有自己的顏色和透明度（`instanceAlpha`，Three.js 內建的只有顏色，透明度是自己加進著色器的）。
 */

type Point = [number, number, number]

type Item = {
  shape: 0 | 1 | 2
  age: number
  life: number
  from: Point
  /** 飛向哪裡：每一格重新問一次，目標在動也追得到 */
  to: (() => Point) | null
  /** 拋物線的高度（火砲） */
  arc: number
  vel: Point
  gravity: number
  /** 大小：開始和結束 */
  s0: Point
  s1: Point
  /** 方塊沿著飛行方向擺（箭、曳光）；不沿著的自己轉 */
  along: boolean
  quat: Quaternion | null
  color: Color
  a0: number
  a1: number
  done: (() => void) | null
}

const CAPACITY = [640, 256, 128]
const UP = new Vector3(0, 1, 0)
const FORWARD = new Vector3(0, 0, 1)

function alphaMaterial(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ transparent: true, depthWrite: false })
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

export class Effects {
  private readonly meshes: InstancedMesh[]
  private readonly alphas: InstancedBufferAttribute[]
  private readonly material = alphaMaterial()
  private items: Item[] = []
  private readonly m = new Matrix4()
  private readonly p = new Vector3()
  private readonly s = new Vector3()
  private readonly q = new Quaternion()
  private readonly dir = new Vector3()
  private readonly scene: Scene
  /** 系統設定了「減少動態效果」：不噴碎片 */
  private readonly calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(scene: Scene) {
    this.scene = scene
    const shapes: BufferGeometry[] = [
      new BoxGeometry(1, 1, 1),
      new SphereGeometry(1, 10, 8),
      new RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2),
    ]
    this.alphas = []
    this.meshes = shapes.map((geometry, i) => {
      const alpha = new InstancedBufferAttribute(new Float32Array(CAPACITY[i]).fill(1), 1)
      alpha.setUsage(DynamicDrawUsage)
      geometry.setAttribute('instanceAlpha', alpha)
      this.alphas.push(alpha)
      const mesh = new InstancedMesh(geometry, this.material, CAPACITY[i])
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      mesh.setColorAt(0, new Color(1, 1, 1))
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.renderOrder = 5
      scene.add(mesh)
      return mesh
    })
  }

  private add(item: Partial<Item> & Pick<Item, 'shape' | 'life' | 'from' | 's0' | 'color'>) {
    if (this.items.length > 900) return
    this.items.push({
      age: 0,
      to: null,
      arc: 0,
      vel: [0, 0, 0],
      gravity: 0,
      s1: item.s0,
      along: false,
      quat: null,
      a0: 1,
      a1: 1,
      done: null,
      ...item,
    })
  }

  /** 一發砲彈從 `from` 飛向 `to`（會跟著目標），`life` 秒後到；`ball` 是圓的（火砲、冰、毒），不然是一支箭 */
  shot(from: Point, to: () => Point, life: number, color: number, size: number, ball: boolean, arc: number, done: () => void) {
    this.add({
      shape: ball ? 1 : 0,
      life,
      from,
      to,
      arc,
      s0: ball ? [size, size, size] : [size * 0.35, size * 0.35, size * 3.2],
      along: !ball,
      color: new Color(color),
      done,
    })
  }

  /** 一條馬上就到的線（重弩的曳光、閃電的一段），慢慢變細消失 */
  beam(a: Point, b: Point, color: number, width: number, life: number) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (length < 0.01) return
    this.dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize()
    this.add({
      shape: 0,
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

  /** 閃電：依序經過每一個點，中間歪來歪去 */
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
    }
  }

  /** 貼著地面往外擴的一圈（爆炸、冰霜的範圍、蓋塔） */
  ring(x: number, z: number, radius: number, color: number, life: number, y = 0.04) {
    this.add({
      shape: 2,
      life,
      from: [x, y, z],
      s0: [radius * 0.25, 1, radius * 0.25],
      s1: [radius, 1, radius],
      color: new Color(color),
      a0: 0.9,
      a1: 0,
    })
  }

  /** 一閃就消失的光球 */
  flash(at: Point, radius: number, color: number, life: number) {
    this.add({
      shape: 1,
      life,
      from: at,
      s0: [radius * 0.4, radius * 0.4, radius * 0.4],
      s1: [radius, radius, radius],
      color: new Color(color),
      a0: 0.85,
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
        shape: 0,
        life: 0.45 + Math.random() * 0.25,
        from: at,
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

  /** 往上飄的小光點（升級、號角） */
  rise(x: number, z: number, color: number, count: number) {
    if (this.calm) return
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      this.add({
        shape: 1,
        life: 0.7,
        from: [x + Math.cos(angle) * 0.34, 0.1, z + Math.sin(angle) * 0.34],
        vel: [0, 1.6, 0],
        s0: [0.07, 0.07, 0.07],
        s1: [0.02, 0.02, 0.02],
        color: new Color(color),
        a0: 1,
        a1: 0,
      })
    }
  }

  update(dt: number) {
    const counts = [0, 0, 0]
    const keep: Item[] = []
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
      } else {
        it.vel[1] -= it.gravity * dt
        it.from[0] += it.vel[0] * dt
        it.from[1] = Math.max(0.03, it.from[1] + it.vel[1] * dt)
        it.from[2] += it.vel[2] * dt
        p.set(it.from[0], it.from[1], it.from[2])
        if (it.quat) q.copy(it.quat)
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
    this.items = keep
    this.meshes.forEach((mesh, i) => {
      mesh.count = counts[i]
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
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
    this.material.dispose()
  }
}
