/** 只有一個詞的 view、動作和選項，和 backend/src/justone.rs 對應 */

export type Stage = 'clue' | 'review' | 'guess' | 'reveal' | 'end'
/** ok：留下來；duplicate：和別人一樣；invalid：和題目同字根；similar：出題的人標了「太像了」 */
export type ClueStatus = 'ok' | 'duplicate' | 'invalid' | 'similar'
export type Outcome = 'correct' | 'wrong' | 'pass'

export type JoOptions = {
  /** 一局幾張牌（桌遊是 13 張） */
  cards: number
  /** 寫提示的秒數，0 是不限 */
  clueSecs: number
  /** 猜的秒數，0 是不限 */
  guessSecs: number
  /** 線下模式：猜的人直接說出答案，出題的人按對或錯 */
  offline: boolean
}

export type JoClue = {
  seat: number
  text: string
  status: ClueStatus
  /** 誰標了「太像了」 */
  markedBy: number | null
}

export type JoSeat = {
  online: boolean
  ready: boolean
  /** 寫提示時：這個人寫好了沒 */
  submitted: boolean
}

export type JoRecord = {
  round: number
  guesser: number
  word: string
  clues: JoClue[]
  guess: string | null
  outcome: Outcome
  /** 猜錯但出題的人投票算對 */
  accepted: boolean
}

export type Deck = {
  total: number
  /** 還沒翻的牌 */
  left: number
  score: number
  /** 丟掉的牌 */
  lost: number
}

export type JoView = {
  stage: Stage
  endsIn: number | null
  options: JoOptions
  you: number | null
  guesser: number
  /** 第幾題 */
  round: number
  /** 每個出題的人寫幾個提示（3 人時是 2） */
  perGiver: number
  deck: Deck
  /** 題目；猜的人和觀戰的人公布前是 null */
  word: string | null
  /** 自己這題已經送出的提示（寫提示時） */
  mine: string[] | null
  seats: JoSeat[]
  /** 寫提示時是 null；猜的人只拿到留下來的 */
  clues: JoClue[] | null
  /** 被刪掉幾個（猜的時候開始有） */
  removed: number | null
  guess: string | null
  outcome: Outcome | null
  /** 線上模式猜錯時的「算對」投票 */
  accept: { votes: number; needed: number; mine: boolean; accepted: boolean } | null
  history: JoRecord[]
  result: { score: number; total: number; rating: string } | null
  /** 這個房間最好的成績 */
  best: { score: number; total: number } | null
}

export type JoAction =
  | { type: 'clue'; words: string[] }
  | { type: 'mark'; index: number }
  | { type: 'ready' }
  | { type: 'guess'; word: string }
  | { type: 'pass' }
  | { type: 'judge'; correct: boolean }
  | { type: 'accept' }

export type JustOneParty = { view: JoView; action: JoAction; options: JoOptions; event: never }

export const STATUS_NAMES: Record<ClueStatus, string> = {
  ok: '留下',
  duplicate: '一樣，刪掉',
  invalid: '無效',
  similar: '太像了',
}

export const MAX_CLUE = 12
export const MAX_GUESS = 20
