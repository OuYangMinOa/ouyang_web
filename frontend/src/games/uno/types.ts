/** UNO 的 view、動作和選項，和 backend/src/uno.rs 對應 */

/**
 * 0～107。0～99 是有顏色的牌：顏色 * 25 + k，k 是 0（0 一張）、1～18（1～9 各兩張）、
 * 19～20 跳過、21～22 迴轉、23～24 +2；100～103 是萬用、104～107 是萬用+4。
 */
export type Card = number

/** 0 紅、1 黃、2 綠、3 藍 */
export type Color = 0 | 1 | 2 | 3

export type Scoring = 'single' | 'points'

export type UnoOptions = {
  /** +2 上可以疊 +2 或 +4、+4 上可以疊 +4 */
  stacking: boolean
  /** 沒得出時一直抽到能出為止 */
  drawUntil: boolean
  /** 每手的思考秒數，0 是不限 */
  thinkSecs: number
  scoring: Scoring
  /** 累計點數模式的目標分數 */
  target: number
}

export type UnoSeat = {
  count: number
  online: boolean
  /** 喊過 UNO、現在剩一張 */
  uno: boolean
  /** 這個房間累計的分數 */
  total: number
}

export type LogEntry =
  | { type: 'play'; seat: number; card: Card; color: Color }
  | { type: 'draw'; seat: number; count: number }
  | { type: 'pass'; seat: number }
  | { type: 'caught'; seat: number; by: number }

export type UnoView = {
  stage: 'play' | 'end'
  /** 這個房間的第幾局 */
  game: number
  options: UnoOptions
  you: number | null
  /** 自己的手牌（照顏色排）；觀戰是 null */
  hand: Card[] | null
  seats: UnoSeat[]
  /** 輪到誰；結束時是 null */
  turn: number | null
  clockwise: boolean
  endsIn: number | null
  /** 桌上的牌 */
  top: Card
  /** 現在的顏色（萬用牌由出的人指定） */
  color: Color
  /** 疊加中的罰抽張數 */
  pending: number
  /** 疊到最上面的是 +4 */
  pendingFour: boolean
  /** 抽牌堆剩幾張 */
  pile: number
  /** 輪到自己、剛抽到能出的那張 */
  drawn: Card | null
  /** 輪到自己時現在能出的牌 */
  playable: Card[]
  /** 剩一張沒喊 UNO、現在可以被抓的人 */
  exposed: number | null
  /** 最近的動作，舊的在前面 */
  log: LogEntry[]
  result: { winner: number; gained: number; champion: boolean; hands: Card[][] } | null
}

export type UnoAction =
  | { type: 'play'; card: Card; color?: Color; uno?: boolean }
  | { type: 'draw' }
  | { type: 'pass' }
  | { type: 'uno' }
  | { type: 'catch'; seat: number }

export type UnoParty = { view: UnoView; action: UnoAction; options: UnoOptions; event: never }

export type Face = number | 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild4'

export const COLOR_NAMES = ['紅', '黃', '綠', '藍']
/** CSS class 用的顏色名，對應 index.css 的 --uno-* */
export const COLOR_KEYS = ['red', 'yellow', 'green', 'blue'] as const

export function faceOf(card: Card): Face {
  if (card >= 104) return 'wild4'
  if (card >= 100) return 'wild'
  const k = card % 25
  if (k === 0) return 0
  if (k <= 18) return Math.ceil(k / 2)
  if (k <= 20) return 'skip'
  if (k <= 22) return 'reverse'
  return 'draw2'
}

/** 牌的顏色；萬用牌是 null */
export const colorOf = (card: Card): Color | null => (card < 100 ? (Math.floor(card / 25) as Color) : null)

export const isWild = (card: Card) => card >= 100

/** 牌面上的字 */
export function faceText(card: Card): string {
  const f = faceOf(card)
  if (typeof f === 'number') return String(f)
  return { skip: '⊘', reverse: '⇄', draw2: '+2', wild: '★', wild4: '+4' }[f]
}

/** 給螢幕閱讀器、紀錄用：「紅 7」「藍 跳過」「萬用+4」 */
export function cardLabel(card: Card): string {
  const f = faceOf(card)
  if (f === 'wild') return '萬用'
  if (f === 'wild4') return '萬用+4'
  const word = typeof f === 'number' ? String(f) : { skip: '跳過', reverse: '迴轉', draw2: '+2' }[f]
  return `${COLOR_NAMES[colorOf(card)!]} ${word}`
}

/** 結算時的點數：數字照面額、功能牌 20、萬用牌 50 */
export function points(card: Card): number {
  const f = faceOf(card)
  if (typeof f === 'number') return f
  return f === 'wild' || f === 'wild4' ? 50 : 20
}
