/** 德州撲克的 view、動作和選項，和 backend/src/poker.rs 對應 */

/** 0～51：點數 * 4 + 花色。點數 0 是 2、12 是 A；花色 0 ♣、1 ♦、2 ♥、3 ♠。 */
export type Card = number

export type PokerOptions = {
  /** 每個人開局的籌碼 */
  chips: number
  /** 大盲（小盲是一半） */
  bigBlind: number
  /** 每幾手升一次盲注，0 是不升 */
  blindUp: number
  /** 最多打幾手，0 是打到只剩一個人有籌碼 */
  handLimit: number
  /** 每次行動的思考秒數，0 是不限 */
  thinkSecs: number
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

export type PokerSeat = {
  /** 桌上的籌碼（不含這一輪推出去的） */
  stack: number
  /** 這一輪推出去的籌碼 */
  bet: number
  /** 這手有發牌 */
  dealt: boolean
  folded: boolean
  allIn: boolean
  /** 輸光了，在旁邊觀戰 */
  out: boolean
  online: boolean
  /** 最後一個動作：「跟注 40」「棄牌」 */
  last: string | null
  /** 自己的牌，或被公開的牌；其他人是 null */
  cards: [Card, Card] | null
  shown: boolean
  /** 公開的牌組成的牌型 */
  rank: string | null
  /** 這手贏回多少 */
  won: number
  /** 這個房間累計贏了幾局 */
  wins: number
}

/** 輪到自己時能做什麼；金額都是「這一輪總共推出去多少」 */
export type PokerTurn = {
  toCall: number
  canCheck: boolean
  canRaise: boolean
  minRaiseTo: number
  maxRaiseTo: number
  currentBet: number
}

export type PokerResult = {
  amount: number
  winners: number[]
  /** 贏的牌型；其他人都棄牌時是 null */
  hand: string | null
  /** 贏家最好的 5 張（有亮牌才有） */
  best: Card[] | null
}

export type PokerView = {
  stage: 'play' | 'end'
  /** 這個房間的第幾局 */
  game: number
  options: PokerOptions
  you: number | null
  /** 第幾手 */
  hand: number
  street: Street
  board: Card[]
  button: number
  smallBlind: number
  bigBlind: number
  sb: number | null
  bb: number | null
  /** 再幾手升盲（這一手也算），不升是 null */
  blindUpIn: number | null
  /** 底池（含這一輪推出去的） */
  pot: number
  seats: PokerSeat[]
  turn: number | null
  endsIn: number | null
  /** 自己這手的資訊；觀戰、沒發到牌是 null */
  me: {
    /** 目前的牌型：「兩對」 */
    rank: string
    /** 組成目前牌型的 5 張（翻牌後才有） */
    best: Card[]
    turn: PokerTurn | null
    canShow: boolean
  } | null
  results: PokerResult[]
  /** 下一手還有幾毫秒 */
  nextHandIn: number | null
  log: string[]
  /** 結束時的名次（座位），第一個是冠軍 */
  ranking: number[] | null
}

export type PokerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'raise'; to: number }
  | { type: 'allIn' }
  | { type: 'show' }

export type PokerParty = { view: PokerView; action: PokerAction; options: PokerOptions; event: never }

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
export const SUITS = ['♣', '♦', '♥', '♠']
const SUIT_WORDS = ['梅花', '方塊', '紅心', '黑桃']

export const rankOf = (card: Card) => Math.floor(card / 4)
export const suitOf = (card: Card) => card % 4
export const isRed = (card: Card) => suitOf(card) === 1 || suitOf(card) === 2
export const cardText = (card: Card) => `${SUITS[suitOf(card)]}${RANKS[rankOf(card)]}`
/** 給螢幕閱讀器：「黑桃 A」 */
export const cardLabel = (card: Card) => `${SUIT_WORDS[suitOf(card)]} ${RANKS[rankOf(card)]}`

export const STREET_NAMES: Record<Street, string> = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '轉牌',
  river: '河牌',
  showdown: '攤牌',
}

/** 籌碼數字加千分位 */
export const chips = (n: number) => n.toLocaleString('en-US')
