// 偵察型「渡鴉」的模型：兩條反關節的長腿撐著一個駕駛艙（像一隻鳥），前面一顆大的發光鏡頭，
// 頂上轉個不停的雷達盤，右邊掛一把長的脈衝步槍、左邊是飛彈艙，背上的架子掛兩架偵察機（放出去、用掉就看不到）。
// 駕駛艙跟著瞄準轉、步槍跟著仰角抬；腿照走路的相位擺（膝蓋往後彎），快跑時壓低、步子跨大，在空中縮腳。
import { Group, type Object3D, type Vector3 } from 'three'
import type { Team } from './map'
import { part, Rig, type MechKit } from './mech'
import { clamp, wrapAngle, type MechBody } from './physics'
import { MECHS } from './spec'

/** 髖關節離地多高、大腿和小腿多長 */
const HIP_Y = 3.75
const THIGH = 1.9
const SHIN = 2.2
/** 駕駛艙的軸心在髖關節上面多高 */
const CAB_Y = 0.35
/** 步槍畫出來的仰角範圍 */
const GUN_MIN = -0.6
const GUN_MAX = 0.9

type Leg = { hip: Group; knee: Group; ankle: Group }

export class ReconModel extends Rig {
  private readonly hips = new Group()
  private readonly cab = new Group()
  private readonly gun = new Group()
  private readonly barrel = new Group()
  private readonly dish = new Group()
  private readonly legs: Leg[] = []
  private readonly racked: Group[] = []
  private readonly muzzlePoint: Object3D
  private readonly pod: Object3D
  private readonly launcher: Object3D
  private recoil = 0
  private lean = 0
  private air = 0
  private scan = 0
  /** 偵察機在外面飛（雷達轉快一點） */
  flying = false

  constructor(kit: MechKit, team: Team) {
    super(kit, team, 4.6)
    const armor = kit.armor[team]
    const trim = kit.trim[team]
    const glow = kit.glow[team]
    const { box, cyl, cyl6, cone, disc } = kit.geo

    // 骨盆：兩條腿掛在這裡
    this.hips.position.y = HIP_Y
    this.root.add(this.hips)
    part(this.hips, box, kit.dark, [1.3, 0.6, 1.0], [0, 0, 0])
    part(this.hips, box, trim, [1.5, 0.3, 0.8], [0, 0.2, -0.05])

    for (const s of [-1, 1]) {
      const hip = new Group()
      hip.position.set(s * 0.85, 0, 0)
      this.hips.add(hip)
      part(hip, cyl, kit.metal, [0.6, 0.45, 0.6], [0, 0, 0], [0, 0, Math.PI / 2])
      // 大腿：往後下方
      part(hip, box, armor, [0.5, THIGH, 0.68], [0, -THIGH / 2, 0])
      part(hip, box, trim, [0.56, THIGH * 0.5, 0.74], [0, -THIGH * 0.32, 0.02])
      const knee = new Group()
      knee.position.y = -THIGH
      hip.add(knee)
      part(knee, cyl, kit.metal, [0.5, 0.56, 0.5], [0, 0, 0], [0, 0, Math.PI / 2])
      // 膝蓋往後凸
      part(knee, box, armor, [0.6, 0.55, 0.5], [0, 0.05, -0.28], [0.3, 0, 0])
      // 小腿：往前下方，前面一塊護甲、後面一根液壓桿
      part(knee, box, kit.dark, [0.36, SHIN, 0.42], [0, -SHIN / 2, 0])
      part(knee, box, armor, [0.44, SHIN * 0.6, 0.2], [0, -SHIN * 0.42, 0.24])
      part(knee, cyl6, kit.metal, [0.1, SHIN * 0.8, 0.1], [0, -SHIN * 0.5, -0.3])
      const ankle = new Group()
      ankle.position.y = -SHIN
      knee.add(ankle)
      part(ankle, cyl, kit.metal, [0.38, 0.46, 0.38], [0, 0, 0], [0, 0, Math.PI / 2])
      // 腳掌：往前三根爪、往後一根
      part(ankle, box, kit.dark, [0.85, 0.24, 1.15], [0, -0.16, 0.25])
      part(ankle, box, armor, [0.7, 0.18, 0.7], [0, 0.02, 0.2])
      for (const x of [-0.3, 0, 0.3]) part(ankle, box, kit.dark, [0.18, 0.18, 0.6], [x, -0.2, 0.98], [0.12, x * 0.4, 0])
      part(ankle, box, kit.dark, [0.2, 0.18, 0.5], [0, -0.2, -0.5], [-0.15, 0, 0])
      this.legs.push({ hip, knee, ankle })
    }

    // 駕駛艙：跟著瞄準轉
    this.cab.position.y = HIP_Y + CAB_Y
    this.root.add(this.cab)
    part(this.cab, box, kit.dark, [1.4, 0.5, 1.3], [0, 0, 0])
    part(this.cab, box, armor, [2.2, 1.25, 2.5], [0, 0.85, -0.1])
    part(this.cab, box, armor, [1.8, 0.8, 1.05], [0, 0.72, 1.45], [0.5, 0, 0])
    part(this.cab, box, trim, [2.3, 0.2, 2.4], [0, 1.55, -0.15])
    part(this.cab, box, trim, [2.3, 0.35, 0.5], [0, 0.25, 1.05])
    // 大鏡頭（朝前）和兩邊的小鏡頭
    part(this.cab, cyl, kit.metal, [0.82, 0.3, 0.82], [0, 0.95, 1.72], [Math.PI / 2, 0, 0])
    part(this.cab, cyl, kit.dark, [0.62, 0.12, 0.62], [0, 0.95, 1.9], [Math.PI / 2, 0, 0])
    part(this.cab, disc, glow, [0.48, 0.48, 0.48], [0, 0.95, 1.97])
    for (const s of [-1, 1]) part(this.cab, disc, glow, [0.18, 0.18, 0.18], [s * 0.62, 1.15, 1.72])
    // 側面的散熱片
    for (const s of [-1, 1]) for (const y of [0.55, 0.85, 1.15]) part(this.cab, box, kit.dark, [0.08, 0.14, 1.1], [s * 1.12, y, -0.4])
    // 天線
    part(this.cab, cyl6, kit.metal, [0.05, 1.7, 0.05], [-0.85, 2.35, -1.0], [-0.2, 0, -0.1])
    part(this.cab, cyl6, kit.metal, [0.04, 1.1, 0.04], [-0.65, 2.05, -1.1], [-0.35, 0, 0.1])

    // 頂上的雷達盤：一根桿子撐著，斜斜的盤子一直轉
    part(this.cab, cyl6, kit.metal, [0.16, 0.8, 0.16], [0.35, 1.95, -0.6])
    this.dish.position.set(0.35, 2.4, -0.6)
    this.cab.add(this.dish)
    part(this.dish, cyl, trim, [1.6, 0.12, 1.6], [0, 0.15, 0.1], [-1.1, 0, 0])
    part(this.dish, cyl, kit.dark, [1.3, 0.1, 1.3], [0, 0.2, 0.05], [-1.1, 0, 0])
    part(this.dish, cyl6, kit.metal, [0.06, 0.7, 0.06], [0, 0.4, 0.45], [-1.1, 0, 0])
    part(this.dish, box, glow, [0.14, 0.14, 0.14], [0, 0.52, 0.72])

    // 背上的架子和兩架偵察機（機身直立貼著架子）
    part(this.cab, box, kit.dark, [1.9, 1.0, 0.35], [0, 0.85, -1.5])
    part(this.cab, box, trim, [2.0, 0.18, 0.5], [0, 1.4, -1.55])
    for (const x of [-0.5, 0.5]) {
      const d = new Group()
      d.position.set(x, 0.85, -1.85)
      d.rotation.x = Math.PI / 2
      this.cab.add(d)
      part(d, box, armor, [0.6, 0.2, 0.7], [0, 0, 0])
      part(d, disc, glow, [0.16, 0.16, 0.16], [0, 0, 0.36])
      for (const [a, b] of [
        [-1, 1],
        [1, 1],
        [-1, -1],
        [1, -1],
      ]) {
        part(d, cyl, kit.metal, [0.12, 0.12, 0.12], [a * 0.42, 0.06, b * 0.42])
        part(d, box, kit.dark, [0.5, 0.02, 0.06], [a * 0.42, 0.13, b * 0.42])
      }
      this.racked.push(d)
    }
    // 偵察機放出去的地方（架子後上方）
    this.launcher = new Group()
    this.launcher.position.set(0, 1.9, -2.2)
    this.cab.add(this.launcher)

    // 左邊的飛彈艙：兩發
    const pod = new Group()
    pod.position.set(-1.4, 0.95, 0.15)
    this.cab.add(pod)
    part(pod, box, trim, [0.6, 0.85, 1.3], [0, 0, 0])
    part(pod, box, kit.dark, [0.5, 0.75, 0.1], [0, 0, 0.66])
    for (const y of [-0.2, 0.2]) {
      const m = part(pod, cone, kit.missile, [0.22, 0.45, 0.22], [0, y, 0.72], [-Math.PI / 2, 0, 0])
      this.missiles.push(m)
    }
    this.pod = pod

    // 右邊的脈衝步槍：跟著仰角抬，開火時槍管往後退
    this.gun.position.set(1.4, 0.55, 0.35)
    this.cab.add(this.gun)
    part(this.gun, cyl, kit.metal, [0.4, 0.3, 0.4], [-0.2, 0, 0], [0, 0, Math.PI / 2])
    part(this.gun, box, kit.dark, [0.42, 0.55, 1.7], [0, 0, 0.45])
    part(this.gun, box, armor, [0.48, 0.3, 1.2], [0, 0.3, 0.35])
    part(this.gun, box, kit.dark, [0.22, 0.5, 0.35], [0, -0.45, 0.35], [0.2, 0, 0])
    part(this.gun, box, kit.dark, [0.18, 0.2, 0.7], [0, 0.55, 0.6])
    part(this.gun, disc, glow, [0.12, 0.12, 0.12], [0, 0.55, 0.96])
    this.barrel.position.z = 1.3
    this.gun.add(this.barrel)
    part(this.barrel, cyl, kit.metal, [0.18, 2.5, 0.18], [0, 0.05, 1.25], [Math.PI / 2, 0, 0])
    part(this.barrel, cyl, kit.dark, [0.3, 0.5, 0.3], [0, 0.05, 2.45], [Math.PI / 2, 0, 0])
    // 槍管上一圈一圈發光的線圈
    for (const z of [0.5, 0.9, 1.3]) part(this.barrel, cyl, glow, [0.24, 0.06, 0.24], [0, 0.05, z], [Math.PI / 2, 0, 0])
    const muzzle = new Group()
    muzzle.position.set(0, 0.05, 4.1)
    this.gun.add(muzzle)
    this.muzzlePoint = muzzle
    this.finish(kit, 'recon')
  }

  /** 開了一槍：槍管往後退 */
  fire() {
    this.recoil = 1
  }

  /** 只有一把槍：兩邊都是同一個槍口 */
  muzzle(_side: number, out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return this.muzzlePoint.getWorldPosition(out)
  }

  podPosition(out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return this.pod.getWorldPosition(out)
  }

  /** 偵察機放出去的位置 */
  launchPosition(out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return this.launcher.getWorldPosition(out)
  }

  /** 背上還掛著幾架 */
  setDrones(n: number) {
    this.racked.forEach((d, i) => (d.visible = i < n))
  }

  pose(b: MechBody, _firing: boolean, dt: number) {
    this.root.position.set(b.x, b.y, b.z)
    this.root.rotation.y = b.legs
    this.placeShadow(b, 4.6)

    const speed = Math.hypot(b.vx, b.vz)
    this.lean += ((b.boosting && speed > 1.5 ? 1 : 0) - this.lean) * Math.min(1, dt * 6)
    this.air += ((b.onGround ? 0 : 1) - this.air) * Math.min(1, dt * 8)
    // 步子多大：走路最多 1，快跑跨得更大
    const pace = b.onGround ? clamp(speed / MECHS.recon.walk, 0, 1.5) : 0
    const crouch = this.lean * (b.onGround ? 1 : 0)

    // 腿：大腿往後下、小腿往前下（膝蓋在後面），腳掌保持水平
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i]
      const phase = b.stride + (i === 0 ? 0 : Math.PI)
      const swing = Math.sin(phase) * 0.42 * pace
      const lift = Math.max(0, Math.cos(phase)) * 0.5 * Math.min(pace, 1.2)
      const thigh = 0.5 - swing + lift * 0.25 + crouch * 0.3 + this.air * 0.35 + b.landed * 0.3
      const knee = -1.1 - lift - crouch * 0.5 - this.air * 0.55 - b.landed * 0.5
      leg.hip.rotation.x = thigh
      leg.knee.rotation.x = knee
      leg.ankle.rotation.x = -(thigh + knee) - this.air * 0.2
    }
    // 走路時上下晃、快跑時壓低、落地時往下沉
    const bob = Math.abs(Math.sin(b.stride)) * 0.1 * pace
    const drop = crouch * 0.35 + b.landed * 0.45
    this.hips.position.y = HIP_Y - drop + bob
    this.cab.position.y = HIP_Y + CAB_Y - drop + bob

    // 駕駛艙轉向瞄準的方向（相對於腳），稍微跟著仰角點頭；步槍補上剩下的仰角
    const nod = clamp(b.aimPitch, -0.6, 0.9) * 0.2
    this.cab.rotation.set(-nod + this.lean * 0.1, wrapAngle(b.aimYaw - b.legs), 0, 'YXZ')
    this.gun.rotation.x = -clamp(b.aimPitch, GUN_MIN, GUN_MAX) + nod - this.lean * 0.1
    this.recoil = Math.max(0, this.recoil - dt * 7)
    this.barrel.position.z = 1.3 - this.recoil * 0.35

    // 雷達盤：偵察機在外面時轉快一點
    this.scan += dt * (this.flying ? 4 : 1.2)
    this.dish.rotation.y = this.scan
  }
}
