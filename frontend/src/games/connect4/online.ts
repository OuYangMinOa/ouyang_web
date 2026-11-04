import { isTakebackEvent, Takeback, type TakebackEvent, type TakebackView } from '../shared/takeback'
import type { RoomEvent, Seat } from '../shared/useRoom'
import { newGame, other, play, RED, YELLOW, type Disc, type GameState } from './rules'

export type Connect4Event = { type: 'move'; col: number } | { type: 'resign' } | { type: 'restart' } | TakebackEvent

export type OnlineGame = GameState & {
  /** 第幾局（從 0 起算）：決定 seat 執哪一色 */
  round: number
  takeback: TakebackView
}

/** 第 round 局由哪個 seat 執紅（先手）：每局交換 */
export function redSeat(round: number): Seat {
  return round % 2 === 0 ? 0 : 1
}

export function seatColor(round: number, seat: Seat): Disc {
  return seat === redSeat(round) ? RED : YELLOW
}

/** 把房間的事件從頭重播成目前局面；不合法、不是輪到該 seat、對局結束後的棋步都忽略 */
export function reduceEvents(events: readonly RoomEvent<Connect4Event>[]): OnlineGame {
  let round = 0
  let state = newGame()
  /** 每一手之前的局面，悔棋時退回去 */
  let before: GameState[] = []
  const takeback = new Takeback()
  for (const { seat, data } of events) {
    if (!data || typeof data !== 'object') continue
    const color = seatColor(round, seat)
    if (isTakebackEvent(data)) {
      const plies = takeback.handle(seat, data, !!state.result)
      if (plies) {
        state = before[before.length - plies]
        before = before.slice(0, -plies)
      }
    } else if (data.type === 'move') {
      if (color !== state.toMove) continue
      const next = play(state, data.col)
      if (!next) continue
      before.push(state)
      state = next
      takeback.moved(seat)
    } else if (data.type === 'resign') {
      if (!state.result) state = { ...state, result: { winner: other(color), reason: 'resign' } }
      takeback.reset(false)
    } else if (data.type === 'restart') {
      if (state.result) {
        round++
        state = newGame()
        before = []
        takeback.reset(true)
      }
    }
  }
  return { ...state, round, takeback: takeback.view() }
}
