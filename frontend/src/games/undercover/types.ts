/** 誰是臥底的 view、動作和選項，和 backend/src/undercover.rs 對應 */

export type Role = 'civilian' | 'undercover' | 'blank'
export type Stage = 'peek' | 'speak' | 'discuss' | 'vote' | 'out' | 'guess' | 'end'

export type UcOptions = {
  /** 臥底人數，0 是照人數自動決定 */
  undercover: number
  blank: boolean
  /** 線下模式：當面口頭描述 */
  offline: boolean
  /** 出局時公開身分 */
  reveal: boolean
  speakSecs: number
  /** 0 表示不討論，說完直接投票 */
  discussSecs: number
}

export type UcSeat = {
  alive: boolean
  online: boolean
  /** 出局（有開公開身分）或結束後才看得到 */
  role: Role | null
  ready: boolean
  voted: boolean
  /** 這個房間累計的分數 */
  points: number
}

export type Speech = {
  round: number
  seat: number
  /** null：線下口頭說的、跳過或時間到 */
  text: string | null
  timeout: boolean
}

export type Tally = {
  round: number
  revote: boolean
  /** 每個座位投給誰 */
  ballots: (number | null)[]
  out: number | null
}

export type UcView = {
  stage: Stage
  endsIn: number | null
  round: number
  options: UcOptions
  counts: { civilian: number; undercover: number; blank: number }
  you: number | null
  /** 自己的詞；白板和觀戰是 null */
  word: string | null
  blank: boolean
  seats: UcSeat[]
  speaker: number | null
  speakers: number[]
  speeches: Speech[]
  vote: { candidates: number[]; revote: boolean; mine: number | null } | null
  tallies: Tally[]
  outs: { round: number; seat: number }[]
  guessing: number | null
  guess: { seat: number; word: string | null; correct: boolean } | null
  result: { winner: 'civilian' | 'undercover'; words: { civilian: string; undercover: string } } | null
}

export type UcAction =
  | { type: 'ready' }
  | { type: 'describe'; text: string }
  | { type: 'done' }
  | { type: 'vote'; seat: number }
  | { type: 'guess'; word: string }

export type UndercoverParty = { view: UcView; action: UcAction; options: UcOptions; event: never }

export const ROLE_NAMES: Record<Role, string> = { civilian: '平民', undercover: '臥底', blank: '白板' }

export const MAX_DESCRIPTION = 40
