// 偵察型的偵察機：飛行的物理（自己這邊飛的照固定步長算）和模型（四旋翼、發光的鏡頭、一圈一圈往外擴的掃描波）。
// 操控：滑鼠轉方向，W/S 往看的方向飛（稍微往下看還是平飛，往下看很多才往下衝），A/D 橫移，空白鍵上升、Shift 下降。
// 撞到大樓會停下來（用和機甲一樣的推出去），不能飛進對方的機庫、不能高過 `DRONE.ceiling`；飛多遠都可以，只是訊號越來越差（`droneNoise`）。
// 沒人操控（停在原地偵測）時就停在空中，鏡頭一直朝著停下來時的方向。
import { AdditiveBlending, DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, type Object3D } from 'three'
import type { MapIndex, Team } from './map'
import { assemble, part, type MechKit } from './mech'
import { clamp } from './physics'
import { DRONE, TEAMS } from './spec'

const TAN_H = Math.tan((DRONE.viewH * Math.PI) / 180)
const TAN_V = Math.tan((DRONE.viewV * Math.PI) / 180)

export type DroneBody = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** 鏡頭的方向（操控的人看出去的方向） */
  yaw: number
  pitch: number
  /** 飛了幾秒 */
  age: number
}

export type DroneInput = {
  /** 往看的方向飛（-1～1）、往右（-1～1）、上升（-1～1） */
  forward: number
  strafe: number
  rise: number
}

export const DRONE_PITCH_MIN = -1.35
export const DRONE_PITCH_MAX = 0.9
/** 鏡頭的仰角超過這個（弧度）才往上、往下飛 */
const DIVE_FROM = 0.35

export function newDrone(x: number, y: number, z: number, yaw: number): DroneBody {
  // 從背上彈出去：先往上、往後一點
  return { x, y, z, vx: -Math.sin(yaw) * 3, vy: 9, vz: -Math.cos(yaw) * 3, yaw, pitch: -0.12, age: 0 }
}

const normal = { x: 0, z: 0 }
const probe = { x: 0, y: 0, z: 0 }

/** 往前算一步；`team` 決定哪一邊的能量牆擋住 */
export function stepDrone(d: DroneBody, input: DroneInput, h: number, map: MapIndex, team: Team) {
  d.age += h
  // 往前飛的方向：鏡頭稍微往上、往下看（20 度內）還是平飛，看得越斜越往那邊飛
  const tilt = clamp((Math.abs(d.pitch) - DIVE_FROM) / 0.4, 0, 1)
  const fy = Math.sin(d.pitch) * tilt
  const fh = Math.sqrt(1 - fy * fy)
  const fx = Math.sin(d.yaw) * fh
  const fz = Math.cos(d.yaw) * fh
  const rx = -Math.cos(d.yaw)
  const rz = Math.sin(d.yaw)
  let wx = fx * input.forward + rx * input.strafe
  let wy = fy * input.forward
  let wz = fz * input.forward + rz * input.strafe
  const wl = Math.hypot(wx, wy, wz)
  if (wl > 1) {
    wx /= wl
    wy /= wl
    wz /= wl
  }
  // 想要的速度：水平照方向，垂直是往看的方向的那一份加上升降
  const tx = wx * DRONE.speed
  const tz = wz * DRONE.speed
  const ty = clamp(wy * DRONE.speed + input.rise * DRONE.climb, -DRONE.speed, DRONE.speed)
  const step = DRONE.accel * h
  const dx = tx - d.vx
  const dy = ty - d.vy
  const dz = tz - d.vz
  const dl = Math.hypot(dx, dy, dz)
  if (dl <= step) {
    d.vx = tx
    d.vy = ty
    d.vz = tz
  } else {
    d.vx += (dx / dl) * step
    d.vy += (dy / dl) * step
    d.vz += (dz / dl) * step
  }

  // 往上撞到東西（橋面底下）：不再往上
  const r = DRONE.radius
  if (d.vy > 0 && map.ray(d.x, d.y, d.z, 0, 1, 0, r + d.vy * h) !== Infinity) d.vy = 0
  d.x += d.vx * h
  d.y += d.vy * h
  d.z += d.vz * h

  // 撞到大樓、能量牆、地圖邊界：推出去，去掉往牆裡的速度
  probe.x = d.x
  probe.y = d.y - r
  probe.z = d.z
  if (map.push(probe, r, r * 2, 0, team, normal)) {
    d.x = probe.x
    d.z = probe.z
    const into = d.vx * normal.x + d.vz * normal.z
    if (into < 0) {
      d.vx -= into * normal.x
      d.vz -= into * normal.z
    }
  }
  // 地面（屋頂、橋面、河床）
  const floor = map.ground(d.x, d.y, d.z, r, 0) + r
  if (d.y < floor) {
    d.y = floor
    if (d.vy < 0) d.vy = 0
  }
  if (d.y > DRONE.ceiling) {
    d.y = DRONE.ceiling
    if (d.vy > 0) d.vy = 0
  }
}

/** 離自己的機甲多遠（水平，公尺） */
export function droneDistance(d: { x: number; z: number }, home: { x: number; z: number }): number {
  return Math.hypot(d.x - home.x, d.z - home.z)
}

/** 離自己的機甲 `far` 公尺時畫面有多少雜訊：0 很清楚、1 整個畫面都是雜訊（訊號斷了） */
export function droneNoise(far: number): number {
  return clamp((far - DRONE.clear) / (DRONE.lost - DRONE.clear), 0, 1)
}

/** 雜訊 `noise` 時掃描看得多遠：雜訊不多時照樣看得到 `DRONE.scan`，越糊看得越近，全糊了就什麼都掃不到 */
export function droneReach(noise: number): number {
  return DRONE.scan * clamp((1 - noise) / 0.7, 0, 1)
}

/** (x, y, z) 在不在偵察機鏡頭的畫面裡（往前看左右 `DRONE.viewH`、上下 `DRONE.viewV` 度；不管距離和擋住） */
export function inDroneView(d: { x: number; y: number; z: number; yaw: number; pitch: number }, x: number, y: number, z: number): boolean {
  const vx = x - d.x
  const vy = y - d.y
  const vz = z - d.z
  const sy = Math.sin(d.yaw)
  const cy = Math.cos(d.yaw)
  const sp = Math.sin(d.pitch)
  const cp = Math.cos(d.pitch)
  // 鏡頭的前、右、上
  const f = vx * sy * cp + vy * sp + vz * cy * cp
  if (f <= 0.5) return false
  const r = -vx * cy + vz * sy
  const u = -vx * sp * sy + vy * cp - vz * sp * cy
  return Math.abs(r) <= f * TAN_H && Math.abs(u) <= f * TAN_V
}

/** 偵察機的模型：機身、四支旋翼、前面發光的鏡頭、上面閃的燈，加上一圈往外擴的掃描波 */
export class DroneModel {
  readonly root = new Group()
  private readonly rotors: Group[] = []
  private readonly light: Mesh
  private readonly ring: Mesh
  private readonly ringMat: MeshBasicMaterial
  private readonly ringGeo: RingGeometry
  /** 掃描波跟著鏡頭轉 */
  private readonly scanner = new Group()
  private spin = 0
  private blink = 0
  /** 掃描波擴散到哪裡（0～1，超過 1 就不畫） */
  private wave = 2

  constructor(kit: MechKit, team: Team) {
    const { box, cyl, disc } = kit.geo
    const armor = kit.armor[team]
    const glow = kit.glow[team]
    const body = new Group()
    body.scale.setScalar(DRONE.scale)
    this.root.add(body)
    part(body, box, armor, [0.9, 0.32, 1.1], [0, 0, 0])
    part(body, box, kit.trim[team], [0.6, 0.22, 0.7], [0, 0.24, -0.05])
    part(body, box, kit.dark, [0.7, 0.18, 0.9], [0, -0.22, 0])
    // 鏡頭（朝前）
    part(body, cyl, kit.metal, [0.36, 0.22, 0.36], [0, -0.02, 0.6], [Math.PI / 2, 0, 0])
    part(body, disc, glow, [0.26, 0.26, 0.26], [0, -0.02, 0.72])
    this.light = part(body, box, glow, [0.12, 0.08, 0.12], [0, 0.4, -0.25])
    // 四支手臂和旋翼
    for (const [x, z] of [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      part(body, box, kit.dark, [0.1, 0.08, 1.05], [x * 0.45, 0.05, z * 0.45], [0, Math.atan2(x, z), 0])
      part(body, cyl, kit.metal, [0.16, 0.2, 0.16], [x * 0.8, 0.12, z * 0.8])
      const rotor = new Group()
      rotor.position.set(x * 0.8, 0.24, z * 0.8)
      body.add(rotor)
      part(rotor, box, kit.dark, [0.95, 0.02, 0.1], [0, 0, 0])
      part(rotor, box, kit.dark, [0.1, 0.02, 0.95], [0, 0, 0])
      this.rotors.push(rotor)
    }
    // 掃描波：鏡頭前面的一段弧（和鏡頭畫面一樣寬），從機身往前擴到看得到的距離（每一架自己一份材質，才能各自變淡）
    const half = (DRONE.viewH * Math.PI) / 180
    this.ringGeo = new RingGeometry(0.93, 1, 24, 1, -Math.PI / 2 - half, half * 2)
    this.ringGeo.rotateX(-Math.PI / 2)
    this.ringMat = new MeshBasicMaterial({
      color: TEAMS[team].glow,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    })
    this.ring = new Mesh(this.ringGeo, this.ringMat)
    this.ring.visible = false
    this.ring.frustumCulled = false
    this.scanner.rotation.order = 'YXZ'
    this.scanner.add(this.ring)
    this.root.add(this.scanner)
    // 零件換成合併、倒角過的網格；量位置時當作飛在半空中（不然會被當成貼著地面、沾滿灰塵）
    assemble(kit, 'drone', this.root, team, () => this.root.position.set(0, 12, 0))
  }

  /** 掃描波從頭開始擴 */
  pulse() {
    this.wave = 0
  }

  /** 擺到 (x, y, z)，機身朝 `yaw`、照速度往前傾；掃描波朝鏡頭的方向（`pitch` 是仰角）擴到 `reach` 公尺 */
  pose(x: number, y: number, z: number, yaw: number, pitch: number, reach: number, vx: number, vz: number, dt: number) {
    this.root.position.set(x, y, z)
    const body = this.root.children[0] as Object3D
    body.rotation.order = 'YXZ'
    body.rotation.y = yaw
    // 往飛的方向傾一點
    const fwd = vx * Math.sin(yaw) + vz * Math.cos(yaw)
    const side = vx * Math.cos(yaw) - vz * Math.sin(yaw)
    body.rotation.x = clamp(fwd * 0.012, -0.35, 0.35)
    body.rotation.z = clamp(side * 0.012, -0.35, 0.35)
    this.spin += dt * 60
    this.rotors.forEach((r, i) => (r.rotation.y = this.spin * (i % 2 ? 1 : -1)))
    this.blink += dt
    this.light.visible = this.blink % 0.8 < 0.15
    // 掃描波（訊號斷了就沒有）
    this.wave += dt / 1.1
    const on = this.wave < 1 && reach > 2
    this.ring.visible = on
    if (on) {
      this.scanner.rotation.y = yaw
      this.scanner.rotation.x = -pitch
      const s = 2 + this.wave * (reach - 2)
      this.ring.scale.set(s, 1, s)
      this.ringMat.opacity = 0.75 * (1 - this.wave)
    }
  }

  dispose() {
    this.ringGeo.dispose()
    this.ringMat.dispose()
  }
}
