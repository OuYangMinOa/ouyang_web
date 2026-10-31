// 線上對戰：把伺服器轉送的事件從頭重播成局面；兩邊各自執行，所以必須是確定性的
import type { RoomEvent, Seat } from '../shared/useRoom.ts'
import { BLACK, RED, applyMove, currentPosition, encodeMove, newGame, resign, type Game, type Side } from './rules.ts'

export type XqEvent = { type: 'move'; from: number; to: number } | { type: 'resign' } | { type: 'restart' }

export type OnlineState = {
  game: Game
  /** 第幾局（從 0 開始）；每次再來一局就交換先後手 */
  round: number
}

/** 這一局執紅（先手）的座位 */
export function redSeat(round: number): Seat {
  return round % 2 === 0 ? 0 : 1
}

export function seatSide(seat: Seat, round: number): Side {
  return seat === redSeat(round) ? RED : BLACK
}

function isSquare(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 90
}

export function reduceOnline(events: RoomEvent<XqEvent>[]): OnlineState {
  let game = newGame()
  let round = 0
  for (const { seat, data } of events) {
    if (!data || typeof data !== 'object') continue
    const side = seatSide(seat, round)
    switch (data.type) {
      case 'move': {
        if (game.result || currentPosition(game).turn !== side) break
        if (!isSquare(data.from) || !isSquare(data.to)) break
        game = applyMove(game, encodeMove(data.from, data.to)) ?? game
        break
      }
      case 'resign':
        game = resign(game, side)
        break
      case 'restart':
        if (game.result) {
          game = newGame()
          round++
        }
        break
    }
  }
  return { game, round }
}
