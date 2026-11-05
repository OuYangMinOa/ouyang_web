/** 吹牛骰子的 view、動作和選項，和 backend/src/liarsdice.rs 對應 */

export type Mode = 'elimination' | 'points'
/** 起叫最少個數：不限（1 個）、人數、人數 + 1 */
export type Opening = 'one' | 'players' | 'playersPlusOne'

export type LiarsOptions = {
  mode: Mode
  /** 一點萬用 */
  wildOnes: boolean
  /** 這輪有人喊過一點之後，一點就不再萬用 */
  onesLock: boolean
  opening: Opening
  /** 五顆全不同的散骰可以重搖 */
  scatter: boolean
  /** 計分制打幾輪 */
  rounds: number
  /** 每手的思考秒數，0 是不限 */
  thinkSecs: number
}

/** 喊價：場上至少有 count 顆 face 點 */
export type Bid = { count: number; face: number }
export type SeatBid = Bid & { seat: number }

export type LiarsSeat = {
  /** 現在有幾顆骰子；0 是出局 */
  dice: number
  online: boolean
  /** 這局喝了幾杯（輸了幾次） */
  cups: number
  /** 房間累計的勝場和杯數 */
  wins: number
  totalCups: number
  /** 這輪最後喊的 */
  bid: Bid | null
  /** 搖過幾次，變了就播搖骰動畫 */
  rolls: number
  /** 這輪散骰重搖過 */
  rerolled: boolean
  /** 揭曉時按了「下一輪」 */
  ready: boolean
}

export type Reveal = {
  bid: Bid
  bidder: number
  opener: number
  /** 這次一點有沒有算萬用 */
  wild: boolean
  /** 開的那一刻所有人的骰子 */
  hands: number[][]
  matched: number
  loser: number
  /** 輸的人因此出局 */
  out: boolean
  /** 開的人是逾時或斷線由電腦代開的 */
  auto: boolean
}

export type Stage = 'rolling' | 'bidding' | 'reveal' | 'end'

export type LiarsView = {
  stage: Stage
  /** 這個房間的第幾局 */
  game: number
  /** 這局的第幾輪 */
  round: number
  options: LiarsOptions
  you: number | null
  /** 自己的骰子；觀戰是 null */
  mine: number[] | null
  seats: LiarsSeat[]
  turn: number | null
  endsIn: number | null
  /** 搖骰、揭曉還剩幾毫秒 */
  nextIn: number | null
  /** 現在的喊價 */
  bid: SeatBid | null
  /** 這輪喊過的，舊的在前面 */
  history: SeatBid[]
  /** 每個點數（索引 0 是一點）現在最少要喊幾個；null 是喊不上去了。只在喊價時有值 */
  minCounts: (number | null)[]
  minOpen: number
  /** 場上的骰子總數 */
  total: number
  /** 現在一點算萬用 */
  wild: boolean
  /** 這輪有人喊過一點 */
  onesCalled: boolean
  canReroll: boolean
  /** 揭曉和結束時才有 */
  reveal: Reveal | null
  /** 揭曉的是這局最後一輪 */
  final: boolean
  log: string[]
  result: { ranking: number[]; winners: number[] } | null
}

export type LiarsAction =
  | { type: 'bid'; count: number; face: number }
  | { type: 'open' }
  | { type: 'reroll' }
  | { type: 'ready' }

export type LiarsParty = { view: LiarsView; action: LiarsAction; options: LiarsOptions; event: never }

export const FACES = [1, 2, 3, 4, 5, 6] as const

/** 一點萬用時一點最大 */
export function faceRank(face: number, onesHigh: boolean): number {
  return onesHigh && face === 1 ? 7 : face
}

/** 這顆骰子在揭曉時算不算數：本身就是喊的點數、萬用的一點，或不算 */
export function matchKind(die: number, reveal: Pick<Reveal, 'bid' | 'wild'>): 'match' | 'wild' | 'miss' {
  if (die === reveal.bid.face) return 'match'
  if (reveal.wild && die === 1) return 'wild'
  return 'miss'
}

/** 「3 個 5」 */
export const bidText = (bid: Bid) => `${bid.count} 個 ${bid.face}`
