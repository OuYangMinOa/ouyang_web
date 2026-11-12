// 機甲對戰的 3D 畫面和遊戲迴圈：three.js 畫城市和機甲，每台在自己這邊跑物理的機甲（自己的、負責開的電腦）
// 照固定步長往前算，別人的照收到的狀態推算。開火打中、飛彈、鎖定都在這裡判斷，打中了送給伺服器算傷害。
// 偵察型的偵察機也在這裡：放出去後鏡頭跟著偵察機，掃到的敵人標在自己這隊的畫面和小地圖上，引爆時把炸到的人送給伺服器。
// 堡壘型、砲擊型的變身（E）也在這裡：堡壘型的盾牌擋住從正面打來的子彈、飛彈；砲擊型架砲後調砲管的仰角和左右（鏡頭在後面微微抬頭，沒有落點的標示），
// 迫擊砲彈照彈道飛，對方沒有任何提示（只聽得到很大的砲聲）。偵察機爆炸、迫擊砲彈炸到、狙擊型打中頭都是一發擊倒（傷害伺服器算）。
// 選單的背景是幾台機甲站在廣場上、鏡頭繞著轉。
import { Color, PerspectiveCamera, Vector3, WebGLRenderer, type Group } from 'three'
import { MechAudio } from './audio'
import { BotBrain, type BotOrders, type BotTarget } from './bot'
import {
  DRONE_PITCH_MAX,
  DRONE_PITCH_MIN,
  DroneModel,
  droneDistance,
  droneNoise,
  droneReach,
  inDroneView,
  newDrone,
  stepDrone,
  type DroneBody,
  type DroneInput,
} from './drone'
import { FortressModel } from './fortress'
import { Effects } from './fx'
import { Input, type Controls, type PadAction, type TouchState } from './input'
import { BED, buildMap, inBase, MapIndex, rayBox, WATER, type MapData, type Team } from './map'
import { createMechKit, disposeMechKit, MechModel, type MechKit, type Rig } from './mech'
import { MechLighting } from './mechlight'
import { MortarModel } from './mortar'
import {
  encodeState,
  HIT_EVERY,
  PING_BURST,
  PING_EVERY,
  PING_FIRST,
  RemoteMech,
  SEND_EVERY,
  type Difficulty,
  type HitReport,
  type KillWeapon,
  type MechaPlayer,
} from './online'
import { clamp, deployedReady, newBody, safe, stepDeploy, stepMech, wrapAngle, type MechBody, type MechInput } from './physics'
import { Post } from './post'
import { ReconModel } from './recon'
import { SniperModel } from './sniper'
import { armsOf, DRONE, ease, MECH, mechKind, MECHS, SHELL, shellElevation, shellRange, shellTime, TEAMS, type MechKind, type MechSpec } from './spec'
import { World } from './world'

export type Phase = 'preview' | 'showroom' | 'countdown' | 'battle' | 'ended'

export type Rect = { x: number; y: number; w: number; h: number }

export type SeatSetup = { name: string; team: Team; bot: boolean; kind: MechKind }

export type BattleSetup = {
  seats: SeatSetup[]
  /** 自己的座位；觀戰是 null */
  me: number | null
  /** 開打的時間（performance.now() 的時間軸） */
  goAt: number
  players: MechaPlayer[]
  /** 在隊伍裡排第幾（決定重生點） */
  slots: number[]
  driving: boolean
  difficulty: Difficulty
  /** 自己最後送出的狀態（重新整理後接著打） */
  resume: number[] | null
  /** 負責開電腦時：電腦最後的狀態 */
  botStates: number[][]
}

export type BattleLink = {
  state: (d: number[] | null, bots: number[][]) => void
  hits: (hits: HitReport[]) => void
  missile: (m: { id: number; o: number[]; dir: number[]; target?: number; goal?: number[]; by?: number }) => void
  boom: (b: { o: number[]; hits: number[]; by?: number; n: number }) => void
  shell: (s: { id: number; o: number[]; v: number[]; by?: number }) => void
  ping: (t: number) => void
}

export type KillInfo = { killer: number; victim: number; w: KillWeapon }

export type GameEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'countdown'; n: number }
  | { type: 'toast'; text: string }
  | { type: 'kill'; kill: KillInfo }
  | { type: 'pad'; action: 'menu' }
  | { type: 'lock'; locked: boolean }
  | { type: 'focus'; seat: number | null }
  /** 自己的偵察機：沒放出去、操控中、停在原地偵測 */
  | { type: 'drone'; mode: DroneMode }
  /** `by` 打下了 `seat` 的偵察機（擊倒訊息用） */
  | { type: 'downed'; seat: number; by: number }
  /** 自己活著、站在自己家的重生點裡（可以換機體） */
  | { type: 'home'; inside: boolean }
  /** 自己的機甲變身了沒（觸控按鈕跟著換） */
  | { type: 'deploy'; on: boolean }

export type DroneMode = 'none' | 'fly' | 'parked'

/** 每一格的儀表（直接改 DOM，不經過 React） */
export type HudFrame = {
  hp: number
  energy: number
  drained: boolean
  ammo: number
  /** 現在這把主武器的彈匣 */
  magazine: number
  /** 換彈的進度 0～1；沒在換是 -1 */
  reload: number
  /** 變身：-1 是不會變身，0 一般、1 變身中、2 變身好了、3 收回中 */
  deploy: number
  /**
   * 砲擊型架砲時：砲管的仰角（度）、仰角在可調範圍裡的位置（0 最低～1 最高）、照這個仰角在平地上大約打多遠（公尺）、飛幾秒
   * （只是照仰角算的，不知道真正落在哪裡）；沒架砲是 null
   */
  mortar: { elev: number; level: number; range: number; time: number } | null
  missiles: number
  safe: boolean
  alive: boolean
  /** 鎖定框在畫面上的位置（比例 0～1）；沒有在鎖是 null */
  lock: { x: number; y: number; done: boolean; progress: number } | null
  /** 準星張開的程度（0～1） */
  spread: number
  /** 最後一次打中別人、擊倒別人、被打的時間（performance.now） */
  hitAt: number
  hurtAt: number
  /** 被打的方向（相對於鏡頭，弧度，0 是正前方） */
  hurtDir: number
  /** 有飛彈鎖定自己 */
  warn: boolean
  /** 還有幾毫秒復活 */
  respawnIn: number | null
  /** 比賽時鐘（毫秒，開打前是負的） */
  clock: number
  /** 小地圖上每個座位：[x, z, 方向, 狀態]；狀態 0 看不到、1 隊友、2 敵人、3 自己、4 被偵察機標記的敵人 */
  radar: Float32Array
  /** 小地圖上自己這隊的偵察機：每個座位 [x, z, 有沒有(0/1), 鏡頭的水平角, 看得多遠（公尺）] */
  drones: Float32Array
  /** 名牌：每個座位在畫面上的位置 [x, y, 顯示(0 不顯示、1 名牌、2 被偵察機標記), 血量比例] */
  labels: Float32Array
  /** 放大瞄準的程度（0～1）；`scope` 是狙擊型開了狙擊鏡 */
  zoom: number
  scope: boolean
  /** 準星對到的地方離自己多遠（公尺） */
  range: number
  /** 自己在操控偵察機：離機甲多遠（公尺）、機身還剩多少（0～1）；沒在操控是 null */
  /**
   * 操控偵察機時：離機甲多遠、機身還剩多少（0～1）、畫面有多少雜訊（0～1，1 是訊號斷了）、看得多遠（公尺）、
   * 掃描範圍（`DRONE.viewH`、`viewV`）佔畫面的寬、高（0～1）
   */
  flight: { far: number; hp: number; noise: number; reach: number; fw: number; fh: number } | null
  /** 自己的偵察機停在原地偵測（沒在操控） */
  parked: boolean
  /** 背上還掛著幾架偵察機（不算正在飛的）；不是偵察型是 0 */
  rack: number
  /** 自己被敵人的偵察機掃到了 */
  scanned: boolean
}

type Gun = { cooldown: number; mag: number; reload: number; side: number }

type Pilot = {
  seat: number
  name: string
  team: Team
  kind: MechKind
  spec: MechSpec
  body: MechBody
  model: Rig
  /** 在自己這邊跑物理（自己的或負責開的電腦） */
  local: boolean
  bot: BotBrain | null
  remote: RemoteMech | null
  alive: boolean
  life: number
  hp: number
  missiles: number
  gun: Gun
  /** 變身後的那一把主武器（堡壘型的重機槍、砲擊型的迫擊砲；不會變身的用不到） */
  alt: Gun
  /** 別人的：上一格變身了沒（變了就放變身的聲音） */
  deployWas: boolean
  firing: boolean
  /** 別人開火的畫面：累積到一發的時間就畫一發曳光彈 */
  fireAcc: number
  input: MechInput
  orders: BotOrders
  /** 倒下的位置（冒煙用）和時間 */
  wreck: { x: number; y: number; z: number; at: number } | null
  stepPrev: number
  /** 推進器噴火粒子的累積 */
  puff: number
  lockSeat: number | null
  lockTime: number
  /** 主武器開了幾發（送出去的狀態帶著，別人照這個畫出狙擊型的每一砲） */
  shots: number
  /** 這條命還剩幾架偵察機（引爆了才少，和伺服器一樣） */
  drones: number
  /** 放出去的偵察機（操控中或停在原地） */
  drone: Flyer | null
  /** 別人的偵察機：爆炸、被打下來的是第幾架（只分單雙：0、1），狀態裡還是那一架就不畫；沒有是 -1 */
  droneGone: number
  /** 被自己這隊的偵察機標記到什麼時候（performance.now） */
  spottedUntil: number
}

/** 一架飛行中的偵察機：自己這邊飛的照物理算，別人的照收到的位置平滑過去 */
type Flyer = {
  body: DroneBody
  model: DroneModel
  input: DroneInput
  /** 自己這邊的：正在操控（不是停在原地）；電腦放的一直在操控 */
  piloting: boolean
  /** 機身還剩多少（伺服器說被打了多少就扣） */
  hp: number
  /** 下一次掃描波（畫面）還有幾秒 */
  pulse: number
}

type Missile = {
  owner: number
  team: Team
  id: number
  x: number
  y: number
  z: number
  /** 飛的方向（單位向量）和速度 */
  dx: number
  dy: number
  dz: number
  speed: number
  /** 彈道（舊版用戶端發射的沒有準星點，就直直飛）和已經沿著彈道飛了多遠 */
  course: Course | null
  s: number
  target: number | null
  age: number
  /** 自己這邊發射的（自己或負責開的電腦）：打中要回報 */
  local: boolean
  mesh: Group
  trail: number
}

/**
 * 飛彈的彈道：從發射點照發射的方向（斜斜朝上）飛出去，彎下來接到「發射點 → 準星那一點」的線上（三次貝茲曲線，
 * 先取樣成一段段折線），之後沿著線直直飛過去。同樣的發射點、方向、準星點，每個人算出來的彈道都一樣
 */
type Course = {
  /** 曲線上取樣的點（x, y, z 一組）和從起點到每一點的長度 */
  pts: Float32Array
  lens: Float32Array
  total: number
  /** 曲線的終點（在線上），之後沿著 u 直飛 */
  ex: number
  ey: number
  ez: number
  ux: number
  uy: number
  uz: number
}

/** 一發迫擊砲彈：照初速和重力飛（每個人自己算，同樣的砲口和初速大家看到的一樣）；落在哪裡沒有任何標示 */
type Shell = {
  owner: number
  team: Team
  id: number
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  age: number
  /** 自己這邊發射的（自己或負責開的電腦）：炸到要回報 */
  local: boolean
  mesh: Group
  trail: number
}

const COURSE_SAMPLES = 32

function makeCourse(o: Vector3, dir: Vector3, goal: Vector3): Course | null {
  const ux = goal.x - o.x
  const uy = goal.y - o.y
  const uz = goal.z - o.z
  const len = Math.hypot(ux, uy, uz)
  if (len < 1) return null
  // 接回線上的距離、往上拉的長度（決定飛多高）、接回線上前的那一段
  const back = Math.min(len, 70)
  const up = clamp(len * 0.6, 8, 26)
  const tail = Math.min(back * 0.5, 28)
  const ex = o.x + (ux / len) * back
  const ey = o.y + (uy / len) * back
  const ez = o.z + (uz / len) * back
  const p1 = [o.x + dir.x * up, o.y + dir.y * up, o.z + dir.z * up]
  const p2 = [ex - (ux / len) * tail, ey - (uy / len) * tail, ez - (uz / len) * tail]
  const p0 = [o.x, o.y, o.z]
  const p3 = [ex, ey, ez]
  const pts = new Float32Array((COURSE_SAMPLES + 1) * 3)
  const lens = new Float32Array(COURSE_SAMPLES + 1)
  for (let k = 0; k <= COURSE_SAMPLES; k++) {
    const t = k / COURSE_SAMPLES
    const a = (1 - t) ** 3
    const b = 3 * (1 - t) ** 2 * t
    const c = 3 * (1 - t) * t * t
    const d = t ** 3
    for (let i = 0; i < 3; i++) pts[k * 3 + i] = a * p0[i] + b * p1[i] + c * p2[i] + d * p3[i]
    if (k > 0) lens[k] = lens[k - 1] + Math.hypot(pts[k * 3] - pts[k * 3 - 3], pts[k * 3 + 1] - pts[k * 3 - 2], pts[k * 3 + 2] - pts[k * 3 - 1])
  }
  return { pts, lens, total: lens[COURSE_SAMPLES], ex, ey, ez, ux: ux / len, uy: uy / len, uz: uz / len }
}

/** 彈道上飛了 `s` 公尺的那一點 */
function courseAt(c: Course, s: number, out: Vector3): Vector3 {
  if (s >= c.total) return out.set(c.ex + c.ux * (s - c.total), c.ey + c.uy * (s - c.total), c.ez + c.uz * (s - c.total))
  let k = 1
  while (k < COURSE_SAMPLES && c.lens[k] < s) k++
  const f = (s - c.lens[k - 1]) / (c.lens[k] - c.lens[k - 1] || 1)
  const i = (k - 1) * 3
  return out.set(
    c.pts[i] + (c.pts[i + 3] - c.pts[i]) * f,
    c.pts[i + 1] + (c.pts[i + 4] - c.pts[i + 1]) * f,
    c.pts[i + 2] + (c.pts[i + 5] - c.pts[i + 2]) * f,
  )
}

/** 物理的固定步長 */
const STEP = 1 / 60
const MAX_STEPS = 8
const BASE_FOV = 70
const PORTRAIT_FOV = 84
const PITCH_MIN = -0.75
const PITCH_MAX = 0.95
/** 選單畫面的機甲站在大橋上（河的正上方、橋塔旁邊）；選隊畫面的那一台站在河濱步道上，背後是河和大橋 */
const SHOWCASE = { x: -22, z: 0 }
const SHOWROOM = { x: -43, z: -96 }
const tmpV = new Vector3()
const tmpW = new Vector3()

/** 打中範圍的高：變身時跟著蹲下去變矮 */
function hitHOf(p: Pilot): number {
  const dep = p.spec.deploy
  return dep ? p.spec.hitH + (dep.hitH - p.spec.hitH) * ease(p.body.deploy) : p.spec.hitH
}

/** 射線打到機甲的距離（打中範圍是一個方塊，不管朝哪邊；`pad` 是往外多算的，飛彈用） */
function rayMech(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, p: Pilot, pad = 0): number {
  const b = p.body
  const r = p.spec.hitR + pad
  return rayBox(ox, oy, oz, dx, dy, dz, b.x - r, b.y + 0.2 - pad, b.z - r, b.x + r, b.y + hitHOf(p), b.z + r)
}

/** 射線打到機甲的頭（`MechSpec.head`，變身時跟著蹲低）的距離；打不到是 Infinity */
function rayHead(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, p: Pilot): number {
  const b = p.body
  const h = p.spec.head
  const y = b.y - (p.spec.deploy?.drop ?? 0) * ease(b.deploy)
  return rayBox(ox, oy, oz, dx, dy, dz, b.x - h.r, y + h.y0, b.z - h.r, b.x + h.r, y + h.y1, b.z + h.r)
}

/** 收砲收到最後，瞄準的仰角最高只能到這裡（慢慢把頭放平） */
const PACK_PITCH = 0.15

/**
 * 瞄準的仰角可以轉到哪裡。砲擊型架砲時跟著架砲的進度換成砲管的仰角（`SHELL.elevMin`～`elevMax`；鏡頭抬多高另外算，見 `viewPitch`），
 * 收砲時上限慢慢降下來（把頭放平）
 */
function pitchRange(p: Pilot): [number, number] {
  const b = p.body
  if (!p.spec.deploy?.mortar || b.deploy <= 0) return [PITCH_MIN, PITCH_MAX]
  const k = ease(b.deploy)
  const lo = PITCH_MIN + (SHELL.elevMin - PITCH_MIN) * k
  if (b.deployed) return [lo, PITCH_MAX + (SHELL.elevMax - PITCH_MAX) * k]
  const hi = PACK_PITCH + (SHELL.elevMax - PACK_PITCH) * k
  return [Math.min(lo, hi), hi]
}

/**
 * 鏡頭的仰角：平常就是瞄準的仰角。砲擊型架砲時瞄準的仰角是砲管的仰角（最高 85 度），鏡頭只微微抬頭（`SHELL.view`），
 * 照架砲的進度慢慢換過去
 */
function viewPitch(p: Pilot): number {
  const b = p.body
  if (!p.spec.deploy?.mortar || b.deploy <= 0) return b.aimPitch
  const elev = clamp(b.aimPitch, SHELL.elevMin, SHELL.elevMax)
  const view = SHELL.view.base + (elev - SHELL.elevMin) * SHELL.view.follow
  return b.aimPitch + (view - b.aimPitch) * ease(b.deploy)
}

/** 盾牌變身到這個進度以上才擋得住（還在移過去的時候擋不住） */
const SHIELD_UP = 0.7

/**
 * 射線（方向要是單位向量）打到堡壘型的盾牌的距離：一面立在地上、跟著上半身轉的牆（`deploy.shield`），
 * 只擋從正面打來的（從後面、側面平行打來的穿過去）；沒有盾牌、還沒立好、打不到是 Infinity。
 * `p` 只用到機甲的數值、身體和活著沒（測試直接傳這幾個）
 */
export function rayShield(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  p: Pick<Pilot, 'spec' | 'body' | 'alive'>,
): number {
  const sh = p.spec.deploy?.shield
  const b = p.body
  if (!sh || b.deploy < SHIELD_UP || !p.alive) return Infinity
  const fx = Math.sin(b.aimYaw)
  const fz = Math.cos(b.aimYaw)
  const facing = dx * fx + dz * fz
  if (facing > -1e-3) return Infinity
  const cx = b.x + fx * sh.dist
  const cz = b.z + fz * sh.dist
  const t = ((cx - ox) * fx + (cz - oz) * fz) / facing
  if (t < 0) return Infinity
  const px = ox + dx * t - cx
  const pz = oz + dz * t - cz
  const py = oy + dy * t - b.y
  // 盾牌上的左右位置：右方是 (-cos, sin)
  if (Math.abs(-px * fz + pz * fx) > sh.width / 2 || py < -0.5 || py > sh.height) return Infinity
  return t
}

/** 要用變身後的那一把主武器（變身中就算變身後的） */
const wantsAlt = (p: Pilot) => p.spec.deploy !== null && p.body.deployed
/** 變身中、收回中（不能用主武器） */
const shifting = (b: MechBody) => (b.deployed ? b.deploy < 1 : b.deploy > 0)
/** 放大瞄準的視角（變身後換成變身後的） */
function zoomFovOf(p: Pilot): number {
  const dep = p.spec.deploy
  return dep ? p.spec.zoomFov + (dep.zoomFov - p.spec.zoomFov) * ease(p.body.deploy) : p.spec.zoomFov
}

/** 射線（方向要是單位向量）打到球（偵察機）的距離；打不到是 Infinity */
function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number): number {
  const lx = cx - ox
  const ly = cy - oy
  const lz = cz - oz
  const tc = lx * dx + ly * dy + lz * dz
  if (tc < 0) return Infinity
  const d2 = lx * lx + ly * ly + lz * lz - tc * tc
  if (d2 > r * r) return Infinity
  return tc - Math.sqrt(r * r - d2)
}

/** 畫面上離鏡頭超過這個距離的機甲不畫（60 台的時候省下遠處看不清楚的那些；比電磁砲的射程遠） */
const CULL = 560
/** 偵察機很小，這麼遠就不畫 */
const DRONE_CULL = 320
/** 超過這個距離（放大瞄準時照視角放寬）的機甲換成簡單外形（`Rig.setFar`） */
const LOD = 130

/** 砲擊型架好砲時，砲管的軸心大約離腳底多高（畫面上估平地打多遠用） */
const MORTAR_MUZZLE = 3.7

/** 機甲身體中間的高度（瞄準、鎖定、爆風照這裡算） */
const midY = (p: Pilot) => p.body.y + hitHOf(p) * 0.52
/** 機甲「眼睛」的高度（看不看得到、電腦瞄準從這裡看出去） */
const eyeY = (p: Pilot) => p.body.y + p.spec.eye - 0.8

function emptyOrders(): BotOrders {
  return {
    input: { strafe: 0, forward: 0, boost: false, jump: false },
    fire: false,
    missile: false,
    lock: null,
    drone: false,
    flight: { input: { forward: 0, strafe: 0, rise: 0 }, detonate: false },
    deploy: false,
    shell: null,
  }
}

export class MechGame {
  private readonly host: HTMLElement
  private readonly emit: (e: GameEvent) => void
  private readonly onFrame: (f: HudFrame) => void
  private readonly renderer: WebGLRenderer
  private readonly camera = new PerspectiveCamera(BASE_FOV, 1, 0.3, 3200)
  private readonly map: MapData
  private readonly index: MapIndex
  private readonly world: World
  private readonly kit: MechKit
  /** 機甲專用的陰影和反射探針（手機沒有） */
  private readonly light: MechLighting | null
  /** 這一格陰影和探針對準哪裡 */
  private readonly lightAt = new Vector3()
  /** 泛光、色調映射（手機沒有，直接畫到螢幕上） */
  private readonly post: Post | null
  private readonly fx: Effects
  private readonly audio: MechAudio
  private readonly input = new Input()
  private readonly controls: Controls = { strafe: 0, forward: 0, boost: false, jump: false, fire: false, zoom: false }
  private readonly look = { x: 0, y: 0 }
  private readonly resize: ResizeObserver
  private readonly frame: HudFrame
  private pilots: Pilot[] = []
  private me: Pilot | null = null
  private missiles: Missile[] = []
  private shells: Shell[] = []
  /** 上次通知畫面的：自己變身了沒 */
  private deployOn = false
  private phase: Phase = 'preview'
  private raf = 0
  private last = 0
  private time = 0
  private acc = 0
  private disposed = false
  private pixelRatio: number
  private slowFrames = 0
  private stage: Rect | null = null
  /** 選單背景的機甲（不在對戰裡） */
  private showcase: Pilot[] = []
  private orbit = 0
  /** 線上：起跑時間、送東西的函式和計時 */
  private link: BattleLink | null = null
  private goAt = 0
  private clock = 0
  private sendTimer = 0
  private hitTimer = 0
  private pingTimer = 0
  private pings = 0
  private bestRtt = Infinity
  private hits: HitReport[] = []
  private driving = false
  private difficulty: Difficulty = 'normal'
  private slots: number[] = []
  private nextMissile = 1
  private lastCount = 4
  /** 打開選單時放開所有按鍵（線上不能暫停） */
  private hold = false
  /** 觀戰時鏡頭跟著的座位 */
  private focus = 0
  private zoom = 0
  /** 自己剛打出去的那一發迫擊砲彈（鏡頭抬頭看著它飛出去）、看的程度 0～1、看到的仰角 */
  private watch: Shell | null = null
  private watchK = 0
  private watchPitch = 0
  /** 開砲的瞬間視角被震寬幾度（很快縮回來） */
  private fovKick = 0
  private fov = BASE_FOV
  private hitAt = -1e9
  private hurtAt = -1e9
  private hurtDir = 0
  private deathCam = 0
  private killer: number | null = null
  private readonly camPos = new Vector3()
  private readonly aimPoint = new Vector3()
  private camReady = false
  private locked = false
  private lockBeep = 0
  private showroomKind: MechKind = 'speed'
  /** 開火鍵上一格有沒有按著（操控偵察機時按下去那一下引爆）；引爆後放開前不開火 */
  private fireWas = false
  private fireBlock = false
  /** 偵察機掃描的計時、自己被敵人的偵察機掃到的時間 */
  private scanTimer = 0
  private scannedUntil = 0
  /** 畫面現在糊到什麼程度（`setBlur`） */
  private blurred = 0
  /** 上次通知畫面的偵察機狀態（觸控按鈕跟著換） */
  private droneMode: DroneMode = 'none'
  /** 上一次通知畫面的：自己在不在自己家的重生點裡 */
  private home = false
  /** 自己停著的偵察機被打的提示，多久提示一次 */
  private droneHurtAt = 0
  /** 小地圖上每個敵人「這隊有沒有人看得到」：每個座位隔一小段時間才重算（60 台時每格都算射線太多） */
  private seenCache: { at: number; team: Team; on: boolean }[] = []

  constructor(host: HTMLElement, emit: (e: GameEvent) => void, onFrame: (f: HudFrame) => void, sound: boolean) {
    this.host = host
    this.emit = emit
    this.onFrame = onFrame
    // 不支援 WebGL 時這裡會丟錯，由呼叫的人顯示訊息
    const coarse = window.matchMedia('(pointer: coarse)').matches
    // 桌機先畫到自己的貼圖上再做後處理（反鋸齒在那張貼圖上做），螢幕那一層就不用多重取樣
    this.renderer = new WebGLRenderer({ antialias: coarse, powerPreference: 'high-performance' })
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2)
    this.renderer.setPixelRatio(this.pixelRatio)
    this.post = coarse ? null : new Post(this.renderer)
    host.appendChild(this.renderer.domElement)
    this.map = buildMap()
    this.index = new MapIndex(this.map)
    this.world = new World(this.map, this.renderer, { mobile: coarse, hdr: !coarse })
    this.light = coarse ? null : new MechLighting(this.renderer, this.world)
    this.kit = createMechKit(this.renderer, coarse, this.light)
    // 機甲腳下的圓影子：有真的影子時只留淡淡的一圈（站在大樓的影子裡也看得出機甲踩在地上），沒有時是唯一的影子
    this.kit.shadow.opacity = this.world.realShadows ? 0.45 : 1
    this.fx = new Effects(this.world.scene, !coarse)
    this.audio = new MechAudio(sound)
    this.frame = {
      hp: MECHS.speed.hp,
      energy: 1,
      drained: false,
      ammo: MECHS.speed.magazine,
      magazine: MECHS.speed.magazine,
      reload: -1,
      deploy: -1,
      mortar: null,
      missiles: MECH.missiles,
      safe: false,
      alive: true,
      lock: null,
      spread: 0,
      hitAt: -1e9,
      hurtAt: -1e9,
      hurtDir: 0,
      warn: false,
      respawnIn: null,
      clock: 0,
      radar: new Float32Array(0),
      drones: new Float32Array(0),
      labels: new Float32Array(0),
      zoom: 0,
      scope: false,
      range: 0,
      flight: null,
      parked: false,
      rack: 0,
      scanned: false,
    }
    this.input.attach(this.renderer.domElement)
    this.resize = new ResizeObserver(() => this.fit())
    this.resize.observe(host)
    this.fit()
    this.preview()
    this.warm()
    this.raf = requestAnimationFrame(this.loop)
  }

  /**
   * 開場先把之後才會用到的東西畫一次：遠處的簡化版（另一組著色器）、偵察機（要烘遮蔽貼圖）。
   * 不然對戰中第一次有機甲走遠、第一次放偵察機時才編譯、才烘，畫面會卡一下
   */
  private warm() {
    const drone = new DroneModel(this.kit, 0)
    drone.root.position.set(SHOWCASE.x, 30, SHOWCASE.z)
    this.world.scene.add(drone.root)
    for (const p of this.showcase) p.model.setFar(true, this.kit, p.spec)
    this.orbitCamera(0)
    this.render()
    for (const p of this.showcase) p.model.setFar(false, this.kit, p.spec)
    this.world.scene.remove(drone.root)
    drone.dispose()
  }

  /** 地圖資料（小地圖用） */
  get mapData(): MapData {
    return this.map
  }

  // ---------- 外面呼叫的 ----------

  setTouch(patch: Partial<TouchState>) {
    Object.assign(this.input.touch, patch)
  }

  touchLook(dx: number, dy: number) {
    this.input.touchLook(dx, dy)
  }

  /** 觸控按鈕：飛彈、換彈 */
  press(action: PadAction) {
    this.input.push(action)
  }

  setSensitivity(v: number) {
    this.input.sensitivity = v
  }

  setSound(on: boolean) {
    this.audio.setEnabled(on)
  }

  unlockAudio() {
    this.audio.unlock()
  }

  /** 鎖定滑鼠游標（點畫面時） */
  lockPointer() {
    this.input.lock()
  }

  unlockPointer() {
    this.input.unlock()
  }

  /** 打開選單：放開所有按鍵 */
  setHold(on: boolean) {
    this.hold = on
    if (on) {
      this.input.reset()
      this.input.unlock()
    }
  }

  setStage(rect: Rect | null) {
    this.stage = rect
    this.fit()
  }

  /** 選單畫面：幾台機甲站在大橋上，鏡頭繞著轉 */
  preview() {
    this.clearBattle()
    this.setPhase('preview')
    this.input.capture = false
    this.makeShowcase([
      { team: 0, kind: 'speed', x: SHOWCASE.x - 7, z: SHOWCASE.z - 2, yaw: 1.9 },
      { team: 1, kind: 'sniper', x: SHOWCASE.x + 9, z: SHOWCASE.z - 1, yaw: -1.3 },
      { team: 0, kind: 'recon', x: SHOWCASE.x - 1, z: SHOWCASE.z + 5, yaw: 2.6 },
      { team: 1, kind: 'fortress', x: SHOWCASE.x + 3, z: SHOWCASE.z - 7.5, yaw: -0.4 },
      { team: 0, kind: 'mortar', x: SHOWCASE.x - 13, z: SHOWCASE.z + 6, yaw: 2.2 },
    ])
    // 堡壘型立著盾牌
    for (const p of this.showcase) if (p.kind === 'fortress') Object.assign(p.body, { deployed: true, deploy: 1 })
  }

  /** 選隊畫面：自己選的機甲照隊伍上色，鏡頭近一點 */
  showroom(team: Team, kind: MechKind) {
    if (this.phase !== 'showroom' || kind !== this.showroomKind) {
      if (this.phase !== 'showroom') {
        this.clearBattle()
        this.setPhase('showroom')
        this.input.capture = false
      }
      this.showroomKind = kind
      this.makeShowcase([{ team, kind, x: SHOWROOM.x, z: SHOWROOM.z, yaw: Math.PI * 0.75 }])
    }
    for (const p of this.showcase) p.model.setTeam(this.kit, team)
  }

  /** 開始一局（或重新整理後接著打） */
  start(setup: BattleSetup, link: BattleLink) {
    this.clearBattle()
    this.link = link
    this.goAt = setup.goAt
    this.driving = setup.driving
    this.difficulty = setup.difficulty
    this.slots = setup.slots
    this.sendTimer = 0
    this.hitTimer = 0
    this.pingTimer = 0
    this.pings = 0
    this.bestRtt = Infinity
    this.lastCount = 4
    this.deathCam = 0
    this.killer = null
    this.camReady = false
    const now = performance.now()
    this.clock = (now - this.goAt) / 1000
    const botState = new Map(setup.botStates.map((row) => [row[0], row.slice(1)]))
    this.botSeats = new Set(setup.seats.flatMap((s, seat) => (s.bot ? [seat] : [])))
    setup.seats.forEach((s, seat) => {
      const player = setup.players[seat]
      const mine = seat === setup.me
      const local = mine || (s.bot && this.driving)
      const spawn = this.spawnPoint(s.team, setup.slots[seat] ?? 0)
      const pilot = this.makePilot(seat, s.name, s.team, s.kind, spawn.x, spawn.z, spawn.yaw)
      pilot.local = local
      pilot.alive = player?.alive ?? true
      pilot.life = player?.life ?? 1
      pilot.hp = player?.hp ?? pilot.spec.hp
      pilot.missiles = player?.missiles ?? MECH.missiles
      pilot.drones = player?.drones ?? pilot.spec.drones
      pilot.deployWas = false
      this.rack(pilot)
      if (s.bot && this.driving) pilot.bot = new BotBrain(seat, this.difficulty, s.kind)
      if (!local) pilot.remote = new RemoteMech(s.kind)
      // 重新整理後：從最後送出的位置接著打
      const resume = mine ? setup.resume : s.bot ? botState.get(seat) : null
      if (local && resume && resume.length >= 12 && resume[11] === pilot.life && this.clock > 0) {
        Object.assign(pilot.body, { x: resume[1], y: resume[2], z: resume[3], legs: resume[7], aimYaw: resume[8], aimPitch: resume[9] })
      }
      pilot.model.setVisible(pilot.alive && local)
      this.pilots.push(pilot)
    })
    this.me = setup.me !== null ? (this.pilots[setup.me] ?? null) : null
    this.focus = this.me?.seat ?? this.firstAlive()
    this.input.capture = this.me !== null
    this.frame.radar = new Float32Array(this.pilots.length * 4)
    this.frame.drones = new Float32Array(this.pilots.length * 5)
    this.frame.labels = new Float32Array(this.pilots.length * 4)
    this.setPhase(this.clock >= 0 ? 'battle' : 'countdown')
    this.emit({ type: 'focus', seat: this.me ? null : this.focus })
  }

  /** 伺服器的 view 變了：活著沒有、第幾條命、血量、飛彈、是不是負責開電腦 */
  sync(players: MechaPlayer[], driving: boolean, goAt: number) {
    if (this.phase !== 'countdown' && this.phase !== 'battle') return
    if (this.clock < 0) this.goAt = goAt
    this.setDriving(driving)
    players.forEach((p, seat) => {
      const pilot = this.pilots[seat]
      if (!pilot) return
      pilot.team = p.team
      // 換了機體（重生點裡換、或倒下時選了下一台）：換成新的一台；活著的是原地換（伺服器把第幾條命加一）
      const kind = mechKind(p.mech)
      const swapped = kind !== pilot.kind
      if (swapped) this.reKind(pilot, kind)
      if (p.alive && (!pilot.alive || p.life > pilot.life)) this.respawn(pilot, p.life, swapped && pilot.alive)
      else if (!p.alive && pilot.alive) this.down(pilot)
      pilot.hp = p.hp
      if (p.life !== pilot.life) pilot.missiles = p.missiles
      else pilot.missiles = Math.min(pilot.missiles, p.missiles)
      // 偵察機和伺服器一樣是引爆了才少
      const drones = p.drones ?? pilot.spec.drones
      pilot.drones = p.life !== pilot.life ? drones : Math.min(pilot.drones, drones)
      pilot.life = p.life
      pilot.model.setMissiles(pilot.missiles)
      this.rack(pilot)
    })
  }

  /** 這局結算了 */
  end() {
    if (this.phase !== 'battle' && this.phase !== 'countdown') return
    this.setPhase('ended')
    this.input.capture = false
    this.input.unlock()
    for (const m of this.missiles) this.fx.removeMissile(m.mesh)
    this.missiles = []
    for (const s of this.shells) this.removeShell(s)
    this.shells = []
    for (const p of this.pilots) this.removeFlyer(p)
    this.syncDroneMode()
  }

  onTick(rows: number[][], hp: number[] | undefined, dmg: number[][] | undefined) {
    const now = performance.now()
    for (const row of rows) {
      const p = this.pilots[row[0]]
      if (!p || p.local || !p.remote) continue
      p.remote.push(row.slice(1), this.clock, now)
    }
    if (hp) {
      hp.forEach((v, seat) => {
        const p = this.pilots[seat]
        if (!p) return
        if (p === this.me && v < p.hp) this.audio.hurt()
        p.hp = v
      })
    }
    if (dmg) {
      for (const [from, to, amount, kind] of dmg) {
        const shooter = this.pilots[from]
        const target = this.pilots[to]
        if (!shooter || !target) continue
        if (kind === 3) {
          this.droneHurt(target, amount, now)
          continue
        }
        if (target.bot) target.bot.hurt()
        if (target === this.me) {
          this.hurtAt = now
          this.fx.shake = Math.min(1, this.fx.shake + 0.15)
          const dx = shooter.body.x - target.body.x
          const dz = shooter.body.z - target.body.z
          this.hurtDir = wrapAngle(this.me.body.aimYaw - Math.atan2(dx, dz))
        }
      }
    }
  }

  /** `p` 放出去的偵察機被打了 `amount`：扣機身；自己的偵察機停在外面被打時提示一下 */
  private droneHurt(p: Pilot, amount: number, now: number) {
    const f = p.drone
    if (!f) return
    f.hp = Math.max(0, f.hp - amount)
    if (p !== this.me) return
    if (f.piloting) this.fx.shake = Math.min(1, this.fx.shake + 0.12)
    else if (now - this.droneHurtAt > 3000) {
      this.droneHurtAt = now
      this.emit({ type: 'toast', text: '偵察機被攻擊了！' })
    }
  }

  onMissile(seat: number, id: number, o: number[], dir: number[], target: number | null, goal: number[] | null) {
    const p = this.pilots[seat]
    if (!p || p.local) return
    if (![...o, ...dir].every(Number.isFinite)) return
    const g = goal && goal.length === 3 && goal.every(Number.isFinite) ? new Vector3(goal[0], goal[1], goal[2]) : null
    this.launch(p, id, new Vector3(o[0], o[1], o[2]), new Vector3(dir[0], dir[1], dir[2]).normalize(), target, g, false)
  }

  /** 別人發射了迫擊砲彈：照一樣的砲口和初速飛 */
  onShell(seat: number, id: number, o: number[], v: number[]) {
    const p = this.pilots[seat]
    if (!p || p.local || o.length !== 3 || v.length !== 3 || ![...o, ...v].every(Number.isFinite)) return
    p.model.fire(0)
    this.addShell(p, id, o, v, false)
  }

  /** 別人的偵察機在 `o` 爆炸了 */
  onBoom(seat: number, o: number[]) {
    const p = this.pilots[seat]
    if (!p || p.local || o.length !== 3 || !o.every(Number.isFinite)) return
    this.removeFlyer(p)
    p.droneGone = p.remote?.droneN ?? 0
    this.rack(p)
    this.blast(o[0], o[1], o[2])
  }

  /** `seat` 這條命的第 `n` 架偵察機被 `by` 打下來了 */
  onDowned(seat: number, by: number, n: number) {
    const p = this.pilots[seat]
    if (!p) return
    const f = p.drone
    if (p.local) {
      // 自己這邊的：還是同一架才算（已經引爆的就不用了），和伺服器一樣少一架
      if (f && p.spec.drones - p.drones === n) {
        this.droneWreck(f.body)
        this.removeFlyer(p)
        p.drones = Math.max(0, p.drones - 1)
        this.rack(p)
        if (p === this.me) {
          this.camReady = false
          this.emit({ type: 'toast', text: '偵察機被擊落了' })
        }
      }
    } else {
      if (f && p.remote?.droneN === n % 2) {
        this.droneWreck(f.body)
        this.removeFlyer(p)
      }
      p.droneGone = n % 2
      this.rack(p)
    }
    if (this.me && by === this.me.seat) {
      this.hitAt = performance.now()
      this.audio.hitMarker()
    }
    this.emit({ type: 'downed', seat, by })
  }

  /** 偵察機被打下來：小小的爆炸（沒有傷害） */
  private droneWreck(d: DroneBody) {
    this.fx.explosion(d.x, d.y, d.z, 0.5)
    this.audio.explosion(this.distToCam(d.x, d.y, d.z) + 1, false)
  }

  onKill(killer: number, victim: number, w: KillWeapon) {
    const v = this.pilots[victim]
    if (!v) return
    if (v.alive) this.down(v)
    if (v === this.me) {
      this.killer = killer
      this.deathCam = 0
    }
    if (this.me && killer === this.me.seat) this.audio.kill()
    this.emit({ type: 'kill', kill: { killer, victim, w } })
  }

  onPong(t: number, clock: number) {
    const now = performance.now()
    const rtt = now - t
    if (rtt < 0 || rtt > 5000) return
    // 只拿最快的那幾次修時鐘
    if (rtt > this.bestRtt * 1.3 + 15) return
    this.bestRtt = Math.min(this.bestRtt, rtt)
    this.goAt = t + rtt / 2 - clock
  }

  /** 觀戰換下一台 */
  cycleFocus(): number | null {
    if (this.me || this.pilots.length === 0) return null
    for (let k = 1; k <= this.pilots.length; k++) {
      const p = this.pilots[(this.focus + k) % this.pilots.length]
      if (p.alive) {
        this.focus = p.seat
        this.camReady = false
        return p.seat
      }
    }
    return this.focus
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resize.disconnect()
    this.input.detach()
    this.audio.dispose()
    this.clearBattle()
    this.clearShowcase()
    this.fx.dispose()
    disposeMechKit(this.kit)
    this.light?.dispose()
    this.post?.dispose()
    this.world.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  // ---------- 內部 ----------

  private setPhase(phase: Phase) {
    this.phase = phase
    this.emit({ type: 'phase', phase })
  }

  private fit() {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.post?.resize()
    this.camera.aspect = w / h
    const s = this.stage
    if (s && s.w > 0 && s.h > 0) {
      // 選隊畫面：機甲畫在選單旁邊空出來的那一塊
      const cx = s.x + s.w / 2
      const cy = s.y + s.h / 2
      this.camera.setViewOffset(w, h, w / 2 - cx, h / 2 - cy, w, h)
    } else this.camera.clearViewOffset()
    this.camera.updateProjectionMatrix()
  }

  private spawnPoint(team: Team, slot: number) {
    const list = this.map.spawns[team]
    return list[slot % list.length]
  }

  private makePilot(seat: number, name: string, team: Team, kind: MechKind, x: number, z: number, yaw: number): Pilot {
    const model =
      kind === 'sniper'
        ? new SniperModel(this.kit, team)
        : kind === 'recon'
          ? new ReconModel(this.kit, team)
          : kind === 'fortress'
            ? new FortressModel(this.kit, team)
            : kind === 'mortar'
              ? new MortarModel(this.kit, team)
              : new MechModel(this.kit, team)
    this.world.scene.add(model.root)
    const spec = MECHS[kind]
    return {
      seat,
      name,
      team,
      kind,
      spec,
      body: newBody(team, kind, x, z, yaw),
      model,
      local: false,
      bot: null,
      remote: null,
      alive: true,
      life: 1,
      hp: spec.hp,
      missiles: MECH.missiles,
      gun: { cooldown: 0, mag: spec.magazine, reload: 0, side: 0 },
      alt: { cooldown: 0, mag: spec.deploy?.arms.magazine ?? 0, reload: 0, side: 0 },
      deployWas: false,
      firing: false,
      fireAcc: 0,
      input: { strafe: 0, forward: 0, boost: false, jump: false },
      orders: emptyOrders(),
      wreck: null,
      stepPrev: 0,
      puff: 0,
      lockSeat: null,
      lockTime: 0,
      shots: 0,
      drones: spec.drones,
      drone: null,
      droneGone: -1,
      spottedUntil: 0,
    }
  }

  private makeShowcase(list: { team: Team; kind: MechKind; x: number; z: number; yaw: number }[]) {
    this.clearShowcase()
    this.showcase = list.map((s, i) => {
      const p = this.makePilot(-1 - i, '', s.team, s.kind, s.x, s.z, s.yaw)
      p.body.y = this.index.ground(s.x, 50, s.z, p.spec.radius, MECH.step)
      p.model.pose(p.body, false, 0)
      return p
    })
    this.camReady = false
  }

  private clearShowcase() {
    for (const p of this.showcase) this.world.scene.remove(p.model.root)
    this.showcase = []
  }

  private clearBattle() {
    for (const p of this.pilots) {
      this.removeFlyer(p)
      this.world.scene.remove(p.model.root)
    }
    for (const m of this.missiles) this.fx.removeMissile(m.mesh)
    for (const s of this.shells) this.removeShell(s)
    this.pilots = []
    this.missiles = []
    this.shells = []
    this.seenCache = []
    this.me = null
    this.link = null
    this.hits = []
    this.fx.clear()
    this.clearShowcase()
    this.locked = false
  }

  private firstAlive(): number {
    return this.pilots.find((p) => p.alive)?.seat ?? 0
  }

  /** 換人開電腦：接手時把電腦變成自己這邊跑，交出去時改成照收到的狀態畫 */
  private setDriving(on: boolean) {
    if (on === this.driving) return
    this.driving = on
    for (const p of this.pilots) {
      if (p === this.me) continue
      const isBot = p.bot !== null || (on && p.remote !== null && this.isBotSeat(p.seat))
      if (!isBot) continue
      if (on) {
        p.local = true
        p.remote = null
        p.bot = new BotBrain(p.seat, this.difficulty, p.kind)
        p.body.vx = p.body.vz = p.body.vy = 0
      } else {
        p.local = false
        p.bot = null
        p.remote = new RemoteMech(p.kind)
      }
    }
  }

  /** 哪些座位是電腦（開局時記下來，接手開電腦時用） */
  private botSeats = new Set<number>()
  private isBotSeat(seat: number) {
    return this.botSeats.has(seat)
  }

  /** 換機體：模型、數值、物理換成新的一台，位置和視角不變（放出去的偵察機收回來） */
  private reKind(p: Pilot, kind: MechKind) {
    this.removeFlyer(p)
    p.droneGone = -1
    this.world.scene.remove(p.model.root)
    const fresh = this.makePilot(p.seat, p.name, p.team, kind, p.body.x, p.body.z, p.body.legs)
    Object.assign(fresh.body, { y: p.body.y, aimYaw: p.body.aimYaw, aimPitch: p.body.aimPitch })
    p.kind = kind
    p.spec = fresh.spec
    p.model = fresh.model
    p.body = fresh.body
    p.gun = fresh.gun
    p.alt = fresh.alt
    p.deployWas = false
    p.lockSeat = null
    p.lockTime = 0
    if (p.remote) p.remote = new RemoteMech(kind)
    if (p.bot) p.bot = new BotBrain(p.seat, this.difficulty, kind)
    if (p === this.me) {
      this.zoom = 0
      this.camReady = false
      this.syncDroneMode()
      this.emit({ type: 'toast', text: p.alive ? `換成${MECHS[kind].name}` : `下次出擊用${MECHS[kind].name}` })
    }
  }

  /** 復活：自己這邊跑的回到重生點（`inPlace` 是重生點裡換機體：留在原地），別人的等新的狀態 */
  private respawn(p: Pilot, life: number, inPlace = false) {
    p.alive = true
    p.life = life
    p.wreck = null
    p.hp = p.spec.hp
    p.missiles = MECH.missiles
    p.gun.mag = p.spec.magazine
    p.gun.reload = 0
    p.alt.mag = p.spec.deploy?.arms.magazine ?? 0
    p.alt.reload = 0
    p.lockSeat = null
    p.lockTime = 0
    p.drones = p.spec.drones
    this.removeFlyer(p)
    p.droneGone = -1
    this.rack(p)
    if (p.local) {
      if (!inPlace) {
        const s = this.spawnPoint(p.team, this.slots[p.seat] ?? 0)
        p.body = newBody(p.team, p.kind, s.x, s.z, s.yaw)
      }
      p.model.setVisible(true)
      p.bot?.reset()
    } else {
      p.remote?.drop()
      p.model.setVisible(false)
    }
    if (p === this.me) {
      this.killer = null
      if (!inPlace) this.camReady = false
    }
  }

  /** 倒下：爆炸、留下冒煙的殘骸；飛在外面的偵察機斷了訊號掉下去 */
  private down(p: Pilot) {
    p.alive = false
    p.firing = false
    p.hp = 0
    if (p.drone) {
      const d = p.drone.body
      this.fx.impact(d.x, d.y, d.z, true)
      this.removeFlyer(p)
    }
    const b = p.body
    p.wreck = { x: b.x, y: b.y + 2, z: b.z, at: performance.now() }
    p.model.setVisible(false)
    p.remote?.drop()
    this.fx.explosion(b.x, b.y + 3, b.z, 2)
    const d = this.distToCam(b.x, b.y, b.z)
    this.audio.explosion(d, true)
    this.fx.shake = Math.min(1, this.fx.shake + clamp(1 - d / 80, 0, 0.6))
  }

  private distToCam(x: number, y: number, z: number) {
    return Math.hypot(x - this.camera.position.x, y - this.camera.position.y, z - this.camera.position.z)
  }

  private readonly loop = (t: number) => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 1 / 60
    this.last = t
    this.watchPerformance(dt)
    this.update(dt)
    this.render()
  }

  private watchPerformance(dt: number) {
    if (dt > 0.026) this.slowFrames++
    else this.slowFrames = Math.max(0, this.slowFrames - 2)
    if (this.slowFrames <= 90) return
    if (this.world.cheaper()) {
      // 先把每一格重畫的陰影換成只畫一次的（機甲改用腳下的圓影子）
      this.kit.shadow.opacity = 1
      this.slowFrames = 0
    } else if (this.light?.cheaper()) {
      // 再關掉每一格都要多畫的：機甲的自陰影、反射探針、泛光；還是跟不上再降解析度
      if (this.post) this.post.glow = false
      this.slowFrames = 0
    } else if (this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25)
      this.renderer.setPixelRatio(this.pixelRatio)
      this.fit()
      this.slowFrames = 0
    }
  }

  private render() {
    if (this.disposed) return
    this.world.update(this.time, this.camera, this.particleScale())
    if (this.light) this.light.update(this.lightAt, this.aimLight())
    if (this.post) this.post.render(this.world.scene, this.camera, this.time)
    else this.renderer.render(this.world.scene, this.camera)
  }

  /**
   * 機甲的自陰影和反射探針這一格對準哪裡（寫進 `lightAt`），回傳四周多大的範圍要有清楚的自陰影：
   * 選單是廣場上那幾台、選隊是展示的那一台，對戰是鏡頭跟著的機甲（操控偵察機時是偵察機、倒下了是殘骸）
   */
  private aimLight(): number {
    if (this.phase === 'preview' || this.phase === 'showroom') {
      const showroom = this.phase === 'showroom'
      const c = showroom ? SHOWROOM : SHOWCASE
      this.lightAt.set(c.x, this.index.ground(c.x, 50, c.z, 2, MECH.step) + 3.5, c.z)
      return showroom ? 9 : 24
    }
    const me = this.me
    const p = me ?? this.pilots[this.focus]
    if (!p) this.lightAt.copy(this.camera.position)
    else if (me && me.alive && me.drone?.piloting) this.lightAt.set(me.drone.body.x, me.drone.body.y, me.drone.body.z)
    else if (!p.alive && p.wreck) this.lightAt.set(p.wreck.x, p.wreck.y + 1.5, p.wreck.z)
    else this.lightAt.set(p.body.x, p.body.y + 3.5, p.body.z)
    return 22
  }

  private update(dt: number) {
    this.time += dt
    const now = performance.now()
    const battle = this.phase === 'countdown' || this.phase === 'battle' || this.phase === 'ended'

    if (this.phase === 'preview' || this.phase === 'showroom') {
      for (const p of this.showcase) {
        p.body.aimYaw = p.body.legs + Math.sin(this.time * 0.5 + p.seat) * 0.3
        p.body.aimPitch = Math.sin(this.time * 0.4 + p.seat) * 0.1
        // 選隊畫面：會變身的每隔幾秒變身、收回一次
        if (this.phase === 'showroom' && p.spec.deploy) {
          p.body.deployed = Math.floor(this.time / 3.5) % 2 === 1
          stepDeploy(p.body, dt)
        }
        p.model.pose(p.body, false, dt)
      }
      this.fx.update(dt, this.particleScale())
      this.orbitCamera(dt)
      return
    }
    if (!battle) return

    this.clock = (now - this.goAt) / 1000
    if (this.phase === 'countdown') {
      const n = Math.ceil(-this.clock)
      if (n <= 3 && n !== this.lastCount && n > 0) {
        this.lastCount = n
        this.emit({ type: 'countdown', n })
        this.audio.beep(false)
      }
      if (this.clock >= 0) {
        this.emit({ type: 'countdown', n: 0 })
        this.audio.beep(true)
        this.setPhase('battle')
      }
    }
    const live = this.phase === 'battle'

    // 操作
    const actions: PadAction[] = []
    this.input.read(this.controls, this.look, actions, dt)
    if (this.hold || !this.me || this.phase === 'ended') {
      Object.assign(this.controls, { strafe: 0, forward: 0, boost: false, jump: false, fire: false, zoom: false })
      this.look.x = this.look.y = 0
      actions.length = 0
    }
    for (const a of actions) if (a === 'menu') this.emit({ type: 'pad', action: 'menu' })
    const me = this.me
    // 開火鍵按下去的那一下（操控偵察機時是引爆）；引爆後要先放開才會開火
    const fireEdge = this.controls.fire && !this.fireWas
    this.fireWas = this.controls.fire
    if (!this.controls.fire) this.fireBlock = false
    const flyer = me && me.alive && me.drone?.piloting ? me.drone : null
    if (me && flyer) {
      // 操控偵察機：轉頭轉的是偵察機的鏡頭，機甲站著不動
      const d = flyer.body
      d.yaw = wrapAngle(d.yaw - this.look.x)
      d.pitch = clamp(d.pitch - this.look.y, DRONE_PITCH_MIN, DRONE_PITCH_MAX)
      flyer.input.forward = live ? this.controls.forward : 0
      flyer.input.strafe = live ? this.controls.strafe : 0
      flyer.input.rise = live ? (this.controls.jump ? 1 : 0) - (this.controls.boost ? 1 : 0) : 0
      Object.assign(me.input, { strafe: 0, forward: 0, boost: false, jump: false })
    } else if (me && me.alive) {
      // 放大瞄準時轉得慢一點（照視角縮小的比例），準星才不會一下子甩過頭
      const k = 1 - this.zoom * (1 - zoomFovOf(me) / BASE_FOV)
      me.body.aimYaw = wrapAngle(me.body.aimYaw - this.look.x * k)
      const [lo, hi] = pitchRange(me)
      me.body.aimPitch = clamp(me.body.aimPitch - this.look.y * k, lo, hi)
      me.input.strafe = live ? this.controls.strafe : 0
      me.input.forward = live ? this.controls.forward : 0
      me.input.boost = live && this.controls.boost
      me.input.jump = live && this.controls.jump
    }
    this.zoom += ((this.controls.zoom && me?.alive && !flyer ? 1 : 0) - this.zoom) * Math.min(1, dt * 12)

    // 電腦想一想（還沒開打、結算後站著不動）；放了偵察機的電腦操控偵察機，機甲站著
    const targets: BotTarget[] = this.pilots.map((p) => ({
      seat: p.seat,
      team: p.team,
      body: p.body,
      alive: p.alive && this.shown(p, now),
      drone: p.alive && p.drone ? p.drone.body : null,
    }))
    for (const p of this.pilots) {
      if (!p.bot || !p.local || !p.alive) continue
      p.bot.drones = p.drones
      if (!live) Object.assign(p.orders, emptyOrders())
      else if (p.drone) {
        Object.assign(p.orders, emptyOrders())
        p.bot.fly(dt, p.drone.body, p.body, targets, this.index, p.orders.flight)
        Object.assign(p.drone.input, p.orders.flight.input)
      } else p.bot.think(dt, p.body, targets, this.index, p.orders)
      p.input = p.orders.input
    }

    // 物理：自己這邊跑的照固定步長
    this.acc += dt
    let steps = 0
    while (this.acc >= STEP && steps < MAX_STEPS) {
      for (const p of this.pilots) {
        if (!p.local || !p.alive) continue
        stepMech(p.body, p.input, STEP, this.index)
        if (p.drone) stepDrone(p.drone.body, p.drone.input, STEP, this.index, p.team)
      }
      this.acc -= STEP
      steps++
    }
    if (steps === MAX_STEPS) this.acc = 0
    // 別人的照收到的狀態推算
    for (const p of this.pilots) {
      if (p.local || !p.remote) continue
      if (p.alive && p.remote.visible(now)) p.remote.apply(p.body, this.clock, dt)
    }

    // 準星對到哪裡
    this.updateAim()
    // 開火、飛彈、鎖定、偵察機
    for (const p of this.pilots) this.weapons(p, dt, now, live, p === me ? actions : null, p === me && fireEdge)
    this.updateMissiles(dt, now)
    this.updateShells(dt, now)
    this.updateDrones(dt, now)
    this.updateScan(dt, now)

    // 送狀態、打中、對時
    this.network(dt)

    this.updateVisuals(dt, now)
    this.updateCamera(dt, now)
    this.updateAudio()
    this.syncDroneMode()
    this.emitFrame(now)
  }

  /** 別人的機甲有沒有在畫面上（自己這邊跑的永遠有） */
  private shown(p: Pilot, now: number) {
    return p.alive && (p.local || (p.remote?.visible(now) ?? false))
  }

  /** 鏡頭中間對到的那一點（槍口往這裡打） */
  private updateAim() {
    const cam = this.camera
    cam.getWorldDirection(tmpV)
    const ox = cam.position.x
    const oy = cam.position.y
    const oz = cam.position.z
    const far = 600
    let t = this.index.ray(ox, oy, oz, tmpV.x, tmpV.y, tmpV.z, far)
    if (t === Infinity) t = far
    const self = this.me ?? this.pilots[this.focus]
    for (const p of this.pilots) {
      if (p === self || !this.shown(p, performance.now())) continue
      const hit = rayMech(ox, oy, oz, tmpV.x, tmpV.y, tmpV.z, p)
      if (hit < t) t = hit
      // 敵人的盾牌
      if (self && p.team !== self.team) t = Math.min(t, rayShield(ox, oy, oz, tmpV.x, tmpV.y, tmpV.z, p))
      // 敵人的偵察機（準星對到才打得下來）
      const d = p.drone?.body
      if (d && self && p.team !== self.team) t = Math.min(t, raySphere(ox, oy, oz, tmpV.x, tmpV.y, tmpV.z, d.x, d.y, d.z, DRONE.hitR))
    }
    // 太近（鏡頭貼著牆）就往前多看一點，不要往自己的腳打
    t = Math.max(t, 12)
    this.aimPoint.set(ox + tmpV.x * t, oy + tmpV.y * t, oz + tmpV.z * t)
  }

  /** 射線打到誰：地圖、機甲（不含開火的那台）或敵人的盾牌，回傳距離和打到的人 */
  private trace(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, range: number, shooter: Pilot, now: number) {
    let t = this.index.ray(ox, oy, oz, dx, dy, dz, range)
    let hit: Pilot | null = null
    /** 打到的是這台放出去的偵察機 */
    let drone: Pilot | null = null
    for (const p of this.pilots) {
      if (p === shooter || !this.shown(p, now)) continue
      const d = rayMech(ox, oy, oz, dx, dy, dz, p)
      if (d < t) {
        t = d
        hit = p
        drone = null
      }
      // 敵人的盾牌擋在前面（自己這隊的子彈穿過去）
      if (p.team !== shooter.team) {
        const s = rayShield(ox, oy, oz, dx, dy, dz, p)
        if (s < t) {
          t = s
          hit = null
          drone = null
        }
      }
      // 敵人的偵察機（自己這隊的子彈穿過去）
      const f = p.drone?.body
      if (!f || p.team === shooter.team) continue
      const s = raySphere(ox, oy, oz, dx, dy, dz, f.x, f.y, f.z, DRONE.hitR)
      if (s < t) {
        t = s
        hit = null
        drone = p
      }
    }
    return { t, hit, drone }
  }

  /** 一台機甲的武器：機槍、換彈、鎖定、飛彈、偵察機、變身（`fireEdge` 是自己剛按下開火鍵） */
  private weapons(p: Pilot, dt: number, now: number, live: boolean, actions: PadAction[] | null, fireEdge: boolean) {
    const spec = p.spec
    const b = p.body
    // 兩把主武器各自冷卻、換彈（沒在用的那把換好了也算）
    for (const [gun, mag] of [
      [p.gun, spec.magazine],
      [p.alt, spec.deploy?.arms.magazine ?? 0],
    ] as const) {
      gun.cooldown = Math.max(0, gun.cooldown - dt)
      if (gun.reload > 0) {
        gun.reload -= dt
        if (gun.reload <= 0) {
          gun.reload = 0
          gun.mag = mag
        }
      }
    }
    if (!p.alive) {
      p.firing = false
      return
    }
    if (!p.local) {
      // 別人變身、收回：放一下聲音（動作在 `RemoteMech` 裡照時間播）
      if (b.deployed !== p.deployWas) {
        p.deployWas = b.deployed
        if (this.shown(p, now)) this.audio.deploy(this.distToCam(b.x, b.y, b.z), b.deployed)
      }
      // 別人開火（打不打得中由開火的人那邊判斷）：機砲照射速畫曳光彈，狙擊型照送來的砲擊數一發一發畫；迫擊砲彈另外收（`onShell`）
      const remote = p.remote
      p.firing = (remote?.firing ?? false) && !shifting(b)
      const shown = this.shown(p, now)
      if (remote && p.kind === 'sniper') {
        for (; remote.shots > 0; remote.shots--) if (shown) this.shoot(p, now, false)
      } else if (spec.deploy?.mortar && b.deployed) {
        p.fireAcc = 0
      } else if (p.firing && shown) {
        p.fireAcc += dt * armsOf(spec, wantsAlt(p)).fireRate
        while (p.fireAcc >= 1) {
          p.fireAcc -= 1
          this.shoot(p, now, false)
        }
      } else p.fireAcc = 0
      return
    }
    const isMe = p === this.me
    const canFire = live && !safe(p.body)
    const ability = isMe && (actions ?? []).includes('ability')
    // 變身（堡壘型、砲擊型）：E 變身、再按一下收回；電腦照它的決定
    if (spec.deploy && (ability || (!isMe && p.bot && p.orders.deploy !== b.deployed))) this.toggleDeploy(p, live)
    // 偵察機：E（電腦照它的決定）放出去；操控時開火鍵引爆、E 回到機甲（偵察機停在原地繼續偵測），
    // 停著的時候再按 E 回去操控。操控時機甲不能開火
    const droneKey = spec.drones > 0 && ability
    const f = p.drone
    if (f?.piloting) {
      const want = isMe ? fireEdge : p.orders.flight.detonate
      if (want && f.body.age >= DRONE.arm) {
        if (isMe) this.fireBlock = true
        this.detonate(p, now)
      } else if (droneKey) this.parkDrone(p)
      p.firing = false
      p.lockSeat = null
      p.lockTime = 0
      if (isMe && this.locked) {
        this.locked = false
        this.emit({ type: 'lock', locked: false })
      }
      return
    }
    if (droneKey || (!isMe && p.orders.drone && !f)) {
      if (f) this.takeDrone(p)
      else this.launchDrone(p, live)
      if (p.drone?.piloting) {
        p.firing = false
        return
      }
    }
    // 現在用的那一把主武器（變身後換一把）
    const alt = wantsAlt(p)
    const g = alt ? p.alt : p.gun
    const arms = armsOf(spec, alt)
    let wantFire: boolean
    let wantMissile = false
    if (isMe) {
      wantFire = this.controls.fire && !this.fireBlock
      for (const a of actions ?? []) {
        if (a === 'reload' && g.mag < arms.magazine && g.reload === 0) {
          g.reload = arms.reload
          this.audio.reload()
        }
        if (a === 'missile') wantMissile = true
      }
    } else {
      wantFire = p.orders.fire
      wantMissile = p.orders.missile
    }
    // 主武器（變身中、收回中不能用；砲擊型架了砲是迫擊砲，照砲管的方向打出去）
    p.firing = false
    const busy = shifting(b)
    const mortar = spec.deploy?.mortar === true && b.deployed
    if (wantFire && canFire && g.reload === 0 && !busy) {
      if (g.mag <= 0) {
        g.reload = arms.reload
        if (isMe) this.audio.reload()
      } else {
        p.firing = true
        while (g.cooldown <= 0 && g.mag > 0) {
          const lob = mortar ? this.shellAim(p) : null
          if (mortar && !lob) {
            p.firing = false
            break
          }
          g.cooldown += 1 / arms.fireRate
          g.mag--
          p.shots++
          if (lob) this.fireShell(p, lob.yaw, lob.elev)
          else this.shoot(p, now, true)
        }
        if (g.mag <= 0) {
          g.reload = arms.reload
          if (isMe) this.audio.reload()
        }
      }
    } else if (wantFire && isMe && !canFire && live) this.audio.empty()
    else if (isMe && fireEdge && busy && live) this.emit({ type: 'toast', text: b.deployed ? '變身中，等一下才能開火' : '收回中，等一下才能開火' })

    // 鎖定：準星附近、看得到、在鎖定距離內的敵人
    const lockTarget = isMe ? (mortar ? null : this.findLock(p, now)) : p.orders.lock
    if (lockTarget !== null && lockTarget === p.lockSeat) p.lockTime += dt
    else {
      p.lockSeat = lockTarget
      p.lockTime = 0
    }
    if (isMe && lockTarget !== null) {
      const done = p.lockTime >= MECH.lockTime
      this.lockBeep -= dt
      if (done !== this.locked) {
        this.locked = done
        this.emit({ type: 'lock', locked: done })
        if (done) this.audio.lock(true)
      } else if (!done && this.lockBeep <= 0) {
        this.lockBeep = 0.12
        this.audio.lock(false)
      }
    } else if (isMe && this.locked) {
      this.locked = false
      this.emit({ type: 'lock', locked: false })
    }

    // 飛彈（架了砲準星不是對著要打的地方，飛彈打不到東西：不讓發射）
    if (wantMissile) {
      if (mortar) {
        if (isMe) this.emit({ type: 'toast', text: '架砲時不能發射飛彈，先收砲' })
      } else if (!canFire) {
        if (isMe) this.emit({ type: 'toast', text: safe(p.body) ? '重生點裡不能開火' : '還不能發射' })
      } else if (p.missiles <= 0) {
        if (isMe) this.emit({ type: 'toast', text: '這條命的飛彈用完了' })
      } else {
        const target = p.lockSeat !== null && p.lockTime >= MECH.lockTime ? p.lockSeat : null
        const o = p.model.podPosition(new Vector3())
        const goal = this.aimGoal(p, new Vector3())
        const dir = this.launchDir(p, o, goal, new Vector3())
        const id = this.nextMissile++
        p.missiles--
        p.model.setMissiles(p.missiles)
        const round = (v: Vector3, k: number) => [v.x, v.y, v.z].map((n) => Math.round(n * k) / k)
        // 送出去的是四捨五入過的，自己這邊也照一樣的值飛，大家看到的彈道才會一樣
        const msg = { id, o: round(o, 100), dir: round(dir, 1000), goal: round(goal, 100) }
        this.launch(
          p,
          id,
          new Vector3(msg.o[0], msg.o[1], msg.o[2]),
          new Vector3(msg.dir[0], msg.dir[1], msg.dir[2]).normalize(),
          target,
          new Vector3(msg.goal[0], msg.goal[1], msg.goal[2]),
          true,
        )
        this.link?.missile({ ...msg, ...(target !== null ? { target } : {}), ...(p.bot ? { by: p.seat } : {}) })
      }
    }
  }

  /** 瞄準的方向（單位向量）：自己是往準星對到的那一點，電腦照它的瞄準角 */
  private aimDir(p: Pilot, out: Vector3): Vector3 {
    const b = p.body
    if (p === this.me) {
      const eye = tmpW.set(b.x, eyeY(p), b.z)
      return out.copy(this.aimPoint).sub(eye).normalize()
    }
    const cp = Math.cos(b.aimPitch)
    return out.set(Math.sin(b.aimYaw) * cp, Math.sin(b.aimPitch), Math.cos(b.aimYaw) * cp)
  }

  /** 準星對到的那一點：自己是鏡頭中間對到的；電腦從眼睛照瞄準角看出去對到的（太遠就取 300 公尺） */
  private aimGoal(p: Pilot, out: Vector3): Vector3 {
    if (p === this.me) return out.copy(this.aimPoint)
    const b = p.body
    const dir = this.aimDir(p, tmpV)
    const ey = eyeY(p)
    const t = this.index.ray(b.x, ey, b.z, dir.x, dir.y, dir.z, 300)
    const far = t === Infinity ? 300 : Math.max(t, 12)
    return out.set(b.x + dir.x * far, ey + dir.y * far, b.z + dir.z * far)
  }

  /**
   * 發射的方向：往準星的那一邊、斜斜地朝上（先往上飛）。
   * 頭上很近就有東西（在橋下、貼著大樓）就不往上，直接往準星飛
   */
  private launchDir(p: Pilot, o: Vector3, goal: Vector3, out: Vector3): Vector3 {
    let hx = goal.x - o.x
    let hz = goal.z - o.z
    const hl = Math.hypot(hx, hz)
    if (hl < 0.5) {
      hx = Math.sin(p.body.aimYaw)
      hz = Math.cos(p.body.aimYaw)
    } else {
      hx /= hl
      hz /= hl
    }
    out.set(hx * 0.6, 1, hz * 0.6).normalize()
    if (this.index.ray(o.x, o.y, o.z, out.x, out.y, out.z, 16) !== Infinity) {
      out.copy(goal).sub(o).normalize()
      out.y += 0.08
      out.normalize()
    }
    return out
  }

  /** 自己的鎖定目標：準星附近（`lockAngle`）、看得到、最近的敵人 */
  private findLock(p: Pilot, now: number): number | null {
    const cam = this.camera
    cam.getWorldDirection(tmpV)
    let best: number | null = null
    let bestA: number = MECH.lockAngle
    for (const q of this.pilots) {
      if (q.team === p.team || !this.shown(q, now) || inBase(q.team, q.body.x, q.body.z)) continue
      const b = q.body
      const dx = b.x - p.body.x
      const dz = b.z - p.body.z
      if (Math.hypot(dx, dz) > MECH.lockRange) continue
      const cx = b.x - cam.position.x
      const cy = midY(q) - cam.position.y
      const cz = b.z - cam.position.z
      const len = Math.hypot(cx, cy, cz)
      const a = Math.acos(clamp((cx * tmpV.x + cy * tmpV.y + cz * tmpV.z) / len, -1, 1))
      if (a >= bestA) continue
      if (!this.index.clear(p.body.x, eyeY(p), p.body.z, b.x, midY(q), b.z)) continue
      bestA = a
      best = q.seat
    }
    return best
  }

  /** 開一發主武器：`real` 是自己這邊開的（打中要回報），別人的只畫出來 */
  private shoot(p: Pilot, now: number, real: boolean) {
    const g = wantsAlt(p) ? p.alt : p.gun
    const spec = armsOf(p.spec, wantsAlt(p))
    const side = g.side
    g.side = 1 - side
    p.model.fire(side)
    const o = p.model.muzzle(side, tmpW.clone())
    const dir = new Vector3()
    const b = p.body
    if (p === this.me) dir.copy(this.aimPoint).sub(o).normalize()
    else {
      // 別人的、電腦的：照瞄準角，從眼睛的高度看出去對到的點
      this.aimDir(p, dir)
      const ey = eyeY(p)
      const t = this.index.ray(b.x, ey, b.z, dir.x, dir.y, dir.z, spec.gunRange)
      const far = t === Infinity ? spec.gunRange : Math.max(t, 10)
      dir.set(b.x + dir.x * far - o.x, ey + dir.y * far - o.y, b.z + dir.z * far - o.z).normalize()
    }
    // 散布：移動、在空中時比較大；狙擊型站穩了放大瞄準幾乎沒有
    const moving = Math.hypot(b.vx, b.vz) > 3
    const zoomed = p === this.me && this.zoom > 0.8
    const spread = !b.onGround ? spec.airSpread : moving ? spec.moveSpread : zoomed ? spec.zoomSpread : spec.spread
    dir.x += (Math.random() - 0.5) * 2 * spread
    dir.y += (Math.random() - 0.5) * 2 * spread
    dir.z += (Math.random() - 0.5) * 2 * spread
    dir.normalize()
    const { t, hit, drone } = this.trace(o.x, o.y, o.z, dir.x, dir.y, dir.z, spec.gunRange, p, now)
    const dist = t === Infinity ? spec.gunRange : t
    const heavy = p.kind === 'sniper'
    const d = p === this.me ? 0 : this.distToCam(o.x, o.y, o.z)
    this.fx.tracer(o.x, o.y, o.z, dir.x, dir.y, dir.z, dist, new Color(TEAMS[p.team].glow), heavy)
    if (heavy) {
      this.audio.cannon(d)
      // 砲口的震波把腳邊的灰塵掀起來
      if (b.onGround) this.fx.dust(b.x, b.y, b.z, 12)
      // 自己開砲：鏡頭用力晃一下、視角震寬一下、準星往上跳一點；旁邊的人開砲也感覺得到
      if (p === this.me) {
        this.fx.shake = Math.min(1, this.fx.shake + 0.6)
        this.fovKick = this.fov * 0.1
        b.aimPitch = clamp(b.aimPitch + 0.012, PITCH_MIN, PITCH_MAX)
      } else this.fx.shake = Math.min(1, this.fx.shake + clamp(1 - d / 40, 0, 0.3))
    } else this.audio.gun(d)
    if (t !== Infinity) {
      const ix = o.x + dir.x * t
      const iy = o.y + dir.y * t
      const iz = o.z + dir.z * t
      this.fx.impact(ix, iy, iz, hit !== null || drone !== null, heavy)
      if (heavy) {
        // 電磁砲打到東西：很響的一聲、附近的鏡頭跟著晃，打在平地上留一片焦痕
        const di = this.distToCam(ix, iy, iz)
        this.audio.slam(di)
        this.fx.shake = Math.min(1, this.fx.shake + clamp(1 - di / 45, 0, 0.45))
        if (!hit && !drone) {
          const g = this.flatGround(ix, iy, iz, 1)
          if (g !== null) this.fx.scorch(ix, g + 0.06, iz, 2.2)
        }
      }
    }
    // 打中敵人的偵察機：伺服器累積到 `DRONE.hp` 就打下來
    if (real && drone) {
      this.hits.push({ seat: drone.seat, w: 'gun', drone: true, ...(p.bot ? { by: p.seat } : {}) })
      if (p === this.me) {
        this.hitAt = now
        this.audio.hitMarker()
      }
      return
    }
    if (!real || !hit || hit.team === p.team || inBase(hit.team, hit.body.x, hit.body.z)) return
    // 狙擊型的電磁砲打中頭：一發擊倒（伺服器只認狙擊型）
    const head = heavy && rayHead(o.x, o.y, o.z, dir.x, dir.y, dir.z, hit) !== Infinity
    this.hits.push({ seat: hit.seat, w: 'gun', ...(head ? { head: true } : {}), ...(p.bot ? { by: p.seat } : {}) })
    if (p === this.me) {
      this.hitAt = now
      this.audio.hitMarker()
    }
  }

  private launch(p: Pilot, id: number, o: Vector3, dir: Vector3, target: number | null, goal: Vector3 | null, local: boolean) {
    const mesh = this.fx.missileMesh()
    mesh.position.copy(o)
    mesh.lookAt(o.x + dir.x, o.y + dir.y, o.z + dir.z)
    this.missiles.push({
      owner: p.seat,
      team: p.team,
      id,
      x: o.x,
      y: o.y,
      z: o.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      speed: MECH.missileLaunch,
      course: goal ? makeCourse(o, dir, goal) : null,
      s: 0,
      target,
      age: 0,
      local,
      mesh,
      trail: 0,
    })
    this.audio.missile(p === this.me ? 0 : this.distToCam(o.x, o.y, o.z))
  }

  /**
   * 飛彈：沿著彈道（`makeCourse`）先往上飛、再彎下來接到「發射點 → 準星那一點」的線上，沿著線飛過去。
   * 有鎖定的飛過彈道最高的那一段後改成追目標（剛轉下來那一段轉得快，之後照 `missileTurn`，衝刺橫移躲得掉）。
   * 撞到東西就爆炸；自己這邊發射的要回報打中誰
   */
  private updateMissiles(dt: number, now: number) {
    let warn = false
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i]
      m.age += dt
      m.speed = Math.min(MECH.missileSpeed, m.speed + MECH.missileAccel * dt)
      const target = m.target !== null ? this.pilots[m.target] : undefined
      const tracking = target !== undefined && this.shown(target, now)
      if (tracking && target === this.me) warn = true
      let step = m.speed * dt
      if (tracking && (m.course === null || m.age > MECH.missilePop)) {
        // 追目標：照轉向速度慢慢轉過去
        const b = target.body
        let wx = b.x - m.x
        let wy = midY(target) - m.y
        let wz = b.z - m.z
        const wl = Math.hypot(wx, wy, wz) || 1
        wx /= wl
        wy /= wl
        wz /= wl
        const turn = m.age < MECH.missilePop + 0.7 ? MECH.missileDive : MECH.missileTurn
        const angle = Math.acos(clamp(m.dx * wx + m.dy * wy + m.dz * wz, -1, 1))
        const k = angle > 1e-4 ? Math.min(1, (turn * dt) / angle) : 1
        const nx = m.dx + (wx - m.dx) * k
        const ny = m.dy + (wy - m.dy) * k
        const nz = m.dz + (wz - m.dz) * k
        const nl = Math.hypot(nx, ny, nz) || 1
        m.dx = nx / nl
        m.dy = ny / nl
        m.dz = nz / nl
      } else if (m.course && !tracking && m.target !== null && m.age > MECH.missilePop) {
        // 鎖定的目標不見了（倒下、看不到）：照現在的方向直直飛
      } else if (m.course) {
        // 沿著彈道：這一格要飛到彈道上的下一點
        m.s += step
        const next = courseAt(m.course, m.s, tmpW)
        const mx = next.x - m.x
        const my = next.y - m.y
        const mz = next.z - m.z
        const ml = Math.hypot(mx, my, mz)
        if (ml > 1e-4) {
          m.dx = mx / ml
          m.dy = my / ml
          m.dz = mz / ml
          step = ml
        }
      }
      const dx = m.dx
      const dy = m.dy
      const dz = m.dz
      const wall = this.index.ray(m.x, m.y, m.z, dx, dy, dz, step)
      // 打到機甲：沿著這一步找最近的
      let direct: Pilot | null = null
      let best = wall === Infinity ? step : wall
      let shielded = false
      for (const p of this.pilots) {
        if (p.seat === m.owner || p.team === m.team || !this.shown(p, now)) continue
        const d = rayMech(m.x, m.y, m.z, dx, dy, dz, p, MECH.missileHit)
        if (d <= best) {
          best = d
          direct = p
          shielded = false
        }
        // 撞到敵人的盾牌：在盾牌上爆炸（不算直接命中，爆風還是炸得到）
        const s = rayShield(m.x, m.y, m.z, dx, dy, dz, p)
        if (s <= best) {
          best = s
          direct = null
          shielded = true
        }
      }
      const hitSomething = direct !== null || shielded || wall !== Infinity
      m.x += dx * Math.min(best, step)
      m.y += dy * Math.min(best, step)
      m.z += dz * Math.min(best, step)
      m.mesh.position.set(m.x, m.y, m.z)
      m.mesh.lookAt(m.x + dx, m.y + dy, m.z + dz)
      m.trail += dt
      while (m.trail > 0.015) {
        m.trail -= 0.015
        this.fx.trail(m.x - dx * 0.8, m.y - dy * 0.8, m.z - dz * 0.8)
      }
      if (!hitSomething && m.age < MECH.missileLife && m.y > BED - 1) continue
      this.explode(m, direct, now)
      this.fx.removeMissile(m.mesh)
      this.missiles.splice(i, 1)
    }
    if (warn && this.me?.alive) this.audio.warn()
    this.frame.warn = warn
  }

  private explode(m: Missile, direct: Pilot | null, now: number) {
    this.fx.explosion(m.x, m.y, m.z, 1)
    const d = this.distToCam(m.x, m.y, m.z)
    this.audio.explosion(d, false)
    this.fx.shake = Math.min(1, this.fx.shake + clamp(1 - d / 60, 0, 0.5))
    if (!m.local) return
    const owner = this.pilots[m.owner]
    if (!owner) return
    const hits: HitReport[] = []
    const by = owner.bot ? { by: owner.seat } : {}
    if (direct && !inBase(direct.team, direct.body.x, direct.body.z)) hits.push({ seat: direct.seat, w: 'missile', id: m.id, direct: true, ...by })
    // 爆風：附近看得到爆炸點的敵人
    for (const p of this.pilots) {
      if (p === direct || p.team === m.team || !this.shown(p, now) || inBase(p.team, p.body.x, p.body.z)) continue
      const b = p.body
      const dist = Math.hypot(b.x - m.x, midY(p) - m.y, b.z - m.z)
      if (dist > MECH.splash) continue
      if (!this.index.clear(m.x, m.y + 0.5, m.z, b.x, midY(p), b.z)) continue
      hits.push({ seat: p.seat, w: 'missile', id: m.id, direct: false, ...by })
    }
    if (hits.length === 0) return
    this.hits.push(...hits)
    if (owner === this.me) {
      this.hitAt = now
      this.audio.hitMarker()
    }
  }

  // ---------- 變身、迫擊砲 ----------

  /** 變身、收回（堡壘型、砲擊型）：開打了、站在地上才能變身；收回隨時可以（變身到一半也可以反悔） */
  private toggleDeploy(p: Pilot, live: boolean) {
    const b = p.body
    const isMe = p === this.me
    if (!b.deployed) {
      if (!live || !b.onGround) {
        if (isMe) this.emit({ type: 'toast', text: !live ? '還不能變身' : '站在地上才能變身' })
        return
      }
      b.deployed = true
      b.boosting = false
    } else b.deployed = false
    if (isMe) this.zoom = 0
    this.audio.deploy(isMe ? 0 : this.distToCam(b.x, b.y, b.z), b.deployed)
  }

  /**
   * 這一發迫擊砲彈往哪裡打（方位、仰角）：自己就是砲管現在的方向；電腦給的是它想打的那一點，
   * 這裡照砲口的位置算出要抬幾度（太近、太遠打不到就不打）
   */
  private shellAim(p: Pilot): { yaw: number; elev: number } | null {
    const b = p.body
    if (p === this.me) return { yaw: b.aimYaw, elev: clamp(b.aimPitch, SHELL.elevMin, SHELL.elevMax) }
    const s = p.orders.shell
    if (!s) return null
    const o = p.model.muzzle(0, tmpW)
    const elev = shellElevation(Math.hypot(s.x - o.x, s.z - o.z), s.y - o.y)
    return elev === null ? null : { yaw: Math.atan2(s.x - o.x, s.z - o.z), elev }
  }

  /**
   * 發射一發迫擊砲彈：從砲口照方位 `yaw`、仰角 `elev` 用固定的初速打出去，方向照散布偏一點（放大瞄準準一點）。
   * 送給伺服器的是四捨五入過的，自己這邊也照一樣的值飛，大家看到的彈道才一樣
   */
  private fireShell(p: Pilot, yaw: number, elev: number) {
    const arms = armsOf(p.spec, true)
    p.model.fire(0)
    const o = p.model.muzzle(0, new Vector3())
    const spread = p === this.me && this.zoom > 0.8 ? arms.zoomSpread : arms.spread
    const a = yaw + (Math.random() - 0.5) * 2 * spread
    const e = elev + (Math.random() - 0.5) * spread
    const vx = Math.sin(a) * Math.cos(e) * SHELL.speed
    const vy = Math.sin(e) * SHELL.speed
    const vz = Math.cos(a) * Math.cos(e) * SHELL.speed
    const round = (v: number, k: number) => Math.round(v * k) / k
    const msg = { id: this.nextMissile++, o: [round(o.x, 100), round(o.y, 100), round(o.z, 100)], v: [round(vx, 1000), round(vy, 1000), round(vz, 1000)] }
    this.addShell(p, msg.id, msg.o, msg.v, true)
    this.link?.shell({ ...msg, ...(p.bot ? { by: p.seat } : {}) })
    // 自己開砲：鏡頭用力晃、視角震寬一下，接著抬頭看砲彈飛出去
    if (p === this.me) {
      this.fx.shake = 1
      this.fovKick = 7
      this.watch = this.shells[this.shells.length - 1] ?? null
    }
  }

  /** 爆炸點是不是在一片平的地面上（留焦痕用，半徑 `r`）：是就回傳地面的高度，不是（牆上、斜坡、水裡）回傳 null */
  private flatGround(x: number, y: number, z: number, r: number): number | null {
    const g = this.index.ground(x, y + 0.5, z, 0.5, 1)
    if (g < WATER || Math.abs(g - y) > 1.2) return null
    for (const [ox, oz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ]) {
      if (Math.abs(this.index.ground(x + ox, y + 0.5, z + oz, 0.5, 1) - g) > 0.4) return null
    }
    return g
  }

  /** 一發砲彈開始飛（自己的、別人的）：砲口的火光和很大的砲聲（整張地圖都聽得到，這是對方唯一的提示） */
  private addShell(p: Pilot, id: number, o: number[], v: number[], local: boolean) {
    const mesh = this.fx.shellMesh()
    mesh.position.set(o[0], o[1], o[2])
    mesh.scale.setScalar(1.6)
    const s: Shell = {
      owner: p.seat,
      team: p.team,
      id,
      x: o[0],
      y: o[1],
      z: o[2],
      vx: v[0],
      vy: v[1],
      vz: v[2],
      age: 0,
      local,
      mesh,
      trail: 0,
    }
    this.shells.push(s)
    const vl = Math.hypot(v[0], v[1], v[2]) || 1
    const b = p.body
    this.fx.mortarFlash(o[0], o[1], o[2], v[0] / vl, v[1] / vl, v[2] / vl, b.x, b.y, b.z)
    const d = p === this.me ? 0 : this.distToCam(o[0], o[1], o[2])
    this.audio.mortar(d)
    // 旁邊的人開砲：地面跟著震
    if (p !== this.me) this.fx.shake = Math.min(1, this.fx.shake + clamp(1 - d / 60, 0, 0.5))
  }

  private removeShell(s: Shell) {
    this.fx.removeMissile(s.mesh)
  }

  /** 迫擊砲彈：照重力飛，撞到地圖、敵人的機甲或盾牌就爆炸（落點沒有任何標示、警告）。自己這邊發射的要回報炸到誰 */
  private updateShells(dt: number, now: number) {
    const G = SHELL.gravity
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i]
      s.age += dt
      const dx = s.vx * dt
      const dy = s.vy * dt - 0.5 * G * dt * dt
      const dz = s.vz * dt
      s.vy -= G * dt
      const len = Math.hypot(dx, dy, dz) || 1e-6
      const ux = dx / len
      const uy = dy / len
      const uz = dz / len
      const wall = this.index.ray(s.x, s.y, s.z, ux, uy, uz, len)
      let best = wall === Infinity ? len : wall
      let hit = wall !== Infinity
      let direct: Pilot | null = null
      for (const p of this.pilots) {
        if (p.team === s.team || !this.shown(p, now)) continue
        const d = rayMech(s.x, s.y, s.z, ux, uy, uz, p, 0.4)
        if (d <= best) {
          best = d
          direct = p
          hit = true
        }
        const sh = rayShield(s.x, s.y, s.z, ux, uy, uz, p)
        if (sh <= best) {
          best = sh
          direct = null
          hit = true
        }
      }
      const step = Math.min(best, len)
      s.x += ux * step
      s.y += uy * step
      s.z += uz * step
      s.mesh.position.set(s.x, s.y, s.z)
      s.mesh.lookAt(s.x + s.vx, s.y + s.vy, s.z + s.vz)
      s.trail += dt
      while (s.trail > 0.03) {
        s.trail -= 0.03
        this.fx.shellTrail(s.x - ux * 0.6, s.y - uy * 0.6, s.z - uz * 0.6, s.age < 1.5)
      }
      if (!hit && s.age < SHELL.life && s.y > BED - 1) continue
      if (hit) this.explodeShell(s, direct, now)
      this.removeShell(s)
      this.shells.splice(i, 1)
    }
  }

  /** 砲彈爆炸：爆炸半徑內、看得到爆炸點的敵人都擊倒（傷害伺服器算），自己這邊發射的送給伺服器 */
  private explodeShell(s: Shell, direct: Pilot | null, now: number) {
    this.fx.shellBlast(s.x, s.y, s.z)
    const g = this.flatGround(s.x, s.y, s.z, 3.5)
    if (g !== null) this.fx.scorch(s.x, g + 0.08, s.z, SHELL.blast * 0.8)
    const d = this.distToCam(s.x, s.y, s.z)
    this.audio.blast(d)
    this.fx.shake = Math.min(1, this.fx.shake + clamp(1.15 - d / 130, 0, 1))
    if (!s.local) return
    const owner = this.pilots[s.owner]
    if (!owner) return
    const by = owner.bot ? { by: owner.seat } : {}
    const hits: HitReport[] = []
    for (const q of this.pilots) {
      if (q.team === s.team || !this.shown(q, now) || inBase(q.team, q.body.x, q.body.z)) continue
      const b = q.body
      const cx = clamp(s.x, b.x - q.spec.hitR, b.x + q.spec.hitR)
      const cy = clamp(s.y, b.y, b.y + hitHOf(q))
      const cz = clamp(s.z, b.z - q.spec.hitR, b.z + q.spec.hitR)
      const dist = Math.hypot(s.x - cx, s.y - cy, s.z - cz)
      if (q !== direct && dist > SHELL.blast) continue
      if (q !== direct && dist > 2 && !this.index.clear(s.x, s.y + 0.5, s.z, b.x, midY(q), b.z)) continue
      hits.push({ seat: q.seat, w: 'shell', id: s.id, ...by })
    }
    if (hits.length === 0) return
    this.hits.push(...hits)
    if (owner === this.me) {
      this.hitAt = now
      this.audio.hitMarker()
    }
  }

  // ---------- 偵察機 ----------

  /** 背上掛的偵察機（用掉、飛出去的不畫）和雷達轉多快 */
  private rack(p: Pilot) {
    if (!(p.model instanceof ReconModel)) return
    p.model.setDrones(p.drones - (p.drone ? 1 : 0))
    p.model.flying = p.drone !== null
  }

  private makeFlyer(p: Pilot, body: DroneBody, piloting: boolean): Flyer {
    const model = new DroneModel(this.kit, p.team)
    this.world.scene.add(model.root)
    return { body, model, input: { forward: 0, strafe: 0, rise: 0 }, piloting, hp: DRONE.hp, pulse: 0.3 }
  }

  private removeFlyer(p: Pilot) {
    const f = p.drone
    if (!f) return
    this.world.scene.remove(f.model.root)
    f.model.dispose()
    p.drone = null
  }

  /** 放出偵察機：要是偵察型、還有偵察機、開打了、不在重生點裡 */
  private launchDrone(p: Pilot, live: boolean) {
    const isMe = p === this.me
    if (p.spec.drones === 0 || !(p.model instanceof ReconModel)) return
    if (!live || safe(p.body)) {
      if (isMe) this.emit({ type: 'toast', text: safe(p.body) ? '重生點裡不能放偵察機' : '還不能放偵察機' })
      return
    }
    if (p.drones <= 0) {
      if (isMe) this.emit({ type: 'toast', text: '這條命的偵察機用完了' })
      return
    }
    const o = p.model.launchPosition(new Vector3())
    p.drone = this.makeFlyer(p, newDrone(o.x, o.y, o.z, p.body.aimYaw), true)
    this.rack(p)
    this.audio.drone(isMe ? 0 : this.distToCam(o.x, o.y, o.z))
    if (isMe) {
      this.zoom = 0
      this.camReady = false
    }
  }

  /** 回到機甲：偵察機停在原地（慢慢停下來）繼續偵測 */
  private parkDrone(p: Pilot) {
    const f = p.drone
    if (!f) return
    f.piloting = false
    Object.assign(f.input, { forward: 0, strafe: 0, rise: 0 })
    if (p === this.me) {
      this.camReady = false
      this.audio.ping()
    }
  }

  /** 回去操控停著的偵察機（重生點裡不行，和放出去一樣） */
  private takeDrone(p: Pilot) {
    const f = p.drone
    if (!f) return
    if (safe(p.body)) {
      if (p === this.me) this.emit({ type: 'toast', text: '重生點裡不能操控偵察機' })
      return
    }
    f.piloting = true
    if (p === this.me) {
      this.zoom = 0
      this.camReady = false
      this.audio.ping()
    }
  }

  /** 自己的偵察機狀態變了就通知畫面（觸控按鈕跟著換） */
  private syncDroneMode() {
    const f = this.me?.alive ? this.me.drone : null
    const mode: DroneMode = !f ? 'none' : f.piloting ? 'fly' : 'parked'
    if (mode === this.droneMode) return
    this.droneMode = mode
    this.emit({ type: 'drone', mode })
  }

  /** 引爆自己這邊的偵察機：爆炸半徑內、看得到爆炸點的敵人都擊倒（送給伺服器算） */
  private detonate(p: Pilot, now: number) {
    const f = p.drone
    if (!f) return
    const d = f.body
    const n = p.spec.drones - p.drones
    this.removeFlyer(p)
    p.drones = Math.max(0, p.drones - 1)
    this.rack(p)
    this.blast(d.x, d.y, d.z)
    const hits: number[] = []
    for (const q of this.pilots) {
      if (q.team === p.team || !this.shown(q, now) || inBase(q.team, q.body.x, q.body.z)) continue
      // 爆炸點到打中範圍（方塊）最近的那一點
      const b = q.body
      const cx = clamp(d.x, b.x - q.spec.hitR, b.x + q.spec.hitR)
      const cy = clamp(d.y, b.y, b.y + hitHOf(q))
      const cz = clamp(d.z, b.z - q.spec.hitR, b.z + q.spec.hitR)
      const dist = Math.hypot(d.x - cx, d.y - cy, d.z - cz)
      if (dist > DRONE.blast) continue
      if (dist > 2 && !this.index.clear(d.x, d.y, d.z, b.x, midY(q), b.z)) continue
      hits.push(q.seat)
    }
    const round = (v: number) => Math.round(v * 100) / 100
    this.link?.boom({ o: [round(d.x), round(d.y), round(d.z)], hits, n, ...(p.bot ? { by: p.seat } : {}) })
    if (p === this.me) {
      this.camReady = false
      if (hits.length) {
        this.hitAt = now
        this.audio.hitMarker()
      }
    }
  }

  /** 偵察機爆炸的畫面和聲音 */
  private blast(x: number, y: number, z: number) {
    this.fx.explosion(x, y, z, 1.3)
    const d = this.distToCam(x, y, z)
    this.audio.explosion(d, false)
    this.fx.shake = Math.min(1, this.fx.shake + clamp(1 - d / 60, 0, 0.5))
  }

  /** 別人的偵察機照收到的位置平滑過去；每一架擺模型、定時放掃描波 */
  private updateDrones(dt: number, now: number) {
    for (const p of this.pilots) {
      if (!p.local && p.remote) {
        const at = p.alive && p.remote.visible(now) ? p.remote.drone : null
        if (!at || p.remote.droneN === p.droneGone) {
          this.removeFlyer(p)
          if (!at && p.droneGone >= 0) {
            p.droneGone = -1
            this.rack(p)
          }
        } else {
          p.droneGone = -1
          if (!p.drone) {
            p.drone = this.makeFlyer(p, newDrone(at[0], at[1], at[2], p.body.aimYaw), false)
            Object.assign(p.drone.body, { vx: 0, vy: 0, vz: 0 })
            this.rack(p)
          }
          const d = p.drone.body
          const k = 1 - Math.exp(-10 * dt)
          const nx = d.x + (at[0] - d.x) * k
          const ny = d.y + (at[1] - d.y) * k
          const nz = d.z + (at[2] - d.z) * k
          if (dt > 0) {
            d.vx = (nx - d.x) / dt
            d.vy = (ny - d.y) / dt
            d.vz = (nz - d.z) / dt
          }
          d.x = nx
          d.y = ny
          d.z = nz
          // 鏡頭的方向照收到的（掃描照這個算）
          d.yaw = wrapAngle(d.yaw + wrapAngle(p.remote.droneYaw - d.yaw) * k)
          d.pitch += (p.remote.dronePitch - d.pitch) * k
        }
      }
      const f = p.drone
      if (!f) continue
      const d = f.body
      const near = this.distToCam(d.x, d.y, d.z) < DRONE_CULL
      f.model.root.visible = near
      if (near) f.model.pose(d.x, d.y, d.z, d.yaw, d.pitch, this.reachOf(p), d.vx, d.vz, dt)
      f.pulse -= dt
      if (f.pulse <= 0) {
        f.pulse = DRONE.pulse
        f.model.pulse()
        if (p === this.me && f.piloting) this.audio.ping()
      }
    }
  }

  /** 偵察機現在看得多遠（離自己的機甲越遠訊號越差、看得越近；沒有偵察機是 0） */
  private reachOf(p: Pilot): number {
    const d = p.drone?.body
    return d ? droneReach(droneNoise(droneDistance(d, p.body))) : 0
  }

  /**
   * 偵察機的掃描：鏡頭的畫面裡（`inDroneView`）、看得到的距離內（`reachOf`）、中間沒被擋住的敵人，
   * 自己這隊（觀戰時是鏡頭跟著的那隊）的偵察機掃到就標記 `DRONE.mark` 秒；敵人的偵察機掃到自己就警告。
   * 每個人在自己這邊算（偵察機的位置和鏡頭方向在狀態裡）
   */
  private updateScan(dt: number, now: number) {
    this.scanTimer -= dt
    if (this.scanTimer > 0) return
    this.scanTimer = 0.2
    const viewer = this.me ?? this.pilots[this.focus]
    if (!viewer) return
    for (const p of this.pilots) {
      const f = p.drone
      if (!f || !p.alive) continue
      const d = f.body
      const reach = this.reachOf(p)
      if (reach <= 0) continue
      for (const q of this.pilots) {
        if (q.team === p.team || !this.shown(q, now) || inBase(q.team, q.body.x, q.body.z)) continue
        const b = q.body
        const y = midY(q)
        if (Math.hypot(b.x - d.x, y - d.y, b.z - d.z) > reach || !inDroneView(d, b.x, y, b.z)) continue
        if (!this.index.clear(d.x, d.y, d.z, b.x, y, b.z)) continue
        if (p.team === viewer.team) q.spottedUntil = now + DRONE.mark * 1000
        if (q === this.me) this.scannedUntil = now + 700
      }
    }
  }

  private network(dt: number) {
    const link = this.link
    if (!link || this.phase === 'ended') return
    this.sendTimer -= dt
    if (this.sendTimer <= 0) {
      this.sendTimer = Math.max(0, this.sendTimer + SEND_EVERY)
      const me = this.me
      const state = (p: Pilot) =>
        encodeState(p.body, this.clock, p.firing, p.gun.reload > 0, p.life, p.shots, p.drone?.body ?? null, p.spec.drones - p.drones)
      const mine = me && me.alive ? state(me) : null
      const bots: number[][] = []
      if (this.driving) {
        for (const p of this.pilots) {
          if (p.bot && p.local && p.alive) bots.push([p.seat, ...state(p)])
        }
      }
      // 負責開電腦的人一定要送（電腦都倒下了也要讓伺服器知道自己還在跑），不然會被換掉
      if (mine || this.driving) link.state(mine, bots)
    }
    this.hitTimer -= dt
    if (this.hits.length && this.hitTimer <= 0) {
      this.hitTimer = HIT_EVERY
      link.hits(this.hits.splice(0, 96))
    }
    this.pingTimer -= dt
    if (this.pingTimer <= 0) {
      this.pings++
      this.pingTimer = this.pings < PING_BURST ? PING_FIRST : PING_EVERY
      link.ping(performance.now())
    }
  }

  private updateVisuals(dt: number, now: number) {
    // 開了狙擊鏡：鏡頭在砲塔裡，自己的機甲不畫
    const scoped = this.scoped()
    for (const p of this.pilots) {
      const b = p.body
      // 太遠的不畫（也不擺姿勢、不冒煙）、遠的換成簡單外形：60 台時省很多
      const dist = p === this.me ? 0 : this.distToCam(b.x, b.y, b.z)
      const visible = this.shown(p, now) && dist < CULL
      p.model.setVisible(visible && !(scoped && p === this.me))
      if (!p.alive) {
        // 殘骸冒煙到復活
        if (p.wreck && now - p.wreck.at < MECH.respawn * 1000) {
          p.puff += dt
          while (p.puff > 0.08) {
            p.puff -= 0.08
            this.fx.wreck(p.wreck.x, p.wreck.y, p.wreck.z)
          }
        }
        continue
      }
      if (!visible) continue
      const far = dist > LOD * (BASE_FOV / this.camera.fov)
      p.model.setFar(far, this.kit, p.spec)
      if (far) {
        p.model.poseFar(b)
        continue
      }
      p.model.pose(b, p.firing && !shifting(b), dt)
      // 推進器的火和煙（長弓沒有推進器）
      const jets = p.spec.jets
      if (jets && (b.boosting || b.hovering)) {
        p.puff += dt * (b.boosting ? 40 : 25)
        // 兩具推進器在背上，跟著上半身轉
        const sin = Math.sin(b.aimYaw)
        const cos = Math.cos(b.aimYaw)
        const color = new Color(TEAMS[p.team].glow)
        while (p.puff > 1) {
          p.puff -= 1
          for (const s of [-1, 1]) {
            const ox = -cos * s * jets.side - sin * jets.back
            const oz = sin * s * jets.side - cos * jets.back
            this.fx.thrust(b.x + ox, b.y + jets.up, b.z + oz, -sin * 0.8, -0.6, -cos * 0.8, color, b.boosting)
          }
        }
        if (b.boosting && b.onGround && Math.random() < 0.5) this.fx.dust(b.x, b.y, b.z, 1)
      }
      // 腳步：每踩一步（噴火衝刺時腳不動；長弓快跑一樣有腳步）
      const step = Math.floor(b.stride / Math.PI)
      if (step !== p.stepPrev) {
        p.stepPrev = step
        if (b.onGround && (!b.boosting || !jets)) {
          this.audio.step(p === this.me ? 0 : this.distToCam(b.x, b.y, b.z), clamp(Math.hypot(b.vx, b.vz) / p.spec.walk, 0, 1))
          if (Math.random() < 0.6) this.fx.dust(b.x, b.y, b.z, 2)
        }
      }
      if (b.landed > 0.95) {
        this.fx.dust(b.x, b.y, b.z, 8)
        this.audio.step(p === this.me ? 0 : this.distToCam(b.x, b.y, b.z), 1)
        if (p === this.me) this.fx.shake = Math.min(1, this.fx.shake + 0.2)
        b.landed = 0.94
      }
    }
    this.fx.update(dt, this.particleScale())
  }

  private particleScale() {
    const h = this.renderer.domElement.height || 1
    return h / (2 * Math.tan((this.camera.fov * Math.PI) / 360))
  }

  /** 選單、選隊：鏡頭繞著大橋上的機甲轉 */
  private orbitCamera(dt: number) {
    this.orbit += dt * (this.phase === 'showroom' ? 0.18 : 0.06)
    const showroom = this.phase === 'showroom'
    const c = showroom ? SHOWROOM : SHOWCASE
    const r = showroom ? 17 : 30
    const a = this.orbit + (showroom ? 0 : 1.2)
    const y = this.index.ground(c.x, 50, c.z, 2, MECH.step)
    this.camera.position.set(c.x + Math.sin(a) * r, y + (showroom ? 6 : 12), c.z + Math.cos(a) * r)
    this.camera.lookAt(c.x, y + (showroom ? 3.4 : 4), c.z)
    this.setFov(showroom ? 40 : 55)
  }

  private setFov(fov: number) {
    if (Math.abs(this.camera.fov - fov) < 0.01) return
    this.camera.fov = fov
    this.camera.updateProjectionMatrix()
  }

  private updateCamera(dt: number, now: number) {
    const me = this.me
    // 倒下：從殘骸旁邊看著打倒自己的人
    if (me && !me.alive && me.wreck) {
      this.deathCam += dt
      const w = me.wreck
      const killer = this.killer !== null ? this.pilots[this.killer] : null
      const lookAt = killer && this.shown(killer, now) ? tmpV.set(killer.body.x, killer.body.y + 3.5, killer.body.z) : tmpV.set(w.x, w.y, w.z)
      const a = me.body.aimYaw + Math.PI + this.deathCam * 0.25
      const r = 12 + Math.min(this.deathCam, 2) * 4
      tmpW.set(w.x + Math.sin(a) * r, w.y + 8 + Math.min(this.deathCam, 2) * 3, w.z + Math.cos(a) * r)
      this.camera.position.lerp(tmpW, Math.min(1, dt * 3))
      this.camera.lookAt(lookAt)
      this.setFov(BASE_FOV)
      return
    }
    // 操控偵察機：鏡頭在偵察機後上方
    if (me && me.alive && me.drone?.piloting) {
      this.droneCamera(me.drone.body, dt)
      return
    }
    const p = me ?? this.pilots[this.focus]
    if (!p) return
    if (!me && !this.shown(p, now) && p.alive === false) {
      const next = this.cycleFocus()
      if (next !== null) this.emit({ type: 'focus', seat: next })
    }
    const b = p.body
    const spec = p.spec
    const yaw = b.aimYaw
    const pitch = viewPitch(p)
    // 觀戰時看不到別人有沒有放大瞄準
    const z = p === me ? this.zoom : 0
    // 變身後換一組鏡頭（堡壘型貼在正後方；砲擊型架砲時拉遠到右後方，只微微抬頭）
    const dep = spec.deploy
    const dk = dep ? ease(b.deploy) : 0
    const cam = (i: number) => spec.cam[i] + ((dep?.cam[i] ?? 0) - spec.cam[i]) * dk
    const zcam = (i: number) => spec.zoomCam[i] + ((dep?.zoomCam[i] ?? 0) - spec.zoomCam[i]) * dk
    const back = cam(0) + (zcam(0) - cam(0)) * z
    const side = cam(1) + (zcam(1) - cam(1)) * z
    const up = cam(2) + (zcam(2) - cam(2)) * z
    const fx = Math.sin(yaw) * Math.cos(pitch)
    const fy = Math.sin(pitch)
    const fz = Math.cos(yaw) * Math.cos(pitch)
    // 砲擊型剛開砲：鏡頭的位置不動，抬頭看著砲彈飛出去（仰角高時砲彈一下就飛出畫面上緣），看完慢慢轉回來
    const w = p === me ? this.watch : null
    const watching = w !== null && w.age < SHELL.watch.time && this.shells.includes(w)
    if (w && watching) {
      const to = Math.atan2(w.y - this.camPos.y, Math.hypot(w.x - this.camPos.x, w.z - this.camPos.z))
      this.watchPitch = clamp(to - SHELL.watch.above, pitch, Math.max(pitch, SHELL.watch.max))
    } else if (w) this.watch = null
    this.watchK += ((watching ? 1 : 0) - this.watchK) * Math.min(1, dt * (watching ? 9 : 2.2))
    const look = this.watchK > 0.001 ? pitch + (Math.max(this.watchPitch, pitch) - pitch) * this.watchK : pitch
    const lx = Math.sin(yaw) * Math.cos(look)
    const ly = Math.sin(look)
    const lz = Math.cos(yaw) * Math.cos(look)
    const rx = -Math.cos(yaw)
    const rz = Math.sin(yaw)
    const px = b.x
    const py = b.y + spec.eye
    const pz = b.z
    // 往後、往右一點、往上一點（越往下看鏡頭越高）
    let cx = px - fx * back + rx * side
    let cy = py - fy * back + up
    let cz = pz - fz * back + rz * side
    // 鏡頭不要穿牆：從機甲頭上往鏡頭拉一條線，撞到東西就停在前面
    const dx = cx - px
    const dy = cy - py
    const dz = cz - pz
    const len = Math.hypot(dx, dy, dz)
    const hit = len > 0.01 ? this.index.ray(px, py, pz, dx / len, dy / len, dz / len, len + 0.6) : Infinity
    if (hit !== Infinity) {
      const d = Math.max(Math.min(1.2, len), hit - 0.6)
      cx = px + (dx / len) * d
      cy = py + (dy / len) * d
      cz = pz + (dz / len) * d
    }
    // 也不要貼著頭頂的樓板、高架的底下（往上看時畫面上緣會穿過去），再不要低到腳底下（河床比地面低，所以照機甲的高度算）
    cy = Math.max(Math.min(cy, this.index.ceiling(cx, cz, 0.6, py) - 0.5), b.y + 0.8)
    if (!this.camReady) {
      this.camPos.set(cx, cy, cz)
      this.camReady = true
    } else {
      // 自己的鏡頭幾乎不延遲（瞄準要跟手），觀戰的平滑一點
      const k = me ? 1 - Math.exp(-40 * dt) : 1 - Math.exp(-8 * dt)
      this.camPos.x += (cx - this.camPos.x) * k
      this.camPos.y += (cy - this.camPos.y) * k
      this.camPos.z += (cz - this.camPos.z) * k
    }
    const shake = this.fx.shake * this.fx.shake * 0.35
    this.camera.position.set(
      this.camPos.x + (Math.random() - 0.5) * shake,
      this.camPos.y + (Math.random() - 0.5) * shake,
      this.camPos.z + (Math.random() - 0.5) * shake,
    )
    // 晃的時候看的方向也跟著抖一點（只移位置的話，遠的東西幾乎不會動）
    this.camera.lookAt(
      this.camPos.x + lx * 50 + (Math.random() - 0.5) * shake * 3,
      this.camPos.y + ly * 50 + (Math.random() - 0.5) * shake * 3,
      this.camPos.z + lz * 50 + (Math.random() - 0.5) * shake * 3,
    )
    // 衝刺時視角拉寬一點（長弓快跑只拉一半）
    const boost = b.boosting ? (spec.jets ? 1 : 0.5) : 0
    // 直的手機畫面很窄：視角放寬一點，左右才看得到東西
    const base = this.camera.aspect < 1 ? PORTRAIT_FOV : BASE_FOV
    this.fov += (base + boost * 8 - (base - zoomFovOf(p)) * z - this.fov) * Math.min(1, dt * (z > 0.5 ? 12 : 6))
    // 開砲的瞬間視角被震寬一下
    this.fovKick *= Math.exp(-9 * dt)
    this.setFov(this.fov + (p === me ? this.fovKick : 0))
  }

  /** 偵察機的鏡頭：在機身後上方一點，照偵察機的鏡頭方向看出去，不穿牆 */
  private droneCamera(d: DroneBody, dt: number) {
    const fx = Math.sin(d.yaw) * Math.cos(d.pitch)
    const fy = Math.sin(d.pitch)
    const fz = Math.cos(d.yaw) * Math.cos(d.pitch)
    let cx = d.x - fx * 4.2
    let cy = d.y - fy * 4.2 + 1.1
    let cz = d.z - fz * 4.2
    const dx = cx - d.x
    const dy = cy - d.y
    const dz = cz - d.z
    const len = Math.hypot(dx, dy, dz)
    const hit = this.index.ray(d.x, d.y, d.z, dx / len, dy / len, dz / len, len + 0.4)
    if (hit !== Infinity) {
      const k = Math.max(0.3, hit - 0.4) / len
      cx = d.x + dx * k
      cy = d.y + dy * k
      cz = d.z + dz * k
    }
    if (!this.camReady) {
      this.camPos.set(cx, cy, cz)
      this.camReady = true
    } else {
      const k = 1 - Math.exp(-30 * dt)
      this.camPos.x += (cx - this.camPos.x) * k
      this.camPos.y += (cy - this.camPos.y) * k
      this.camPos.z += (cz - this.camPos.z) * k
    }
    const shake = this.fx.shake * this.fx.shake * 0.35
    this.camera.position.set(
      this.camPos.x + (Math.random() - 0.5) * shake,
      this.camPos.y + (Math.random() - 0.5) * shake,
      this.camPos.z + (Math.random() - 0.5) * shake,
    )
    this.camera.lookAt(this.camPos.x + fx * 50, this.camPos.y + fy * 50, this.camPos.z + fz * 50)
    const base = this.camera.aspect < 1 ? PORTRAIT_FOV : BASE_FOV
    this.fov += (base - this.fov) * Math.min(1, dt * 6)
    this.setFov(this.fov)
  }

  /** 自己是狙擊型、開著狙擊鏡 */
  private scoped(): boolean {
    const me = this.me
    return me !== null && me.alive && me.kind === 'sniper' && this.zoom > 0.6
  }

  private updateAudio() {
    const me = this.me
    const b = me?.alive ? me.body : null
    // 推進器的聲音（長弓、渡鴉沒有推進器）；操控偵察機時是旋翼的嗡嗡聲，停著的離鏡頭越遠越小聲
    this.audio.thrust(b && me?.spec.jets ? (b.boosting ? 1 : b.hovering ? 0.6 : 0) : 0)
    const f = me?.alive ? me.drone : null
    const d = f?.body
    const level = !d ? 0 : f.piloting ? 0.5 + Math.min(0.5, Math.hypot(d.vx, d.vy, d.vz) / 50) : 0.4 * clamp(1 - this.distToCam(d.x, d.y, d.z) / 40, 0, 1)
    this.audio.buzz(level)
  }

  private emitFrame(now: number) {
    const f = this.frame
    const me = this.me
    const home = me !== null && me.alive && safe(me.body) && (this.phase === 'battle' || this.phase === 'countdown')
    if (home !== this.home) {
      this.home = home
      this.emit({ type: 'home', inside: home })
    }
    const deployOn = me !== null && me.alive && me.body.deployed
    if (deployOn !== this.deployOn) {
      this.deployOn = deployOn
      this.emit({ type: 'deploy', on: deployOn })
    }
    const p = me ?? this.pilots[this.focus]
    f.clock = this.clock * 1000
    f.zoom = me ? this.zoom : 0
    f.scope = this.scoped()
    f.range = me ? Math.hypot(this.aimPoint.x - me.body.x, this.aimPoint.y - eyeY(me), this.aimPoint.z - me.body.z) : 0
    f.hitAt = this.hitAt
    f.hurtAt = this.hurtAt
    f.hurtDir = this.hurtDir
    const out = me?.alive ? me.drone : null
    const far = me && out ? droneDistance(out.body, me.body) : 0
    if (me && out?.piloting) {
      const noise = droneNoise(far)
      const tv = Math.tan((this.camera.fov * Math.PI) / 360)
      const fw = Math.min(0.96, Math.tan((DRONE.viewH * Math.PI) / 180) / (tv * this.camera.aspect))
      const fh = Math.min(0.96, Math.tan((DRONE.viewV * Math.PI) / 180) / tv)
      f.flight = { far, hp: out.hp / DRONE.hp, noise, reach: droneReach(noise), fw, fh }
    } else {
      f.flight = null
    }
    this.setBlur(f.flight?.noise ?? 0)
    f.parked = out !== null && !out.piloting
    f.scanned = me !== null && me.alive && now < this.scannedUntil
    if (p) {
      const b = p.body
      f.hp = p.hp
      f.energy = b.energy / MECH.energy
      f.drained = b.drained
      const alt = wantsAlt(p)
      const g = alt ? p.alt : p.gun
      const arms = armsOf(p.spec, alt)
      f.ammo = g.mag
      f.magazine = arms.magazine
      f.reload = g.reload > 0 ? 1 - g.reload / arms.reload : -1
      f.deploy = !p.spec.deploy ? -1 : b.deployed ? (deployedReady(b) ? 2 : 1) : b.deploy > 0 ? 3 : 0
      f.missiles = p.missiles
      f.rack = Math.max(0, p.drones - (p.drone ? 1 : 0))
      f.safe = safe(b)
      f.alive = p.alive
      const moving = Math.hypot(b.vx, b.vz) > 3
      f.spread = !b.onGround ? 1 : moving ? 0.55 : p === me && this.zoom > 0.8 ? 0 : 0.2
      f.respawnIn = !p.alive && p.wreck ? Math.max(0, MECH.respawn * 1000 - (now - p.wreck.at)) : null
    }
    // 迫擊砲：砲管的仰角，和照這個仰角在平地上大約打多遠、飛多久（砲口比腳底高一截；真正的落點不知道）
    if (me && me.alive && me.spec.deploy?.mortar && me.body.deployed) {
      const elev = clamp(me.body.aimPitch, SHELL.elevMin, SHELL.elevMax)
      const h = MORTAR_MUZZLE + Math.sin(elev) * 4
      f.mortar = {
        elev: (elev * 180) / Math.PI,
        level: (elev - SHELL.elevMin) / (SHELL.elevMax - SHELL.elevMin),
        range: shellRange(elev, h),
        time: shellTime(elev, h),
      }
    } else f.mortar = null
    // 鎖定框
    f.lock = null
    if (me && me.alive && me.lockSeat !== null) {
      const q = this.pilots[me.lockSeat]
      if (q) {
        tmpV.set(q.body.x, midY(q), q.body.z).project(this.camera)
        if (tmpV.z < 1) {
          f.lock = {
            x: (tmpV.x + 1) / 2,
            y: (1 - tmpV.y) / 2,
            done: me.lockTime >= MECH.lockTime,
            progress: clamp(me.lockTime / MECH.lockTime, 0, 1),
          }
        }
      }
    }
    // 小地圖和名牌
    const team = p?.team ?? 0
    const viewer = p?.body
    for (let i = 0; i < this.pilots.length; i++) {
      const q = this.pilots[i]
      const b = q.body
      const shown = this.shown(q, now)
      // 被自己這隊的偵察機標記的敵人：小地圖、畫面上都看得到（隔著牆、多遠都看得到）
      const spotted = shown && q.team !== team && now < q.spottedUntil
      let state = 0
      if (shown) {
        if (q === p) state = 3
        else if (q.team === team) state = 1
        else if (spotted) state = 4
        else if (viewer && (q.firing || this.seenCached(q, team, now))) state = 2
      }
      f.radar[i * 4] = b.x
      f.radar[i * 4 + 1] = b.z
      f.radar[i * 4 + 2] = b.aimYaw
      f.radar[i * 4 + 3] = state
      // 名牌：隊友一直有、敵人看得到才有
      let show = 0
      if (shown && q !== p && (q.team === team || state === 2 || state === 4)) {
        tmpV.set(b.x, b.y + q.spec.hitH + 1, b.z)
        const dist = this.distToCam(b.x, b.y, b.z)
        tmpV.project(this.camera)
        // 隊友的名牌：人多（30 對 30）的時候只顯示近的，不然滿畫面都是名字
        const far = q.team === team ? (this.pilots.length > 16 ? 160 : 400) : spotted ? 1000 : 160
        if (tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1 && dist < far) {
          show = spotted ? 2 : 1
          f.labels[i * 4] = (tmpV.x + 1) / 2
          f.labels[i * 4 + 1] = (1 - tmpV.y) / 2
        }
      }
      f.labels[i * 4 + 2] = show
      f.labels[i * 4 + 3] = clamp(q.hp / q.spec.hp, 0, 1)
      // 自己這隊的偵察機：位置、鏡頭朝哪裡、看得多遠
      const d = q.team === team && q.alive ? q.drone?.body : undefined
      f.drones[i * 5] = d?.x ?? 0
      f.drones[i * 5 + 1] = d?.z ?? 0
      f.drones[i * 5 + 2] = d ? 1 : 0
      f.drones[i * 5 + 3] = d?.yaw ?? 0
      f.drones[i * 5 + 4] = d ? this.reachOf(q) : 0
    }
    this.onFrame(f)
  }

  /** 偵察機訊號差的時候整個畫面跟著糊、褪色（雜訊在 `Hud` 上畫）；分 20 段，才不會每一格都改樣式 */
  private setBlur(noise: number) {
    const k = Math.round(noise * 20) / 20
    if (k === this.blurred) return
    this.blurred = k
    this.renderer.domElement.style.filter =
      k > 0 ? `blur(${(k * k * 7).toFixed(2)}px) saturate(${(1 - k * 0.75).toFixed(2)}) contrast(${(1 - k * 0.35).toFixed(2)})` : ''
  }

  /** `seenByTeam` 的快取：每個座位隔 0.2～0.3 秒才重算一次（錯開，不要同一格一起算） */
  private seenCached(q: Pilot, team: Team, now: number): boolean {
    let c = this.seenCache[q.seat]
    if (!c) c = this.seenCache[q.seat] = { at: -Infinity, team, on: false }
    if (c.team !== team || now - c.at > 200 + (q.seat % 4) * 25) {
      c.at = now
      c.team = team
      c.on = this.seenByTeam(q, team, now)
    }
    return c.on
  }

  /** 這一隊有沒有人看得到 q（小地圖上的敵人） */
  private seenByTeam(q: Pilot, team: Team, now: number): boolean {
    for (const p of this.pilots) {
      if (p.team !== team || !this.shown(p, now)) continue
      const d = Math.hypot(p.body.x - q.body.x, p.body.z - q.body.z)
      if (d > 200) continue
      if (d < 25) return true
      if (this.index.clear(p.body.x, eyeY(p), p.body.z, q.body.x, midY(q), q.body.z)) return true
    }
    return false
  }
}
