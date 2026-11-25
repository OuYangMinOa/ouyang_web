// 吃哪家的 view、動作和選項（後端 backend/src/dinner.rs）

export type DinnerMode = 'vote' | 'draw'

export type DinnerOptions = {
  /** 每個人最多提名幾家（1～5） */
  perPlayer: number
  mode: DinnerMode
}

export type DinnerSeat = { name: string; online: boolean; /** 提名好了／投好了 */ done: boolean }

export type DinnerCandidate = { id: string; /** 提名的座位 */ by: number }

export type DinnerResult = {
  /** candidates 的索引 */
  winner: number
  /** 每個候選拿到哪些座位的票（抽籤模式是空的） */
  votes: number[][]
  /** 轉盤上的候選：同票的那幾家，或抽籤模式的全部；不用抽籤是空的 */
  spin: number[]
}

export type DinnerView = {
  stage: 'nominate' | 'vote' | 'result'
  mode: DinnerMode
  perPlayer: number
  /** 自己的座位；觀戰是 null */
  you: number | null
  seats: DinnerSeat[]
  candidates: DinnerCandidate[]
  /** 在線的人裡有幾個好了 */
  done: number
  online: number
  /** 自己勾的（還沒投是 null） */
  ballot: number[] | null
  result: DinnerResult | null
}

export type DinnerAction =
  | { type: 'nominate'; id: string }
  | { type: 'withdraw'; id: string }
  | { type: 'ready'; ready: boolean }
  | { type: 'vote'; picks: number[] }
  | { type: 'proceed' }

export type DinnerParty = { view: DinnerView; action: DinnerAction; options: DinnerOptions; event: never }
