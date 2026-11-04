/** 傳話畫畫的 view、動作和選項，和 backend/src/telephone.rs 對應 */

import type { Stroke } from '../draw/types'

/** 一句話最多幾個字；一張畫最多幾筆、幾個點（和後端一樣，超過伺服器會拒絕） */
export const MAX_TEXT = 60
export const MAX_STROKES = 400
export const MAX_POINTS = 8_000

export type Stage = 'write' | 'draw' | 'reveal' | 'end'

export type TpOptions = {
  /** 傳幾步；0 是跟人數一樣 */
  steps: number
  writeSecs: number
  drawSecs: number
}

export type Content = { kind: 'text'; text: string } | { kind: 'drawing'; strokes: Stroke[] }

/** 一串裡的一步；`auto` 是第一步沒寫、系統抽的題目 */
export type Entry = Content & { author: number; auto: boolean; likes: number; liked: boolean }

export type Chain = {
  index: number
  /** 出題的座位 */
  owner: number
  entries: Entry[]
}

export type TpSeat = {
  online: boolean
  /** 這一步按了完成 */
  done: boolean
  /** 拿到幾個讚（結算才有） */
  likes: number
}

export type TpView = {
  stage: Stage
  /** 第幾步（從 0 起算） */
  step: number
  steps: number
  endsIn: number | null
  you: number | null
  options: TpOptions
  /** 傳下去的順序（座位） */
  ring: number[]
  seats: TpSeat[]
  /** 作答中、有座位的人才有：自己這一串的上一步、自己存的草稿、抽到的題目 */
  task: {
    previous: (Content & { author: number; auto: boolean }) | null
    draft: Content | null
    suggestion: { id: number; text: string } | null
  } | null
  /** 揭曉中：第幾串、攤開了幾步，`current` 只有攤開的部分 */
  reveal: { chain: number; shown: number; current: Chain } | null
  /** 結算時所有串 */
  chains: Chain[] | null
}

export type TpAction =
  | { type: 'write'; step: number; text: string; done: boolean }
  | { type: 'draw'; step: number; strokes: Stroke[]; done: boolean }
  | { type: 'edit'; step: number }
  | { type: 'suggest' }
  | { type: 'next'; chain: number; shown: number }
  | { type: 'like'; chain: number; entry: number }

export type TelephoneParty = { view: TpView; action: TpAction; options: TpOptions }
