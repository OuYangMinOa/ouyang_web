// 多人連線（後端 `backend/src/racing.rs`，房間是派對房間 `shared/useParty.ts`）。
//
// 每台車在自己的瀏覽器跑物理，每秒送 20 次自己的狀態；伺服器每 50 毫秒把有更新的車合併轉送給所有人。
// 別人的車收到的是「一小段時間以前」的狀態，用速度和轉向速度往前推算到現在才畫，
// 新的狀態進來時和舊的推算差了多少，就當作誤差在零點幾秒內慢慢消掉，畫面不會一跳一跳。
import type { Party } from '../shared/useParty'
import type { Difficulty } from './ai'
import { clamp, wrapAngle } from './noise'
import { driftTimeFor, stepVertical, type Car } from './physics'
import { CAR_COLORS, CARS, type CarKind } from './spec'
import type { TrackPath } from './track'

export type OnlineTrack = 'coast' | 'canyon' | 'city' | 'xinyi'

export type RacingOptions = { track: OnlineTrack; laps: number; difficulty: Difficulty }

/** 每個座位的車：車種和車色（`CAR_COLORS` 的第幾個）。選車時車色先選先贏，別人選走的不能選 */
export type RacingPick = { car: CarKind; color: number }

export type RacingPlayer = {
  /** 每一圈的時間（毫秒） */
  lapTimes: number[]
  /** 完賽時的比賽時間（毫秒），還沒跑完是 null */
  finish: number | null
  /** 結算後的名次 */
  place: number | null
  /** 這個房間累計的分數 */
  points: number
}

export type RacingView = {
  /** 這個房間的第幾局，換了就是新的一局 */
  game: number
  track: OnlineTrack
  laps: number
  /** `grid[seat]` 是第幾個起跑格（0 在最前面） */
  grid: number[]
  /** 還有幾毫秒起跑（伺服器送出當下） */
  startsIn: number
  /** 起跑後過了幾毫秒；結算後停在結算的時間 */
  elapsed: number
  /** 第一個人跑完後，還剩幾毫秒結算 */
  endsIn: number | null
  ended: boolean
  you: number | null
  /** 自己最後送出的狀態（重新整理後從這裡接著跑） */
  resume: number[] | null
  players: RacingPlayer[]
  difficulty: Difficulty
  /** 電腦的座位 */
  bots: number[]
  /** 負責開電腦的座位（電腦在他的瀏覽器裡跑）；沒有電腦是 null */
  driver: number | null
  /** 自己負責開電腦時才有：電腦最後的狀態，每列是 [座位, ...狀態]（重新整理後接著開） */
  botStates: number[][]
  /** 每個座位的車種和車色（選車時可以換，車色不會重複） */
  cars: RacingPick[]
  /** 選車時：還剩幾毫秒、每個座位選好了沒有（電腦一開始就選好了）；選完、開始倒數後是 null */
  select: { endsIn: number; ready: boolean[] } | null
}

/** 撞到座位 `seat` 的車：`by` 是撞人的電腦（自己的車撞的不填），`v` 是被撞的車該拿到的速度變化 [vx, vz] */
export type BumpHit = { seat: number; by?: number; v: number[] }

export type RacingAction =
  /** 自己的車（跑完後重新整理就沒有）和自己負責開的電腦（每列 [座位, ...狀態]） */
  | { type: 'state'; d?: number[]; bots?: number[][] }
  /** `bot` 是替自己負責開的電腦回報 */
  | { type: 'lap'; lap: number; time: number; bot?: number }
  /** 對時：`t` 是送出時的 performance.now()，伺服器原封不動送回來 */
  | { type: 'ping'; t: number }
  | { type: 'bump'; hits: BumpHit[] }
  /** 選車時換車；車色被別的真人選走了會被擋下來，電腦的顏色會讓出來 */
  | { type: 'pick'; car: CarKind; color: number }
  /** 選好了（之後這局不能再換） */
  | { type: 'ready' }

export type RacingEvent =
  /** 每列是 [座位, ...狀態] */
  | { type: 'cars'; cars: number[][] }
  /** 只回給送 ping 的人：`clock` 是伺服器收到時的比賽時間（毫秒，起跑前是負的） */
  | { type: 'pong'; t: number; clock: number }
  /** 座位 `from` 的車撞到自己這邊開的座位 `to`（自己的車或負責開的電腦）：那台車加上速度變化 `v` */
  | { type: 'bump'; from: number; to: number; v: number[] }

export type RacingParty = { view: RacingView; action: RacingAction; options: RacingOptions; event: RacingEvent }

/** 座位上的人的名字（離開房間的人這局結束前還在名單上，真的找不到才用編號） */
export function seatName(party: Party<RacingParty>, seat: number): string {
  return party.playerAt(seat)?.name ?? `車手 ${seat + 1}`
}

/** 座位選的車（車色是第幾個）；伺服器送來的資料怪怪的就當作綜合型、照座位輪流配色 */
export function seatPick(view: RacingView, seat: number): RacingPick {
  const pick = view.cars?.[seat]
  const car = CARS.some((c) => c.kind === pick?.car) ? pick!.car : 'all'
  const color = pick && Number.isInteger(pick.color) && pick.color >= 0 ? pick.color % CAR_COLORS.length : seat % CAR_COLORS.length
  return { car, color }
}

/** 座位的車（車色是色碼，給 3D 畫面和名單用） */
export function seatCar(view: RacingView, seat: number): { car: CarKind; color: number } {
  const pick = seatPick(view, seat)
  return { car: pick.car, color: CAR_COLORS[pick.color].hex }
}

/** 每秒送幾次自己的狀態 */
export const SEND_EVERY = 0.05
/** 對時的間隔（秒）：剛開局密一點，很快就對準，之後慢慢補 */
export const PING_FIRST = 0.3
export const PING_EVERY = 2
/** 開局後先密集對時幾次 */
export const PING_BURST = 6
/** 撞擊通知最少隔多久送一次（秒），免得貼著摩擦時一直送 */
export const BUMP_EVERY = 0.1
/** 同一對車在這段時間（毫秒）內只算一次碰撞：自己偵測到的和對方送來的通知不要重複加 */
export const BUMP_DEDUPE_MS = 250
/** 多久沒收到某台車的狀態就當它不見了（斷線、切到背景）：不畫、不撞 */
const STALE_MS = 3000
/** 往前推算最多推多久（秒）：網路卡住時不要一路推到牆裡 */
const MAX_AHEAD = 0.35
/** 新舊推算差太多（重生、卡頓很久）就直接跳過去，不慢慢滑 */
const SNAP = 8
/** 誤差消掉的速度（每秒） */
const SETTLE = 8

// 狀態的格式，和 racing.rs 的 STATE_LEN 對應：[時間, x, z, 車頭方向, vx, vz, 轉向速度, 方向盤, 旗標, 進度]
const F_BRAKE = 1
const F_BOOST = 2
const F_DRIFT_RIGHT = 4
const F_DRIFT_LEFT = 8
const F_OFFROAD = 16
const F_THROTTLE = 32
/** 甩尾集氣到第幾段（0～2）放在旗標的第 6、7 位 */
const LEVEL_SHIFT = 6

const round = (v: number, digits: number) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

/** 自己的車編成要送出去的狀態；`clock` 是比賽時鐘（秒，起跑前是負的） */
export function encodeState(car: Car, clock: number, driftLevel: number): number[] {
  let flags = 0
  if (car.braking) flags |= F_BRAKE
  if (car.boost > 0) flags |= F_BOOST
  if (car.drift > 0) flags |= F_DRIFT_RIGHT
  if (car.drift < 0) flags |= F_DRIFT_LEFT
  if (car.offroad) flags |= F_OFFROAD
  if (car.throttle > 0.5) flags |= F_THROTTLE
  if (car.drift !== 0) flags |= driftLevel << LEVEL_SHIFT
  return [
    Math.round(clock * 1000),
    round(car.x, 2),
    round(car.z, 2),
    round(car.heading, 3),
    round(car.vx, 2),
    round(car.vz, 2),
    round(car.yawRate, 3),
    round(car.steer, 2),
    flags,
    round(car.progress, 1),
  ]
}

/** 收到的狀態格式對不對（伺服器只檢查是數字，長度和範圍這裡再看一次） */
function valid(d: unknown): d is number[] {
  return Array.isArray(d) && d.length === 10 && d.every((v) => typeof v === 'number' && Number.isFinite(v))
}

/**
 * 一台別人的車：收狀態、往前推算、把結果寫進 `Car`，畫面、粒子、小地圖、名次都照用單機版的那一套。
 */
export class RemoteDriver {
  private d: number[] | null = null
  /** 收到最新狀態的時間（performance.now） */
  private seen = 0
  /** 換到新狀態時的位置和車頭方向誤差，慢慢消掉 */
  private ex = 0
  private ez = 0
  private eh = 0
  private readonly p = { x: 0, z: 0, h: 0 }

  /** 有在畫面上：收過狀態而且沒有太久沒更新 */
  visible(now: number): boolean {
    return this.d !== null && now - this.seen < STALE_MS
  }

  /** 已經收過狀態了（還沒收過的車停在起跑格上） */
  get started(): boolean {
    return this.d !== null
  }

  /** `clock` 是自己的比賽時鐘（秒），`now` 是 performance.now() */
  push(raw: unknown, clock: number, now: number) {
    if (!valid(raw)) return
    const old = this.d
    // 亂序晚到的舊狀態不要
    if (old && raw[0] <= old[0]) return
    const smooth = old !== null && this.visible(now)
    let px = 0
    let pz = 0
    let ph = 0
    if (smooth) {
      this.predict(old, clock)
      px = this.p.x + this.ex
      pz = this.p.z + this.ez
      ph = this.p.h + this.eh
    }
    this.d = raw
    this.seen = now
    if (!smooth) {
      this.ex = this.ez = this.eh = 0
      return
    }
    this.predict(raw, clock)
    this.ex = px - this.p.x
    this.ez = pz - this.p.z
    this.eh = wrapAngle(ph - this.p.h)
    if (Math.hypot(this.ex, this.ez) > SNAP) this.ex = this.ez = this.eh = 0
  }

  /** 照狀態 `d` 推算比賽時間 `clock` 時的位置（寫進 this.p） */
  private predict(d: number[], clock: number) {
    const tau = clamp(clock - d[0] / 1000, 0, MAX_AHEAD)
    // 沿著轉向的弧線推：速度方向跟著車頭轉一半的角度，比直線準一點
    const turn = d[6] * tau
    const c = Math.cos(turn / 2)
    const s = Math.sin(turn / 2)
    const vx = d[4] * c + d[5] * s
    const vz = d[5] * c - d[4] * s
    this.p.x = d[1] + vx * tau
    this.p.z = d[2] + vz * tau
    this.p.h = wrapAngle(d[3] + turn)
  }

  /** 把推算到 `clock` 的結果寫進 `car`；`h` 是這一步的秒數（誤差照這個消） */
  apply(car: Car, track: TrackPath, clock: number, h: number) {
    const d = this.d
    if (!d) return
    const k = Math.exp(-SETTLE * h)
    this.ex *= k
    this.ez *= k
    this.eh *= k
    this.predict(d, clock)
    car.x = this.p.x + this.ex
    car.z = this.p.z + this.ez
    car.heading = wrapAngle(this.p.h + this.eh)
    // 速度跟著車頭轉過的角度轉（車頭方向和速度方向的夾角不變）
    const turn = car.heading - d[3]
    const c = Math.cos(turn)
    const s = Math.sin(turn)
    car.vx = d[4] * c + d[5] * s
    car.vz = d[5] * c - d[4] * s
    const sinH = Math.sin(car.heading)
    const cosH = Math.cos(car.heading)
    car.speed = car.vx * sinH + car.vz * cosH
    car.slip = car.vx * cosH - car.vz * sinH
    car.yawRate = d[6]
    car.steer = d[7]
    const flags = d[8]
    car.braking = (flags & F_BRAKE) !== 0
    car.boost = flags & F_BOOST ? 1 : 0
    car.drift = flags & F_DRIFT_RIGHT ? 1 : flags & F_DRIFT_LEFT ? -1 : 0
    car.driftTime = car.drift !== 0 ? driftTimeFor((flags >> LEVEL_SHIFT) & 3) : 0
    car.offroad = (flags & F_OFFROAD) !== 0
    car.throttle = flags & F_THROTTLE ? 1 : 0
    car.progress = d[9]
    car.impact = 0
    track.locate(car.x, car.z, car.loc)
    // 高度不在狀態裡：照同一套物理自己算，過坡頂一樣會飛起來
    stepVertical(car, h)
  }
}
