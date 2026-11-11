// 多人連線（後端 `backend/src/mecha.rs`，房間是派對房間 `shared/useParty.ts`）。
//
// 和 3D 賽車一樣：每台機甲在自己的瀏覽器跑物理，每秒送 20 次狀態，伺服器每 50 毫秒合併轉送（`tick` 事件，順便帶血量和傷害）。
// 別人的機甲收到的是一小段時間以前的狀態，用速度往前推算到「現在」才畫，新狀態和舊推算差多少就慢慢消掉。
import type { Party } from '../shared/useParty'
import { BED, type Team } from './map'
import { clamp, stepDeploy, wrapAngle, type MechBody } from './physics'
import { MECH, MECHS, type MechKind } from './spec'

export type Difficulty = 'easy' | 'normal' | 'hard'

export const DIFFICULTIES: { value: Difficulty; label: string }[] = [
  { value: 'easy', label: '簡單' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困難' },
]

export type MechaOptions = { killTarget: number; timeLimit: number; difficulty: Difficulty }

export type MechaPlayer = {
  team: Team
  /** 選的機甲（選隊時可以換） */
  mech: MechKind
  alive: boolean
  /** 還有幾毫秒復活（活著是 null） */
  respawnIn: number | null
  /** 第幾條命（從 1 開始），復活就加一 */
  life: number
  hp: number
  /** 這條命還剩幾發飛彈 */
  missiles: number
  /** 這條命還剩幾架偵察機（引爆了才少；偵察型才有） */
  drones: number
  kills: number
  deaths: number
  damage: number
  /** 這個房間累計贏了幾場 */
  wins: number
}

export type MechaView = {
  game: number
  killTarget: number
  timeLimit: number
  /** 還有幾毫秒開打（伺服器送出當下） */
  startsIn: number
  /** 開打後過了幾毫秒；結算後停在結算的時間 */
  elapsed: number
  /** 還剩幾毫秒時間到；結算了是 null */
  endsIn: number | null
  ended: boolean
  /** 贏的隊伍；平手或還沒結束是 null */
  winner: Team | null
  score: [number, number]
  you: number | null
  /** 自己最後送出的狀態（重新整理後從這裡接著打） */
  resume: number[] | null
  players: MechaPlayer[]
  difficulty: Difficulty
  bots: number[]
  /** 負責開電腦的座位 */
  driver: number | null
  /** 自己負責開電腦時才有：電腦最後的狀態，每列是 [座位, ...狀態] */
  botStates: number[][]
  /** 選隊時：還剩幾毫秒、每個座位準備好了沒有；選完是 null */
  select: { endsIn: number; ready: boolean[] } | null
}

/** `drone` 是打中 `seat` 放出去的偵察機（只有主武器打得下來）；`id` 是飛彈、砲彈的號碼 */
export type HitReport = { seat: number; w: 'gun' | 'missile' | 'shell'; id?: number; direct?: boolean; by?: number; drone?: boolean }

export type MechaAction =
  | { type: 'state'; d?: number[]; bots?: number[][] }
  | { type: 'hit'; hits: HitReport[] }
  | { type: 'missile'; id: number; o: number[]; dir: number[]; target?: number; goal?: number[]; by?: number }
  /** 偵察機引爆：爆炸的位置、炸到的座位、這條命的第幾架（0 起算；已經被打下來的不算） */
  | { type: 'boom'; o: number[]; hits: number[]; by?: number; n: number }
  /** 砲擊型發射迫擊砲彈：砲口、初速 */
  | { type: 'shell'; id: number; o: number[]; v: number[]; by?: number }
  | { type: 'ping'; t: number }
  | { type: 'team'; team: Team }
  | { type: 'mech'; mech: MechKind }
  | { type: 'ready' }

export type MechaEvent =
  /** `m` 每列是 [座位, ...狀態]；`hp` 是每個座位現在的血量（有變才有）；`d` 是這段時間的傷害 [開火的, 被打的, 傷害, 0 主武器／1 飛彈／2 偵察機] */
  | { type: 'tick'; m: number[][]; hp?: number[]; d?: number[][] }
  /** `goal` 是發射時準星對到的那一點（舊版用戶端沒有） */
  | { type: 'missile'; seat: number; id: number; o: number[]; dir: number[]; target: number | null; goal?: number[] | null }
  /** 別人的偵察機在 `o` 爆炸了 */
  | { type: 'boom'; seat: number; o: number[] }
  /** 別人發射了迫擊砲彈：砲口、初速 */
  | { type: 'shell'; seat: number; id: number; o: number[]; v: number[] }
  /** `seat` 這條命的第 `n` 架偵察機（0 起算）被 `by` 打下來了 */
  | { type: 'downed'; seat: number; by: number; n: number }
  | { type: 'kill'; killer: number; victim: number; w: KillWeapon }
  | { type: 'pong'; t: number; clock: number }

export type KillWeapon = 'gun' | 'missile' | 'drone' | 'shell'

export type MechaParty = { view: MechaView; action: MechaAction; options: MechaOptions; event: MechaEvent }

export function seatName(party: Party<MechaParty>, seat: number): string {
  return party.playerAt(seat)?.name ?? `駕駛員 ${seat + 1}`
}

/** 座位在隊伍裡排第幾（決定重生點） */
export function slotOf(view: MechaView, seat: number): number {
  const team = view.players[seat]?.team ?? 0
  let k = 0
  for (let s = 0; s < seat; s++) if (view.players[s]?.team === team) k++
  return k
}

/** 每秒送幾次自己的狀態 */
export const SEND_EVERY = 0.05
/** 打中的通知最少隔多久送一次 */
export const HIT_EVERY = 0.1
export const PING_FIRST = 0.3
export const PING_EVERY = 2
export const PING_BURST = 6
const STALE_MS = 3000
const MAX_AHEAD = 0.3
const SNAP = 10
const SETTLE = 9

// 狀態的格式，和 mecha.rs 的 STATE_LEN 對應：
// [時間, x, y, z, vx, vy, vz, 腳的方向, 瞄準水平角, 瞄準仰角, 旗標, 第幾條命, 偵察機的 x, y, z, 偵察機鏡頭的水平角, 仰角]
// （偵察機的鏡頭方向：大家照這個算它的畫面裡看得到誰）
// 旗標的低 5 位元是下面這些，再上去 6 位元是開了幾砲（除以 64 的餘數）：狙擊型一發一發打，別人照這個數字畫出每一砲；
// 再上去一位元是偵察機在外面飛（偵察機的位置才有意義），再上去一位元是「這條命的第二架」
// （伺服器靠它分辨打的是不是現在這一架：打下來、引爆之後還在路上的舊狀態不算），
// 再上去一位元是堡壘型、砲擊型變身了（伺服器照它算主武器的射速；別人照它播變身的動作）
const STATE_LEN = 17
const F_BOOST = 1
const F_FIRE = 2
const F_GROUND = 4
const F_HOVER = 8
const F_RELOAD = 16
const SHOT_SHIFT = 32
const SHOT_WRAP = 64
const F_DRONE = SHOT_SHIFT * SHOT_WRAP
const F_DRONE2 = F_DRONE * 2
const F_DEPLOY = F_DRONE2 * 2

const round = (v: number, digits: number) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

export function encodeState(
  b: MechBody,
  clock: number,
  firing: boolean,
  reloading: boolean,
  life: number,
  shots: number,
  drone: { x: number; y: number; z: number; yaw: number; pitch: number } | null,
  /** 這條命的第幾架偵察機（0 起算） */
  droneN = 0,
): number[] {
  let flags = (shots % SHOT_WRAP) * SHOT_SHIFT
  if (b.boosting) flags |= F_BOOST
  if (firing) flags |= F_FIRE
  if (b.onGround) flags |= F_GROUND
  if (b.hovering) flags |= F_HOVER
  if (reloading) flags |= F_RELOAD
  if (drone) flags |= F_DRONE | (droneN % 2 ? F_DRONE2 : 0)
  if (b.deployed) flags |= F_DEPLOY
  return [
    Math.round(clock * 1000),
    round(b.x, 2),
    round(b.y, 2),
    round(b.z, 2),
    round(b.vx, 2),
    round(b.vy, 2),
    round(b.vz, 2),
    round(b.legs, 3),
    round(b.aimYaw, 3),
    round(b.aimPitch, 3),
    flags,
    life,
    drone ? round(drone.x, 2) : 0,
    drone ? round(drone.y, 2) : 0,
    drone ? round(drone.z, 2) : 0,
    drone ? round(drone.yaw, 3) : 0,
    drone ? round(drone.pitch, 3) : 0,
  ]
}

function valid(d: unknown): d is number[] {
  return Array.isArray(d) && d.length === STATE_LEN && d.every((v) => typeof v === 'number' && Number.isFinite(v))
}

/** 一台別人的機甲：收狀態、往前推算、寫進 `MechBody`，畫面和打中判定照用自己的那一套 */
export class RemoteMech {
  private d: number[] | null = null
  private seen = 0
  private ex = 0
  private ey = 0
  private ez = 0
  private readonly p = { x: 0, y: 0, z: 0 }
  /** 開火中（旗標） */
  firing = false
  reloading = false
  life = 0
  /** 還沒畫出來的砲擊（開了幾砲的數字變了幾次） */
  shots = 0
  /** 偵察機最後回報的位置；沒在飛是 null */
  drone: [number, number, number] | null = null
  /** 偵察機鏡頭的方向 */
  droneYaw = 0
  dronePitch = 0
  /** 外面那架是這條命的第幾架（只分單雙：0 或 1） */
  droneN = 0
  private shotCount: number | null = null
  private readonly kind: MechKind

  constructor(kind: MechKind) {
    this.kind = kind
  }

  visible(now: number): boolean {
    return this.d !== null && now - this.seen < STALE_MS
  }

  /** 倒下了：之後要等新的一條命的狀態 */
  drop() {
    this.d = null
    this.firing = false
    this.shots = 0
    this.shotCount = null
    this.drone = null
  }

  push(raw: unknown, clock: number, now: number) {
    if (!valid(raw)) return
    const old = this.d
    if (old && raw[11] === old[11] && raw[0] <= old[0]) return
    const smooth = old !== null && this.visible(now) && raw[11] === old[11]
    let px = 0
    let py = 0
    let pz = 0
    if (smooth) {
      this.predict(old, clock)
      px = this.p.x + this.ex
      py = this.p.y + this.ey
      pz = this.p.z + this.ez
    }
    this.d = raw
    this.seen = now
    this.life = raw[11]
    this.drone = raw[10] & F_DRONE ? [raw[12], raw[13], raw[14]] : null
    this.droneN = raw[10] & F_DRONE2 ? 1 : 0
    this.droneYaw = raw[15]
    this.dronePitch = raw[16]
    // 砲擊的數字：第一次收到的只是記下來（之前開的砲不用補畫）
    const count = Math.floor(raw[10] / SHOT_SHIFT) % SHOT_WRAP
    if (this.shotCount !== null && smooth) this.shots += (count - this.shotCount + SHOT_WRAP) % SHOT_WRAP
    this.shotCount = count
    if (!smooth) {
      this.ex = this.ey = this.ez = 0
      return
    }
    this.predict(raw, clock)
    this.ex = px - this.p.x
    this.ey = py - this.p.y
    this.ez = pz - this.p.z
    if (Math.hypot(this.ex, this.ey, this.ez) > SNAP) this.ex = this.ey = this.ez = 0
  }

  private predict(d: number[], clock: number) {
    const tau = clamp(clock - d[0] / 1000, 0, MAX_AHEAD)
    const ground = (d[10] & F_GROUND) !== 0
    this.p.x = d[1] + d[4] * tau
    this.p.z = d[3] + d[6] * tau
    // 在空中的照重力（飛行時推進器抵掉大部分）；河床比地面低
    const g = ground ? 0 : d[10] & F_HOVER ? MECH.gravity - MECHS[this.kind].hover : MECH.gravity
    this.p.y = Math.max(BED, d[2] + (ground ? 0 : d[5] * tau - 0.5 * g * tau * tau))
  }

  /** 把推算到 `clock` 的結果寫進 `b` */
  apply(b: MechBody, clock: number, h: number) {
    const d = this.d
    if (!d) return
    const k = Math.exp(-SETTLE * h)
    this.ex *= k
    this.ey *= k
    this.ez *= k
    this.predict(d, clock)
    const px = b.x
    const pz = b.z
    b.x = this.p.x + this.ex
    b.y = this.p.y + this.ey
    b.z = this.p.z + this.ez
    b.vx = d[4]
    b.vy = d[5]
    b.vz = d[6]
    b.legs = wrapAngle(b.legs + clamp(wrapAngle(d[7] - b.legs), -10 * h, 10 * h))
    b.aimYaw = wrapAngle(b.aimYaw + wrapAngle(d[8] - b.aimYaw) * Math.min(1, h * 18))
    b.aimPitch += (d[9] - b.aimPitch) * Math.min(1, h * 18)
    const flags = d[10]
    b.boosting = (flags & F_BOOST) !== 0
    b.hovering = (flags & F_HOVER) !== 0
    const wasGround = b.onGround
    b.onGround = (flags & F_GROUND) !== 0
    if (b.onGround && !wasGround && b.vy < -8) b.landed = Math.min(1, -b.vy / 22)
    b.landed = Math.max(0, b.landed - h * 3)
    this.firing = (flags & F_FIRE) !== 0
    this.reloading = (flags & F_RELOAD) !== 0
    // 變身：旗標說要不要變身，動作自己照時間播
    b.deployed = (flags & F_DEPLOY) !== 0
    stepDeploy(b, h)
    // 走路的相位照實際移動的距離算
    const moved = Math.hypot(b.x - px, b.z - pz)
    const speed = Math.hypot(b.vx, b.vz)
    const spec = MECHS[this.kind]
    if (b.onGround && (!b.boosting || !spec.jets) && speed > 1.5 && moved < 5) {
      const back = Math.abs(wrapAngle(Math.atan2(b.vx, b.vz) - b.aimYaw)) > Math.PI * 0.6
      b.stride += (moved / spec.gait) * (back ? -1 : 1)
    }
  }
}
