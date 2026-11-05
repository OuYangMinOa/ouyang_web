import type { Seat } from './useRoom'

/**
 * 線上棋類的悔棋：一方提出，另一方同意才退回。跟其他事件一樣走伺服器轉送、在兩端各自重播，後端不用改。
 *
 * - 退到提出的人「上一次輪到自己」的局面：剛下完、對手還沒回就退一手，對手已經回了就退兩手。
 * - 同一時間只能有一個請求；任何人下了一手、認輸或換局，請求就作廢。
 * - 被拒絕後，要等局面變了（有人再下一手）才能再提，避免一直洗請求。
 * - 對局結束後就不能悔棋了。
 */
export type TakebackEvent =
  | { type: 'takeback' }
  | { type: 'takeback-accept' }
  | { type: 'takeback-decline' }
  | { type: 'takeback-cancel' }

export type TakebackRequest = {
  by: Seat
  /** 同意的話要退幾手 */
  plies: number
}

export type TakebackView = {
  pending: TakebackRequest | null
  /** 上一個請求怎麼結束的，給畫面顯示；局面一變就清掉 */
  last: { by: Seat; accepted: boolean } | null
  /** 這個 seat 現在能不能提出悔棋 */
  canRequest: [boolean, boolean]
}

export function isTakebackEvent(data: { type?: unknown }): data is TakebackEvent {
  return (
    data.type === 'takeback' ||
    data.type === 'takeback-accept' ||
    data.type === 'takeback-decline' ||
    data.type === 'takeback-cancel'
  )
}

/** 在 reducer 裡追蹤這一局每一手是誰下的，以及悔棋請求的狀態 */
export class Takeback {
  /** 這一局每一手是哪個 seat 下的（黑白棋會有同一方連下的情況） */
  private movers: Seat[] = []
  private pending: TakebackRequest | null = null
  private last: TakebackView['last'] = null
  /** 被拒絕時已經下了幾手；手數沒變之前不能再提 */
  private declinedAt: [number | null, number | null] = [null, null]

  /** 有人成功下了一手 */
  moved(seat: Seat) {
    this.movers.push(seat)
    this.pending = null
    this.last = null
  }

  /** 認輸、換新的一局 */
  reset(newRound: boolean) {
    this.pending = null
    this.last = null
    if (newRound) {
      this.movers = []
      this.declinedAt = [null, null]
    }
  }

  /** 處理一個悔棋事件；回傳要退回幾手（0 表示局面不用動） */
  handle(seat: Seat, event: TakebackEvent, finished: boolean): number {
    const pending = this.pending
    switch (event.type) {
      case 'takeback': {
        if (finished || pending || !this.allowed(seat)) return 0
        this.pending = { by: seat, plies: this.movers.length - this.movers.lastIndexOf(seat) }
        this.last = null
        return 0
      }
      case 'takeback-cancel':
        if (pending?.by === seat) this.pending = null
        return 0
      case 'takeback-decline':
        if (!pending || pending.by === seat) return 0
        this.pending = null
        this.last = { by: pending.by, accepted: false }
        this.declinedAt[pending.by] = this.movers.length
        return 0
      case 'takeback-accept':
        if (!pending || pending.by === seat || finished) return 0
        this.pending = null
        this.movers.length -= pending.plies
        this.last = { by: pending.by, accepted: true }
        this.declinedAt = [null, null]
        return pending.plies
    }
  }

  view(): TakebackView {
    return { pending: this.pending, last: this.last, canRequest: [this.allowed(0), this.allowed(1)] }
  }

  private allowed(seat: Seat): boolean {
    return !this.pending && this.movers.includes(seat) && this.declinedAt[seat] !== this.movers.length
  }
}
