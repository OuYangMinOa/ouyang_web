// 一盤棋的紀錄與勝負判定，以及線上模式的事件 reducer（不含 React，方便測試）
import {
  BISHOP,
  BLACK,
  FLAG_EP,
  KNIGHT,
  PAWN,
  Position,
  QUEEN,
  ROOK,
  WHITE,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  moveToSan,
  parseSquare,
  squareName,
  type Color,
} from './engine.ts'

export type DrawReason = 'stalemate' | 'fifty' | 'repetition' | 'material'
export type Result = { winner: Color; reason: 'checkmate' | 'resign' } | { winner: null; reason: DrawReason }

export type Played = {
  move: number
  san: string
  color: Color
  /** 被吃掉的棋子（帶正負號），沒吃子是 0 */
  captured: number
}

export class ChessGame {
  pos = Position.fromFen()
  played: Played[] = []
  legal: number[]
  result: Result | null = null
  private keys: string[] = []

  constructor() {
    this.legal = this.pos.legalMoves()
    this.keys.push(this.repetitionKey())
  }

  get turn(): Color {
    return this.pos.turn
  }

  get lastMove(): number | null {
    return this.played.length ? this.played[this.played.length - 1].move : null
  }

  /** 不合法或對局已結束就回傳 false、局面不變 */
  play(m: number): boolean {
    if (this.result || !this.legal.includes(m)) return false
    const pos = this.pos
    const color = pos.turn
    const san = moveToSan(pos, m, this.legal)
    const captured = moveFlags(m) & FLAG_EP ? -color * PAWN : pos.board[moveTo(m)]
    pos.make(m)
    this.played.push({ move: m, san, color, captured })
    this.legal = pos.legalMoves()
    const key = this.repetitionKey()
    this.keys.push(key)

    // 將死優先：第 100 個半回合剛好將死也算贏
    if (this.legal.length === 0) {
      this.result = pos.inCheck() ? { winner: color, reason: 'checkmate' } : { winner: null, reason: 'stalemate' }
    } else if (pos.insufficientMaterial()) this.result = { winner: null, reason: 'material' }
    else if (this.keys.filter((k) => k === key).length >= 3) this.result = { winner: null, reason: 'repetition' }
    else if (pos.halfmove >= 100) this.result = { winner: null, reason: 'fifty' }
    return true
  }

  resign(color: Color) {
    if (!this.result) this.result = { winner: -color as Color, reason: 'resign' }
  }

  /** 重複局面要比：棋子位置、輪到誰、入堡權、以及「真的能吃」的過路兵 */
  private repetitionKey(): string {
    const [placement, side, castling] = this.pos.toFen().split(' ')
    const ep = this.legal.find((m) => moveFlags(m) & FLAG_EP)
    return `${placement} ${side} ${castling} ${ep === undefined ? '-' : moveTo(ep)}`
  }
}

/** 照順序重播走法；遇到不合法的就停下 */
export function replay(moves: readonly number[]): ChessGame {
  const game = new ChessGame()
  for (const m of moves) if (!game.play(m)) break
  return game
}

// ---- 線上模式 ----

export type PromoLetter = 'q' | 'r' | 'b' | 'n'
export type ChessEvent =
  | { type: 'move'; from: string; to: string; promotion?: PromoLetter }
  | { type: 'resign' }
  | { type: 'restart' }

const PROMO_TYPES: Record<string, number> = { q: QUEEN, r: ROOK, b: BISHOP, n: KNIGHT }
const PROMO_LETTERS = ['', '', 'n', 'b', 'r', 'q'] as const

export function moveToEvent(m: number): ChessEvent {
  const promo = movePromo(m)
  const from = squareName(moveFrom(m))
  const to = squareName(moveTo(m))
  return promo ? { type: 'move', from, to, promotion: PROMO_LETTERS[promo] as PromoLetter } : { type: 'move', from, to }
}

/** 在合法走法裡找 from/to/promotion 完全相符的那一步；升變一定要指定棋子 */
export function findMove(legal: readonly number[], from: unknown, to: unknown, promotion?: unknown): number | null {
  const f = parseSquare(from)
  const t = parseSquare(to)
  const promo = promotion === undefined ? 0 : (PROMO_TYPES[String(promotion)] ?? -1)
  return legal.find((m) => moveFrom(m) === f && moveTo(m) === t && movePromo(m) === promo) ?? null
}

/** seat 0 第一局執白，每次再來一局就交換 */
export function seatColor(seat: number, round: number): Color {
  return (seat + round) % 2 === 0 ? WHITE : BLACK
}

export type OnlineState = { round: number; game: ChessGame }

/** 把伺服器的事件序列從頭重播成目前局面；不合法、不是輪到該 seat、或對局結束後的棋步都忽略 */
export function reduceOnline(events: readonly { seat: number; data: ChessEvent }[]): OnlineState {
  let round = 0
  let game = new ChessGame()
  for (const { seat, data } of events) {
    if (!data || typeof data !== 'object') continue
    if (data.type === 'move') {
      if (game.result || seatColor(seat, round) !== game.turn) continue
      const m = findMove(game.legal, data.from, data.to, data.promotion)
      if (m !== null) game.play(m)
    } else if (data.type === 'resign') {
      game.resign(seatColor(seat, round))
    } else if (data.type === 'restart' && game.result) {
      // 只有結束後才接受，兩人同時按「再來一局」時第二個會被忽略
      round++
      game = new ChessGame()
    }
  }
  return { round, game }
}
