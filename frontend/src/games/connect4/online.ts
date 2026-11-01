import type { RoomEvent, Seat } from '../shared/useRoom'
import { newGame, other, play, RED, YELLOW, type Disc, type GameState } from './rules'

export type Connect4Event = { type: 'move'; col: number } | { type: 'resign' } | { type: 'restart' }

export type OnlineGame = GameState & {
  /** 第幾局（從 0 起算）：決定 seat 執哪一色 */
  round: number
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
  for (const { seat, data } of events) {
    if (!data || typeof data !== 'object') continue
    const color = seatColor(round, seat)
    if (data.type === 'move') {
      if (color !== state.toMove) continue
      state = play(state, data.col) ?? state
    } else if (data.type === 'resign') {
      if (!state.result) state = { ...state, result: { winner: other(color), reason: 'resign' } }
    } else if (data.type === 'restart') {
      if (state.result) {
        round++
        state = newGame()
      }
    }
  }
  return { ...state, round }
}
