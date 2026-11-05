/** 暗號接頭的 view、動作和選項，和 backend/src/contact.rs 對應 */

export type Stage = 'teams' | 'clue' | 'guess' | 'end'
/** 密碼表上的一格：翡翠隊、紫晶隊、路人、叛徒 */
export type Card = 'jade' | 'amethyst' | 'bystander' | 'traitor'
/**
 * 一輪怎麼結束：miss 翻到路人或對方的、limit 翻滿「數字＋1」張、stop 自己結束、timeout 猜的時間到、
 * away 組員都斷線、noClue 沒有給提示、over 分出勝負
 */
export type TurnEnd = 'miss' | 'limit' | 'stop' | 'timeout' | 'away' | 'noClue' | 'over'

export type CtOptions = {
  /** 給提示的秒數，0 是不限 */
  clueSecs: number
  /** 猜的秒數，0 是不限 */
  guessSecs: number
  /** 線下模式：聯絡人當面說出提示，網頁上只選數字 */
  offline: boolean
}

export type CtFlip = { index: number; card: Card; by: number }

export type CtTurn = {
  team: number
  /** 給提示的人；沒給提示是 null */
  by: number | null
  /** 提示詞；線下模式和沒給提示是 null */
  word: string | null
  count: number | null
  reveals: CtFlip[]
  end: TurnEnd | null
}

export type CtView = {
  stage: Stage
  endsIn: number | null
  options: CtOptions
  you: number | null
  /** 每個座位在哪一隊（0 翡翠、1 紫晶；選隊時可能是 null） */
  teams: (number | null)[]
  /** 每隊現在的聯絡人 */
  leads: [number | null, number | null]
  /** 看過密碼表的人：不能標記、翻牌，聊天只有看過的人看得到 */
  insiders: boolean[]
  online: boolean[]
  /** 每個人在這個房間當過幾次聯絡人 */
  led: number[]
  /** 每個人在這個房間贏過幾局 */
  wins: number[]
  /** 這個房間的第幾局 */
  game: number
  /** 先手隊；選隊時是 null */
  first: number | null
  turn: number
  /** 25 個詞；選隊時是 null */
  words: string[] | null
  /** 翻開的格子是什麼，沒翻開是 null */
  revealed: (Card | null)[] | null
  /** 密碼表：只有看過的人有，結束後大家都有 */
  key: Card[] | null
  /** 每一格有哪些組員標記了（只有輪到的那隊在猜時有） */
  marks: number[][] | null
  /** 兩隊各還剩幾張 */
  left: [number, number]
  /** 已經翻開幾張（翻牌時帶著，盤面變了就會被擋下來） */
  seq: number
  /** 猜的時候這輪的提示 */
  clue: { word: string | null; count: number | null; by: number | null; limit: number; made: number } | null
  log: CtTurn[]
  winner: number | null
  reason: 'cards' | 'traitor' | null
}

export type CtAction =
  | { type: 'join'; team: number }
  | { type: 'lead' }
  | { type: 'shuffle' }
  | { type: 'go' }
  | { type: 'clue'; word: string; count: number }
  | { type: 'mark'; index: number }
  | { type: 'reveal'; index: number; seq: number }
  | { type: 'stop' }

export type ContactParty = { view: CtView; action: CtAction; options: CtOptions; event: never }

/** 兩隊：名字、密碼表上的卡、給色盲也分得出來的記號 */
export const TEAMS = [
  { name: '翡翠', card: 'jade', mark: '◆' },
  { name: '紫晶', card: 'amethyst', mark: '▲' },
] as const

export const CARD_NAMES: Record<Card, string> = {
  jade: '翡翠隊',
  amethyst: '紫晶隊',
  bystander: '路人',
  traitor: '叛徒',
}

export const CARD_MARKS: Record<Card, string> = {
  jade: '◆',
  amethyst: '▲',
  bystander: '○',
  traitor: '✕',
}

export const MAX_CLUE = 12
export const MAX_COUNT = 9
