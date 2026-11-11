// 電腦駕駛：在負責開電腦的那個人的瀏覽器裡跑（見 mecha.rs 的 `driver`）。
// 沒看到敵人時沿著路網（map.ts 的 `nodes`）走向最近的敵人；看到了就停下來邊橫移邊打，
// 太近就退、太遠就靠過去，被打時偶爾衝刺或跳起來閃，瞄準夠久就發飛彈。
// 難度決定瞄得多準、反應多快、轉頭多快。電腦知道每台機甲在哪裡（不用找），但要看得到才會開火。
// 偵察型的電腦一陣子沒看到敵人時放偵察機出去：飛高越過大樓、到了上空再俯衝下去引爆（順便幫隊友標記鏡頭前面的敵人）。
// 狙擊型的電腦每條命有機會先爬上自己這一隊的大樓（map.ts 的 `perches`），站在靠河那一邊等敵人過河。
// 堡壘型看到敵人一陣子、距離合適就變身站著打，一陣子沒看到人就收回來繼續走。
// 砲擊型有機會先爬上自己這一隊大樓的屋頂架砲；沒有就往敵人走，看到遠處的敵人、頭上沒東西擋就架砲，照砲彈要飛多久抓提前量，
// 敵人靠太近、太久沒目標就收砲。
// 砲彈的警告圈出現在附近時（`incoming`），照難度決定要不要躲：往落點的反方向跑，變身了就先收回來。
import type { DroneBody, DroneInput } from './drone'
import { findPath, FLOORS, inBase, MAP_Z, nearestNode, RIVER, type MapIndex, type Team } from './map'
import type { Difficulty } from './online'
import { clamp, deployedReady, wrapAngle, type MechBody, type MechInput } from './physics'
import { armsOf, DRONE, MECH, MECHS, SHELL, type MechKind, type MechSpec } from './spec'

/** `t` 是變身好了的堡壘型、盾牌正對著 (x, z)（打過去會被盾牌擋住） */
function shieldFacing(t: MechBody, x: number, z: number): boolean {
  if (!MECHS[t.kind].deploy?.shield || t.deploy < 0.7) return false
  const a = Math.atan2(x - t.x, z - t.z)
  return Math.abs(wrapAngle(a - t.aimYaw)) < 0.9
}

/** 電腦看得到的一台機甲；`drone` 是它放出去的偵察機（沒有是 null） */
export type BotTarget = { seat: number; team: Team; body: MechBody; alive: boolean; drone: { x: number; y: number; z: number } | null }

/** 操控偵察機：怎麼飛（鏡頭方向直接改在偵察機上）、要不要引爆 */
export type DroneOrders = { input: DroneInput; detonate: boolean }

export type BotOrders = {
  input: MechInput
  fire: boolean
  missile: boolean
  /** 正在瞄準、可以鎖定的目標 */
  lock: number | null
  /** 放出偵察機 */
  drone: boolean
  flight: DroneOrders
  /** 要不要變身（堡壘型、砲擊型；其他的不管） */
  deploy: boolean
  /** 砲擊型架了砲：這一發的落點（`fire` 時才看） */
  shell: { x: number; y: number; z: number } | null
}

/** 電腦的偵察機最多飛幾秒（偵察機沒有電池，飛太久就引爆、回去打） */
const FLY_MAX = 30
/** 沒看到敵人的機甲時，多近的敵人偵察機會停下來打 */
const DRONE_SIGHT = 150
/** 偏好哪座橋：河上的路網點照南北分成一段段，每台電腦每一段各自多算 0～`BRIDGE_BIAS` 公尺 */
const BIAS_BAND = 40
const BRIDGE_BIAS = 22
/** 狙擊型每條命有多少機會先去大樓的狙擊點；在狙擊點等多久都沒看到敵人就下去找 */
const PERCH_CHANCE = 0.6
const PERCH_WAIT = 40
/** 砲擊型每條命有多少機會先去屋頂架砲 */
const ROOF_CHANCE = 0.55
/** 堡壘型：多久沒看到敵人就收回來；收回來之後多久才會再變身 */
const FORTRESS_WAIT = 4
const DEPLOY_COOL = 5
/** 砲擊型：敵人靠多近就收砲（改用卡賓槍）、多久沒目標就收砲 */
const MORTAR_NEAR = 50
const MORTAR_WAIT = 12

const SKILL: Record<Difficulty, { aim: number; react: number; turn: number; burst: number; missile: number; dodge: number }> = {
  easy: { aim: 0.07, react: 0.75, turn: 2.6, burst: 0.5, missile: 0.08, dodge: 0.2 },
  normal: { aim: 0.04, react: 0.4, turn: 4, burst: 0.75, missile: 0.18, dodge: 0.45 },
  hard: { aim: 0.022, react: 0.22, turn: 6, burst: 0.9, missile: 0.35, dodge: 0.7 },
}

export class BotBrain {
  readonly seat: number
  private readonly skill: (typeof SKILL)[Difficulty]
  private readonly spec: MechSpec
  /** 狙擊型：站遠一點、站穩了才開砲 */
  private readonly sniper: boolean
  /** 偵察型：中距離，看不到敵人時放偵察機 */
  private readonly recon: boolean
  /** 堡壘型、砲擊型：看到敵人就變身 */
  private readonly fortress: boolean
  private readonly mortar: boolean
  /** 想不想變身、收回來之後多久才能再變身、變身後多久沒有目標 */
  private deployWant = false
  private deployCool = 2
  private deployIdle = 0
  /** 躲砲彈：落點、還要跑多久 */
  private fleeX = 0
  private fleeZ = 0
  private flee = 0
  /** 這條命還剩幾架偵察機（遊戲每一格告訴它） */
  drones = 0
  /** 多久沒看到目標了、下次能放偵察機還要等多久 */
  private blind = 0
  private droneCool = 4
  /** 偵察機：追誰、卡住多久、多久沒有目標 */
  private flyTarget = -1
  private flyStuck = 0
  private flyIdle = 0
  /** 正在打誰的偵察機、多久重找一次 */
  private droneSeat = -1
  private droneScan = 0
  private target = -1
  private retarget = 0
  private path: number[] = []
  private repath = 0
  /** 看到目標多久了（反應時間到才開火） */
  private seen = 0
  /** 瞄準誤差：慢慢飄動，不是每格亂跳 */
  private errYaw = 0
  private errPitch = 0
  private errTimer = 0
  private strafeDir = 1
  private strafeTimer = 0
  private burstTimer = 0
  private bursting = true
  private stuck = 0
  private unstick = 0
  private jumpTimer = 0
  private boostTimer = 0
  /** 最近被打（`hurt` 呼叫）：閃避 */
  private hurtTimer = 0
  private lockTimer = 0
  private readonly rand: () => number
  /** 每一段（`BIAS_BAND` 公尺）的河多算多少：每條命重抽，大家才不會全擠在最近的那座橋 */
  private readonly bias: Float32Array
  /** 狙擊型這條命要去的狙擊點（`perches` 的第幾個，-1 是不去）、這條命選過了沒、在那裡多久沒看到敵人 */
  private perch = -1
  private perchPicked = false
  private perchIdle = 0

  constructor(seat: number, difficulty: Difficulty, kind: MechKind = 'speed', rand: () => number = Math.random) {
    this.seat = seat
    this.skill = SKILL[difficulty] ?? SKILL.normal
    this.spec = MECHS[kind]
    this.sniper = kind === 'sniper'
    this.recon = kind === 'recon'
    this.fortress = kind === 'fortress'
    this.mortar = kind === 'mortar'
    this.rand = rand
    this.strafeDir = rand() < 0.5 ? -1 : 1
    this.bias = new Float32Array(Math.ceil((MAP_Z * 2) / BIAS_BAND) + 1)
    this.rollBias()
  }

  private rollBias() {
    for (let i = 0; i < this.bias.length; i++) this.bias[i] = this.rand() * BRIDGE_BIAS
  }

  /** 被打中了 */
  hurt() {
    this.hurtTimer = 1.2
  }

  /** 復活：從頭想 */
  reset() {
    this.rollBias()
    this.perch = -1
    this.perchPicked = false
    this.perchIdle = 0
    this.path = []
    this.target = -1
    this.seen = 0
    this.lockTimer = 0
    this.blind = 0
    this.droneCool = 4
    this.flyTarget = -1
    this.deployWant = false
    this.deployCool = 2
    this.deployIdle = 0
    this.flee = 0
  }

  /**
   * 砲彈快落在附近（警告圈出現了）：照難度決定要不要躲，躲的話往落點的反方向跑一陣子；
   * 變身了要先收回來（收回要一秒左右，跑的時間多給一點），比較常選擇站著硬吃
   */
  incoming(x: number, z: number, planted: boolean) {
    if (this.flee > 0 || this.rand() > this.skill.dodge * (planted ? 0.5 : 1)) return
    this.fleeX = x
    this.fleeZ = z
    this.flee = planted ? 2.8 : 1.8
    if (planted) this.pack()
  }

  /** 收回來（之後 `DEPLOY_COOL` 秒內不會再變身） */
  private pack() {
    if (this.deployWant) this.deployCool = DEPLOY_COOL
    this.deployWant = false
  }

  think(dt: number, me: MechBody, others: BotTarget[], map: MapIndex, out: BotOrders) {
    this.decide(dt, me, others, map, out)
    // 躲砲彈：照瞄準的方向換算成前後左右，往落點的反方向衝（頭不轉，照樣可以打）
    if (this.flee > 0) {
      this.flee -= dt
      if (!me.deployed && me.deploy <= 0) {
        const d = wrapAngle(Math.atan2(me.x - this.fleeX, me.z - this.fleeZ) - me.aimYaw)
        out.input.forward = Math.cos(d)
        out.input.strafe = -Math.sin(d)
        out.input.boost = me.energy > MECH.minBoost
        out.input.jump = false
      }
    }
    out.deploy = (this.fortress || this.mortar) && this.deployWant
  }

  private decide(dt: number, me: MechBody, others: BotTarget[], map: MapIndex, out: BotOrders) {
    const skill = this.skill
    const r = this.rand
    out.fire = false
    out.missile = false
    out.lock = null
    out.drone = false
    out.shell = null
    out.input.forward = 0
    out.input.strafe = 0
    out.input.boost = false
    out.input.jump = false
    this.hurtTimer = Math.max(0, this.hurtTimer - dt)
    this.deployCool -= dt
    const planted = me.deployed || me.deploy > 0

    // 狙擊型：這條命要不要先去大樓的狙擊點；砲擊型：要不要先去屋頂架砲
    if ((this.sniper || this.mortar) && !this.perchPicked) {
      this.perchPicked = true
      const roof = FLOORS[FLOORS.length - 1] - 0.5
      const mine = map.data.perches.flatMap((p, i) => (p.team === me.team && (this.sniper || p.y >= roof) ? [i] : []))
      if (mine.length > 0 && r() < (this.sniper ? PERCH_CHANCE : ROOF_CHANCE)) this.perch = mine[Math.floor(r() * mine.length)]
    }
    const perch = this.perch >= 0 ? map.data.perches[this.perch] : null
    const atPerch = perch !== null && Math.hypot(perch.x - me.x, perch.z - me.z) < 4 && Math.abs(perch.y - me.y) < 2

    // 選目標：看得到的優先，再來是近的（狙擊型、架了砲的砲擊型看得比較遠）；擋在敵人盾牌正面的不優先
    const sight = this.sniper ? 390 : this.mortar ? (me.deployed ? SHELL.range : 300) : 220
    this.retarget -= dt
    const valid = (t: BotTarget | undefined) => t !== undefined && t.alive && t.team !== me.team && !inBase(t.team, t.body.x, t.body.z)
    let target = others.find((t) => t.seat === this.target)
    if (this.retarget <= 0 || !valid(target)) {
      this.retarget = 0.6 + r() * 0.4
      let best: BotTarget | undefined
      let bestScore = Infinity
      for (const t of others) {
        if (!valid(t)) continue
        const d = Math.hypot(t.body.x - me.x, t.body.z - me.z)
        const see = d < sight && map.clear(me.x, me.y + this.spec.eye - 0.8, me.z, t.body.x, t.body.y + MECHS[t.body.kind].hitH * 0.52, t.body.z)
        const score = d + (see ? 0 : 90) + (t.seat === this.target ? -25 : 0) + (shieldFacing(t.body, me.x, me.z) ? 70 : 0)
        if (score < bestScore) {
          bestScore = score
          best = t
        }
      }
      target = best
      this.target = best?.seat ?? -1
    }

    const eyeY = me.y + this.spec.eye - 0.8
    let visible = false
    let dist = Infinity
    if (target && valid(target)) {
      const t = target.body
      dist = Math.hypot(t.x - me.x, t.z - me.z)
      visible = dist < sight + 10 && map.clear(me.x, eyeY, me.z, t.x, t.y + MECHS[t.kind].hitH * 0.52, t.z)
    }
    this.seen = visible ? this.seen + dt : 0
    this.blind = visible ? 0 : this.blind + dt
    this.droneCool -= dt
    // 偵察型：一陣子沒看到敵人、偵察機飛得到的地方有敵人，就放偵察機去找
    if (
      this.recon &&
      this.drones > 0 &&
      this.blind > 2.5 &&
      this.droneCool <= 0 &&
      !inBase(me.team, me.x, me.z) &&
      target &&
      Math.hypot(target.body.x - me.x, target.body.z - me.z) < DRONE.clear + 20
    ) {
      this.droneCool = 12 + r() * 10
      out.drone = true
      return
    }

    // 瞄準誤差慢慢飄
    this.errTimer -= dt
    if (this.errTimer <= 0) {
      this.errTimer = 0.25 + r() * 0.35
      const spread = skill.aim * (me.boosting || !me.onGround ? 1.6 : 1) * (this.hurtTimer > 0 ? 1.3 : 1) * (this.sniper ? 0.6 : 1)
      this.errYaw = (r() - 0.5) * 2 * spread
      this.errPitch = (r() - 0.5) * 1.2 * spread
    }

    // 砲擊型架了砲：看得到、射程內的敵人就打過去；敵人太近、太久沒目標（在屋頂上等久一點）就收砲
    if (this.mortar && me.deployed) {
      this.lockTimer = 0
      if (target && visible) {
        this.deployIdle = 0
        this.perchIdle = 0
        if (dist < MORTAR_NEAR) this.pack()
        else if (dist >= SHELL.min) this.lob(dt, me, target, dist, out)
      } else {
        this.deployIdle += dt
        if (this.deployIdle > (atPerch ? PERCH_WAIT : MORTAR_WAIT)) {
          this.pack()
          if (atPerch) this.perch = -1
        }
        if (perch && atPerch) this.face(dt, me, perch.yaw)
      }
      return
    }

    if (target && visible) {
      const t = target.body
      // 往目標身體中間瞄，帶一點提前量
      const lead = dist / 900
      const tx = t.x + t.vx * lead
      const tz = t.z + t.vz * lead
      const ty = t.y + MECHS[t.kind].hitH * 0.52
      const wantYaw = Math.atan2(tx - me.x, tz - me.z) + this.errYaw
      const wantPitch = Math.atan2(ty - eyeY + 0.5, Math.hypot(tx - me.x, tz - me.z)) + this.errPitch
      const step = skill.turn * dt
      me.aimYaw = wrapAngle(me.aimYaw + clamp(wrapAngle(wantYaw - me.aimYaw), -step, step))
      me.aimPitch = clamp(me.aimPitch + clamp(wantPitch - me.aimPitch, -step, step), -0.6, 0.9)
      const off = Math.abs(wrapAngle(wantYaw - me.aimYaw)) + Math.abs(wantPitch - me.aimPitch)

      // 開火：反應時間到、瞄得差不多，一陣一陣打
      this.burstTimer -= dt
      if (this.burstTimer <= 0) {
        this.bursting = r() < skill.burst
        this.burstTimer = this.bursting ? 0.6 + r() * 1.2 : 0.3 + r() * 0.6
      }
      // 狙擊型要瞄得更準才開砲；堡壘型變身後換重機槍（射程比較遠、一直打）
      const range = armsOf(this.spec, deployedReady(me)).gunRange
      out.fire = this.seen > skill.react && off < (this.sniper ? 0.03 : 0.12) && dist < range && (this.bursting || deployedReady(me))

      // 飛彈：瞄準夠久就鎖定，偶爾發射
      const aimed = off < MECH.lockAngle && dist < MECH.lockRange
      this.lockTimer = aimed ? this.lockTimer + dt : 0
      out.lock = aimed ? target.seat : null
      if (this.lockTimer > MECH.lockTime + 0.3 && r() < skill.missile * dt) out.missile = true

      this.perchIdle = 0
      // 堡壘型：看到敵人一陣子、距離合適就變身，變身了就站著打
      if (this.fortress) {
        this.deployIdle = 0
        if (!this.deployWant && this.deployCool <= 0 && me.onGround && this.seen > skill.react + 0.4 && dist > 25 && dist < 190) this.deployWant = true
      }
      // 砲擊型：在屋頂上、或看到遠處的敵人而且頭上沒東西擋（樓板底下打不出去），就架砲
      if (this.mortar && !this.deployWant && this.deployCool <= 0 && me.onGround) {
        const open = map.ceiling(me.x, me.z, this.spec.radius, me.y + this.spec.height) === Infinity
        if (open && (atPerch || (!perch && dist > 110 && dist < SHELL.range - 40 && this.seen > skill.react + 0.6))) this.deployWant = true
      }
      if (planted || this.deployWant) return
      // 還沒走到狙擊點：邊走邊打
      if (perch && !atPerch) {
        this.navigate(dt, me, map, perch, out, false)
        this.avoidWalls(dt, me, map, out)
        return
      }
      // 在狙擊點上：站穩了打，不走位
      if (atPerch) return

      // 走位：橫移，保持距離
      this.strafeTimer -= dt
      if (this.strafeTimer <= 0) {
        this.strafeDir = r() < 0.5 ? -1 : 1
        this.strafeTimer = 0.8 + r() * 1.8
      }
      out.input.strafe = this.strafeDir * (0.7 + r() * 0.1)
      const far = this.sniper ? 200 : this.recon ? 120 : this.mortar ? 160 : 95
      const near = this.sniper ? 90 : this.recon ? 45 : this.mortar ? 70 : 35
      if (dist > far) out.input.forward = 1
      else if (dist < near) out.input.forward = -1
      else out.input.forward = 0
      // 狙擊型開砲時站穩（移動時散布很大），沒在開砲才橫移
      if (this.sniper && this.bursting && out.input.forward === 0) out.input.strafe = 0
      // 被打時閃避
      this.boostTimer -= dt
      if (this.hurtTimer > 0 && this.boostTimer <= 0 && me.energy > 40 && r() < skill.dodge) {
        this.boostTimer = 2 + r() * 2
        this.unstick = 0
      }
      if (this.boostTimer > 1.4 + r() * 0.1 && me.energy > 10) out.input.boost = true
      this.jumpTimer -= dt
      if (this.jumpTimer <= 0) {
        this.jumpTimer = 2.5 + r() * 4
        if (r() < skill.dodge * 0.5) out.input.jump = true
      }
      if (!me.onGround && me.y < 6 && me.energy > 30 && this.hurtTimer > 0) out.input.jump = true
      this.avoidWalls(dt, me, map, out)
      return
    }
    this.lockTimer = 0

    // 沒看到敵人的機甲：附近看得到敵人的偵察機就站著把它打下來
    if (this.huntDrone(dt, me, others, map, out)) return

    // 堡壘型變身了：一陣子沒看到敵人就收回來
    if (this.fortress && planted) {
      this.deployIdle += dt
      if (this.deployIdle > FORTRESS_WAIT) this.pack()
      return
    }
    if (planted) return

    // 在狙擊點上：面向河等敵人，等太久都沒看到人就下去找；砲擊型到了屋頂就架砲
    if (perch && atPerch) {
      this.perchIdle += dt
      if (this.perchIdle > PERCH_WAIT) this.perch = -1
      if (this.mortar && this.deployCool <= 0 && me.onGround) this.deployWant = true
      this.face(dt, me, perch.yaw)
      return
    }
    // 沒看到：沿著路網走向狙擊點、目標（沒有目標就往敵人的機庫走）
    const goal = perch ?? (target ? { x: target.body.x, y: target.body.y, z: target.body.z } : { x: me.team === 0 ? 250 : -250, y: 0, z: 0 })
    this.navigate(dt, me, map, goal, out, true)
    this.avoidWalls(dt, me, map, out)
  }

  /** 慢慢轉向 `yaw`、頭擺平（在狙擊點上等人） */
  private face(dt: number, me: MechBody, yaw: number) {
    const step = this.skill.turn * 0.5 * dt
    me.aimYaw = wrapAngle(me.aimYaw + clamp(wrapAngle(yaw - me.aimYaw), -step, step))
    me.aimPitch += (0 - me.aimPitch) * Math.min(1, dt * 3)
  }

  /**
   * 砲擊型架了砲：照砲彈要飛多久抓提前量（難度越高抓得越準），落點照瞄準誤差偏一點（左右、前後），
   * 轉過去對準了、反應時間到了才開砲
   */
  private lob(dt: number, me: MechBody, target: BotTarget, dist: number, out: BotOrders) {
    const t = target.body
    const flight = SHELL.time0 + dist / SHELL.timePer
    const lead = flight * (0.4 + this.skill.burst * 0.5)
    const ex = t.x + t.vx * lead
    const ez = t.z + t.vz * lead
    const yaw = Math.atan2(ex - me.x, ez - me.z)
    const side = this.errYaw * 0.35 * dist
    const along = this.errPitch * 0.35 * dist
    const gx = ex + Math.cos(yaw) * side + Math.sin(yaw) * along
    const gz = ez - Math.sin(yaw) * side + Math.cos(yaw) * along
    const step = this.skill.turn * dt
    me.aimYaw = wrapAngle(me.aimYaw + clamp(wrapAngle(yaw - me.aimYaw), -step, step))
    me.aimPitch += (-0.3 - me.aimPitch) * Math.min(1, dt * 3)
    out.shell = { x: gx, y: t.y, z: gz }
    out.fire = this.seen > this.skill.react && Math.abs(wrapAngle(yaw - me.aimYaw)) < 0.15
  }

  /**
   * 沿著路網走向 `goal`：`turn` 時把頭轉向要走的方向（沒在打的時候），
   * 不然頭不動（正在瞄準），把要走的方向換算成前後左右（邊走邊打）
   */
  private navigate(dt: number, me: MechBody, map: MapIndex, goal: { x: number; y: number; z: number }, out: BotOrders, turn: boolean) {
    const r = this.rand
    this.repath -= dt
    if (this.repath <= 0 || this.path.length === 0) {
      // 找路要算不少射線，隔一陣子才重算一次
      this.repath = 1.2 + r()
      const goalNode = nearestNode(map, goal.x, goal.y, goal.z)
      const start = nearestNode(map, me.x, me.y, me.z)
      const nodes = map.data.nodes
      const enemyBase = (i: number) => inBase((1 - me.team) as Team, nodes[i].x, nodes[i].z)
      const bias = this.bias
      const river = (i: number) => (Math.abs(nodes[i].x) < RIVER ? bias[Math.floor((nodes[i].z + MAP_Z) / BIAS_BAND)] : 0)
      this.path = findPath(map.data, start, goalNode, enemyBase, river)
    }
    // 走到下一個點附近就換下一個（高度也要差不多：橋上的點不是橋下的點）
    while (this.path.length > 1) {
      const n = map.data.nodes[this.path[0]]
      const reached = Math.hypot(n.x - me.x, n.z - me.z) < 7 && Math.abs(n.y - me.y) < 3
      if (reached || this.canSkip(me, map)) this.path.shift()
      else break
    }
    // 要去狙擊點：走到最後一個路網點之後直接走過去（狙擊點不一定剛好在路網的點上），站準一點
    const last = this.perch >= 0 && this.path.length === 1 ? map.data.nodes[this.path[0]] : null
    const arrived = last !== null && Math.hypot(last.x - me.x, last.z - me.z) < 5 && Math.abs(last.y - me.y) < 3
    const next = this.path.length && !arrived ? map.data.nodes[this.path[0]] : goal
    const close = this.path.length <= 1 && Math.hypot(goal.x - me.x, goal.z - me.z) < (this.perch >= 0 ? 2.5 : 10)
    const wantYaw = Math.atan2(next.x - me.x, next.z - me.z)
    if (!turn) {
      // 前方 (sin, cos)、右方 (-cos, sin)：要走的方向在瞄準方向的前後左右各多少
      const d = wrapAngle(wantYaw - me.aimYaw)
      out.input.forward = close ? 0 : Math.cos(d)
      out.input.strafe = close ? 0 : -Math.sin(d)
      return
    }
    const step = this.skill.turn * 0.8 * dt
    me.aimYaw = wrapAngle(me.aimYaw + clamp(wrapAngle(wantYaw - me.aimYaw), -step, step))
    me.aimPitch += (0 - me.aimPitch) * Math.min(1, dt * 3)
    const facing = Math.abs(wrapAngle(wantYaw - me.aimYaw)) < 0.6
    out.input.forward = close ? 0 : facing ? 1 : 0.3
    // 長直線上有能量就衝刺
    if (facing && me.energy > 55 && Math.hypot(next.x - me.x, next.z - me.z) > 25) out.input.boost = true
  }

  /**
   * 操控偵察機：找離偵察機最近的敵人，離很遠時飛到比它高 30 公尺的地方（越過大樓），到了附近俯衝下去，
   * 夠近就引爆；前面有東西擋住就往上飛，卡住、飛太久（`FLY_MAX` 秒）、一直找不到人也引爆（早點回去打）
   */
  fly(dt: number, d: DroneBody, me: MechBody, others: BotTarget[], map: MapIndex, out: DroneOrders) {
    out.detonate = false
    out.input.forward = 0
    out.input.strafe = 0
    out.input.rise = 0
    const valid = (t: BotTarget) => t.alive && t.team !== me.team && !inBase(t.team, t.body.x, t.body.z)
    let target = others.find((t) => t.seat === this.flyTarget && valid(t))
    if (!target) {
      let best = Infinity
      for (const t of others) {
        if (!valid(t)) continue
        const dist = Math.hypot(t.body.x - d.x, t.body.z - d.z)
        // 太遠的不追（訊號會變差、看不到）
        if (Math.hypot(t.body.x - me.x, t.body.z - me.z) > DRONE.clear + 40) continue
        if (dist < best) {
          best = dist
          target = t
        }
      }
      this.flyTarget = target?.seat ?? -1
    }
    if (!target) {
      this.flyIdle += dt
      if (this.flyIdle > 2 && d.age > DRONE.arm) out.detonate = true
      return
    }
    this.flyIdle = 0
    const t = target.body
    const ty = t.y + MECHS[t.kind].hitH * 0.5
    const hd = Math.hypot(t.x - d.x, t.z - d.z)
    const dist = Math.hypot(hd, ty - d.y)
    if (dist < 5 && d.age > DRONE.arm) {
      out.detonate = true
      return
    }
    // 方向：水平朝目標；遠的時候平飛（高度用升降調），近了照目標的方向俯衝
    const wantYaw = Math.atan2(t.x - d.x, t.z - d.z)
    const diving = hd < 30
    const wantPitch = diving ? Math.atan2(ty - d.y, hd) : 0
    const turn = 3 * dt
    d.yaw = wrapAngle(d.yaw + clamp(wrapAngle(wantYaw - d.yaw), -turn, turn))
    d.pitch = clamp(d.pitch + clamp(wantPitch - d.pitch, -turn, turn), -1.3, 0.8)
    out.input.forward = Math.abs(wrapAngle(wantYaw - d.yaw)) < 0.8 ? 1 : 0.2
    out.input.rise = diving ? clamp((ty - d.y) / 6, -1, 1) : clamp((Math.max(t.y, me.y) + 30 - d.y) / 6, -1, 1)
    // 前面有東西：往上
    const cp = Math.cos(d.pitch)
    if (map.ray(d.x, d.y, d.z, Math.sin(d.yaw) * cp, Math.sin(d.pitch), Math.cos(d.yaw) * cp, 9) !== Infinity) {
      out.input.rise = 1
      out.input.forward = 0.25
    }
    // 卡住、飛太久：引爆
    const speed = Math.hypot(d.vx, d.vy, d.vz)
    this.flyStuck = speed < 2 && d.age > 1.5 ? this.flyStuck + dt : 0
    if (this.flyStuck > 1.5 || d.age > FLY_MAX) out.detonate = true
  }

  /** 找附近看得到的敵人偵察機、瞄準、開火；有在打就回傳 true */
  private huntDrone(dt: number, me: MechBody, others: BotTarget[], map: MapIndex, out: BotOrders): boolean {
    const eyeY = me.y + this.spec.eye - 0.8
    this.droneScan -= dt
    if (this.droneScan <= 0) {
      this.droneScan = 0.5 + this.rand() * 0.3
      this.droneSeat = -1
      let best = DRONE_SIGHT
      for (const t of others) {
        const d = t.drone
        if (!d || !t.alive || t.team === me.team) continue
        const dist = Math.hypot(d.x - me.x, d.y - eyeY, d.z - me.z)
        if (dist < best && map.clear(me.x, eyeY, me.z, d.x, d.y, d.z)) {
          best = dist
          this.droneSeat = t.seat
        }
      }
    }
    const d = others.find((t) => t.seat === this.droneSeat)?.drone
    if (!d) {
      this.droneSeat = -1
      return false
    }
    const h = Math.hypot(d.x - me.x, d.z - me.z)
    const wantYaw = Math.atan2(d.x - me.x, d.z - me.z) + this.errYaw
    const wantPitch = Math.atan2(d.y - eyeY, h) + this.errPitch
    const step = this.skill.turn * dt
    me.aimYaw = wrapAngle(me.aimYaw + clamp(wrapAngle(wantYaw - me.aimYaw), -step, step))
    me.aimPitch = clamp(me.aimPitch + clamp(wantPitch - me.aimPitch, -step, step), -0.6, 0.9)
    const off = Math.abs(wrapAngle(wantYaw - me.aimYaw)) + Math.abs(wantPitch - me.aimPitch)
    out.fire = off < (this.sniper ? 0.03 : 0.08) && Math.hypot(h, d.y - eyeY) < this.spec.gunRange
    this.avoidWalls(dt, me, map, out)
    return true
  }

  /** 下下個點已經看得到就直接走過去（不用一定要踩到每個點） */
  private canSkip(me: MechBody, map: MapIndex): boolean {
    if (this.path.length < 2) return false
    const n = map.data.nodes[this.path[1]]
    // 高度不一樣（橋上橋下、坡道）就乖乖一個點一個點走
    if (Math.hypot(n.x - me.x, n.z - me.z) > 60 || Math.abs(n.y - me.y) > 1.5) return false
    // 左右各看一條，確定身體過得去
    const dx = n.x - me.x
    const dz = n.z - me.z
    const len = Math.hypot(dx, dz) || 1
    const ox = (-dz / len) * 2
    const oz = (dx / len) * 2
    const ay = me.y + 1
    const by = n.y + 1
    return map.clear(me.x + ox, ay, me.z + oz, n.x + ox, by, n.z + oz) && map.clear(me.x - ox, ay, me.z - oz, n.x - ox, by, n.z - oz)
  }

  /** 卡住了：跳起來、往旁邊閃一下 */
  private avoidWalls(dt: number, me: MechBody, map: MapIndex, out: BotOrders) {
    const moving = Math.abs(out.input.forward) + Math.abs(out.input.strafe) > 0.3
    const speed = Math.hypot(me.vx, me.vz)
    if (moving && speed < 2.5) this.stuck += dt
    else this.stuck = Math.max(0, this.stuck - dt * 2)
    if (this.stuck > 0.7) {
      this.stuck = 0
      this.unstick = 0.8
      this.strafeDir = -this.strafeDir
      this.repath = 0
    }
    if (this.unstick > 0) {
      this.unstick -= dt
      out.input.strafe = this.strafeDir
      out.input.jump = me.onGround || me.energy > 20
    }
    // 前面很近有東西擋住：往旁邊偏
    const ahead = map.ray(me.x, me.y + 1, me.z, Math.sin(me.aimYaw), 0, Math.cos(me.aimYaw), 6)
    if (ahead !== Infinity && out.input.forward > 0) out.input.strafe += this.strafeDir * 0.8
  }
}
