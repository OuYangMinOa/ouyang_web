// 車子的 3D 模型：用側面輪廓擠出車身，加上玻璃車艙、尾翼、四個輪子、車燈和地上的影子。
// 每個車種的外型不同（`SHAPES`），同一種車的形狀、輪胎這些大家共用（CarParts），每台車只有自己的烤漆和煞車燈材質。
import {
  BoxGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  PlaneGeometry,
  Shape,
  type BufferGeometry,
  type Material,
} from 'three'
import type { Car } from './physics'
import type { CarKind } from './spec'

type Point = [number, number]
type Spot = { x: number; y: number; z: number }

/**
 * 一種車的外型。輪廓畫在側面（x 往車頭、y 往上，單位公尺），左右對稱的東西只給右邊的 x。
 * 大小要和 `spec.ts` 的車長、車寬對得上，碰撞才不會看起來沒撞到或穿進去。
 */
type ShapeDef = {
  body: Point[]
  bodyWidth: number
  cabin: Point[]
  cabinWidth: number
  /** 車頂鈑金：寬、長、高度、前後位置；敞篷的沒有 */
  roof: { w: number; l: number; y: number; z: number } | null
  /** 尾翼：寬、深、高度、前後位置、支架多高（0 是直接貼在車上） */
  wing: { w: number; d: number; y: number; z: number; strut: number } | null
  wheel: { r: number; x: number; front: number; rear: number }
  head: Spot
  tail: Spot
  flame: Spot
  /** 影子的寬、長 */
  shadow: [number, number]
}

const SHAPES: Record<CarKind, ShapeDef> = {
  // 綜合：一般的跑車
  all: {
    body: [
      [-2.1, 0.28],
      [-2.16, 0.62],
      [-2.02, 0.86],
      [1.25, 0.82],
      [2.02, 0.64],
      [2.2, 0.42],
      [2.1, 0.28],
    ],
    bodyWidth: 1.86,
    cabin: [
      [-1.4, 0.8],
      [-0.78, 1.2],
      [0.32, 1.22],
      [1.15, 0.8],
    ],
    cabinWidth: 1.52,
    roof: { w: 1.36, l: 1.0, y: 1.235, z: -0.22 },
    wing: { w: 1.9, d: 0.4, y: 1.1, z: -1.92, strut: 0.26 },
    wheel: { r: 0.36, x: 0.88, front: 1.32, rear: -1.28 },
    head: { x: 0.63, y: 0.62, z: 2.17 },
    tail: { x: 0.6, y: 0.72, z: -2.17 },
    flame: { x: 0.33, y: 0.42, z: -2.18 },
    shadow: [2.7, 5.2],
  },
  // 極速：又長又低的楔形超跑，車艙往後縮，尾巴是低低的鴨尾
  speed: {
    body: [
      [-2.3, 0.26],
      [-2.36, 0.6],
      [-2.2, 0.76],
      [0.6, 0.8],
      [1.9, 0.5],
      [2.36, 0.32],
      [2.3, 0.22],
    ],
    bodyWidth: 1.98,
    cabin: [
      [-1.55, 0.76],
      [-0.9, 1.07],
      [0.12, 1.09],
      [0.95, 0.76],
    ],
    cabinWidth: 1.5,
    roof: { w: 1.2, l: 0.9, y: 1.1, z: -0.38 },
    wing: { w: 1.96, d: 0.36, y: 0.9, z: -2.12, strut: 0.1 },
    wheel: { r: 0.38, x: 0.95, front: 1.48, rear: -1.46 },
    head: { x: 0.68, y: 0.46, z: 2.29 },
    tail: { x: 0.68, y: 0.66, z: -2.37 },
    flame: { x: 0.36, y: 0.4, z: -2.38 },
    shadow: [2.85, 5.6],
  },
  // 加速：短短高高的小鋼砲，車艙一路接到車尾，尾翼貼在車頂後緣
  accel: {
    body: [
      [-1.9, 0.3],
      [-1.95, 0.8],
      [-1.85, 0.94],
      [0.85, 0.92],
      [1.7, 0.72],
      [1.95, 0.5],
      [1.88, 0.3],
    ],
    bodyWidth: 1.78,
    cabin: [
      [-1.86, 0.9],
      [-1.62, 1.4],
      [0.1, 1.44],
      [0.9, 0.9],
    ],
    cabinWidth: 1.58,
    roof: { w: 1.44, l: 1.55, y: 1.455, z: -0.76 },
    wing: { w: 1.5, d: 0.3, y: 1.46, z: -1.7, strut: 0 },
    wheel: { r: 0.35, x: 0.83, front: 1.2, rear: -1.18 },
    head: { x: 0.6, y: 0.68, z: 1.93 },
    tail: { x: 0.62, y: 0.86, z: -1.95 },
    flame: { x: 0.3, y: 0.42, z: -1.96 },
    shadow: [2.55, 4.7],
  },
  // 操控：小小低低的賽車，只有一個小座艙，沒有車頂
  grip: {
    body: [
      [-1.92, 0.28],
      [-1.98, 0.64],
      [-1.8, 0.78],
      [1.05, 0.74],
      [1.78, 0.56],
      [1.98, 0.38],
      [1.92, 0.26],
    ],
    bodyWidth: 1.8,
    cabin: [
      [-0.95, 0.74],
      [-0.72, 0.99],
      [0.3, 1.01],
      [0.9, 0.74],
    ],
    cabinWidth: 1.3,
    roof: null,
    wing: { w: 1.72, d: 0.32, y: 0.88, z: -1.78, strut: 0.08 },
    wheel: { r: 0.35, x: 0.88, front: 1.22, rear: -1.2 },
    head: { x: 0.6, y: 0.56, z: 1.95 },
    tail: { x: 0.6, y: 0.64, z: -1.97 },
    flame: { x: 0.3, y: 0.4, z: -1.98 },
    shadow: [2.6, 4.8],
  },
  // 甩尾：寬體雙門跑車，前下巴很低，高高的大尾翼
  drift: {
    body: [
      [-2.12, 0.26],
      [-2.18, 0.64],
      [-2.02, 0.84],
      [1.2, 0.82],
      [2.0, 0.62],
      [2.22, 0.36],
      [2.16, 0.2],
    ],
    bodyWidth: 1.92,
    cabin: [
      [-1.3, 0.8],
      [-0.72, 1.18],
      [0.3, 1.2],
      [1.1, 0.8],
    ],
    cabinWidth: 1.54,
    roof: { w: 1.34, l: 0.98, y: 1.215, z: -0.21 },
    wing: { w: 2.1, d: 0.5, y: 1.42, z: -1.95, strut: 0.58 },
    wheel: { r: 0.37, x: 0.92, front: 1.34, rear: -1.3 },
    head: { x: 0.66, y: 0.6, z: 2.19 },
    tail: { x: 0.62, y: 0.7, z: -2.19 },
    flame: { x: 0.34, y: 0.4, z: -2.2 },
    shadow: [2.8, 5.3],
  },
}

/** 選單上的側面剪影（SVG，車頭朝右；y 往下，所以高度取負的） */
export function carProfile(kind: CarKind) {
  const def = SHAPES[kind]
  const path = (points: Point[]) => `M${points.map(([x, y]) => `${x.toFixed(2)} ${(-y).toFixed(2)}`).join('L')}Z`
  const box = (x0: number, x1: number, y0: number, y1: number) =>
    path([
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ])
  // 輪廓的 x 就是模型的 z（車頭方向）
  const w = def.wing
  return {
    body: path(def.body),
    cabin: path(def.cabin),
    wing: w
      ? box(w.z - w.d / 2, w.z + w.d / 2, w.y - 0.04, w.y + 0.04) +
        (w.strut > 0 ? box(w.z - 0.05, w.z + 0.05, w.y - 0.04 - w.strut, w.y - 0.04) : '')
      : null,
    wheels: [def.wheel.front, def.wheel.rear].map((x) => ({ x, r: def.wheel.r })),
  }
}

/** 一種車的幾何形狀（同一種車共用） */
type BodyParts = {
  def: ShapeDef
  body: BufferGeometry
  cabin: BufferGeometry
  roof: BufferGeometry | null
  wing: BufferGeometry | null
  strut: BufferGeometry | null
  tire: BufferGeometry
  rim: BufferGeometry
  shadow: BufferGeometry
}

export type CarParts = {
  head: BufferGeometry
  tail: BufferGeometry
  flame: BufferGeometry
  glass: Material
  tireMat: Material
  rimMat: Material
  trim: Material
  headMat: Material
  flameMat: Material
  shadowMat: MeshBasicMaterial
  /** 各車種的形狀，用到才做 */
  bodies: Map<CarKind, BodyParts>
}

function extrudeProfile(points: Point[], width: number, bevel: number): BufferGeometry {
  const shape = new Shape()
  shape.moveTo(points[0][0], points[0][1])
  for (const [x, y] of points.slice(1)) shape.lineTo(x, y)
  shape.closePath()
  const geo = new ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
  })
  // 輪廓畫在 x（車長）、y（高度）平面，擠出方向 z 是車寬；轉成車頭朝 +z
  geo.translate(0, 0, -(width - bevel * 2) / 2)
  geo.rotateY(-Math.PI / 2)
  geo.computeVertexNormals()
  return geo
}

function shadowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(32, 64, 6, 32, 64, 62)
  g.addColorStop(0, 'rgba(0,0,0,0.85)')
  g.addColorStop(0.55, 'rgba(0,0,0,0.5)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.save()
  ctx.scale(1, 2)
  ctx.fillRect(0, 0, 64, 64)
  ctx.restore()
  return new CanvasTexture(canvas)
}

export function createCarParts(): CarParts {
  const flame = new ConeGeometry(0.13, 0.8, 8)
  flame.rotateX(-Math.PI / 2)
  flame.translate(0, 0, -0.4)
  return {
    head: new BoxGeometry(0.46, 0.14, 0.08),
    tail: new BoxGeometry(0.52, 0.12, 0.08),
    flame,
    glass: new MeshPhongMaterial({ color: 0x18202c, shininess: 120, specular: 0x8899aa }),
    tireMat: new MeshLambertMaterial({ color: 0x151515 }),
    rimMat: new MeshPhongMaterial({ color: 0xc4cad2, shininess: 60 }),
    trim: new MeshLambertMaterial({ color: 0x1d1d22 }),
    headMat: new MeshBasicMaterial({ color: 0xfff4d6 }),
    flameMat: new MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, depthWrite: false }),
    shadowMat: new MeshBasicMaterial({
      color: 0x000000,
      map: shadowTexture(),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    bodies: new Map(),
  }
}

function bodyParts(parts: CarParts, kind: CarKind): BodyParts {
  const cached = parts.bodies.get(kind)
  if (cached) return cached
  const def = SHAPES[kind]
  const { r } = def.wheel
  const tire = new CylinderGeometry(r, r, 0.3, 18)
  tire.rotateZ(Math.PI / 2)
  // 輪圈用六角形，轉起來看得出在轉
  const rim = new CylinderGeometry(r * 0.61, r * 0.61, 0.32, 6)
  rim.rotateZ(Math.PI / 2)
  const shadow = new PlaneGeometry(def.shadow[0], def.shadow[1])
  shadow.rotateX(-Math.PI / 2)
  const made: BodyParts = {
    def,
    body: extrudeProfile(def.body, def.bodyWidth, 0.07),
    cabin: extrudeProfile(def.cabin, def.cabinWidth, 0.05),
    roof: def.roof ? new BoxGeometry(def.roof.w, 0.06, def.roof.l) : null,
    wing: def.wing ? new BoxGeometry(def.wing.w, 0.06, def.wing.d) : null,
    strut: def.wing && def.wing.strut > 0 ? new BoxGeometry(0.08, def.wing.strut, 0.14) : null,
    tire,
    rim,
    shadow,
  }
  parts.bodies.set(kind, made)
  return made
}

export function disposeCarParts(parts: CarParts) {
  for (const body of parts.bodies.values()) {
    for (const geo of [body.body, body.cabin, body.roof, body.wing, body.strut, body.tire, body.rim, body.shadow]) {
      geo?.dispose()
    }
  }
  parts.bodies.clear()
  for (const value of Object.values(parts)) {
    if (value && typeof value === 'object' && 'dispose' in value) (value as { dispose(): void }).dispose()
  }
  parts.shadowMat.map?.dispose()
}

const TAIL_OFF = 0x6a0c0c
const TAIL_ON = 0xff2a2a

export class CarModel {
  readonly root = new Group()
  private readonly body = new Group()
  private readonly steerPivots: Group[] = []
  private readonly spinners: Group[] = []
  private readonly paint: MeshPhongMaterial
  private readonly tailMat: MeshBasicMaterial
  private readonly flames: Mesh[] = []
  private readonly wheelR: number
  private readonly shadow: Mesh
  private spin = 0
  private roll = 0
  private pitch = 0
  /** 路面的橫向傾斜 */
  private tilt = 0
  /** 落地時車身往下沉多少（慢慢彈回來） */
  private squash = 0

  constructor(parts: CarParts, kind: CarKind, color: number) {
    const shape = bodyParts(parts, kind)
    const def = shape.def
    this.wheelR = def.wheel.r
    this.paint = new MeshPhongMaterial({ color, shininess: 90, specular: 0x555555 })
    this.tailMat = new MeshBasicMaterial({ color: TAIL_OFF })

    const shadow = new Mesh(shape.shadow, parts.shadowMat)
    shadow.position.y = 0.04
    shadow.renderOrder = 1
    this.shadow = shadow
    this.root.add(shadow)
    this.root.add(this.body)
    this.root.rotation.order = 'YXZ'

    this.body.add(new Mesh(shape.body, this.paint))
    this.body.add(new Mesh(shape.cabin, parts.glass))
    if (shape.roof && def.roof) {
      const roof = new Mesh(shape.roof, this.paint)
      roof.position.set(0, def.roof.y, def.roof.z)
      this.body.add(roof)
    }
    if (shape.wing && def.wing) {
      const w = def.wing
      const wing = new Mesh(shape.wing, parts.trim)
      wing.position.set(0, w.y, w.z)
      this.body.add(wing)
      if (shape.strut) {
        for (const side of [-1, 1]) {
          const strut = new Mesh(shape.strut, parts.trim)
          strut.position.set(side * w.w * 0.32, w.y - 0.03 - w.strut / 2, w.z)
          this.body.add(strut)
        }
      }
    }
    for (const side of [-1, 1]) {
      const head = new Mesh(parts.head, parts.headMat)
      head.position.set(side * def.head.x, def.head.y, def.head.z)
      this.body.add(head)
      const tail = new Mesh(parts.tail, this.tailMat)
      tail.position.set(side * def.tail.x, def.tail.y, def.tail.z)
      this.body.add(tail)
      const flame = new Mesh(parts.flame, parts.flameMat)
      flame.position.set(side * def.flame.x, def.flame.y, def.flame.z)
      flame.visible = false
      this.flames.push(flame)
      this.body.add(flame)
    }

    // 輪子不跟著車身側傾，直接掛在 root 上
    const { r, x, front, rear } = def.wheel
    for (const [wx, wz] of [
      [x, front],
      [-x, front],
      [x, rear],
      [-x, rear],
    ]) {
      const pivot = new Group()
      pivot.position.set(wx, r, wz)
      const spinner = new Group()
      spinner.add(new Mesh(shape.tire, parts.tireMat))
      spinner.add(new Mesh(shape.rim, parts.rimMat))
      pivot.add(spinner)
      this.root.add(pivot)
      if (wz > 0) this.steerPivots.push(pivot)
      this.spinners.push(spinner)
    }
  }

  /** 騰空後落地：車身往下一沉再彈回來 */
  land(strength: number) {
    this.squash = Math.max(this.squash, Math.min(0.16, strength * 0.018))
  }

  /** `slope`、`side` 是路面往車頭方向、往車子左邊的坡度（高度／距離） */
  sync(car: Car, slope: number, side: number, dt: number, time: number) {
    this.root.position.set(car.x, car.y, car.z)
    const k = 1 - Math.exp(-10 * dt)
    // 在空中：車頭跟著飛的方向慢慢點下去，車身慢慢擺平；影子留在路面上、離越高越小
    const height = Math.max(0, car.y - car.loc.y)
    const flying = car.air > 0 && height > 0.08
    if (flying) {
      const dive = -Math.atan2(car.vy, Math.max(Math.abs(car.speed), 8)) * 0.6
      this.pitch += (dive - this.pitch) * (1 - Math.exp(-3 * dt))
      this.tilt *= Math.exp(-2 * dt)
    } else {
      this.pitch += (-Math.atan(slope) - this.pitch) * k
      this.tilt += (Math.atan(side) - this.tilt) * k
    }
    this.root.rotation.set(this.pitch, car.heading, this.tilt)
    this.shadow.position.y = 0.04 - height
    this.shadow.scale.setScalar(1 / (1 + height * 0.15))
    this.squash *= Math.exp(-9 * dt)
    this.body.position.y = -this.squash
    // 過彎時車身往外傾：側向加速度 ≈ 轉向角速度 × 速度
    const lean = Math.max(-0.07, Math.min(0.07, car.yawRate * car.speed * 0.0035))
    this.roll += (lean - this.roll) * k
    this.body.rotation.z = this.roll
    // 加速時車頭微微抬起、煞車時往前點頭
    this.body.rotation.x = car.braking ? 0.025 : car.throttle > 0.5 && car.speed < 30 ? -0.015 : 0

    this.spin = (this.spin + (car.speed / this.wheelR) * dt) % (Math.PI * 2)
    for (const s of this.spinners) s.rotation.x = this.spin
    for (const p of this.steerPivots) p.rotation.y = -car.steer * 0.5

    this.tailMat.color.setHex(car.braking ? TAIL_ON : TAIL_OFF)
    const boosting = car.boost > 0
    for (const f of this.flames) {
      f.visible = boosting
      if (boosting) f.scale.set(1, 1, 0.75 + Math.sin(time * 60 + f.position.x * 9) * 0.25)
    }
  }

  dispose() {
    this.paint.dispose()
    this.tailMat.dispose()
  }
}
