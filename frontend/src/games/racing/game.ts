// 一場比賽：three.js 的畫面、固定步長的物理、電腦對手、圈數名次、鏡頭、音效。
// React 那邊只負責選單和儀表（index.tsx）：離散的事情（倒數、過線、完賽）用 `emit` 通知，
// 每個畫面的速度、時間、小地圖用 `onFrame` 給，直接改 DOM，不經過 React 重繪。
import { Color, PerspectiveCamera, Vector2, Vector3, WebGLRenderer } from 'three'
import { cruiseAi, driveAi, newAi, type AiDriver, type Difficulty } from './ai'
import { RaceAudio } from './audio'
import { CarModel, createCarParts, disposeCarParts, type CarParts } from './car'
import { Particles } from './effects'
import { SkidMarks } from './skids'
import { Input, type PadAction, type TouchState } from './input'
import { clamp, smoothstep, wrapAngle } from './noise'
import {
  BUMP_DEDUPE_MS,
  BUMP_EVERY,
  encodeState,
  PING_BURST,
  PING_EVERY,
  PING_FIRST,
  RemoteDriver,
  SEND_EVERY,
  type BumpHit,
} from './online'
import { collideCars, collideRemote, driftLevel, newCar, placeCar, stepCar, type Car, type Controls } from './physics'
import { CAR, CAR_COLORS, CARS, carSpec, type CarKind } from './spec'
import { SpeedBlur, WindLines } from './speedfx'
import { TrackPath } from './track'
import type { TrackDef } from './tracks'
import { buildWorld, type World } from './world'

const AI_NAMES = ['疾風', '雷霆', '閃電', '旋風', '流星', '烈焰', '追風']

export const CAMERA_NAMES = ['追尾', '近距離', '車頂']

/**
 * 追尾鏡頭：離車多遠、多高，看向車前方多遠、多高。
 * `dolly`：視角變廣時鏡頭往前推多少（1 是車子在畫面上完全一樣大）；近距離鏡頭推太多車尾會變很大，所以少推一點
 */
const CAMS = [
  { dist: 8.4, height: 3.2, ahead: 6, look: 1.2, dolly: 0.75 },
  { dist: 5.6, height: 2.0, ahead: 8, look: 1.0, dolly: 0.35 },
]

const STEP = 1 / 120
/** 一格畫面最多跑幾步物理（0.1 秒） */
const MAX_STEPS = 12

/** 高速效果：從極速的幾成開始（風線比模糊早一點出現，集中線最晚），到極速最強 */
const WIND_FROM = 0.5
const BLUR_FROM = 0.55
const LINES_FROM = 0.72
const FX_FULL = 1.0

/** 停著時的視角（度）；開到極速再廣 `FOV_SPEED` 度，噴射時再加 `FOV_BOOST` 度 */
const BASE_FOV = 58
/** 選車畫面的視角：窄一點，車子比較不會變形 */
const SHOWROOM_FOV = 32
const FOV_SPEED = 16
const FOV_BOOST = 9

/** preview 是選單背景（電腦在跑），showroom 是選車畫面（選的車停著、鏡頭繞著轉） */
export type Phase = 'preview' | 'showroom' | 'countdown' | 'racing' | 'finished'

/** 畫面上的一塊（相對遊戲畫面的 CSS 像素） */
export type Rect = { x: number; y: number; w: number; h: number }

export type Hint = 'wrongWay' | 'stuck' | null

export type RaceSetup = {
  track: TrackDef
  laps: number
  opponents: number
  difficulty: Difficulty
  color: number
  car: CarKind
}

/** 線上比賽：伺服器的 view 和房間名單整理出來的開局資料（index.tsx 組） */
export type OnlineSetup = {
  track: TrackDef
  laps: number
  /** 每個座位的名字、車色和車種，索引就是座位 */
  seats: { name: string; color: number; car: CarKind }[]
  /** `grid[seat]` 是第幾個起跑格 */
  grid: number[]
  /** 自己的座位；觀戰是 null */
  me: number | null
  /** 起跑的時間（performance.now() 的時間軸） */
  goAt: number
  /** 重新整理頁面後接著跑：自己最後送出的狀態 */
  resume: number[] | null
  /** 伺服器記的每個座位的成績（重新整理後圈數照這個接著算） */
  results: OnlineResult[]
  /** 電腦的座位 */
  bots: number[]
  /** 自己負責開電腦 */
  driving: boolean
  difficulty: Difficulty
  /** 負責開電腦時，電腦最後的狀態（每列 [座位, ...狀態]）：重新整理後從這裡接著開 */
  botStates: number[][]
}

/** 線上比賽送東西給伺服器 */
export type OnlineLink = {
  /** 自己車子的狀態（跑完後重新整理、沒有自己的車時是 null），和自己負責開的電腦的狀態（每列 [座位, ...狀態]） */
  state: (d: number[] | null, bots: number[][]) => void
  /** 替自己負責開的電腦回報過線 */
  botLap: (seat: number, lap: number, time: number) => void
  ping: (t: number) => void
  bump: (hits: BumpHit[]) => void
}

/** 伺服器記的每個座位的成績（RacingView.players） */
export type OnlineResult = { lapTimes: number[]; finish: number | null; retired?: boolean }

export type RacerInfo = { name: string; color: number; car: CarKind; player: boolean }

export type Standing = RacerInfo & {
  position: number
  /** 完賽時間（毫秒），還沒跑完是 null */
  time: number | null
  bestLap: number | null
  lapsDone: number
}

export type MiniMap = { d: string; viewBox: string; size: number }

export type HudFrame = {
  speedKmh: number
  raceMs: number
  lapMs: number
  lap: number
  laps: number
  position: number
  total: number
  /** 甩尾集氣到第幾段，沒在甩尾是 -1 */
  drift: number
  boost: boolean
  /** 每台車在小地圖上的位置：x0, z0, x1, z1… */
  cars: Float32Array
}

export type FinishResult = {
  track: string
  laps: number
  time: number
  bestLap: number
  lapTimes: number[]
  standings: Standing[]
}

export type RaceEvent =
  | { type: 'map'; map: MiniMap }
  | { type: 'racers'; racers: RacerInfo[] }
  | { type: 'phase'; phase: Phase }
  | { type: 'countdown'; n: number }
  /** `at` 是過線時的比賽時間（毫秒） */
  | { type: 'lap'; lap: number; ms: number; at: number; best: boolean; final: boolean }
  /** 開反了，或卡在牆邊動不了：提示可以回到賽道 */
  | { type: 'hint'; hint: Hint }
  | { type: 'finish'; result: FinishResult }
  | { type: 'standings'; standings: Standing[] }
  | { type: 'pad'; action: PadAction }
  /** 觀戰時看的那台車不見了（回到房間、斷線），自動換成座位 `seat` */
  | { type: 'focus'; seat: number }

type Racer = {
  car: Car
  model: CarModel
  info: RacerInfo
  ai: AiDriver | null
  /** 線上別人的車：照收到的狀態畫，不跑物理 */
  remote: RemoteDriver | null
  /** 線上的座位（單機是 -1） */
  seat: number
  /** 線上的電腦（不管是不是自己負責開） */
  bot: boolean
  ctl: Controls
  lapStart: number
  lapsDone: number
  lapTimes: number[]
  bestLap: number | null
  finish: number | null
  /** 這個畫面裡最大的撞擊力道（物理一個畫面跑好幾步） */
  impact: number
  /** 這個畫面裡最重的一次落地（騰空後落回路面的速度） */
  landing: number
  boosting: boolean
}

const SMOKE = new Color(0xe4e4e4)
const SMOKE_NIGHT = new Color(0x8c8aa2)
const SPARK = [new Color(0xfff1b0), new Color(0x4cc9ff), new Color(0xff9a2e)]
const FLAME = new Color(0xff7a1a)
const CRASH = new Color(0xffd27a)

/** 兩個座位配成一個數字（座位最多 8 個），碰撞去重用 */
const pairKey = (a: number, b: number) => a * 16 + b
/** 胎痕比路面的中心線高多少（路面本身墊高了 0.02） */
const SKID_LIFT = 0.05

function shuffled<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

export class RaceGame {
  private readonly host: HTMLElement
  private readonly emit: (e: RaceEvent) => void
  private readonly onFrame: (f: HudFrame) => void
  private readonly renderer: WebGLRenderer
  // 遠到看得見信義東南邊的山（四、五公里外）
  private readonly camera = new PerspectiveCamera(60, 1, 0.1, 6000)
  private readonly parts: CarParts
  private readonly input = new Input()
  private readonly audio: RaceAudio
  private readonly smoke = new Particles(600, false)
  private readonly glow = new Particles(500, true)
  private readonly skids = new SkidMarks()
  private readonly resize: ResizeObserver
  private readonly playerCtl: Controls = { throttle: 0, brake: 0, steer: 0, drift: false }
  private readonly frame: HudFrame
  private readonly camPos = new Vector3()
  private readonly look = new Vector3()
  private readonly dust = new Color()
  private world: World | null = null
  private track: TrackPath | null = null
  private def: TrackDef | null = null
  private racers: Racer[] = []
  /** 線上：座位 → racers 的索引，和反過來 */
  private seatIndex: number[] = []
  private seatOf: number[] = []
  private cars: Car[] = []
  private player: Racer | null = null
  private setup: RaceSetup | null = null
  private phase: Phase = 'preview'
  private countdown = 0
  private lastCount = 4
  private raceTime = 0
  private acc = 0
  private paused = false
  private raf = 0
  private last = 0
  private time = 0
  private camMode = 0
  private camH = 0
  /** 鏡頭跟著俯仰的坡度（平滑過的） */
  private camGrade = 0
  private camReady = false
  private fov = 60
  private shake = 0
  private orbit = 0
  private focus = 0
  private wrongTime = 0
  private stuckTime = 0
  private hint: Hint = null
  private pixelRatio: number
  private slowFrames = 0
  private disposed = false
  private readonly speedBlur: SpeedBlur
  private readonly bufferSize = new Vector2()
  private readonly wind = new WindLines()
  /** 目前的模糊強度（慢慢跟上目標，不會一下子跳） */
  private blur = 0
  /** 目前的集中線強度，和讓線往外跑的時間 */
  private lines = 0
  private linesTime = 0
  /** 平滑過的前後加速度：加速時鏡頭落後一點（車子往前竄），煞車時追上來一點 */
  private surge = 0
  private prevSpeed = 0
  /** 系統設定了「減少動態效果」就不畫風線 */
  private readonly calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  /**
   * 線上比賽：起跑時間（performance.now() 的時間軸）、送東西的函式、下次送狀態和對時的倒數；單機是 null。
   * `bestRtt` 是對時看過最快的來回時間，只有更快的回應才拿來修時鐘（慢的多半是在路上或瀏覽器忙的時候耽擱了）
   */
  private online: {
    goAt: number
    link: OnlineLink
    timer: number
    pingTimer: number
    pings: number
    bestRtt: number
    bumpTimer: number
    /** 還沒送出的撞擊通知（pairKey(自己這邊的座位, 被撞的座位) → 被撞的車該拿到的速度變化） */
    bumps: Map<number, { seat: number; by: number | undefined; x: number; z: number }>
  } | null = null
  private readonly kick = { x: 0, z: 0 }
  /** 線上：自己這邊的座位和別人的座位上次相撞的時間（pairKey → performance.now），同一次碰撞只算一次 */
  private readonly hitAt = new Map<number, number>()
  /** 線上：自己負責開電腦（伺服器指定） */
  private driving = false
  private difficulty: Difficulty = 'normal'
  /** 線上電腦的座位（照順序分強弱） */
  private botSeats: number[] = []
  /** 線上在自己這邊跑物理的車：自己的車和負責開的電腦 */
  private locals: Racer[] = []
  private localCars: Car[] = []
  /** 線上的比賽時鐘（秒，起跑前是負的），每一步物理往前推 */
  private clock = 0
  /** 線上比賽打開選單時：不能暫停，只是放開所有按鍵 */
  private hold = false
  /** 線上這局已經結算：不再送狀態、不再計圈（沒跑完的車交給電腦開，過線也不算成績） */
  private closed = false
  /** 線上自己跑完後在看別人跑：鏡頭跟著 `focus` 那台車，畫面上的速度、圈數也是那台的 */
  private spectating = false
  /** 選車畫面上車子要畫在哪一塊（選單蓋住的地方以外）；null 是整個畫面 */
  private stage: Rect | null = null

  constructor(
    host: HTMLElement,
    emit: (e: RaceEvent) => void,
    onFrame: (f: HudFrame) => void,
    sound: boolean,
    music: boolean,
  ) {
    this.host = host
    this.emit = emit
    this.onFrame = onFrame
    // 不支援 WebGL 時這裡會丟錯，由呼叫的人顯示訊息
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    const coarse = window.matchMedia('(pointer: coarse)').matches
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, coarse ? 1.75 : 2)
    this.renderer.setPixelRatio(this.pixelRatio)
    host.appendChild(this.renderer.domElement)
    this.speedBlur = new SpeedBlur(Math.min(4, this.renderer.capabilities.maxSamples))
    this.parts = createCarParts()
    this.audio = new RaceAudio(sound, music)
    this.frame = {
      speedKmh: 0,
      raceMs: 0,
      lapMs: 0,
      lap: 1,
      laps: 1,
      position: 1,
      total: 1,
      drift: -1,
      boost: false,
      cars: new Float32Array(0),
    }
    this.input.attach()
    this.resize = new ResizeObserver(() => this.fit())
    this.resize.observe(host)
    this.fit()
    this.raf = requestAnimationFrame(this.loop)
  }

  /** 手機上的觸控按鈕 */
  setTouch(patch: Partial<TouchState>) {
    Object.assign(this.input.touch, patch)
  }

  /** 選單畫面：只有電腦在跑，鏡頭繞著車轉 */
  preview(def: TrackDef) {
    this.online = null
    this.hold = false
    this.closed = false
    this.loadTrack(def)
    this.setup = null
    this.spawn(null, 5, 'normal')
    this.paused = false
    this.input.capture = false
    this.audio.setActive(false)
    this.audio.setMusicPaused(false)
    this.audio.setSong(def.id)
    this.audio.setMood('menu')
    this.setPhase('preview')
    this.resume()
  }

  /** 選車畫面：選的車停在起跑線上，鏡頭慢慢繞著轉。換車種、車色時再呼叫一次，只換車 */
  showroom(def: TrackDef, kind: CarKind, color: number) {
    const same = this.phase === 'showroom' && this.def?.id === def.id
    if (same && this.player?.info.car === kind && this.player.info.color === color) return
    if (!same) {
      this.online = null
      this.driving = false
      this.hold = false
      this.closed = false
      this.setup = null
      this.paused = false
      this.input.capture = false
      this.loadTrack(def)
      this.smoke.clear()
      this.glow.clear()
      this.wind.clear()
      this.audio.setActive(false)
      this.audio.setMusicPaused(false)
      this.audio.setSong(def.id)
      this.audio.setMood('menu')
    }
    this.spawn({ color, car: kind }, 0, 'normal')
    const track = this.track!
    placeCar(this.player!.car, track, track.length - 16, 0)
    if (!same) {
      this.setPhase('showroom')
      this.resume()
    }
  }

  /** 選車畫面上車子要畫在哪一塊（相對遊戲畫面的 CSS 像素）；null 是整個畫面 */
  setStage(rect: Rect | null) {
    this.stage = rect
  }

  startRace(setup: RaceSetup) {
    this.online = null
    this.driving = false
    this.hold = false
    this.closed = false
    this.loadTrack(setup.track)
    this.setup = setup
    this.spawn({ color: setup.color, car: setup.car }, setup.opponents, setup.difficulty)
    this.countdown = 3
    this.lastCount = 4
    this.raceTime = 0
    this.wrongTime = 0
    this.stuckTime = 0
    this.hint = null
    this.paused = false
    this.input.reset()
    this.input.capture = true
    this.smoke.clear()
    this.glow.clear()
    this.wind.clear()
    this.audio.setActive(true)
    this.audio.setMusicPaused(false)
    this.audio.setSong(setup.track.id)
    this.audio.setMood('menu')
    this.setPhase('countdown')
    this.resume()
  }

  restart() {
    if (this.setup && !this.online) this.startRace(this.setup)
  }

  /** 線上比賽開局（或重新整理後接著跑、觀戰）。自己的車每秒用 `link.state` 送 20 次狀態，`link.ping` 對時 */
  startOnline(setup: OnlineSetup, link: OnlineLink) {
    this.loadTrack(setup.track)
    const me = setup.me
    const mine = me !== null ? setup.seats[me] : null
    this.setup = {
      track: setup.track,
      laps: setup.laps,
      opponents: setup.seats.length - 1,
      difficulty: 'normal',
      color: mine?.color ?? CAR_COLORS[0].hex,
      car: mine?.car ?? 'all',
    }
    this.online = {
      goAt: setup.goAt,
      link,
      timer: 0,
      pingTimer: 0,
      pings: 0,
      bestRtt: Infinity,
      bumpTimer: 0,
      bumps: new Map(),
    }
    this.hold = false
    this.closed = false
    this.driving = setup.driving
    this.difficulty = setup.difficulty
    this.botSeats = [...setup.bots]
    this.hitAt.clear()
    this.spawnOnline(setup)
    this.clock = (performance.now() - setup.goAt) / 1000
    this.countdown = -this.clock
    this.lastCount = 4
    this.raceTime = Math.max(0, this.clock)
    this.wrongTime = 0
    this.stuckTime = 0
    this.hint = null
    this.paused = false
    this.input.reset()
    this.input.capture = me !== null
    this.smoke.clear()
    this.glow.clear()
    this.wind.clear()
    this.audio.setActive(true)
    this.audio.setMusicPaused(false)
    this.audio.setSong(setup.track.id)
    this.audio.setMood(this.clock < 0 ? 'menu' : 'race')
    this.setPhase(this.clock < 0 ? 'countdown' : 'racing')
    this.resume()
  }

  /**
   * 再對一次時：每份 view 都能推出起跑時間，但訊息在路上、瀏覽器在忙都會讓推出來的時間偏晚，
   * 所以只往早的方向修（取看過最早的），時鐘只會往前跳一點點
   */
  syncClock(goAt: number) {
    const online = this.online
    // 對時（pong）比較準，有了就不用 view 推的
    if (online && online.bestRtt === Infinity && goAt < online.goAt) online.goAt = goAt
  }

  /** 對時的回應：`t` 是送 ping 時的 performance.now()，`clock` 是伺服器那時的比賽時間（毫秒） */
  onlinePong(t: number, clock: number) {
    const online = this.online
    if (!online) return
    const now = performance.now()
    const rtt = now - t
    if (rtt < 0 || rtt > online.bestRtt) return
    online.bestRtt = rtt
    // 伺服器大約在來回的正中間看時鐘
    online.goAt = (t + now) / 2 - clock
  }

  /**
   * 座位 `from` 的車撞到自己這邊開的座位 `to`（自己的車或負責開的電腦；對方的瀏覽器算的）：
   * 這次碰撞自己還沒算過的話，把速度變化加到那台車上
   */
  onlineBump(from: number, to: number, v: number[]) {
    const target = this.racers[this.seatIndex[to] ?? -1]
    const other = this.racers[this.seatIndex[from] ?? -1]
    // 剛換人開電腦時，撞電腦的通知可能晚到：已經不是自己開的就不理
    if (!this.online || !target || target.remote || !other?.remote || this.phase === 'countdown') return
    const vx = v[0]
    const vz = v[1]
    if (!Number.isFinite(vx) || !Number.isFinite(vz)) return
    const now = performance.now()
    const key = pairKey(to, from)
    if (now - (this.hitAt.get(key) ?? -Infinity) < BUMP_DEDUPE_MS) return
    this.hitAt.set(key, now)
    target.car.vx += vx
    target.car.vz += vz
    target.impact = Math.max(target.impact, Math.hypot(vx, vz) * 1.5)
  }

  /** 收到伺服器轉送的車子狀態：每列是 [座位, ...狀態] */
  onlineCars(rows: number[][]) {
    if (!this.online) return
    const now = performance.now()
    const clock = (now - this.online.goAt) / 1000
    for (const row of rows) {
      const r = this.racers[this.seatIndex[row[0]] ?? -1]
      r?.remote?.push(row.slice(1), clock, now)
    }
  }

  /** 伺服器記的每個座位的圈數和完賽時間（別人的車靠這個排名次）；回到房間的人的車馬上拿掉 */
  onlineResults(results: OnlineResult[]) {
    if (!this.online) return
    results.forEach((res, seat) => {
      const r = this.racers[this.seatIndex[seat] ?? -1]
      if (!r?.remote) return
      this.setLaps(r, res.lapTimes, res.finish)
      if (res.retired) r.remote.drop()
    })
  }

  /**
   * 伺服器指定誰負責開電腦。輪到自己：電腦從現在畫的位置和速度接著開；
   * 換給別人：改成照收到的狀態畫，先墊上自己最後的狀態，新的人的狀態進來前不會不見
   */
  setDriving(driving: boolean) {
    if (!this.online || driving === this.driving) return
    this.driving = driving
    const now = performance.now()
    for (const r of this.racers) {
      if (!r.bot) continue
      const c = r.car
      if (driving) {
        r.remote = null
        r.ai = this.botAi(r.seat)
        c.power = r.ai.power
        c.drift = c.driftTime = c.driftHold = c.driftExit = 0
        c.boost = 0
      } else {
        r.ai = null
        r.remote = new RemoteDriver()
        r.remote.push(this.encode(c), this.clock, now)
      }
    }
    this.refreshLocals()
  }

  /** 線上這局結算了：還沒跑完的話交給電腦開、鏡頭繞著車轉（在看別人跑的話回到自己的車） */
  endOnline() {
    if (!this.online || this.phase === 'preview') return
    this.closed = true
    if (this.spectating) this.spectate(false)
    if (this.phase === 'finished') return
    const p = this.player
    if (p) {
      p.ai = cruiseAi()
      p.car.power = p.ai.power
      p.car.drift = 0
    }
    this.input.capture = false
    this.hold = false
    this.audio.setMood('menu')
    if (this.hint) {
      this.hint = null
      this.emit({ type: 'hint', hint: null })
    }
    this.setPhase('finished')
  }

  /** 觀戰時換下一台車（看得到的，自己跑完的車不算）；回傳現在看的座位 */
  cycleFocus(): number | null {
    if (!this.online || (this.player && !this.spectating) || this.racers.length === 0) return null
    const now = performance.now()
    for (let k = 1; k <= this.racers.length; k++) {
      const i = (this.focus + k) % this.racers.length
      const r = this.racers[i]
      if (r === this.player) continue
      if (!r.remote || r.remote.visible(now) || k === this.racers.length) {
        this.focus = i
        break
      }
    }
    this.camReady = false
    return this.seatOf[this.focus] ?? null
  }

  /**
   * 線上自己跑完後：看別人跑（`on`）或回到自己的車。先看還在跑的車裡跑最前面的；
   * 沒有別的車可以看就不切換，回傳 null
   */
  spectate(on: boolean): number | null {
    const p = this.player
    if (!this.online || !p || p.finish === null) return null
    if (!on) {
      this.spectating = false
      this.focus = this.racers.indexOf(p)
      this.camReady = false
      this.audio.setMood('menu')
      return null
    }
    const now = performance.now()
    let best = -1
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i]
      if (r === p || (r.remote && !r.remote.visible(now))) continue
      const running = r.finish === null
      const b = best < 0 ? null : this.racers[best]
      // 還在跑的優先，再來看進度
      if (!b || (running && b.finish !== null) || (running === (b.finish === null) && r.car.progress > b.car.progress)) {
        best = i
      }
    }
    if (best < 0) return null
    this.spectating = true
    this.focus = best
    this.camReady = false
    this.audio.setMood('race')
    return this.seatOf[best] ?? null
  }

  /** 線上時鏡頭跟著的座位（觀戰時用） */
  focusSeat(): number | null {
    return this.online ? (this.seatOf[this.focus] ?? null) : null
  }

  /** 第一次按開始時呼叫（要在使用者操作的事件裡），之後才有聲音 */
  unlockAudio() {
    this.audio.unlock()
  }

  setSound(on: boolean) {
    this.audio.setEnabled(on)
  }

  setMusic(on: boolean) {
    this.audio.setMusic(on)
  }

  setAutoGas(on: boolean) {
    this.input.autoGas = on
  }

  setPaused(paused: boolean) {
    if (this.online) {
      // 線上比賽不能暫停（別人還在跑）：打開選單時放開所有按鍵，車子自己滑
      this.hold = paused
      this.input.reset()
      return
    }
    if (this.paused === paused || this.disposed) return
    this.paused = paused
    this.input.reset()
    this.audio.setActive(!paused && this.phase !== 'preview')
    this.audio.setMusicPaused(paused)
    if (paused) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
      this.render()
    } else this.resume()
  }

  cycleCamera(): number {
    this.camMode = (this.camMode + 1) % CAMERA_NAMES.length
    this.camReady = false
    return this.camMode
  }

  setCamera(mode: number) {
    this.camMode = clamp(mode, 0, CAMERA_NAMES.length - 1)
    this.camReady = false
  }

  /** 卡住或開反了：放回賽道中間 */
  respawn() {
    if (this.player && this.phase === 'racing') {
      this.reset(this.player)
      this.stuckTime = this.wrongTime = 0
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resize.disconnect()
    this.input.detach()
    this.audio.dispose()
    this.clearRacers()
    if (this.world) {
      this.world.scene.remove(this.smoke.points, this.glow.points, this.wind.mesh, this.skids.mesh)
      this.world.dispose()
    }
    this.smoke.dispose()
    this.glow.dispose()
    this.wind.dispose()
    this.skids.dispose()
    disposeCarParts(this.parts)
    this.speedBlur.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  private fit() {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.renderer.getDrawingBufferSize(this.bufferSize)
    this.speedBlur.setSize(this.bufferSize.x, this.bufferSize.y)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (this.paused) this.render()
  }

  private resume() {
    if (this.raf || this.disposed) return
    this.last = 0
    this.raf = requestAnimationFrame(this.loop)
  }

  private setPhase(phase: Phase) {
    this.phase = phase
    this.emit({ type: 'phase', phase })
  }

  private loadTrack(def: TrackDef) {
    if (this.world && this.def?.id === def.id) return
    this.clearRacers()
    if (this.world) {
      this.world.scene.remove(this.smoke.points, this.glow.points, this.wind.mesh, this.skids.mesh)
      this.world.dispose()
    }
    this.def = def
    this.track = new TrackPath(def)
    this.world = buildWorld(this.track, def, this.renderer.capabilities.getMaxAnisotropy())
    this.world.scene.add(this.smoke.points, this.glow.points, this.wind.mesh, this.skids.mesh)
    this.dust.setHex(def.theme.dust)
    this.smoke.clear()
    this.glow.clear()
    this.camReady = false
    this.emit({ type: 'map', map: this.minimap() })
  }

  private minimap(): MiniMap {
    const t = this.track!
    const pad = t.wall + 10
    const x = t.minX - pad
    const z = t.minZ - pad
    const w = t.maxX - t.minX + pad * 2
    const h = t.maxZ - t.minZ + pad * 2
    let d = ''
    for (let i = 0; i < t.n; i += 3) d += `${i ? 'L' : 'M'}${t.px[i].toFixed(1)} ${t.pz[i].toFixed(1)}`
    return { d: `${d}Z`, viewBox: `${x.toFixed(1)} ${z.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`, size: Math.max(w, h) }
  }

  private clearRacers() {
    for (const r of this.racers) {
      this.world?.scene.remove(r.model.root)
      r.model.dispose()
    }
    this.racers = []
    this.cars = []
    this.player = null
    this.spectating = false
    this.skids.clear()
    this.seatIndex = []
    this.seatOf = []
    this.locals = []
    this.localCars = []
  }

  /** 排起跑格：電腦在前面（越前面越弱），玩家在最後一排。電腦的車色不和玩家重複，車種隨機 */
  private spawn(player: { color: number; car: CarKind } | null, opponents: number, difficulty: Difficulty) {
    this.clearRacers()
    const track = this.track!
    const palette = shuffled(CAR_COLORS.map((c) => c.hex).filter((hex) => hex !== player?.color))
    const infos: RacerInfo[] = []
    for (let i = 0; i < opponents; i++) {
      const car = CARS[Math.floor(Math.random() * CARS.length)].kind
      infos.push({ name: AI_NAMES[i], color: palette[i % palette.length], car, player: false })
    }
    if (player) infos.push({ name: '你', color: player.color, car: player.car, player: true })

    infos.forEach((info, slot) => {
      const car = newCar(carSpec(info.car))
      const back = 9 + Math.floor(slot / 2) * 10 + (slot % 2) * 5
      placeCar(car, track, track.length - back, slot % 2 === 0 ? 3.4 : -3.4)
      car.progress = -back
      const ai = info.player ? null : newAi(difficulty, opponents > 1 ? 1 - slot / (opponents - 1) : 0.5)
      if (ai) car.power = ai.power
      const model = new CarModel(this.parts, info.car, info.color)
      this.world!.scene.add(model.root)
      const racer: Racer = {
        car,
        model,
        info,
        ai,
        remote: null,
        seat: -1,
        bot: false,
        ctl: { throttle: 0, brake: 0, steer: 0, drift: false },
        lapStart: 0,
        lapsDone: 0,
        lapTimes: [],
        bestLap: null,
        finish: null,
        impact: 0,
        landing: 0,
        boosting: false,
      }
      this.racers.push(racer)
      if (info.player) this.player = racer
    })
    this.cars = this.racers.map((r) => r.car)
    this.focus = this.player ? this.racers.indexOf(this.player) : 0
    this.frame.cars = new Float32Array(this.racers.length * 2)
    this.camReady = false
    this.emit({ type: 'racers', racers: infos })
  }

  /**
   * 線上的起跑格：照伺服器抽的順序排。自己的車照單機版操作，自己負責開的電腦照單機版的電腦開，
   * 別人的車（含別人負責開的電腦）等狀態進來
   */
  private spawnOnline(setup: OnlineSetup) {
    this.clearRacers()
    const track = this.track!
    const bots = new Set(setup.bots)
    const botStates = new Map(setup.botStates.map((row) => [row[0], row.slice(1)]))
    setup.seats.forEach((seat, s) => {
      const info: RacerInfo = { name: seat.name, color: seat.color, car: seat.car, player: s === setup.me }
      const car = newCar(carSpec(seat.car))
      const slot = setup.grid[s] ?? s
      const back = 9 + Math.floor(slot / 2) * 10 + (slot % 2) * 5
      placeCar(car, track, track.length - back, slot % 2 === 0 ? 3.4 : -3.4)
      car.progress = -back
      const model = new CarModel(this.parts, info.car, info.color)
      this.world!.scene.add(model.root)
      const bot = bots.has(s)
      const ai = bot && setup.driving ? this.botAi(s) : null
      if (ai) car.power = ai.power
      const racer: Racer = {
        car,
        model,
        info,
        ai,
        remote: info.player || ai ? null : new RemoteDriver(),
        seat: s,
        bot,
        ctl: { throttle: 0, brake: 0, steer: 0, drift: false },
        lapStart: 0,
        lapsDone: 0,
        lapTimes: [],
        bestLap: null,
        finish: null,
        impact: 0,
        landing: 0,
        boosting: false,
      }
      // 重新整理後接著跑：自己的車、自己負責開的電腦放回最後送出的位置（速度歸零），圈數照伺服器記的
      const res = setup.results[s]
      if (res) this.setLaps(racer, res.lapTimes, info.player ? null : res.finish)
      const last = info.player ? setup.resume : ai ? botStates.get(s) : undefined
      if (last) this.placeAt(car, last)
      this.seatIndex[s] = this.racers.length
      this.seatOf.push(s)
      this.racers.push(racer)
      if (info.player) this.player = racer
    })
    this.cars = this.racers.map((r) => r.car)
    this.refreshLocals()
    // 觀戰：先看最前面那一格的車
    const front = setup.grid.indexOf(0)
    this.focus = this.player ? this.racers.indexOf(this.player) : (this.seatIndex[front] ?? 0)
    this.frame.cars = new Float32Array(this.racers.length * 2)
    this.camReady = false
    this.emit({ type: 'racers', racers: this.racers.map((r) => r.info) })
  }

  /** 自己負責開的電腦：照電腦的順序分強弱（第一台最強），換人開時同一台的強弱不變 */
  private botAi(seat: number): AiDriver {
    const k = this.botSeats.indexOf(seat)
    const n = this.botSeats.length
    return newAi(this.difficulty, n > 1 ? k / (n - 1) : 0.5)
  }

  private refreshLocals() {
    this.locals = this.racers.filter((r) => !r.remote)
    this.localCars = this.locals.map((r) => r.car)
  }

  /** 圈數和完賽時間照伺服器記的 */
  private setLaps(r: Racer, lapTimes: number[], finish: number | null) {
    r.lapTimes = [...lapTimes]
    r.lapsDone = lapTimes.length
    r.bestLap = lapTimes.length ? Math.min(...lapTimes) : null
    r.lapStart = lapTimes.reduce((a, b) => a + b, 0) / 1000
    r.finish = finish
  }

  /** 放到送出過的狀態 `d` 的位置（速度歸零） */
  private placeAt(car: Car, d: number[]) {
    const track = this.track!
    car.x = d[1]
    car.z = d[2]
    car.heading = d[3]
    car.progress = d[9]
    car.loc.i = track.indexAt(((d[9] % track.length) + track.length) % track.length)
    track.locate(car.x, car.z, car.loc)
    car.y = car.loc.y
    car.vy = car.air = 0
  }

  private encode(c: Car): number[] {
    return encodeState(c, this.clock, c.drift !== 0 ? driftLevel(c) : 0)
  }

  /** 線上：還在跑的真人裡跑最前面的進度（電腦照這個調整動力）；起跑前、真人都跑完了是 null */
  private leaderProgress(): number | null {
    if (this.clock <= 0) return null
    let best: number | null = null
    for (const r of this.racers) {
      if (r.bot || r.finish !== null) continue
      if (best === null || r.car.progress > best) best = r.car.progress
    }
    return best
  }

  private reset(r: Racer) {
    const track = this.track!
    const k = this.racers.indexOf(r)
    this.skids.lift(k * 2)
    this.skids.lift(k * 2 + 1)
    const lat = clamp(r.car.loc.lat, -(track.halfWidth - 2), track.halfWidth - 2)
    const progress = r.car.progress
    placeCar(r.car, track, r.car.loc.s, lat)
    r.car.progress = progress
    if (r.ai) r.ai.stuck = 0
  }

  private readonly loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop)
    // 一格最多算 0.05 秒（切到背景回來不要一下子跳很遠）；線上的時鐘照真實時間走，
    // 放寬到 0.1 秒，慢的裝置（每秒 10 格）車子才不會比別人慢
    const dt = this.last ? Math.min(this.online ? 0.1 : 0.05, (now - this.last) / 1000) : 0
    this.last = now
    this.watchPerformance(dt)
    this.update(dt)
    this.render()
  }

  /** 一直掉幀就降低解析度（手機、內顯） */
  private watchPerformance(dt: number) {
    if (dt > 0.026) this.slowFrames++
    else this.slowFrames = Math.max(0, this.slowFrames - 2)
    if (this.slowFrames > 90 && this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25)
      this.renderer.setPixelRatio(this.pixelRatio)
      this.fit()
      this.slowFrames = 0
    }
  }

  private render() {
    if (!this.world) return
    this.world.follow(this.camera.position)
    if (this.blur > 0.02 || this.lines > 0.02) {
      this.speedBlur.render(this.renderer, this.world.scene, this.camera, this.blur, this.lines, this.linesTime)
    } else this.renderer.render(this.world.scene, this.camera)
  }

  private update(dt: number) {
    if (!this.track || this.racers.length === 0) return
    this.time += dt
    if (this.phase === 'countdown' || this.phase === 'racing') {
      const actions: PadAction[] = []
      this.input.read(this.playerCtl, actions)
      for (const action of actions) this.emit({ type: 'pad', action })
      if (this.hold) {
        const c = this.playerCtl
        c.throttle = c.brake = c.steer = 0
        c.drift = false
      }
    }
    const online = this.online
    // 線上的時鐘照牆上的時間走（切到背景回來時直接跳到現在），每一步物理再往前推一點，跑完剛好是現在
    if (online) {
      const pending = Math.min(MAX_STEPS, Math.floor((this.acc + dt) / STEP))
      this.clock = (performance.now() - online.goAt) / 1000 - pending * STEP
    }
    this.acc += dt
    let steps = 0
    while (this.acc >= STEP && steps < MAX_STEPS) {
      this.tick(STEP)
      this.acc -= STEP
      steps++
    }
    if (steps === MAX_STEPS) this.acc = 0
    if (online && (this.player || this.driving) && !this.closed) {
      online.timer -= dt
      if (online.timer <= 0) {
        online.timer = Math.max(0, online.timer + SEND_EVERY)
        const bots: number[][] = []
        if (this.driving) for (const r of this.locals) if (r.bot) bots.push([r.seat, ...this.encode(r.car)])
        online.link.state(this.player ? this.encode(this.player.car) : null, bots)
      }
      online.bumpTimer -= dt
      if (online.bumps.size > 0 && online.bumpTimer <= 0) {
        online.bumpTimer = BUMP_EVERY
        const hits: BumpHit[] = []
        for (const b of online.bumps.values()) {
          hits.push({ seat: b.seat, by: b.by, v: [Math.round(b.x * 100) / 100, Math.round(b.z * 100) / 100] })
        }
        online.link.bump(hits)
        online.bumps.clear()
      }
      online.pingTimer -= dt
      if (online.pingTimer <= 0) {
        online.pings++
        online.pingTimer = online.pings < PING_BURST ? PING_FIRST : PING_EVERY
        online.link.ping(performance.now())
      }
    }
    this.updateVisuals(dt)
    this.updateCamera(dt)
    this.updateAudio()
    if (this.phase !== 'preview' && this.phase !== 'showroom') this.emitFrame()
  }

  private tick(h: number) {
    // 選車畫面的車停著不動
    if (this.phase === 'showroom') return
    const track = this.track!
    const online = this.online !== null
    if (online) this.clock += h
    if (this.phase === 'countdown') {
      // 線上照伺服器的起跑時間倒數；前面幾秒（大家在載入賽道）不顯示數字
      this.countdown = online ? -this.clock : this.countdown - h
      const n = Math.max(0, Math.ceil(this.countdown))
      if (n !== this.lastCount && n <= 3) {
        this.lastCount = n
        this.audio.countdown(n)
        this.emit({ type: 'countdown', n })
        if (n === 0) {
          this.audio.setMood('race')
          this.setPhase('racing')
        }
      }
    }
    const moving = this.phase !== 'countdown'
    const player = this.player
    const now = online ? performance.now() : 0
    // 電腦照誰調整動力：單機是玩家；線上是還在跑的真人裡最前面的
    const pace = online
      ? this.driving
        ? this.leaderProgress()
        : null
      : player && this.phase === 'racing'
        ? player.car.progress
        : null
    for (const r of this.racers) {
      if (r.remote) {
        r.remote.apply(r.car, track, this.clock, h)
        continue
      }
      if (!moving) {
        r.ctl.throttle = r.ctl.brake = r.ctl.steer = 0
        r.ctl.drift = false
      } else if (r.ai) {
        driveAi(r.car, r.ai, track, this.cars, h, r.ctl)
        // 領先太多就放慢一點、落後太多就加把勁，比賽才不會一下子就拉開
        if (pace !== null && r !== player) {
          const gap = r.car.progress - pace
          r.car.power = r.ai.power * (1 + clamp(-gap / 600, -0.05, 0.06))
        }
      } else Object.assign(r.ctl, this.playerCtl)
      stepCar(r.car, r.ctl, track, h)
    }
    if (moving && online) this.collideOnline(now)
    else if (moving) collideCars(this.cars)
    for (const r of this.racers) {
      r.impact = Math.max(r.impact, r.car.impact)
      r.landing = Math.max(r.landing, r.car.landing)
    }
    if (this.phase === 'racing' || this.phase === 'finished') {
      this.raceTime = online ? Math.max(0, this.clock) : this.raceTime + h
      this.countLaps()
    }
    if (moving) this.checkStuck(h)
  }

  /**
   * 線上碰撞。自己這邊開的車（自己的車、負責開的電腦）互撞照單機版算；
   * 撞到別人的車時只推開自己這台、拿自己那一半的速度變化，對方那一半記下來送過去。
   * 對方剛送過這次碰撞的通知（已經套用了）就不再算一次。
   */
  private collideOnline(now: number) {
    const online = this.online
    if (!online) return
    if (this.localCars.length > 1) collideCars(this.localCars)
    for (const mine of this.locals) {
      for (const r of this.racers) {
        if (!r.remote?.visible(now)) continue
        const key = pairKey(mine.seat, r.seat)
        const recent = now - (this.hitAt.get(key) ?? -Infinity) < BUMP_DEDUPE_MS
        const vx = mine.car.vx
        const vz = mine.car.vz
        if (!collideRemote(mine.car, r.car, this.kick)) continue
        if (recent) {
          // 這次碰撞已經照對方的通知算過了：位置照樣推開，速度不要再改一次
          mine.car.vx = vx
          mine.car.vz = vz
          continue
        }
        this.hitAt.set(key, now)
        const pending = online.bumps.get(key)
        if (pending) {
          pending.x += this.kick.x
          pending.z += this.kick.z
        } else {
          online.bumps.set(key, { seat: r.seat, by: mine.bot ? mine.seat : undefined, x: this.kick.x, z: this.kick.z })
        }
      }
    }
  }

  private countLaps() {
    const L = this.track!.length
    const laps = this.setup?.laps ?? 1
    for (const r of this.racers) {
      // 別人的車圈數照伺服器記的（onlineResults）
      if (r.finish !== null || r.remote || this.closed) continue
      const done = Math.floor(r.car.progress / L)
      if (done <= r.lapsDone) continue
      r.lapsDone = done
      const ms = (this.raceTime - r.lapStart) * 1000
      r.lapStart = this.raceTime
      r.lapTimes.push(ms)
      const best = r.bestLap === null || ms < r.bestLap
      if (best) r.bestLap = ms
      if (done >= laps) r.finish = this.raceTime * 1000
      if (r === this.player) {
        if (r.finish !== null) this.playerFinished()
        else {
          const final = done === laps - 1
          this.audio.lap(final)
          if (final) this.audio.setMood('final')
          this.emit({ type: 'lap', lap: done, ms, at: this.raceTime * 1000, best: best && done > 1, final })
        }
      } else {
        // 自己負責開的電腦：替它回報過線
        if (r.bot) this.online?.link.botLap(r.seat, done, Math.round(this.raceTime * 1000))
        if (this.phase === 'finished' && r.finish !== null) this.emit({ type: 'standings', standings: this.standings() })
      }
    }
  }

  private playerFinished() {
    const p = this.player!
    this.setPhase('finished')
    // 過線後交給電腦開，鏡頭繞著車轉
    p.ai = cruiseAi()
    p.car.power = p.ai.power
    p.car.drift = 0
    this.input.capture = false
    this.audio.finish()
    this.audio.setMood('menu')
    if (this.hint) {
      this.hint = null
      this.emit({ type: 'hint', hint: null })
    }
    this.emit({
      type: 'finish',
      result: {
        track: this.def!.id,
        laps: this.setup!.laps,
        time: p.finish!,
        bestLap: p.bestLap!,
        lapTimes: [...p.lapTimes],
        standings: this.standings(),
      },
    })
  }

  /** 跑完的照完賽時間排，還在跑的照進度排 */
  private standings(): Standing[] {
    const list = [...this.racers].sort((a, b) => {
      if (a.finish !== null || b.finish !== null) {
        if (a.finish === null) return 1
        if (b.finish === null) return -1
        return a.finish - b.finish
      }
      return b.car.progress - a.car.progress
    })
    return list.map((r, i) => ({
      ...r.info,
      position: i + 1,
      time: r.finish,
      bestLap: r.bestLap,
      lapsDone: Math.max(0, r.lapsDone),
    }))
  }

  private rank(r: Racer): number {
    let ahead = 0
    for (const o of this.racers) {
      if (o === r) continue
      if (o.finish !== null) {
        if (r.finish === null || o.finish < r.finish) ahead++
      } else if (r.finish === null && o.car.progress > r.car.progress) ahead++
    }
    return ahead + 1
  }

  private checkStuck(h: number) {
    for (const r of this.racers) {
      if (!r.ai) continue
      if (Math.abs(r.car.speed) < 1.5) r.ai.stuck += h
      else r.ai.stuck = 0
      if (r.ai.stuck > 2.5) this.reset(r)
    }
    const p = this.player
    if (!p || this.phase !== 'racing') return
    // 逆向：車頭和賽道方向相反而且在往前開；卡住：好幾秒都開不動（頂著牆）
    const c = p.car
    const facing = Math.sin(c.heading) * c.loc.tx + Math.cos(c.heading) * c.loc.tz
    if (facing < -0.3 && c.speed > 3) this.wrongTime += h
    else this.wrongTime = 0
    if (Math.abs(c.speed) < 2.5) this.stuckTime += h
    else this.stuckTime = 0
    const hint: Hint = this.wrongTime > 1.2 ? 'wrongWay' : this.stuckTime > 3 ? 'stuck' : null
    if (hint !== this.hint) {
      this.hint = hint
      this.emit({ type: 'hint', hint })
    }
  }

  private updateVisuals(dt: number) {
    const night = this.def!.theme.night === true
    const now = performance.now()
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i]
      const c = r.car
      // 別人的車：還沒收到狀態時停在起跑格上；斷線、太久沒更新就不畫
      if (r.remote) {
        const shown = r.remote.visible(now) || (!r.remote.started && this.phase === 'countdown')
        r.model.root.visible = shown
        if (!shown) continue
      }
      // 路面往車頭方向、往車子左邊的坡度（斜著開過傾斜的彎道時兩個都有）
      const sinH = Math.sin(c.heading)
      const cosH = Math.cos(c.heading)
      const { tx, tz, grade, bank } = c.loc
      const slope = grade * (sinH * tx + cosH * tz) + bank * (sinH * tz - cosH * tx)
      const side = grade * (cosH * tx - sinH * tz) + bank * (cosH * tz + sinH * tx)
      r.model.sync(c, slope, side, dt, this.time)
      this.spawnParticles(r, dt, night, i === this.focus)
      this.markSkids(r, i)
    }
    this.skids.flush()
    this.keepWatching(now)
    const scale = this.renderer.domElement.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360))
    this.smoke.update(dt, scale)
    this.glow.update(dt, scale)

    const light = this.world!.headlight
    const f = this.racers[this.focus]?.car
    if (light && f) {
      const sx = Math.sin(f.heading)
      const cz = Math.cos(f.heading)
      light.position.set(f.x + sx * 1.8, f.y + 1.1, f.z + cz * 1.8)
      light.target.position.set(f.x + sx * 30, f.y, f.z + cz * 30)
    }
  }

  /** 觀戰時（沒有座位、或跑完後在看別人）看的那台車不見了：換下一台，通知畫面換名字 */
  private keepWatching(now: number) {
    if (!this.online || (this.player && !this.spectating)) return
    const watched = this.racers[this.focus]
    if (!watched?.remote?.started || watched.remote.visible(now)) return
    const seat = this.cycleFocus()
    if (seat !== null && this.racers[this.focus] !== watched) this.emit({ type: 'focus', seat })
  }

  /** 胎痕：甩尾、側滑時兩個後輪在路面留下黑線；騰空、輪子開出柏油路面時不畫。`index` 是第幾台車 */
  private markSkids(r: Racer, index: number) {
    const c = r.car
    const loc = c.loc
    const track = this.track!
    const airborne = c.air > 0 && c.y > loc.y + 0.08
    let strength = 0
    if (!airborne && Math.abs(c.speed) > 4) {
      // 甩尾集氣越多越深；沒按甩尾、只是轉太急側滑時淡一點
      strength = c.drift !== 0 ? 0.55 + driftLevel(c) * 0.1 : smoothstep(4, 9, Math.abs(c.slip)) * 0.45
    }
    const sx = Math.sin(c.heading)
    const cz = Math.cos(c.heading)
    const rear = c.spec.length * 0.3
    const wheels = c.spec.width * 0.42
    for (let side = 0; side < 2; side++) {
      const w = side === 0 ? -wheels : wheels
      const dx = -sx * rear + cz * w
      const dz = -cz * rear - sx * w
      // 輪子離中心線多遠、沿著賽道差多少：路面高度照車子那裡的傾斜和坡度推過去
      const lat = loc.lat + dx * loc.tz - dz * loc.tx
      const along = dx * loc.tx + dz * loc.tz
      const y = loc.y + loc.bank * (lat - loc.lat) + loc.grade * along + SKID_LIFT
      const on = strength > 0 && Math.abs(lat) < track.halfWidth - 0.1
      this.skids.mark(index * 2 + side, c.x + dx, y, c.z + dz, on ? strength : 0)
    }
  }

  private spawnParticles(r: Racer, dt: number, night: boolean, focus: boolean) {
    const c = r.car
    const sx = Math.sin(c.heading)
    const cz = Math.cos(c.heading)
    const chance = (rate: number) => Math.random() < rate * dt
    const sliding = c.drift !== 0 || Math.abs(c.slip) > 4
    const dusty = c.offroad && Math.abs(c.speed) > 6
    // 後輪和車尾的位置：照車子的大小
    const rear = c.spec.length * 0.3
    const wheels = c.spec.width * 0.47
    const tail = c.spec.length * 0.55
    for (const side of [-1, 1]) {
      const wx = c.x - sx * rear + cz * wheels * side
      const wz = c.z - cz * rear - sx * wheels * side
      if ((sliding || dusty) && chance(dusty ? 40 : 30)) {
        this.smoke.emit(
          wx,
          c.y + 0.3,
          wz,
          -c.vx * 0.08 + (Math.random() - 0.5) * 2,
          0.6 + Math.random() * 0.8,
          -c.vz * 0.08 + (Math.random() - 0.5) * 2,
          dusty ? this.dust : night ? SMOKE_NIGHT : SMOKE,
          1.1,
          2.8,
          0.9,
          dusty ? 0.5 : 0.32,
        )
      }
      if (c.drift !== 0 && chance(45)) {
        const level = driftLevel(c)
        this.glow.emit(
          wx,
          c.y + 0.15,
          wz,
          (Math.random() - 0.5) * 4 - c.vx * 0.15,
          1 + Math.random() * 2.5,
          (Math.random() - 0.5) * 4 - c.vz * 0.15,
          SPARK[level],
          level === 0 ? 0.18 : 0.32,
          -0.2,
          0.22,
          1,
        )
      }
    }
    if (c.boost > 0 && chance(70)) {
      this.glow.emit(
        c.x - sx * tail + (Math.random() - 0.5) * 0.6,
        c.y + 0.45,
        c.z - cz * tail + (Math.random() - 0.5) * 0.6,
        c.vx * 0.6 - sx * 6,
        0.5,
        c.vz * 0.6 - cz * 6,
        FLAME,
        0.7,
        1.6,
        0.18,
        0.9,
      )
    }
    if (c.boost > 0 && !r.boosting && focus) this.audio.boost()
    r.boosting = c.boost > 0

    // 騰空後落地：四個輪子揚起一圈塵土，車身往下一沉
    if (r.landing > 2.5) {
      r.model.land(r.landing)
      const n = Math.min(14, Math.round(r.landing * 1.5))
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2
        this.smoke.emit(
          c.x + Math.sin(a) * 1.4,
          c.loc.y + 0.2,
          c.z + Math.cos(a) * 1.4,
          Math.sin(a) * 3 + c.vx * 0.3,
          0.5 + Math.random(),
          Math.cos(a) * 3 + c.vz * 0.3,
          night ? SMOKE_NIGHT : this.dust,
          1,
          3,
          0.7,
          0.4,
        )
      }
      if (focus) {
        this.shake = Math.min(0.45, this.shake + r.landing * 0.025)
        this.audio.land(r.landing)
      }
    }
    r.landing = 0

    if (r.impact > 3) {
      const side = Math.abs(c.loc.lat) > this.track!.wall - 2 ? Math.sign(c.loc.lat) : 0
      const px = c.x + c.loc.tz * side
      const pz = c.z - c.loc.tx * side
      const n = Math.min(24, Math.round(r.impact * 1.5))
      for (let k = 0; k < n; k++) {
        this.glow.emit(
          px,
          c.y + 0.6,
          pz,
          (Math.random() - 0.5) * 9,
          Math.random() * 5,
          (Math.random() - 0.5) * 9,
          CRASH,
          0.22,
          0,
          0.25 + Math.random() * 0.3,
          1,
        )
      }
      if (focus) {
        this.shake = Math.min(0.5, this.shake + r.impact * 0.03)
        this.audio.crash(r.impact)
      }
    }
    r.impact = 0
  }

  private updateCamera(dt: number) {
    const r = this.racers[this.focus]
    if (!r) return
    const c = r.car
    const cam = this.camera
    if (this.phase === 'showroom') {
      this.showroomCamera(c, dt)
      return
    }
    if (cam.view?.enabled) cam.clearViewOffset()
    // 跑完後看別人跑：和觀戰一樣用追車的鏡頭
    const orbiting = this.phase === 'preview' || (this.phase === 'finished' && !this.spectating)
    const live = this.phase === 'countdown' || this.phase === 'racing' || this.spectating
    const k = (rate: number) => (this.camReady ? 1 - Math.exp(-rate * dt) : 1)
    const speedT = clamp(Math.abs(c.speed) / CAR.maxSpeed, 0, 1.3)
    const boosting = c.boost > 0

    // 視角：越快越廣、噴射時再拉開（拉開得快、收回得慢，噴射一開就像被往後扯）
    const fovTarget = orbiting ? 50 : BASE_FOV + speedT * FOV_SPEED + (boosting ? FOV_BOOST : 0)
    this.fov += (fovTarget - this.fov) * k(fovTarget > this.fov ? 6 : 2.5)
    const shown = this.screenFov(this.fov)
    // 推軌變焦：視角變廣的同時鏡頭往車子推近，車子在畫面上差不多一樣大，只有四周的景物被拉開、往後衝
    const zoom = orbiting ? 1 : Math.tan((this.screenFov(BASE_FOV) * Math.PI) / 360) / Math.tan((shown * Math.PI) / 360)
    const accel = this.camReady && dt > 0 ? (c.speed - this.prevSpeed) / dt : 0
    this.prevSpeed = c.speed
    this.surge += (clamp(accel, -10, 24) - this.surge) * k(3)

    if (orbiting) {
      this.orbit += dt * 0.2
      const a = c.heading + Math.PI + Math.sin(this.orbit) * 1.25
      const dist = 11 + Math.sin(this.orbit * 0.7) * 2
      this.look.set(c.x + Math.sin(a) * dist, c.y + 3.4, c.z + Math.cos(a) * dist)
      this.camPos.lerp(this.look, k(3))
      this.keepAboveRoad(c, this.camPos, 1.5)
      cam.position.copy(this.camPos)
      cam.lookAt(c.x, c.y + 1, c.z)
    } else if (this.camMode === 2) {
      // 車頂視角：鏡頭幾乎固定在車上
      this.camH = c.heading
      const sx = Math.sin(c.heading)
      const cz = Math.cos(c.heading)
      this.camPos.set(c.x + sx * 0.1, c.y + 1.5, c.z + cz * 0.1)
      cam.position.copy(this.camPos)
      cam.lookAt(c.x + sx * 22, this.track!.heightAt(c.loc.s + 22) + 0.9, c.z + cz * 22)
    } else {
      const cfg = CAMS[this.camMode]
      let want = c.heading
      // 甩尾時鏡頭看向車子滑行的方向，畫面才看得到車身打橫
      if (c.speed > 4) want += wrapAngle(Math.atan2(c.vx, c.vz) - c.heading) * 0.5
      if (!this.camReady) this.camH = want
      this.camH = wrapAngle(this.camH + wrapAngle(want - this.camH) * k(6))
      const fx = Math.sin(this.camH)
      const fz = Math.cos(this.camH)
      // 鏡頭跟著坡度俯仰（騰空時跟著車子往上、往下的方向）：陡坡上車子和前面的路才都在畫面裡，
      // 下坡時鏡頭也跟著抬高，不會鑽到車子後面的路面底下
      const along = fx * c.loc.tx + fz * c.loc.tz
      const slope = c.air > 0 ? c.vy / Math.max(10, Math.abs(c.speed)) : c.loc.grade * along
      if (!this.camReady) this.camGrade = slope
      this.camGrade += (clamp(slope, -0.8, 0.8) - this.camGrade) * k(5)
      const push = zoom ** cfg.dolly
      const dist = cfg.dist * push + this.surge * 0.07
      const height = cfg.look + (cfg.height - cfg.look) * push
      this.look.set(c.x - fx * dist, c.y - this.camGrade * dist + height, c.z - fz * dist)
      // 位置平滑會讓鏡頭落後「速度 ÷ 平滑係數」那麼遠（極速時多 4 公尺，車子變很小、反而不覺得快），往前補回去
      const a = k(14)
      // 暫停後繼續的第一格 dt 是 0（a 也是 0）：不補，不然 0 ÷ 0 會讓鏡頭位置變成 NaN、畫面全黑
      const lead = a > 0 && a < 1 ? ((1 - a) / a) * dt : 0
      this.look.x += c.vx * lead
      this.look.z += c.vz * lead
      this.camPos.lerp(this.look, a)
      this.keepAboveRoad(c, this.camPos, 1.2)
      cam.position.copy(this.camPos)
      cam.lookAt(c.x + fx * cfg.ahead, c.y + this.camGrade * cfg.ahead + cfg.look, c.z + fz * cfg.ahead)
    }
    this.camReady = true

    if (this.shake > 0.005) {
      cam.position.x += (Math.random() - 0.5) * this.shake
      cam.position.y += (Math.random() - 0.5) * this.shake
      this.shake *= Math.exp(-8 * dt)
    } else this.shake = 0

    // 高速效果（只在比賽中，選單和跑完後的繞車鏡頭不要）：左右糊掉、車頭的風線、畫面外圍的集中線
    const blurT = live ? smoothstep(BLUR_FROM, FX_FULL, speedT) : 0
    const blurTarget = Math.min(1.3, blurT + (boosting && blurT > 0 ? 0.35 : 0))
    this.blur += (blurTarget - this.blur) * k(5)
    const windT = live && !this.calm ? smoothstep(WIND_FROM, FX_FULL, speedT) : 0
    // 風線流到鏡頭前一點就要消失，不然會從鏡頭旁邊整條刷過去
    const behind = (c.x - cam.position.x) * Math.sin(c.heading) + (c.z - cam.position.z) * Math.cos(c.heading)
    this.wind.update(dt, c, windT, boosting, this.camMode === 2, this.camMode === 2 ? Infinity : behind - 1.6)
    const linesTarget =
      live && !this.calm
        ? Math.min(1, smoothstep(LINES_FROM, FX_FULL, speedT) * 0.45 + (boosting ? 0.75 * smoothstep(0.2, 0.45, speedT) : 0))
        : 0
    this.lines += (linesTarget - this.lines) * k(linesTarget > this.lines ? 8 : 3)
    this.linesTime += dt * (0.5 + speedT)

    cam.fov = shown
    cam.updateProjectionMatrix()
  }

  /**
   * 選車畫面的鏡頭：繞著車慢慢轉，照車長拉遠拉近，車子畫在 `stage` 那一塊的正中間
   * （把投影中心移過去，車子就不會被選單蓋住）
   */
  /** 鏡頭不要低過它底下的路面（沿著車子所在的那段賽道找，立體交叉時不會跳到另一層） */
  private keepAboveRoad(c: Car, pos: Vector3, clear: number) {
    const ds = (pos.x - c.x) * c.loc.tx + (pos.z - c.z) * c.loc.tz
    const floor = this.track!.heightAt(c.loc.s + ds) + clear
    if (pos.y < floor) pos.y = floor
  }

  private showroomCamera(c: Car, dt: number) {
    const cam = this.camera
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    const st = this.stage ?? { x: 0, y: 0, w, h }
    // 車子（看起來最長差不多是車長）最多佔那一塊的六成寬，也不要比那一塊的高度大太多
    const px = Math.max(80, Math.min(st.w * 0.6, st.h * 1.35))
    const dist = clamp((c.spec.length * h) / (2 * Math.tan((SHOWROOM_FOV * Math.PI) / 360) * px), 6, 80)
    this.orbit += dt * (this.calm ? 0.12 : 0.35)
    const a = c.heading + Math.PI * 0.8 + this.orbit
    const lift = 0.28
    const flat = dist * Math.cos(lift)
    cam.position.set(c.x + Math.sin(a) * flat, c.y + 0.6 + dist * Math.sin(lift), c.z + Math.cos(a) * flat)
    cam.lookAt(c.x, c.y + 0.6, c.z)
    this.camPos.copy(cam.position)
    this.fov = cam.fov = SHOWROOM_FOV
    this.blur = this.lines = this.shake = 0
    cam.setViewOffset(w, h, w / 2 - (st.x + st.w / 2), h / 2 - (st.y + st.h / 2), w, h)
    this.camReady = true
  }

  /** 直式螢幕放寬視角，左右才看得到路 */
  private screenFov(fov: number) {
    const aspect = this.camera.aspect
    if (aspect >= 1.3) return fov
    const t = Math.tan((fov * Math.PI) / 360) * (1.3 / aspect) ** 0.6
    return Math.min(100, (Math.atan(t) * 360) / Math.PI)
  }

  private updateAudio() {
    if (this.paused || this.phase === 'preview' || this.phase === 'showroom') return
    const r = this.racers[this.focus]
    if (!r) return
    const c = r.car
    // 倒數時踩油門會空催
    if (this.phase === 'countdown') this.audio.update(this.playerCtl.throttle * 22, this.playerCtl.throttle, 0, false)
    else this.audio.update(c.speed, c.throttle, c.slip, c.boost > 0)
  }

  private emitFrame() {
    const r = this.player && !this.spectating ? this.player : this.racers[this.focus]
    const c = r.car
    const f = this.frame
    f.speedKmh = Math.abs(c.speed) * 3.6
    f.raceMs = this.raceTime * 1000
    f.lapMs = r.finish !== null ? (r.lapTimes.at(-1) ?? 0) : (this.raceTime - r.lapStart) * 1000
    f.laps = this.setup?.laps ?? 1
    f.lap = Math.min(f.laps, r.lapsDone + 1)
    f.position = this.rank(r)
    f.total = this.racers.length
    f.drift = c.drift !== 0 ? driftLevel(c) : -1
    f.boost = c.boost > 0
    for (let i = 0; i < this.racers.length; i++) {
      f.cars[i * 2] = this.racers[i].car.x
      f.cars[i * 2 + 1] = this.racers[i].car.z
    }
    this.onFrame(f)
  }
}
