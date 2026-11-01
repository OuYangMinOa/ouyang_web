/** 大老二的 view、動作和選項，和 backend/src/bigtwo.rs 對應 */

/** 0～51：點數 * 4 + 花色。點數 0 是 3、11 是 A、12 是 2；花色 0 ♣、1 ♦、2 ♥、3 ♠。數字越大的牌越大。 */
export type Card = number

export type Kind = 'single' | 'pair' | 'triple' | 'straight' | 'flush' | 'fullHouse' | 'fourKind' | 'straightFlush'

export type Straights = 'twoHigh' | 'natural'

export type B2Options = {
  /** 同花算牌型 */
  flush: boolean
  /** 鐵支、同花順可以壓單張、對子 */
  bombs: boolean
  /** 可以出三條 */
  triples: boolean
  straights: Straights
  /** 手上每剩一張 2，扣分再加倍 */
  twosDouble: boolean
  /** 每手的思考秒數，0 是不限 */
  thinkSecs: number
}

export type Combo = { kind: Kind; cards: Card[] }

export type B2Seat = {
  count: number
  online: boolean
  /** 這一圈最後做了什麼：出的牌、pass，或還沒動作 */
  last: Combo | { pass: true } | null
  /** 這個房間累計的分數 */
  total: number
}

export type B2View = {
  stage: 'play' | 'end'
  /** 這個房間的第幾局 */
  game: number
  options: B2Options
  you: number | null
  /** 自己的手牌（由小到大）；觀戰是 null */
  hand: Card[] | null
  seats: B2Seat[]
  /** 輪到誰；結束時是 null */
  turn: number | null
  endsIn: number | null
  /** 桌上最大的那手；null 是自由出牌 */
  table: (Combo & { seat: number }) | null
  /** 第一手：必須包含 ♣3 */
  first: boolean
  /** 輪到自己時，現在能出的所有組合（由小到大，提示用） */
  plays: Combo[]
  result: { winner: number; deltas: number[]; hands: Card[][] } | null
}

export type B2Action = { type: 'play'; cards: Card[] } | { type: 'pass' }

export type BigTwoParty = { view: B2View; action: B2Action; options: B2Options; event: never }

export const KIND_NAMES: Record<Kind, string> = {
  single: '單張',
  pair: '對子',
  triple: '三條',
  straight: '順子',
  flush: '同花',
  fullHouse: '葫蘆',
  fourKind: '鐵支',
  straightFlush: '同花順',
}

export const CLUB_THREE: Card = 0
export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']
export const SUITS = ['♣', '♦', '♥', '♠']
const SUIT_WORDS = ['梅花', '方塊', '紅心', '黑桃']

export const rankOf = (card: Card) => Math.floor(card / 4)
export const suitOf = (card: Card) => card % 4
export const isRed = (card: Card) => suitOf(card) === 1 || suitOf(card) === 2
export const cardText = (card: Card) => `${SUITS[suitOf(card)]}${RANKS[rankOf(card)]}`
/** 給螢幕閱讀器：「黑桃 A」 */
export const cardLabel = (card: Card) => `${SUIT_WORDS[suitOf(card)]} ${RANKS[rankOf(card)]}`

export type SortMode = 'rank' | 'suit'

/** 照點數（預設，和牌的大小一樣）或照花色（同花色放一起，再照點數）排 */
export function sortHand(hand: Card[], mode: SortMode): Card[] {
  const sorted = [...hand]
  if (mode === 'suit') sorted.sort((a, b) => suitOf(a) - suitOf(b) || a - b)
  else sorted.sort((a, b) => a - b)
  return sorted
}

/** 兩組牌是不是同一組（不管順序） */
export function sameCards(a: readonly Card[], b: readonly Card[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort((p, q) => p - q)
  const y = [...b].sort((p, q) => p - q)
  return x.every((c, i) => c === y[i])
}
