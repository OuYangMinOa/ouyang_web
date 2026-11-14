import { api } from '../../api'
import type { Party } from '../shared/useParty'

/**
 * 迷宮塔防的連線格式（後端 `backend/src/towerdefense.rs`）。模擬全部在伺服器，這裡只有型別和解碼。
 *
 * 數值（塔、怪物、地圖、派兵）開頁面時從 `GET /api/games/towerdefense/spec` 抓一次，前端不抄一份；
 * 塔和怪物在事件裡用「種類的編號」（`spec.towers`、`spec.monsters` 的索引）表示。
 */

export type TowerLevel = {
  cost: number
  damage: number
  cooldown: number
  range: number
  splash: number
  slow: number
  duration: number
  dot: number
  chain: number
  buff: number
}

export type TowerId = 'bolt' | 'cannon' | 'frost' | 'tesla' | 'poison' | 'sniper' | 'beacon'
export type MonsterId =
  | 'grunt'
  | 'runner'
  | 'brute'
  | 'swarm'
  | 'flyer'
  | 'regen'
  | 'splitter'
  | 'mudling'
  | 'ghost'
  | 'boss'
  | 'wyvern'
export type AimMode = 'first' | 'last' | 'strong' | 'weak' | 'near'

export type TowerSpec = {
  id: TowerId
  name: string
  blurb: string
  air: boolean
  ground: boolean
  magic: boolean
  /** 砲彈每秒飛幾格，0 是一開火就打到 */
  shotSpeed: number
  mode: AimMode
  levels: TowerLevel[]
}

export type MonsterSpec = {
  id: MonsterId
  name: string
  blurb: string
  hp: number
  speed: number
  phys: number
  magic: number
  bounty: number
  lives: number
  air: boolean
  regen: number
  slowable: number
  split: { kind: MonsterId; count: number } | null
  size: number
}

export type UnitSpec = { kind: MonsterId; count: number; cost: number; income: number; unlock: number }

export type MapSpec = {
  id: string
  name: string
  blurb: string
  w: number
  h: number
  /** `.` 空地、`#` 岩石、`_` 通道、小寫入口、大寫出口 */
  rows: string[]
  /** 每一路的 [入口格, 出口格] */
  routes: [number, number][]
}

export type Spec = {
  towers: TowerSpec[]
  monsters: MonsterSpec[]
  units: UnitSpec[]
  maps: MapSpec[]
  maxLevel: number
  refund: number
  buildTime: number
  sendHp: number
}

let cached: Promise<Spec> | null = null

/** 整張數值表；失敗的話下次再抓 */
export function loadSpec(): Promise<Spec> {
  cached ??= api<Spec>('/games/towerdefense/spec').catch((e: unknown) => {
    cached = null
    throw e
  })
  return cached
}

export const AIM_MODES: { value: AimMode; label: string; hint: string }[] = [
  { value: 'first', label: '最前', hint: '最靠近出口的' },
  { value: 'last', label: '最後', hint: '離出口最遠的' },
  { value: 'strong', label: '最壯', hint: '血最多的' },
  { value: 'weak', label: '最弱', hint: '血最少的' },
  { value: 'near', label: '最近', hint: '離塔最近的' },
]

export type GameMode = 'coop' | 'versus'
export type Difficulty = 'easy' | 'normal' | 'hard'

export type TdOptions = {
  mode: GameMode
  map: string
  difficulty: Difficulty
  /** 合作要撐幾波，0 是無限 */
  waves: number
  bots: Difficulty
}

/** 塔：[id, 格子, 種類的編號, 等級, 誰蓋的, 瞄準方式的編號] */
export type TowerRow = [number, number, number, number, number, number]

export type FieldView = {
  /** 塔每變一次加一：`tower` 事件的 rev 比這個小的已經算在裡面了 */
  rev: number
  lives: number
  towers: TowerRow[]
  /** 每一路現在會走的格子 */
  paths: number[][]
}

export type PlayerView = {
  gold: number
  income: number
  field: number
  ready: boolean
  /** 這個人想要的遊戲速度 */
  speed: number
  out: boolean
  place: number | null
  kills: number
  damage: number
  built: number
  sent: number
  online: boolean
  wins: number
}

export type TdView = {
  game: number
  mode: GameMode
  map: string
  difficulty: Difficulty
  waves: number
  you: number | null
  tick: number
  /** 已經出到第幾波，0 是還沒開始 */
  wave: number
  /** 還剩幾毫秒下一波開始；這一波還在打是 null */
  nextIn: number | null
  /** 這一波（還沒開始是空的）和下一波出什麼：[怪物種類的編號, 幾隻] */
  now: [number, number][]
  next: [number, number][]
  speed: number
  fields: FieldView[]
  players: PlayerView[]
  bots: number[]
  /** 對抗：自己派兵現在會打到誰 */
  target: number | null
  aim: number | null
  look: number | null
  ended: boolean
  won: boolean | null
  winner: number | null
  /** 合作：這個房間最多撐過幾波 */
  best: number
}

export type TdAction =
  | { type: 'build'; cell: number; kind: TowerId }
  | { type: 'upgrade'; id: number }
  | { type: 'sell'; id: number }
  | { type: 'mode'; id: number; mode: AimMode }
  | { type: 'ready'; ready: boolean }
  | { type: 'send'; unit: number }
  | { type: 'aim'; seat: number | null }
  | { type: 'give'; seat: number; amount: number }
  | { type: 'look'; field: number }
  | { type: 'speed'; speed: number }

export type TickEvent = {
  type: 'tick'
  /** 房間的 tick 數（每 0.1 秒加一） */
  n: number
  f: number
  /** 這塊場地所有的怪物，一隻 10 個字（`decodeMonsters`） */
  m: string
  /** 這個 tick 開火的塔：[塔的 id, 打到的怪物 id…] */
  s?: number[][]
  /** 走到出口的怪物 id */
  x?: number[]
  /** 每個座位的錢、每塊場地的生命和怪物數、每個座位打倒幾隻 */
  g: number[]
  l: number[]
  c: number[]
  k: number[]
}

export type TowerEvent = {
  type: 'tower'
  f: number
  rev: number
  op: 'add' | 'up' | 'sell' | 'mode'
  t: TowerRow
  paths?: number[][]
}

export type TdEvent =
  | TickEvent
  | TowerEvent
  | { type: 'wave'; wave: number }
  | { type: 'ready'; ready: boolean[] }
  | { type: 'send'; from: number; to: number; unit: number; income: number }
  | { type: 'give'; from: number; to: number; amount: number }
  | { type: 'out'; seat: number; place: number }
  | { type: 'aim'; seat: number | null; target: number | null }

export type TdParty = { view: TdView; action: TdAction; options: TdOptions; event: TdEvent }
export type TdRoom = Party<TdParty>

export function seatName(party: Pick<TdRoom, 'playerAt'>, seat: number): string {
  return party.playerAt(seat)?.name ?? `玩家 ${seat + 1}`
}

/** 快照裡的一隻怪 */
export type MonsterState = {
  id: number
  kind: number
  x: number
  y: number
  /** 1～63：最大血量的幾分之幾 */
  hp: number
  slowed: boolean
  poisoned: boolean
  /** 對抗：別人派來的 */
  sent: boolean
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const VALUE = new Uint8Array(128)
for (let i = 0; i < B64.length; i++) VALUE[B64.charCodeAt(i)] = i

/**
 * 解開 `tick` 事件的怪物快照（`towerdefense_field.rs` 的 `encode`）：一隻 10 個字，
 * id 3 個字、種類 1、x 和 y 各 2（(座標 + 1) × 64）、血量 1、狀態 1（1 變慢、2 中毒、4 別人派來的）
 */
export function decodeMonsters(text: string): MonsterState[] {
  const out: MonsterState[] = []
  const v = (i: number) => VALUE[text.charCodeAt(i) & 127]
  for (let i = 0; i + 10 <= text.length; i += 10) {
    const status = v(i + 9)
    out.push({
      id: (v(i) << 12) | (v(i + 1) << 6) | v(i + 2),
      kind: v(i + 3),
      x: ((v(i + 4) << 6) | v(i + 5)) / 64 - 1,
      y: ((v(i + 6) << 6) | v(i + 7)) / 64 - 1,
      hp: v(i + 8),
      slowed: (status & 1) !== 0,
      poisoned: (status & 2) !== 0,
      sent: (status & 4) !== 0,
    })
  }
  return out
}

/** 地圖上的一格是什麼 */
export type Tile = 'ground' | 'rock' | 'walk'

export function tileAt(map: MapSpec, cell: number): Tile {
  const ch = map.rows[Math.floor(cell / map.w)]?.[cell % map.w]
  return ch === '.' ? 'ground' : ch === '#' ? 'rock' : 'walk'
}

/**
 * 在 `cell` 蓋塔會不會把路堵死（伺服器會再檢查一次，這裡只是讓游標先變紅）：
 * 怪物斜走時旁邊兩格都要是空的，所以「走不走得到」只看上下左右就夠了
 */
export function wouldSeal(map: MapSpec, blocked: (cell: number) => boolean, cell: number): boolean {
  const { w, h } = map
  const closed = (c: number) => c === cell || tileAt(map, c) === 'rock' || blocked(c)
  for (const [spawn, exit] of map.routes) {
    const seen = new Uint8Array(w * h)
    const stack = [exit]
    seen[exit] = 1
    while (stack.length) {
      const c = stack.pop()!
      const x = c % w
      const y = Math.floor(c / w)
      const next = [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, y > 0 ? c - w : -1, y < h - 1 ? c + w : -1]
      for (const n of next) {
        if (n >= 0 && !seen[n] && !closed(n)) {
          seen[n] = 1
          stack.push(n)
        }
      }
    }
    if (!seen[spawn]) return true
  }
  return false
}
