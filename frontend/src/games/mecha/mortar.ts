// 砲擊型「隕星」的模型：兩條反關節的腿撐著一個矮胖的上半身，背上一個大彈藥箱，上面架著一門大口徑迫擊砲（平常往後躺著），
// 右手一把卡賓槍、左肩是飛彈艙。架砲（`MechBody.deploy` 從 0 到 1）時跪下來、腰後兩支支架撐到地上，
// 砲管從背後往上翻、立起來朝前（仰角就是瞄準的仰角，`SHELL.elevMin`～`elevMax`），開砲時砲管往後縮一下。
// 上半身和砲跟著瞄準轉；腿用兩節的反向運動學擺，膝蓋往後彎。
import { Group, type Object3D, type Vector3 } from 'three'
import type { Team } from './map'
import { part, Rig, type MechKit } from './mech'
import { clamp, wrapAngle, type MechBody } from './physics'
import { ease, MECHS, SHELL } from './spec'

const SPEC = MECHS.mortar
/** 髖關節離地多高、大腿和小腿多長、腳踝離地多高；架砲時往下跪多少 */
const HIP_Y = 3.1
const THIGH = 1.65
const SHIN = 1.75
const ANKLE_Y = 0.45
const KNEEL = SPEC.deploy!.drop
/** 上半身的軸心在髖關節上面多高 */
const TORSO_Y = 0.35
/** 砲管的軸心（上半身座標）、收著時的角度（往後躺） */
const PIVOT = { y: 1.8, z: -0.95 }
const STOW = -2.85
/** 砲管多長（砲口離軸心多遠） */
const TUBE = 4.2

type Leg = { hip: Group; knee: Group; ankle: Group }

const lerp = (a: number, b: number, k: number) => a + (b - a) * k

export class MortarModel extends Rig {
  private readonly hips = new Group()
  private readonly torso = new Group()
  private readonly legs: Leg[] = []
  private readonly struts: Group[] = []
  private readonly cradle = new Group()
  private readonly tube = new Group()
  private readonly barrel = new Group()
  private readonly tubeMuzzle: Object3D
  private readonly arm = new Group()
  private readonly carbine = new Group()
  private readonly gunMuzzle: Object3D
  private readonly pod: Object3D
  /** 架砲的進度（`pose` 記下來，`muzzle` 照這個決定從砲口還是槍口出來） */
  private k = 0
  private tubeRecoil = 0
  private gunRecoil = 0
  private lean = 0
  private air = 0

  constructor(kit: MechKit, team: Team) {
    super(kit, team, 5.4)
    const armor = kit.armor[team]
    const trim = kit.trim[team]
    const glow = kit.glow[team]
    const { box, cyl, cyl6, cone } = kit.geo

    this.hips.position.y = HIP_Y
    this.root.add(this.hips)
    part(this.hips, box, kit.dark, [1.7, 0.75, 1.3], [0, 0, 0])
    part(this.hips, box, trim, [2, 0.35, 1.1], [0, -0.22, 0.05])

    for (const s of [-1, 1]) {
      const hip = new Group()
      hip.position.set(s * 1.1, 0, 0)
      this.hips.add(hip)
      part(hip, cyl, kit.metal, [0.75, 0.6, 0.75], [0, 0, 0], [0, 0, Math.PI / 2])
      part(hip, box, armor, [0.75, THIGH, 0.95], [0, -THIGH / 2, 0])
      part(hip, box, trim, [0.82, THIGH * 0.45, 1.0], [0, -THIGH * 0.3, 0.02])
      const knee = new Group()
      knee.position.y = -THIGH
      hip.add(knee)
      part(knee, cyl, kit.metal, [0.68, 0.72, 0.68], [0, 0, 0], [0, 0, Math.PI / 2])
      // 膝蓋往後凸
      part(knee, box, armor, [0.8, 0.7, 0.55], [0, 0.05, -0.35], [0.3, 0, 0])
      part(knee, box, kit.dark, [0.55, SHIN, 0.62], [0, -SHIN / 2, 0])
      part(knee, box, armor, [0.66, SHIN * 0.6, 0.26], [0, -SHIN * 0.42, 0.34])
      part(knee, cyl6, kit.metal, [0.12, SHIN * 0.8, 0.12], [0, -SHIN * 0.5, -0.38])
      const ankle = new Group()
      ankle.position.y = -SHIN
      knee.add(ankle)
      part(ankle, cyl, kit.metal, [0.48, 0.6, 0.48], [0, 0, 0], [0, 0, Math.PI / 2])
      part(ankle, box, kit.dark, [1.15, 0.3, 1.5], [0, -0.28, 0.3])
      part(ankle, box, armor, [0.95, 0.22, 1.0], [0, -0.08, 0.3])
      for (const x of [-0.35, 0.35]) part(ankle, box, kit.dark, [0.3, 0.24, 0.7], [x, -0.32, 1.25], [0.15, 0, 0])
      part(ankle, box, kit.dark, [0.34, 0.24, 0.6], [0, -0.32, -0.6], [-0.2, 0, 0])
      this.legs.push({ hip, knee, ankle })

      // 腰後的支架：收著時貼在背後朝上，架砲時往後外側撐到地上
      const strut = new Group()
      strut.position.set(s * 0.7, 0, -0.65)
      this.hips.add(strut)
      part(strut, cyl, kit.metal, [0.42, 0.42, 0.42], [0, 0, 0], [0, 0, Math.PI / 2])
      part(strut, box, trim, [0.3, 0.3, 2.3], [0, 0, -1.15])
      part(strut, box, kit.dark, [0.6, 0.2, 0.75], [0, -0.1, -2.3])
      this.struts.push(strut)
    }

    // 上半身：矮胖的主體、前面的感測頭（發光的大鏡頭）、背上的彈藥箱
    this.torso.position.y = HIP_Y + TORSO_Y
    this.root.add(this.torso)
    part(this.torso, box, armor, [2.4, 1.35, 2.0], [0, 0.7, 0])
    part(this.torso, box, armor, [2.0, 0.8, 0.9], [0, 0.6, 1.25], [0.35, 0, 0])
    part(this.torso, box, trim, [2.5, 0.28, 2.1], [0, 1.42, -0.05])
    part(this.torso, box, kit.dark, [1.0, 0.6, 0.7], [0, 1.2, 1.0])
    part(this.torso, cyl, kit.dark, [0.62, 0.3, 0.62], [0, 1.22, 1.38], [Math.PI / 2, 0, 0])
    part(this.torso, kit.geo.disc, glow, [0.48, 0.48, 0.48], [0, 1.22, 1.54])
    part(this.torso, box, trim, [2.1, 1.5, 1.25], [0, 0.95, -1.5])
    // 彈藥箱側面一排砲彈
    for (const s of [-1, 1]) {
      for (const z of [-1.85, -1.5, -1.15]) part(this.torso, cyl, kit.missile, [0.26, 0.9, 0.26], [s * 1.12, 0.95, z])
    }
    part(this.torso, cyl6, kit.metal, [0.06, 1.4, 0.06], [0.7, 2.1, -0.4], [-0.25, 0, 0.1])

    // 左肩的飛彈艙：兩發，射掉就看不到彈頭
    const pod = new Group()
    pod.position.set(-1.45, 1.25, 0.15)
    this.torso.add(pod)
    part(pod, box, trim, [0.75, 0.62, 1.2], [0, 0, 0])
    part(pod, box, kit.dark, [0.65, 0.5, 0.08], [0, 0, 0.62])
    for (const y of [-0.13, 0.13]) {
      this.missiles.push(part(pod, cone, kit.missile, [0.2, 0.42, 0.2], [0, y, 0.65], [-Math.PI / 2, 0, 0]))
    }
    this.pod = pod

    // 迫擊砲：軸心在彈藥箱上面；砲管（開砲往後縮）上有補強環和砲口
    this.cradle.position.set(0, PIVOT.y, PIVOT.z)
    this.torso.add(this.cradle)
    part(this.cradle, box, kit.dark, [1.2, 0.4, 0.9], [0, -0.2, 0])
    for (const s of [-1, 1]) part(this.cradle, box, trim, [0.2, 0.8, 0.8], [s * 0.62, 0, 0])
    this.cradle.add(this.tube)
    part(this.tube, cyl, kit.metal, [0.5, 0.95, 0.5], [0, 0, 0], [0, 0, Math.PI / 2])
    this.tube.add(this.barrel)
    part(this.barrel, cyl, kit.dark, [1.05, 0.9, 1.05], [0, 0, 0.05], [Math.PI / 2, 0, 0])
    part(this.barrel, cyl, armor, [0.78, TUBE - 0.4, 0.78], [0, 0, TUBE / 2], [Math.PI / 2, 0, 0])
    for (const z of [1.1, 2.3]) part(this.barrel, cyl, trim, [0.95, 0.22, 0.95], [0, 0, z], [Math.PI / 2, 0, 0])
    part(this.barrel, cyl, kit.dark, [1.0, 0.45, 1.0], [0, 0, TUBE - 0.15], [Math.PI / 2, 0, 0])
    const tubeMuzzle = new Group()
    tubeMuzzle.position.z = TUBE + 0.2
    this.barrel.add(tubeMuzzle)
    this.tubeMuzzle = tubeMuzzle

    // 右手：卡賓槍
    this.arm.position.set(1.55, 0.85, 0.2)
    this.torso.add(this.arm)
    part(this.arm, cyl, kit.metal, [0.62, 0.42, 0.62], [0, 0, 0], [0, 0, Math.PI / 2])
    part(this.arm, box, armor, [0.8, 0.85, 1.1], [0.18, 0.05, 0])
    part(this.arm, box, kit.dark, [0.45, 0.55, 1.1], [0.22, -0.45, 0.45])
    this.carbine.position.set(0.22, -0.6, 0.9)
    this.arm.add(this.carbine)
    part(this.carbine, box, trim, [0.45, 0.5, 1.5], [0, 0, 0.35])
    part(this.carbine, box, kit.dark, [0.25, 0.55, 0.35], [0, -0.42, 0.2])
    part(this.carbine, cyl, kit.metal, [0.15, 1.3, 0.15], [0, 0.05, 1.7], [Math.PI / 2, 0, 0])
    part(this.carbine, box, glow, [0.1, 0.08, 0.5], [0, 0.29, 0.3])
    const gunMuzzle = new Group()
    gunMuzzle.position.set(0, 0.05, 2.4)
    this.carbine.add(gunMuzzle)
    this.gunMuzzle = gunMuzzle
  }

  fire(_side: number) {
    if (this.k > 0.5) this.tubeRecoil = 1
    else this.gunRecoil = 1
  }

  /** 槍口：架好砲是砲口，不然是右手的卡賓槍 */
  muzzle(_side: number, out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return (this.k > 0.5 ? this.tubeMuzzle : this.gunMuzzle).getWorldPosition(out)
  }

  podPosition(out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return this.pod.getWorldPosition(out)
  }

  pose(b: MechBody, _firing: boolean, dt: number) {
    this.root.position.set(b.x, b.y, b.z)
    this.root.rotation.y = b.legs
    this.placeShadow(b, 5.4)
    this.k = b.deploy
    const k = ease(b.deploy)

    const speed = Math.hypot(b.vx, b.vz)
    this.lean += ((b.boosting && speed > 1.5 ? 1 : 0) - this.lean) * Math.min(1, dt * 6)
    this.air += ((b.onGround ? 0 : 1) - this.air) * Math.min(1, dt * 8)
    const walking = b.onGround ? clamp(speed / SPEC.walk, 0, 1.6) * (1 - k) : 0
    const bob = Math.abs(Math.sin(b.stride)) * 0.12 * Math.min(walking, 1)
    const hipY = HIP_Y - k * KNEEL - this.lean * 0.3 - b.landed * 0.4 + bob
    this.hips.position.y = hipY
    this.torso.position.y = hipY + TORSO_Y
    this.torso.rotation.set(this.lean * 0.15, wrapAngle(b.aimYaw - b.legs), 0, 'YXZ')

    // 腿：兩節的反向運動學，膝蓋往後彎，腳掌保持水平；跪下時腳掌往前放一點
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i]
      const phase = b.stride + (i === 0 ? 0 : Math.PI)
      const swing = Math.sin(phase) * 0.75 * walking
      const lift = Math.max(0, Math.cos(phase)) * 0.55 * Math.min(walking, 1.2)
      const fz = swing + 0.1 + k * 0.5
      const fy = -(hipY - ANKLE_Y) + lift + this.air * 0.6
      const d = clamp(Math.hypot(fz, fy), 0.5, THIGH + SHIN - 0.02)
      const phi = Math.atan2(fz, -fy)
      const a = Math.acos(clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1))
      const c = Math.acos(clamp((SHIN * SHIN + d * d - THIGH * THIGH) / (2 * SHIN * d), -1, 1))
      leg.hip.rotation.set(-(phi - a), 0, (i === 0 ? -1 : 1) * 0.12 * k)
      leg.knee.rotation.x = -(a + c)
      leg.ankle.rotation.set(phi + c, 0, (i === 0 ? 1 : -1) * 0.12 * k)
    }
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1
      this.struts[i].rotation.set(lerp(1.3, -0.72, k), s * -0.5 * k, 0, 'YXZ')
    }

    // 砲管：從背後往上翻到前面，仰角照瞄準的仰角；開砲時往後縮、慢慢回來
    this.tubeRecoil = Math.max(0, this.tubeRecoil - dt * 1.6)
    this.tube.rotation.x = lerp(STOW, -clamp(b.aimPitch, SHELL.elevMin, SHELL.elevMax), k)
    this.barrel.position.z = -this.tubeRecoil * this.tubeRecoil * 0.8

    // 右手的卡賓槍：平常跟著仰角，架砲時垂下來
    this.gunRecoil = Math.max(0, this.gunRecoil - dt * 9)
    this.arm.rotation.x = lerp(-b.aimPitch * 0.85, 0.65, k)
    this.carbine.position.z = 0.9 - this.gunRecoil * 0.15
  }
}
