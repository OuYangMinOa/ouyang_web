// 主執行緒與 worker 之間的訊息格式

export type ToWorker = {
  id: number
  pattern: string
  flags: string
  text: string
  /** null 表示不用算取代結果 */
  replacement: string | null
}

export type Group = { value: string | undefined; start?: number; end?: number }

export type Match = {
  start: number
  end: number
  value: string
  /** 第 1 組開始的捕獲群組，順序跟 pattern 裡的括號一樣 */
  groups: Group[]
}

export type FromWorker =
  | { id: number; ok: true; matches: Match[]; truncated: boolean; replaced: string | null; ms: number }
  | { id: number; ok: false; error: string }

/** 最多列出幾個符合的結果，太多畫面會卡 */
export const MAX_MATCHES = 5000
