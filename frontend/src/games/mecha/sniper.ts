// 狙擊型「長弓」的模型：低矮的四腳底盤、像蜘蛛一樣往上拱的膝蓋，底盤上一座會轉的砲塔，
// 砲塔兩側各一門長管電磁砲（砲上各掛一顆發光的感測器），砲塔後面是飛彈艙。沒有推進器：衝刺就是跑快一點。
// 砲塔跟著瞄準轉、砲管跟著仰角抬；腳用兩節的反向運動學擺：給腳掌要踩的地方，算出大腿和小腿的角度，
// 走路時對角的兩隻腳一起抬（像小跑步），跑起來步子跨大、底盤壓低，在空中縮腳，落地時底盤往下沉。
import { Group, type Object3D, type Vector3 } from 'three'
import type { Team } from './map'
import { part, Rig, type MechKit } from './mech'
import { clamp, wrapAngle, type MechBody } from './physics'
import { MECHS } from './spec'

/** 底盤（髖關節）離地多高、大腿和小腿多長 */
const HIP_Y = 2
const THIGH = 2.2
const SHIN = 3.4
/** 四隻腳：髖關節在底盤的哪裡、腳掌平常踩在哪裡（底盤座標，+z 是前面）；`pair` 相同的兩隻（對角）一起抬 */
const LEGS = [
  { hx: -1, hz: 1, fx: -2.8, fz: 2.9, pair: 0 },
  { hx: 1, hz: 1, fx: 2.8, fz: 2.9, pair: 1 },
  { hx: -1, hz: -1, fx: -2.8, fz: -2.8, pair: 1 },
  { hx: 1, hz: -1, fx: 2.8, fz: -2.8, pair: 0 },
]
/** 走路時腳掌前後擺多遠、抬多高（跑起來照速度放大，最多到 `MAX_PACE` 倍） */
const STEP_LEN = 0.9
const STEP_LIFT = 0.7
const MAX_PACE = 1.7
/** 砲塔的軸心在底盤上多高；兩門砲的耳軸在砲塔的哪裡；砲管（開火會往後退）和砲口在砲上的哪裡 */
const TURRET_Y = 1
const GUN_X = 1.3
const GUN_Y = 0.6
const BARREL_Z = 1.2
const MUZZLE_Z = 6.3
/** 砲管畫出來的仰角範圍（太低會插進地裡；真正的瞄準照鏡頭） */
const GUN_MIN = -0.45
const GUN_MAX = 0.95

type Leg = { yaw: Group; thigh: Group; knee: Group; foot: Group }

export class SniperModel extends Rig {
  private readonly chassis = new Group()
  private readonly turret = new Group()
  private readonly guns: Group[] = []
  private readonly barrels: Group[] = []
  private readonly muzzles: Object3D[] = []
  private readonly legs: Leg[] = []
  private readonly pod: Object3D
  /** 兩門砲開火後退的量 */
  private readonly recoil = [0, 0]
  private lean = 0
  private air = 0

  constructor(kit: MechKit, team: Team) {
    super(kit, team, 8)
    const armor = kit.armor[team]
    const trim = kit.trim[team]
    const glow = kit.glow[team]
    const { box, cyl, cyl6, cone } = kit.geo

    // 底盤：扁扁的一塊，前面斜的裝甲、底下的裙板、後面的引擎
    this.chassis.position.y = HIP_Y
    this.root.add(this.chassis)
    part(this.chassis, box, kit.dark, [2.2, 0.8, 2.6], [0, 0, 0])
    part(this.chassis, box, armor, [2.5, 0.45, 2.3], [0, 0.45, 0.05])
    part(this.chassis, box, armor, [2.1, 0.4, 0.9], [0, 0.22, 1.45], [0.45, 0, 0])
    part(this.chassis, box, trim, [2.6, 0.25, 2.5], [0, -0.35, 0])
    part(this.chassis, box, trim, [1.8, 0.7, 0.8], [0, 0.15, -1.55])
    for (const x of [-0.5, -0.17, 0.17, 0.5]) part(this.chassis, box, kit.dark, [0.12, 0.3, 0.7], [x, 0.58, -1.55])

    // 四隻腳：髖關節（直的軸，腳繞著它左右擺）→ 大腿 → 膝蓋 → 小腿 → 腳掌
    for (const L of LEGS) {
      part(this.chassis, box, trim, [0.95, 0.6, 0.95], [L.hx, 0.1, L.hz])
      const yaw = new Group()
      yaw.position.set(L.hx, 0, L.hz)
      this.chassis.add(yaw)
      part(yaw, cyl, kit.metal, [0.7, 0.55, 0.7], [0, -0.1, 0])
      const thigh = new Group()
      yaw.add(thigh)
      part(thigh, cyl, kit.metal, [0.5, 0.8, 0.5], [0, 0, 0], [0, 0, Math.PI / 2])
      part(thigh, box, armor, [0.6, 0.55, THIGH], [0, 0.05, THIGH / 2])
      part(thigh, box, trim, [0.66, 0.2, THIGH * 0.7], [0, 0.38, THIGH * 0.45])
      part(thigh, cyl6, kit.metal, [0.12, THIGH * 0.8, 0.12], [0, -0.38, THIGH / 2], [Math.PI / 2, 0, 0])
      const knee = new Group()
      knee.position.z = THIGH
      thigh.add(knee)
      part(knee, cyl, kit.metal, [0.55, 0.75, 0.55], [0, 0, 0], [0, 0, Math.PI / 2])
      part(knee, box, armor, [0.72, 0.62, 0.62], [0, 0.18, 0.05])
      part(knee, box, kit.dark, [0.4, 0.4, SHIN], [0, 0, SHIN / 2])
      part(knee, box, armor, [0.5, 0.18, SHIN * 0.55], [0, 0.26, SHIN * 0.32])
      const foot = new Group()
      foot.position.z = SHIN
      knee.add(foot)
      part(foot, cyl, kit.metal, [0.36, 0.5, 0.36], [0, 0, 0], [0, 0, Math.PI / 2])
      part(foot, box, kit.dark, [0.78, 0.28, 0.95], [0, -0.2, 0.1])
      part(foot, box, armor, [0.6, 0.18, 0.6], [0, -0.02, 0.05])
      this.legs.push({ yaw, thigh, knee, foot })
    }

    // 砲塔：轉盤、主體、前面的感測頭（發光的觀測窗）、天線
    this.turret.position.y = TURRET_Y
    this.chassis.add(this.turret)
    part(this.turret, cyl, kit.metal, [1.9, 0.3, 1.9], [0, -0.15, 0])
    part(this.turret, box, armor, [1.9, 0.75, 2.2], [0, 0.35, -0.1])
    part(this.turret, box, trim, [2, 0.22, 2], [0, 0.8, -0.2])
    part(this.turret, box, armor, [1.1, 0.55, 0.8], [0, 0.4, 1.2], [0.25, 0, 0])
    part(this.turret, box, glow, [0.8, 0.1, 0.06], [0, 0.5, 1.62], [0.25, 0, 0])
    part(this.turret, cyl6, kit.metal, [0.05, 1.4, 0.05], [-0.6, 1.4, -0.9], [-0.3, 0, -0.1])

    // 砲塔後面的飛彈艙：兩發，射掉就看不到彈頭
    const pod = new Group()
    pod.position.set(0, 1.05, -0.85)
    this.turret.add(pod)
    part(pod, box, trim, [1, 0.5, 0.9], [0, 0, 0])
    part(pod, box, kit.dark, [0.9, 0.4, 0.08], [0, 0, 0.46])
    for (const x of [-0.22, 0.22]) {
      this.missiles.push(part(pod, cone, kit.missile, [0.22, 0.45, 0.22], [x, 0, 0.5], [-Math.PI / 2, 0, 0]))
    }
    this.pod = pod

    // 兩門長管電磁砲：耳軸、機匣、配重、砲上的感測器；砲管（開火往後退）上有三圈線圈和砲口制退器
    for (const s of [-1, 1]) {
      part(this.turret, box, trim, [0.35, 0.75, 0.95], [s * 1.02, 0.45, 0.1])
      const gun = new Group()
      gun.position.set(s * GUN_X, GUN_Y, 0.1)
      this.turret.add(gun)
      part(gun, cyl, kit.metal, [0.45, 0.5, 0.45], [-s * 0.25, 0, 0], [0, 0, Math.PI / 2])
      part(gun, box, armor, [0.65, 0.75, 2], [0, 0, 0.3])
      part(gun, box, kit.dark, [0.55, 0.6, 0.7], [0, -0.02, -1])
      part(gun, box, trim, [0.45, 0.15, 1.6], [0, 0.45, 0.3])
      part(gun, box, kit.dark, [0.42, 0.36, 0.55], [0, 0.7, 0.25])
      part(gun, box, glow, [0.24, 0.12, 0.05], [0, 0.72, 0.54])
      const barrel = new Group()
      barrel.position.z = BARREL_Z
      gun.add(barrel)
      part(barrel, box, kit.dark, [0.44, 0.44, 1.4], [0, 0, 0.6])
      part(barrel, cyl, kit.metal, [0.26, 3.9, 0.26], [0, 0, 2.95], [Math.PI / 2, 0, 0])
      for (const z of [1.8, 2.6, 3.4]) part(barrel, cyl, kit.dark, [0.42, 0.12, 0.42], [0, 0, z], [Math.PI / 2, 0, 0])
      part(barrel, box, kit.dark, [0.5, 0.3, 0.55], [0, 0, 4.85])
      part(barrel, cyl, kit.dark, [0.36, 0.3, 0.36], [0, 0, 5.05], [Math.PI / 2, 0, 0])
      const muzzle = new Group()
      muzzle.position.z = MUZZLE_Z
      gun.add(muzzle)
      this.guns.push(gun)
      this.barrels.push(barrel)
      this.muzzles.push(muzzle)
    }
  }

  /** 第 `side` 門砲開了一發：砲管往後退，慢慢回來 */
  fire(side: number) {
    this.recoil[side] = 1
  }

  muzzle(side: number, out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return this.muzzles[side].getWorldPosition(out)
  }

  podPosition(out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return this.pod.getWorldPosition(out)
  }

  pose(b: MechBody, _firing: boolean, dt: number) {
    this.root.position.set(b.x, b.y, b.z)
    this.root.rotation.y = b.legs
    this.placeShadow(b, 8)

    const speed = Math.hypot(b.vx, b.vz)
    this.lean += ((b.boosting && speed > 1.5 ? 1 : 0) - this.lean) * Math.min(1, dt * 6)
    this.air += ((b.onGround ? 0 : 1) - this.air) * Math.min(1, dt * 8)
    // 步子多大：走路最多 1，跑起來跨得更大
    const pace = b.onGround ? clamp(speed / MECHS.sniper.walk, 0, MAX_PACE) : 0
    const crouch = this.lean * (b.onGround ? 1 : 0)

    // 底盤：走路時每踩一步晃一下，快跑時壓低、晃得大一點，落地時往下沉
    const bob = Math.abs(Math.sin(b.stride)) * 0.08 * pace
    const hipY = HIP_Y - crouch * 0.45 - b.landed * 0.5 + bob + this.air * 0.1
    this.chassis.position.y = hipY

    // 砲塔跟著瞄準轉、砲跟著仰角抬，開過火的砲管往後退（一下子退、慢慢回來）
    this.turret.rotation.y = wrapAngle(b.aimYaw - b.legs)
    for (let i = 0; i < 2; i++) {
      this.recoil[i] = Math.max(0, this.recoil[i] - dt * 2.5)
      this.guns[i].rotation.x = -clamp(b.aimPitch, GUN_MIN, GUN_MAX)
      this.barrels[i].position.z = BARREL_Z - this.recoil[i] * this.recoil[i] * 0.9
    }

    // 腳：先決定腳掌要踩在哪（底盤座標，地面在 -hipY），再用兩節 IK 算大腿和小腿的角度
    const reach = THIGH + SHIN - 0.05
    for (let i = 0; i < LEGS.length; i++) {
      const L = LEGS[i]
      const leg = this.legs[i]
      const phase = b.stride + (L.pair === 0 ? 0 : Math.PI)
      const swing = Math.sin(phase) * STEP_LEN * pace
      const lift = Math.max(0, Math.cos(phase)) * STEP_LIFT * Math.min(pace, 1.3)
      // 在空中縮起來；快跑時往外撐
      const spread = (1 - this.air * 0.3) * (1 + crouch * 0.12)
      const fx = L.fx * spread
      const fz = L.fz * spread + swing
      const fy = -hipY + lift + this.air * 1.1
      const dx = fx - L.hx
      const dz = fz - L.hz
      const r = Math.hypot(dx, dz)
      const full = Math.hypot(r, fy) || 1
      const d = clamp(full, 0.5, reach)
      // 膝蓋往上拱：大腿比髖關節到腳掌的那條線高 a1
      const a0 = Math.atan2(fy, r)
      const a1 = Math.acos(clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1))
      const th = a0 + a1
      const kx = Math.cos(th) * THIGH
      const ky = Math.sin(th) * THIGH
      const k = d / full
      const phi = Math.atan2(fy * k - ky, r * k - kx)
      leg.yaw.rotation.y = Math.atan2(dx, dz)
      leg.thigh.rotation.x = -th
      leg.knee.rotation.x = th - phi
      // 腳掌保持水平
      leg.foot.rotation.x = phi
    }
  }
}
