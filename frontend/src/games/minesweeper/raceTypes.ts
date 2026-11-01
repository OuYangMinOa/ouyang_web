/** 踩地雷競速的 view、動作、選項和即時事件，和 backend/src/minesrace.rs 對應 */

export type RaceLevel = 'beginner' | 'intermediate' | 'expert'
export type OnMine = 'freeze' | 'out'
export type BotLevel = 'easy' | 'normal' | 'hard'

export type RaceOptions = {
  level: RaceLevel
  /** 踩到雷：凍結幾秒繼續，或直接出局 */
  onMine: OnMine
  /** 電腦的強度 */
  bots: BotLevel
}

export type RaceAction = { type: 'open' | 'flag' | 'chord'; i: number }

/** 自己的盤面和成績 */
export type RaceMe = {
  /** 房間的第幾局，和 v 一起判斷 view 和即時事件哪一份比較新 */
  game: number
  v: number
  /** 每格一個字：`.` 未開、`F` 旗、`X` 踩到的雷、`0`～`8` 打開的數字 */
  board: string
  opened: number
  hits: number
  /** 還要凍結幾毫秒（送出的當下） */
  frozen: number
  /** 完成的毫秒數 */
  finished: number | null
  out: boolean
  place: number | null
}

export type RacePlayer = {
  opened: number
  hits: number
  frozen: boolean
  finished: number | null
  out: boolean
  /** 對局中是完成的名次，結算後是最後的名次 */
  place: number | null
  /** 這個房間累計的分數 */
  points: number
  /** 每 block×block 一塊：0 沒開、1 不到一半、2 一半以上、3 全開 */
  heat: string
  /** 完整的縮圖（打開的格子，十六進位的位元）；自己結束了或整局結束才有 */
  mini: string | null
}

export type RaceView = {
  options: RaceOptions
  cols: number
  rows: number
  mines: number
  /** 安全格的總數 */
  safe: number
  block: number
  /** 還要倒數幾毫秒才開始 */
  startsIn: number
  /** 開始後經過的毫秒數（結束後固定） */
  elapsed: number
  /** 離結算還有幾毫秒；結束後是 null */
  endsIn: number | null
  ended: boolean
  /** 我的座位；觀戰是 null */
  you: number | null
  me: RaceMe | null
  players: RacePlayer[]
  /** 結束後公開的雷（十六進位的位元） */
  reveal: string | null
}

export type RaceEvent = { type: 'me'; me: RaceMe }

export type RaceParty = { view: RaceView; action: RaceAction; options: RaceOptions; event: RaceEvent }

/** 十六進位位元字串的第 i 位（每個字 4 格，第 4k 格是最低位） */
export function bitAt(hex: string, i: number): boolean {
  const digit = parseInt(hex[i >> 2] ?? '0', 16)
  return ((digit >> (i & 3)) & 1) === 1
}

/** view 和即時事件裡的 me，挑比較新的那一份 */
export function newerMe(fromView: RaceMe | null, fromEvent: RaceMe | null): RaceMe | null {
  if (!fromView) return null
  if (fromEvent && fromEvent.game === fromView.game && fromEvent.v > fromView.v) return fromEvent
  return fromView
}

/** 毫秒 → 12.3 秒 */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`
}
