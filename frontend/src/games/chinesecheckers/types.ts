/** 跳棋的 view、動作和選項，和 backend/src/chinesecheckers.rs 對應 */

export type CcOptions = {
  /** 長跳（對稱跳） */
  longJumps: boolean
  /** 第一個人走完之後繼續，排出所有名次 */
  fullRanking: boolean
  /** 每手的思考秒數，0 是不限 */
  thinkSecs: number
}

export type CcSeat = {
  online: boolean
  /** 走了幾手（沒棋能走被跳過也算） */
  moves: number
  /** 自己有幾顆棋在目標裡 */
  home: number
  /** 進度百分比，走完是 100 */
  progress: number
  /** 走完的名次；還沒走完是 null */
  rank: number | null
  /** 這個房間累計贏了幾局 */
  wins: number
}

export type CcView = {
  stage: 'play' | 'end'
  /** 這個房間的第幾局 */
  game: number
  options: CcOptions
  you: number | null
  /** 121 個字：`.` 是空格，數字是座位（格子編號見 board.ts） */
  board: string
  /** 座位 → 出發的角（0～5），目標是對面的角 */
  corners: number[]
  /** 輪到誰；結束時是 null */
  turn: number | null
  endsIn: number | null
  /** 每人最多走幾手 */
  moveLimit: number
  /** 防堵：別人的棋在主人走滿這麼多手之後還在你的目標裡，就算你的 */
  spoilAfter: number
  /** 這局一共走了幾手；變了就是有新的一手 */
  moveNo: number
  /** 上一手：誰、經過哪些格子（含起點） */
  last: { seat: number; path: number[] } | null
  seats: CcSeat[]
  /** 名次（第一個是贏家）；`limit` 是大家都走滿步數、照進度排名 */
  result: { ranking: number[]; reason: 'finish' | 'limit' } | null
}

export type CcAction = { type: 'move'; path: number[] }

export type ChineseCheckersParty = { view: CcView; action: CcAction; options: CcOptions; event: never }

/** 座位的顏色，CSS 變數是 --cc-<key>（index.css，亮色深色各一組） */
export const COLOR_KEYS = ['red', 'blue', 'green', 'yellow', 'black', 'white'] as const
export const COLOR_NAMES = ['紅', '藍', '綠', '黃', '黑', '白']

export const THINK_CHOICES = [0, 15, 30, 60, 120]
