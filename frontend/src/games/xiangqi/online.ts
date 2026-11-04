// 線上對戰：把伺服器轉送的事件從頭重播成局面；兩邊各自執行，所以必須是確定性的
import { isTakebackEvent, Takeback, type TakebackEvent, type TakebackView } from '../shared/takeback.ts'
import type { RoomEvent, Seat } from '../shared/useRoom.ts'
import { BLACK, RED, applyMove, currentPosition, encodeMove, newGame, resign, type Game, type Side } from './rules.ts'

export type XqEvent =
  | { type: 'move'; from: number; to: number }
  | { type: 'resign' }
  | { type: 'restart' }
  | TakebackEvent

export type OnlineState = {
  game: Game
  /** 第幾局（從 0 開始）；每次再來一局就交換先後手 */
  round: number
  takeback: TakebackView
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
  /** 每一手之前的局面，悔棋時退回去 */
  let before: Game[] = []
  const takeback = new Takeback()
  for (const { seat, data } of events) {
    if (!data || typeof data !== 'object') continue
    const side = seatSide(seat, round)
    if (isTakebackEvent(data)) {
      const plies = takeback.handle(seat, data, !!game.result)
      if (plies) {
        game = before[before.length - plies]
        before = before.slice(0, -plies)
      }
      continue
    }
    switch (data.type) {
      case 'move': {
        if (game.result || currentPosition(game).turn !== side) break
        if (!isSquare(data.from) || !isSquare(data.to)) break
        const next = applyMove(game, encodeMove(data.from, data.to))
        if (!next) break
        before.push(game)
        game = next
        takeback.moved(seat)
        break
      }
      case 'resign':
        game = resign(game, side)
        takeback.reset(false)
        break
      case 'restart':
        if (game.result) {
          game = newGame()
          round++
          before = []
          takeback.reset(true)
        }
        break
    }
  }
  return { game, round, takeback: takeback.view() }
}
