// 堡壘型「要塞」的模型：矮壯的兩條粗腿、方方正正的厚重上半身。平常右手一挺輕機槍、左手扛著摺起來的大盾，
// 背上四門六管重機槍朝天收著（一排）；變身（`MechBody.deploy` 從 0 到 1）時往下蹲、腰後兩支支架往外撐到地上，
// 重機槍翻到肩上朝前（左右各兩門並排，輪流開火），大盾移到正前方立在地上、兩片側翼張開
// （盾牌的大小、位置照 `spec.ts` 的 `deploy.shield`，和擋子彈的範圍一樣）。
// 上半身、盾牌和重機槍跟著瞄準轉；腿用兩節的反向運動學擺，腳掌踩在地上。
import { Group, type Mesh, type Object3D, type Vector3 } from 'three'
import type { Team } from './map'
import { part, Rig, type MechKit } from './mech'
import { clamp, wrapAngle, type MechBody } from './physics'
import { ease, MECHS } from './spec'

const SPEC = MECHS.fortress
const SHIELD = SPEC.deploy!.shield!
/** 髖關節離地多高、大腿和小腿多長、腳踝離地多高；變身時往下蹲多少 */
const HIP_Y = 2.75
const THIGH = 1.45
const SHIN = 1.55
const ANKLE_Y = 0.55
const SQUAT = SPEC.deploy!.drop
/** 上半身的軸心在髖關節上面多高 */
const TORSO_Y = 0.5
/**
 * 四門重機槍收著（背上朝天）和變身後（肩上朝前）的位置（上半身座標）：`side` 是哪一邊，`inner` 是靠裡面的那一門。
 * 照開火的順序排：左右輪流，先裡面兩門、再外面兩門
 */
const GUNS = [
  { side: -1, inner: true },
  { side: 1, inner: true },
  { side: -1, inner: false },
  { side: 1, inner: false },
]
const GUN_STOW = { inner: 0.52, outer: 1.5, y: 1.75, z: -1.45 }
const GUN_UP = { inner: 1.45, outer: 2.45, y: 2.42, z: 0.15 }
/** 大盾扛在左手時的位置、大小（上半身座標） */
const SHIELD_ARM = { x: -2.35, y: 1.05, z: 1.0, scale: 0.6 }
/** 盾牌中間那片的寬，兩邊側翼的寬和張開的角度 */
const PANEL_W = 3.4
const WING_W = (SHIELD.width - PANEL_W) / 2 / Math.cos(0.42)
const WING_OPEN = 0.42

type Leg = { hip: Group; knee: Group; ankle: Group }

const lerp = (a: number, b: number, k: number) => a + (b - a) * k

export class FortressModel extends Rig {
  private readonly hips = new Group()
  private readonly torso = new Group()
  private readonly chest = new Group()
  private readonly legs: Leg[] = []
  private readonly struts: Group[] = []
  private readonly mounts: Group[] = []
  private readonly spinners: Group[] = []
  private readonly gunMuzzles: Object3D[] = []
  private readonly arm = new Group()
  private readonly shieldArm = new Group()
  private readonly shield = new Group()
  private readonly wings: Group[] = []
  private readonly lmgMuzzle: Object3D
  private readonly lmg = new Group()
  private readonly pod: Object3D
  private readonly lights: Mesh[] = []
  /** 變身的進度（`pose` 記下來，`muzzle` 照這個決定從哪一把槍出來） */
  private k = 0
  /** 每一門重機槍開火後退的量；`barrel` 是剛開火的那一門（`fire` 換下一門，`muzzle` 回它的槍口） */
  private recoil = GUNS.map(() => 0)
  private barrel = 0
  private lmgRecoil = 0
  private spin = 0
  private spinSpeed = 0
  private lean = 0
  private air = 0

  constructor(kit: MechKit, team: Team) {
    super(kit, team, 6.4)
    const armor = kit.armor[team]
    const trim = kit.trim[team]
    const glow = kit.glow[team]
    const { box, cyl, cyl6 } = kit.geo

    // 骨盆：兩條腿和腰後的支架掛在這裡
    this.hips.position.y = HIP_Y
    this.root.add(this.hips)
    part(this.hips, box, kit.dark, [2, 0.9, 1.5], [0, 0, 0])
    part(this.hips, box, trim, [2.5, 0.4, 1.3], [0, -0.25, 0.1])
    part(this.hips, box, armor, [1.4, 0.7, 0.4], [0, -0.1, 0.85], [0.2, 0, 0])

    for (const s of [-1, 1]) {
      const hip = new Group()
      hip.position.set(s * 1.3, 0, 0)
      this.hips.add(hip)
      part(hip, cyl, kit.metal, [0.85, 0.7, 0.85], [0, 0, 0], [0, 0, Math.PI / 2])
      part(hip, box, armor, [1.0, THIGH, 1.1], [0, -THIGH / 2, 0])
      part(hip, box, trim, [1.1, 0.5, 1.2], [0, -0.3, 0.02])
      const knee = new Group()
      knee.position.y = -THIGH
      hip.add(knee)
      part(knee, cyl, kit.metal, [0.78, 0.86, 0.78], [0, 0, 0], [0, 0, Math.PI / 2])
      // 膝蓋的護甲往前凸
      part(knee, box, armor, [1.0, 0.85, 0.55], [0, 0.05, 0.55], [-0.25, 0, 0])
      part(knee, box, kit.dark, [0.82, SHIN, 0.95], [0, -SHIN / 2, 0])
      part(knee, box, armor, [1.05, SHIN * 0.72, 0.38], [0, -SHIN * 0.45, 0.48])
      part(knee, cyl6, kit.metal, [0.14, SHIN * 0.8, 0.14], [0, -SHIN * 0.5, -0.5])
      const ankle = new Group()
      ankle.position.y = -SHIN
      knee.add(ankle)
      part(ankle, cyl, kit.metal, [0.6, 0.75, 0.6], [0, 0, 0], [0, 0, Math.PI / 2])
      // 大腳掌：前寬後窄
      part(ankle, box, kit.dark, [1.55, 0.42, 2.2], [0, -0.34, 0.25])
      part(ankle, box, armor, [1.35, 0.3, 1.5], [0, -0.06, 0.35])
      part(ankle, box, kit.dark, [1.6, 0.3, 0.5], [0, -0.4, 1.35], [0.25, 0, 0])
      this.legs.push({ hip, knee, ankle })

      // 腰後的支架：收著時貼在背後朝上，變身時往後外側撐到地上
      const strut = new Group()
      strut.position.set(s * 0.85, -0.05, -0.75)
      this.hips.add(strut)
      part(strut, cyl, kit.metal, [0.5, 0.5, 0.5], [0, 0, 0], [0, 0, Math.PI / 2])
      part(strut, box, trim, [0.38, 0.38, 2.5], [0, 0, -1.25])
      part(strut, cyl6, kit.metal, [0.16, 2, 0.16], [0, 0.22, -1.1], [Math.PI / 2, 0, 0])
      part(strut, box, kit.dark, [0.75, 0.22, 0.9], [0, -0.12, -2.5])
      this.struts.push(strut)
    }

    // 上半身：方方正正的厚重主體，前面斜的裝甲、駕駛艙的觀測窗、背上的散熱片
    this.torso.position.y = HIP_Y + TORSO_Y
    this.root.add(this.torso)
    this.torso.add(this.chest)
    part(this.chest, box, armor, [3.2, 1.95, 2.8], [0, 1, -0.1])
    part(this.chest, box, armor, [2.8, 1.15, 1.25], [0, 0.85, 1.45], [0.42, 0, 0])
    part(this.chest, box, trim, [3.3, 0.32, 2.9], [0, 2.05, -0.15])
    part(this.chest, box, trim, [3.0, 0.45, 1.1], [0, 0.18, 1.2], [-0.12, 0, 0])
    part(this.chest, box, kit.dark, [1.7, 0.42, 0.2], [0, 1.35, 1.82], [0.42, 0, 0])
    this.lights.push(part(this.chest, box, glow, [1.3, 0.12, 0.06], [0, 1.38, 1.93], [0.42, 0, 0]))
    for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) part(this.chest, box, kit.dark, [0.14, 0.28, 1.3], [x, 2.3, -0.75])
    for (const s of [-1, 1]) part(this.chest, box, kit.dark, [0.18, 0.75, 1.3], [s * 1.62, 0.95, 0.35])
    part(this.chest, cyl6, kit.metal, [0.07, 1.7, 0.07], [-1.15, 2.9, -1.1], [-0.3, 0, -0.1])

    // 上面的飛彈艙：兩發，射掉就看不到彈頭
    const pod = new Group()
    pod.position.set(0, 2.45, 0.55)
    this.chest.add(pod)
    part(pod, box, trim, [1.15, 0.55, 1.1], [0, 0, 0])
    part(pod, box, kit.dark, [1.0, 0.42, 0.08], [0, 0, 0.56])
    for (const x of [-0.25, 0.25]) {
      this.missiles.push(part(pod, kit.geo.cone, kit.missile, [0.24, 0.48, 0.24], [x, 0, 0.6], [-Math.PI / 2, 0, 0]))
    }
    this.pod = pod

    // 四門六管重機槍：收著時在背上朝天排成一排，變身時翻到肩上朝前（左右各兩門並排）；彈鼓掛在裡面那一門旁邊
    for (const { side: s, inner } of GUNS) {
      const mount = new Group()
      this.torso.add(mount)
      part(mount, cyl, kit.metal, [0.7, 0.6, 0.7], [0, 0, 0], [0, 0, Math.PI / 2])
      part(mount, box, trim, [0.95, 0.95, 1.5], [0, 0, 0.35])
      if (inner) {
        part(mount, box, kit.dark, [0.6, 0.55, 0.9], [-s * 0.6, -0.1, 0.2])
        part(mount, cyl, kit.dark, [0.7, 0.4, 0.7], [-s * 0.6, -0.15, -0.35], [Math.PI / 2, 0, 0])
      } else {
        // 外面那一門：外側一片護板
        part(mount, box, armor, [0.14, 0.8, 1.3], [s * 0.54, 0, 0.4])
      }
      const spinner = new Group()
      spinner.position.z = 1.1
      mount.add(spinner)
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        part(spinner, cyl, kit.metal, [0.15, 2.3, 0.15], [Math.cos(a) * 0.24, Math.sin(a) * 0.24, 1.15], [Math.PI / 2, 0, 0])
      }
      part(spinner, cyl, kit.dark, [0.68, 0.3, 0.68], [0, 0, 0.2], [Math.PI / 2, 0, 0])
      part(spinner, cyl, kit.dark, [0.62, 0.18, 0.62], [0, 0, 2.05], [Math.PI / 2, 0, 0])
      const muzzle = new Group()
      muzzle.position.z = 3.5
      mount.add(muzzle)
      this.mounts.push(mount)
      this.spinners.push(spinner)
      this.gunMuzzles.push(muzzle)
    }

    // 右手：輕機槍（一般模式的主武器）
    this.arm.position.set(1.95, 1.05, 0.25)
    this.torso.add(this.arm)
    part(this.arm, cyl, kit.metal, [0.75, 0.5, 0.75], [0, 0, 0], [0, 0, Math.PI / 2])
    part(this.arm, box, armor, [1.05, 1.1, 1.35], [0.25, 0.1, 0])
    part(this.arm, box, kit.dark, [0.6, 0.7, 1.3], [0.3, -0.55, 0.55])
    this.lmg.position.set(0.3, -0.75, 1.0)
    this.arm.add(this.lmg)
    part(this.lmg, box, trim, [0.62, 0.62, 1.7], [0, 0, 0.4])
    part(this.lmg, box, kit.dark, [0.4, 0.75, 0.55], [0, -0.55, 0.3])
    part(this.lmg, cyl, kit.metal, [0.2, 1.5, 0.2], [0, 0.05, 1.9], [Math.PI / 2, 0, 0])
    part(this.lmg, cyl, kit.dark, [0.34, 0.4, 0.34], [0, 0.05, 2.55], [Math.PI / 2, 0, 0])
    const lmgMuzzle = new Group()
    lmgMuzzle.position.set(0, 0.05, 2.85)
    this.lmg.add(lmgMuzzle)
    this.lmgMuzzle = lmgMuzzle

    // 左手：扛著大盾；變身時大盾離開手臂，移到正前方
    this.shieldArm.position.set(-1.95, 1.05, 0.25)
    this.torso.add(this.shieldArm)
    part(this.shieldArm, cyl, kit.metal, [0.75, 0.5, 0.75], [0, 0, 0], [0, 0, Math.PI / 2])
    part(this.shieldArm, box, armor, [1.05, 1.1, 1.35], [-0.25, 0.1, 0])
    part(this.shieldArm, box, kit.dark, [0.6, 0.7, 1.4], [-0.3, -0.55, 0.6])

    // 大盾：中間一片、兩邊各一片側翼（收著時摺到中間那片後面），正面有隊伍顏色的燈條和觀測縫
    this.torso.add(this.shield)
    const h = SHIELD.height
    part(this.shield, box, armor, [PANEL_W, h, 0.4], [0, 0, 0])
    part(this.shield, box, trim, [PANEL_W + 0.1, 0.35, 0.5], [0, h / 2 - 0.18, 0])
    part(this.shield, box, trim, [PANEL_W + 0.1, 0.4, 0.5], [0, -h / 2 + 0.2, 0])
    part(this.shield, box, kit.dark, [1.6, 0.18, 0.1], [0, h * 0.28, 0.22])
    this.lights.push(part(this.shield, box, glow, [PANEL_W * 0.8, 0.1, 0.06], [0, -h * 0.22, 0.23]))
    for (const x of [-1.1, 1.1]) part(this.shield, box, kit.dark, [0.16, h * 0.7, 0.1], [x, -0.1, 0.22])
    // 底下插進地裡的爪
    for (const x of [-1.2, 0, 1.2]) part(this.shield, box, kit.dark, [0.5, 0.5, 0.35], [x, -h / 2 - 0.1, 0.1], [0.4, 0, 0])
    for (const s of [-1, 1]) {
      const wing = new Group()
      wing.position.set((s * PANEL_W) / 2, 0, 0)
      this.shield.add(wing)
      part(wing, cyl, kit.metal, [0.3, h * 0.9, 0.3], [0, 0, 0])
      part(wing, box, armor, [WING_W, h * 0.92, 0.32], [(s * WING_W) / 2, -h * 0.02, 0])
      part(wing, box, trim, [WING_W, 0.3, 0.42], [(s * WING_W) / 2, h * 0.42, 0])
      part(wing, box, kit.dark, [0.14, h * 0.6, 0.1], [s * WING_W * 0.55, 0, 0.18])
      this.wings.push(wing)
    }
    // 變身時大搬家的：重機槍從背上翻到肩上、盾從手上移到正前方張開、支架撐到地上
    this.shield.userData.solo = true
    for (const m of this.mounts) m.userData.solo = true
    for (const s of this.struts) s.userData.solo = true
    this.finish(kit, 'fortress')
  }

  /** 開一發：變身了是四門重機槍輪流（不看 `side`，自己記輪到哪一門） */
  fire(_side: number) {
    if (this.k > 0.5) {
      this.barrel = (this.barrel + 1) % GUNS.length
      this.recoil[this.barrel] = 1
      this.spinSpeed = 40
    } else this.lmgRecoil = 1
  }

  /** 槍口：變身了是剛開火的那一門重機槍，不然是右手的輕機槍 */
  muzzle(_side: number, out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return (this.k > 0.5 ? this.gunMuzzles[this.barrel] : this.lmgMuzzle).getWorldPosition(out)
  }

  podPosition(out: Vector3): Vector3 {
    this.root.updateMatrixWorld()
    return this.pod.getWorldPosition(out)
  }

  pose(b: MechBody, firing: boolean, dt: number) {
    this.root.position.set(b.x, b.y, b.z)
    this.root.rotation.y = b.legs
    this.placeShadow(b, 6.4)
    this.k = b.deploy
    const k = ease(b.deploy)

    const speed = Math.hypot(b.vx, b.vz)
    this.lean += ((b.boosting && speed > 1.5 ? 1 : 0) - this.lean) * Math.min(1, dt * 6)
    this.air += ((b.onGround ? 0 : 1) - this.air) * Math.min(1, dt * 8)
    const walking = b.onGround ? clamp(speed / SPEC.walk, 0, 1.6) * (1 - k) : 0
    const bob = Math.abs(Math.sin(b.stride)) * 0.1 * Math.min(walking, 1)
    const hipY = HIP_Y - k * SQUAT - this.lean * 0.25 - b.landed * 0.4 + bob
    this.hips.position.y = hipY
    this.torso.position.y = hipY + TORSO_Y
    this.torso.rotation.y = wrapAngle(b.aimYaw - b.legs)
    // 快跑時上半身往前壓一點；平常微微跟著仰角
    this.chest.rotation.x = this.lean * 0.12 - b.aimPitch * 0.15 * (1 - k)

    // 腿：腳掌要踩的地方（髖關節座標），兩節的反向運動學，膝蓋往前彎，腳掌保持水平；變身時腳往外撐開
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i]
      const phase = b.stride + (i === 0 ? 0 : Math.PI)
      const swing = Math.sin(phase) * 0.7 * walking
      const lift = Math.max(0, Math.cos(phase)) * 0.5 * Math.min(walking, 1.2)
      const fz = swing + 0.15
      const fy = -(hipY - ANKLE_Y) + lift + this.air * 0.5
      const d = clamp(Math.hypot(fz, fy), 0.6, THIGH + SHIN - 0.02)
      const phi = Math.atan2(fz, -fy)
      const a = Math.acos(clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1))
      const c = Math.acos(clamp((SHIN * SHIN + d * d - THIGH * THIGH) / (2 * SHIN * d), -1, 1))
      leg.hip.rotation.set(-(phi + a), 0, (i === 0 ? -1 : 1) * 0.16 * k)
      leg.knee.rotation.x = a + c
      leg.ankle.rotation.set(phi - c, 0, (i === 0 ? 1 : -1) * 0.16 * k)
    }
    // 腰後的支架：收著時朝上，變身時往後外側撐到地上
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1
      this.struts[i].rotation.set(lerp(1.3, -0.72, k), s * -0.55 * k, 0, 'YXZ')
    }

    // 重機槍：從背上朝天翻到肩上朝前，變身好了跟著仰角
    const aim = -clamp(b.aimPitch, -0.4, 0.8)
    for (let i = 0; i < GUNS.length; i++) {
      const { side: s, inner } = GUNS[i]
      const m = this.mounts[i]
      // 先往上抬、再往前移，才不會穿過身體
      const up = Math.sin(k * Math.PI) * 0.6
      const x = inner ? lerp(GUN_STOW.inner, GUN_UP.inner, k) : lerp(GUN_STOW.outer, GUN_UP.outer, k)
      m.position.set(s * x, lerp(GUN_STOW.y, GUN_UP.y, k) + up, lerp(GUN_STOW.z, GUN_UP.z, k))
      this.recoil[i] = Math.max(0, this.recoil[i] - dt * 10)
      m.rotation.x = lerp(-1.65, aim, k)
      m.position.z -= this.recoil[i] * 0.12
    }
    this.spinSpeed = firing && this.k > 0.5 ? 40 : this.spinSpeed * Math.exp(-2 * dt)
    this.spin += this.spinSpeed * dt
    for (const sp of this.spinners) sp.rotation.z = this.spin

    // 右手的輕機槍：平常跟著仰角，變身時垂下來
    this.lmgRecoil = Math.max(0, this.lmgRecoil - dt * 9)
    this.arm.rotation.x = lerp(-b.aimPitch * 0.85, 0.7, k)
    this.lmg.position.z = 1.0 - this.lmgRecoil * 0.2
    // 左手：平常抬著盾，變身時放下
    this.shieldArm.rotation.x = lerp(-0.15, 0.55, k)

    // 大盾：從左手移到正前方、立在地上（底邊貼地），側翼張開
    const h = SHIELD.height
    const torsoY = hipY + TORSO_Y
    const sc = lerp(SHIELD_ARM.scale, 1, k)
    this.shield.scale.setScalar(sc)
    this.shield.position.set(
      lerp(SHIELD_ARM.x, 0, k),
      lerp(SHIELD_ARM.y, h / 2 + 0.05 - torsoY, k),
      lerp(SHIELD_ARM.z, SHIELD.dist, k),
    )
    this.shield.rotation.y = lerp(0.12, 0, k)
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1
      // 收著：摺到中間那片後面；張開：往後斜一點，像一道弧形的牆
      this.wings[i].rotation.y = lerp(s * (Math.PI - 0.1), s * WING_OPEN, clamp(k * 1.4 - 0.2, 0, 1))
    }
  }
}
