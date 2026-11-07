// 車子的 3D 模型：用側面輪廓擠出車身，加上玻璃車艙、尾翼、四個輪子、車燈和地上的影子。
// 形狀、輪胎這些大家共用（CarParts），每台車只有自己的烤漆和煞車燈材質。
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

const WHEEL_R = 0.36

export type CarParts = {
  body: BufferGeometry
  cabin: BufferGeometry
  roof: BufferGeometry
  wing: BufferGeometry
  strut: BufferGeometry
  tire: BufferGeometry
  rim: BufferGeometry
  head: BufferGeometry
  tail: BufferGeometry
  flame: BufferGeometry
  shadow: BufferGeometry
  glass: Material
  tireMat: Material
  rimMat: Material
  trim: Material
  headMat: Material
  flameMat: Material
  shadowMat: MeshBasicMaterial
}

function extrudeProfile(points: [number, number][], width: number, bevel: number): BufferGeometry {
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
  const tire = new CylinderGeometry(WHEEL_R, WHEEL_R, 0.3, 18)
  tire.rotateZ(Math.PI / 2)
  // 輪圈用六角形，轉起來看得出在轉
  const rim = new CylinderGeometry(0.22, 0.22, 0.32, 6)
  rim.rotateZ(Math.PI / 2)
  const flame = new ConeGeometry(0.13, 0.8, 8)
  flame.rotateX(-Math.PI / 2)
  flame.translate(0, 0, -0.4)
  const shadow = new PlaneGeometry(2.7, 5.2)
  shadow.rotateX(-Math.PI / 2)
  return {
    body: extrudeProfile(
      [
        [-2.1, 0.28],
        [-2.16, 0.62],
        [-2.02, 0.86],
        [1.25, 0.82],
        [2.02, 0.64],
        [2.2, 0.42],
        [2.1, 0.28],
      ],
      1.86,
      0.07,
    ),
    cabin: extrudeProfile(
      [
        [-1.4, 0.8],
        [-0.78, 1.2],
        [0.32, 1.22],
        [1.15, 0.8],
      ],
      1.52,
      0.05,
    ),
    roof: new BoxGeometry(1.36, 0.06, 1.0),
    wing: new BoxGeometry(1.9, 0.06, 0.4),
    strut: new BoxGeometry(0.08, 0.26, 0.14),
    tire,
    rim,
    head: new BoxGeometry(0.46, 0.14, 0.08),
    tail: new BoxGeometry(0.52, 0.12, 0.08),
    flame,
    shadow,
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
  }
}

export function disposeCarParts(parts: CarParts) {
  for (const value of Object.values(parts)) {
    if ('dispose' in value) (value as { dispose(): void }).dispose()
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
  private spin = 0
  private roll = 0
  private pitch = 0

  constructor(parts: CarParts, color: number) {
    this.paint = new MeshPhongMaterial({ color, shininess: 90, specular: 0x555555 })
    this.tailMat = new MeshBasicMaterial({ color: TAIL_OFF })

    const shadow = new Mesh(parts.shadow, parts.shadowMat)
    shadow.position.y = 0.04
    shadow.renderOrder = 1
    this.root.add(shadow)
    this.root.add(this.body)
    this.root.rotation.order = 'YXZ'

    this.body.add(new Mesh(parts.body, this.paint))
    this.body.add(new Mesh(parts.cabin, parts.glass))
    const roof = new Mesh(parts.roof, this.paint)
    roof.position.set(0, 1.235, -0.22)
    this.body.add(roof)
    const wing = new Mesh(parts.wing, parts.trim)
    wing.position.set(0, 1.1, -1.92)
    this.body.add(wing)
    for (const x of [-0.6, 0.6]) {
      const strut = new Mesh(parts.strut, parts.trim)
      strut.position.set(x, 0.96, -1.92)
      this.body.add(strut)
      const head = new Mesh(parts.head, parts.headMat)
      head.position.set(x * 1.05, 0.62, 2.17)
      this.body.add(head)
      const tail = new Mesh(parts.tail, this.tailMat)
      tail.position.set(x, 0.72, -2.17)
      this.body.add(tail)
      const flame = new Mesh(parts.flame, parts.flameMat)
      flame.position.set(x * 0.55, 0.42, -2.18)
      flame.visible = false
      this.flames.push(flame)
      this.body.add(flame)
    }

    // 輪子不跟著車身側傾，直接掛在 root 上
    for (const [x, z] of [
      [0.88, 1.32],
      [-0.88, 1.32],
      [0.88, -1.28],
      [-0.88, -1.28],
    ]) {
      const pivot = new Group()
      pivot.position.set(x, WHEEL_R, z)
      const spinner = new Group()
      spinner.add(new Mesh(parts.tire, parts.tireMat))
      spinner.add(new Mesh(parts.rim, parts.rimMat))
      pivot.add(spinner)
      this.root.add(pivot)
      if (z > 0) this.steerPivots.push(pivot)
      this.spinners.push(spinner)
    }
  }

  /** `slope` 是路面往車頭方向的坡度（高度／距離） */
  sync(car: Car, slope: number, dt: number, time: number) {
    this.root.position.set(car.x, car.y, car.z)
    const k = 1 - Math.exp(-10 * dt)
    this.pitch += (-Math.atan(slope) - this.pitch) * k
    this.root.rotation.set(this.pitch, car.heading, 0)
    // 過彎時車身往外傾：側向加速度 ≈ 轉向角速度 × 速度
    const lean = Math.max(-0.07, Math.min(0.07, car.yawRate * car.speed * 0.0035))
    this.roll += (lean - this.roll) * k
    this.body.rotation.z = this.roll
    // 加速時車頭微微抬起、煞車時往前點頭
    this.body.rotation.x = car.braking ? 0.025 : car.throttle > 0.5 && car.speed < 30 ? -0.015 : 0

    this.spin = (this.spin + (car.speed / WHEEL_R) * dt) % (Math.PI * 2)
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
