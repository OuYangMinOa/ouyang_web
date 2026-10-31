// 西洋棋規則引擎：64 格陣列 + 可還原的走子（make / unmake），介面與電腦共用。
// 格子編號 sq = rank * 8 + file，a1 = 0、h1 = 7、a8 = 56。
// 棋子：0 空格；白方為正數、黑方為負數，絕對值是兵種。

export const PAWN = 1
export const KNIGHT = 2
export const BISHOP = 3
export const ROOK = 4
export const QUEEN = 5
export const KING = 6

export const WHITE = 1
export const BLACK = -1
export type Color = 1 | -1

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// 走法編碼成一個整數，方便放進陣列、置換表與 worker 訊息
export const FLAG_CAPTURE = 1
export const FLAG_EP = 2
export const FLAG_CASTLE = 4
export const FLAG_DOUBLE = 8

export function encodeMove(from: number, to: number, promo = 0, flags = 0): number {
  return from | (to << 6) | (promo << 12) | (flags << 15)
}
export const moveFrom = (m: number) => m & 63
export const moveTo = (m: number) => (m >> 6) & 63
export const movePromo = (m: number) => (m >> 12) & 7
export const moveFlags = (m: number) => m >> 15

const FILES = 'abcdefgh'

export function squareName(sq: number): string {
  return FILES[sq & 7] + String((sq >> 3) + 1)
}

/** 'e4' → 28；格式不對回傳 -1 */
export function parseSquare(name: unknown): number {
  if (typeof name !== 'string' || name.length !== 2) return -1
  const f = FILES.indexOf(name[0])
  const r = name.charCodeAt(1) - 49
  return f < 0 || r < 0 || r > 7 ? -1 : r * 8 + f
}

// ---- 預先算好的跳躍表與射線 ----

const KNIGHT_TARGETS: number[][] = []
const KING_TARGETS: number[][] = []
/** RAYS[sq][dir]：0–3 是直線（車），4–7 是斜線（象） */
const RAYS: number[][][] = []
const DIRS = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
]
const KNIGHT_JUMPS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
]

for (let sq = 0; sq < 64; sq++) {
  const f = sq & 7
  const r = sq >> 3
  const jumps = (list: number[][]) =>
    list
      .map(([df, dr]) => [f + df, r + dr])
      .filter(([ff, rr]) => ff >= 0 && ff < 8 && rr >= 0 && rr < 8)
      .map(([ff, rr]) => rr * 8 + ff)
  KNIGHT_TARGETS[sq] = jumps(KNIGHT_JUMPS)
  KING_TARGETS[sq] = jumps(DIRS)
  RAYS[sq] = DIRS.map(([df, dr]) => {
    const ray: number[] = []
    for (let ff = f + df, rr = r + dr; ff >= 0 && ff < 8 && rr >= 0 && rr < 8; ff += df, rr += dr) ray.push(rr * 8 + ff)
    return ray
  })
}

// 入堡權：1 白短、2 白長、4 黑短、8 黑長；王或車離開（或車被吃）原位就失去對應權利
const CASTLE_MASK = new Array<number>(64).fill(15)
CASTLE_MASK[0] = 13
CASTLE_MASK[7] = 14
CASTLE_MASK[4] = 12
CASTLE_MASK[56] = 7
CASTLE_MASK[63] = 11
CASTLE_MASK[60] = 3

// ---- Zobrist 雜湊：兩組 32 位元，一組當索引、一組驗證，碰撞機率可忽略 ----

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) | 0
  }
}
const rand32 = mulberry32(0x5eed)
const fillRandom = (n: number) => Int32Array.from({ length: n }, rand32)
const Z_PIECE_LO = fillRandom(13 * 64)
const Z_PIECE_HI = fillRandom(13 * 64)
const Z_CASTLE_LO = fillRandom(16)
const Z_CASTLE_HI = fillRandom(16)
const Z_EP_LO = fillRandom(8)
const Z_EP_HI = fillRandom(8)
const Z_SIDE_LO = rand32()
const Z_SIDE_HI = rand32()
const zi = (piece: number, sq: number) => (piece + 6) * 64 + sq

// 每步存在還原堆疊裡的欄位數：被吃的子、入堡權、過路兵格、半回合數、雜湊 lo、雜湊 hi
const STRIDE = 6

const FEN_PIECES = ' pnbrqk'

export class Position {
  board = new Int8Array(64)
  turn: Color = WHITE
  castling = 0
  /** 可以吃過路兵的目標格；只有對方真的有兵在旁邊時才設定，讓雜湊與重複局面判斷一致 */
  ep = -1
  halfmove = 0
  fullmove = 1
  /** [白王, 黑王] 的位置 */
  kingSq = [4, 60]
  hashLo = 0
  hashHi = 0
  private undo: number[] = []

  static fromFen(fen = START_FEN): Position {
    const pos = new Position()
    const [placement, side = 'w', castling = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/)
    const rows = placement.split('/')
    if (rows.length !== 8) throw new Error(`FEN 格式錯誤：${fen}`)
    rows.forEach((row, i) => {
      const r = 7 - i
      let f = 0
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') {
          f += Number(ch)
          continue
        }
        const type = FEN_PIECES.indexOf(ch.toLowerCase())
        if (type <= 0 || f > 7) throw new Error(`FEN 格式錯誤：${fen}`)
        const piece = ch === ch.toUpperCase() ? type : -type
        pos.board[r * 8 + f] = piece
        if (type === KING) pos.kingSq[piece > 0 ? 0 : 1] = r * 8 + f
        f++
      }
    })
    pos.turn = side === 'b' ? BLACK : WHITE
    for (const ch of castling) pos.castling |= { K: 1, Q: 2, k: 4, q: 8 }[ch] ?? 0
    const epSq = parseSquare(ep)
    if (epSq >= 0 && pos.epCapturable(epSq + pos.turn * -8, pos.turn)) pos.ep = epSq
    pos.halfmove = Number(half) || 0
    pos.fullmove = Number(full) || 1
    pos.computeHash()
    return pos
  }

  clone(): Position {
    const pos = new Position()
    pos.board = this.board.slice()
    pos.turn = this.turn
    pos.castling = this.castling
    pos.ep = this.ep
    pos.halfmove = this.halfmove
    pos.fullmove = this.fullmove
    pos.kingSq = this.kingSq.slice()
    pos.hashLo = this.hashLo
    pos.hashHi = this.hashHi
    pos.undo = this.undo.slice()
    return pos
  }

  toFen(): string {
    const rows: string[] = []
    for (let r = 7; r >= 0; r--) {
      let row = ''
      let empty = 0
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 8 + f]
        if (p === 0) {
          empty++
          continue
        }
        if (empty) row += empty
        empty = 0
        const ch = FEN_PIECES[Math.abs(p)]
        row += p > 0 ? ch.toUpperCase() : ch
      }
      rows.push(empty ? row + empty : row)
    }
    let castling = ''
    if (this.castling & 1) castling += 'K'
    if (this.castling & 2) castling += 'Q'
    if (this.castling & 4) castling += 'k'
    if (this.castling & 8) castling += 'q'
    const ep = this.ep >= 0 ? squareName(this.ep) : '-'
    return `${rows.join('/')} ${this.turn === WHITE ? 'w' : 'b'} ${castling || '-'} ${ep} ${this.halfmove} ${this.fullmove}`
  }

  private computeHash() {
    let lo = 0
    let hi = 0
    for (let sq = 0; sq < 64; sq++) {
      const p = this.board[sq]
      if (p) {
        lo ^= Z_PIECE_LO[zi(p, sq)]
        hi ^= Z_PIECE_HI[zi(p, sq)]
      }
    }
    lo ^= Z_CASTLE_LO[this.castling]
    hi ^= Z_CASTLE_HI[this.castling]
    if (this.ep >= 0) {
      lo ^= Z_EP_LO[this.ep & 7]
      hi ^= Z_EP_HI[this.ep & 7]
    }
    if (this.turn === BLACK) {
      lo ^= Z_SIDE_LO
      hi ^= Z_SIDE_HI
    }
    this.hashLo = lo
    this.hashHi = hi
  }

  /** 剛走兩步的兵（在 pawnSq）旁邊是否有 `by` 方的兵可以吃過路兵 */
  private epCapturable(pawnSq: number, by: Color): boolean {
    const f = pawnSq & 7
    const b = this.board
    return (f > 0 && b[pawnSq - 1] === by * PAWN) || (f < 7 && b[pawnSq + 1] === by * PAWN)
  }

  kingOf(color: Color): number {
    return this.kingSq[color === WHITE ? 0 : 1]
  }

  /** `sq` 是否被 `by` 方攻擊 */
  attacked(sq: number, by: Color): boolean {
    const b = this.board
    const f = sq & 7
    // by 方的兵從 sq 往自己後方一格的左右兩格攻擊過來
    const pr = sq - by * 8
    if (pr >= 0 && pr < 64) {
      if (f > 0 && b[pr - 1] === by * PAWN) return true
      if (f < 7 && b[pr + 1] === by * PAWN) return true
    }
    const knight = by * KNIGHT
    for (const t of KNIGHT_TARGETS[sq]) if (b[t] === knight) return true
    const king = by * KING
    for (const t of KING_TARGETS[sq]) if (b[t] === king) return true
    const rays = RAYS[sq]
    const queen = by * QUEEN
    for (let d = 0; d < 8; d++) {
      const slider = d < 4 ? by * ROOK : by * BISHOP
      const ray = rays[d]
      for (let i = 0; i < ray.length; i++) {
        const p = b[ray[i]]
        if (p === 0) continue
        if (p === slider || p === queen) return true
        break
      }
    }
    return false
  }

  inCheck(): boolean {
    return this.attacked(this.kingOf(this.turn), -this.turn as Color)
  }

  /** 產生擬合法走法（還沒檢查會不會讓自己的王被將）；`noisy` 時只產生吃子與升后 */
  generate(out: number[], noisy = false): number[] {
    const b = this.board
    const us = this.turn
    for (let sq = 0; sq < 64; sq++) {
      const type = b[sq] * us
      if (type <= 0) continue
      switch (type) {
        case PAWN:
          this.pawnMoves(sq, out, noisy)
          break
        case KNIGHT:
          this.jumpMoves(sq, KNIGHT_TARGETS[sq], out, noisy)
          break
        case BISHOP:
          this.slideMoves(sq, 4, 8, out, noisy)
          break
        case ROOK:
          this.slideMoves(sq, 0, 4, out, noisy)
          break
        case QUEEN:
          this.slideMoves(sq, 0, 8, out, noisy)
          break
        case KING:
          this.jumpMoves(sq, KING_TARGETS[sq], out, noisy)
          if (!noisy) this.castleMoves(out)
          break
      }
    }
    return out
  }

  private pawnMoves(sq: number, out: number[], noisy: boolean) {
    const b = this.board
    const us = this.turn
    const r = sq >> 3
    const f = sq & 7
    const one = sq + us * 8
    const promoting = r === (us === WHITE ? 6 : 1)
    if (b[one] === 0) {
      if (promoting) addPromotions(sq, one, 0, out, noisy)
      else if (!noisy) {
        out.push(encodeMove(sq, one))
        const two = one + us * 8
        if (r === (us === WHITE ? 1 : 6) && b[two] === 0) out.push(encodeMove(sq, two, 0, FLAG_DOUBLE))
      }
    }
    if (f > 0) this.pawnCapture(sq, one - 1, promoting, out, noisy)
    if (f < 7) this.pawnCapture(sq, one + 1, promoting, out, noisy)
  }

  private pawnCapture(from: number, to: number, promoting: boolean, out: number[], noisy: boolean) {
    const t = this.board[to]
    if (t * this.turn < 0) {
      if (promoting) addPromotions(from, to, FLAG_CAPTURE, out, noisy)
      else out.push(encodeMove(from, to, 0, FLAG_CAPTURE))
    } else if (to === this.ep) {
      out.push(encodeMove(from, to, 0, FLAG_CAPTURE | FLAG_EP))
    }
  }

  private jumpMoves(sq: number, targets: number[], out: number[], noisy: boolean) {
    const b = this.board
    const us = this.turn
    for (const to of targets) {
      const t = b[to]
      if (t === 0) {
        if (!noisy) out.push(encodeMove(sq, to))
      } else if (t * us < 0) out.push(encodeMove(sq, to, 0, FLAG_CAPTURE))
    }
  }

  private slideMoves(sq: number, d0: number, d1: number, out: number[], noisy: boolean) {
    const b = this.board
    const us = this.turn
    const rays = RAYS[sq]
    for (let d = d0; d < d1; d++) {
      const ray = rays[d]
      for (let i = 0; i < ray.length; i++) {
        const to = ray[i]
        const t = b[to]
        if (t === 0) {
          if (!noisy) out.push(encodeMove(sq, to))
          continue
        }
        if (t * us < 0) out.push(encodeMove(sq, to, 0, FLAG_CAPTURE))
        break
      }
    }
  }

  private castleMoves(out: number[]) {
    const b = this.board
    const us = this.turn
    const them = -us as Color
    const base = us === WHITE ? 0 : 56
    const rights = us === WHITE ? this.castling & 3 : this.castling >> 2
    if (!rights || b[base + 4] !== us * KING || this.attacked(base + 4, them)) return
    // 王經過與到達的格子都不能被攻擊；長入堡時 b 檔只需要空著
    if (
      rights & 1 &&
      b[base + 5] === 0 &&
      b[base + 6] === 0 &&
      b[base + 7] === us * ROOK &&
      !this.attacked(base + 5, them) &&
      !this.attacked(base + 6, them)
    )
      out.push(encodeMove(base + 4, base + 6, 0, FLAG_CASTLE))
    if (
      rights & 2 &&
      b[base + 3] === 0 &&
      b[base + 2] === 0 &&
      b[base + 1] === 0 &&
      b[base] === us * ROOK &&
      !this.attacked(base + 3, them) &&
      !this.attacked(base + 2, them)
    )
      out.push(encodeMove(base + 4, base + 2, 0, FLAG_CASTLE))
  }

  make(m: number) {
    const b = this.board
    const us = this.turn
    const from = m & 63
    const to = (m >> 6) & 63
    const promo = (m >> 12) & 7
    const flags = m >> 15
    const piece = b[from]
    const capSq = flags & FLAG_EP ? to - us * 8 : to
    const captured = b[capSq]
    this.undo.push(captured, this.castling, this.ep, this.halfmove, this.hashLo, this.hashHi)

    let lo = this.hashLo ^ Z_PIECE_LO[zi(piece, from)]
    let hi = this.hashHi ^ Z_PIECE_HI[zi(piece, from)]
    if (captured) {
      b[capSq] = 0
      lo ^= Z_PIECE_LO[zi(captured, capSq)]
      hi ^= Z_PIECE_HI[zi(captured, capSq)]
    }
    const placed = promo ? us * promo : piece
    b[from] = 0
    b[to] = placed
    lo ^= Z_PIECE_LO[zi(placed, to)]
    hi ^= Z_PIECE_HI[zi(placed, to)]

    if (flags & FLAG_CASTLE) {
      const rf = to > from ? from + 3 : from - 4
      const rt = to > from ? from + 1 : from - 1
      const rook = b[rf]
      b[rf] = 0
      b[rt] = rook
      lo ^= Z_PIECE_LO[zi(rook, rf)] ^ Z_PIECE_LO[zi(rook, rt)]
      hi ^= Z_PIECE_HI[zi(rook, rf)] ^ Z_PIECE_HI[zi(rook, rt)]
    }
    if (piece === us * KING) this.kingSq[us === WHITE ? 0 : 1] = to

    const castling = this.castling & CASTLE_MASK[from] & CASTLE_MASK[to]
    if (castling !== this.castling) {
      lo ^= Z_CASTLE_LO[this.castling] ^ Z_CASTLE_LO[castling]
      hi ^= Z_CASTLE_HI[this.castling] ^ Z_CASTLE_HI[castling]
      this.castling = castling
    }
    if (this.ep >= 0) {
      lo ^= Z_EP_LO[this.ep & 7]
      hi ^= Z_EP_HI[this.ep & 7]
      this.ep = -1
    }
    if (flags & FLAG_DOUBLE && this.epCapturable(to, -us as Color)) {
      this.ep = (from + to) >> 1
      lo ^= Z_EP_LO[this.ep & 7]
      hi ^= Z_EP_HI[this.ep & 7]
    }
    this.halfmove = piece === us * PAWN || captured ? 0 : this.halfmove + 1
    if (us === BLACK) this.fullmove++
    this.turn = -us as Color
    this.hashLo = lo ^ Z_SIDE_LO
    this.hashHi = hi ^ Z_SIDE_HI
  }

  unmake(m: number) {
    const b = this.board
    const us = -this.turn as Color
    this.turn = us
    const from = m & 63
    const to = (m >> 6) & 63
    const promo = (m >> 12) & 7
    const flags = m >> 15
    const n = this.undo.length - STRIDE
    const u = this.undo
    const captured = u[n]

    const moved = promo ? us * PAWN : b[to]
    b[from] = moved
    if (flags & FLAG_EP) {
      b[to] = 0
      b[to - us * 8] = captured
    } else b[to] = captured
    if (flags & FLAG_CASTLE) {
      const rf = to > from ? from + 3 : from - 4
      const rt = to > from ? from + 1 : from - 1
      b[rf] = b[rt]
      b[rt] = 0
    }
    if (moved === us * KING) this.kingSq[us === WHITE ? 0 : 1] = from
    if (us === BLACK) this.fullmove--
    this.castling = u[n + 1]
    this.ep = u[n + 2]
    this.halfmove = u[n + 3]
    this.hashLo = u[n + 4]
    this.hashHi = u[n + 5]
    u.length = n
  }

  /** 空著（讓對方連走），給搜尋的 null-move 剪枝用 */
  makeNull() {
    this.undo.push(0, this.castling, this.ep, this.halfmove, this.hashLo, this.hashHi)
    if (this.ep >= 0) {
      this.hashLo ^= Z_EP_LO[this.ep & 7]
      this.hashHi ^= Z_EP_HI[this.ep & 7]
      this.ep = -1
    }
    // 歸零讓重複局面判斷不會跨過空著
    this.halfmove = 0
    this.turn = -this.turn as Color
    this.hashLo ^= Z_SIDE_LO
    this.hashHi ^= Z_SIDE_HI
  }

  unmakeNull() {
    const n = this.undo.length - STRIDE
    const u = this.undo
    this.turn = -this.turn as Color
    this.ep = u[n + 2]
    this.halfmove = u[n + 3]
    this.hashLo = u[n + 4]
    this.hashHi = u[n + 5]
    u.length = n
  }

  /** 走完 m 之後，走的那一方的王是否安全 */
  isLegalAfterMake(): boolean {
    const mover = -this.turn as Color
    return !this.attacked(this.kingOf(mover), this.turn)
  }

  legalMoves(): number[] {
    const pseudo = this.generate([])
    const out: number[] = []
    for (const m of pseudo) {
      this.make(m)
      if (this.isLegalAfterMake()) out.push(m)
      this.unmake(m)
    }
    return out
  }

  /** 從上次吃子或動兵以來，目前局面是否出現過（搜尋時出現一次就當和棋） */
  isRepetition(): boolean {
    const u = this.undo
    const count = u.length / STRIDE
    for (let k = 4; k <= this.halfmove && k <= count; k += 2) {
      const base = (count - k) * STRIDE
      if (u[base + 4] === this.hashLo && u[base + 5] === this.hashHi) return true
    }
    return false
  }

  /** 雙方都無法將死對方：K vs K、K+B vs K、K+N vs K、所有象都在同色格 */
  insufficientMaterial(): boolean {
    let knights = 0
    let lightBishops = 0
    let darkBishops = 0
    for (let sq = 0; sq < 64; sq++) {
      const type = Math.abs(this.board[sq])
      if (type === 0 || type === KING) continue
      if (type === KNIGHT) knights++
      else if (type === BISHOP) {
        if (((sq >> 3) + (sq & 7)) % 2) lightBishops++
        else darkBishops++
      } else return false
    }
    if (knights === 0) return lightBishops === 0 || darkBishops === 0
    return knights === 1 && lightBishops + darkBishops === 0
  }
}

function addPromotions(from: number, to: number, flags: number, out: number[], noisy: boolean) {
  out.push(encodeMove(from, to, QUEEN, flags))
  if (noisy) return
  out.push(encodeMove(from, to, ROOK, flags), encodeMove(from, to, BISHOP, flags), encodeMove(from, to, KNIGHT, flags))
}

/** 數葉節點，用來驗證走法產生器 */
export function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1
  const moves = pos.generate([])
  let nodes = 0
  for (const m of moves) {
    pos.make(m)
    if (pos.isLegalAfterMake()) nodes += depth === 1 ? 1 : perft(pos, depth - 1)
    pos.unmake(m)
  }
  return nodes
}

const SAN_LETTERS = ['', '', 'N', 'B', 'R', 'Q', 'K']

/** 標準代數記譜（SAN）：e4、Nbd7、exd5、O-O、e8=Q+、Qh7# */
export function moveToSan(pos: Position, m: number, legal = pos.legalMoves()): string {
  const from = moveFrom(m)
  const to = moveTo(m)
  const flags = moveFlags(m)
  const type = Math.abs(pos.board[from])
  let san: string
  if (flags & FLAG_CASTLE) san = to > from ? 'O-O' : 'O-O-O'
  else if (type === PAWN) {
    san = flags & FLAG_CAPTURE ? `${FILES[from & 7]}x${squareName(to)}` : squareName(to)
    const promo = movePromo(m)
    if (promo) san += `=${SAN_LETTERS[promo]}`
  } else {
    // 同種棋子都能走到同一格時，先用檔（a–h）區分，不夠再用列，最後兩個都寫
    const rivals = legal.filter(
      (o) => o !== m && moveTo(o) === to && moveFrom(o) !== from && Math.abs(pos.board[moveFrom(o)]) === type,
    )
    let disambig = ''
    if (rivals.length) {
      const sameFile = rivals.some((o) => (moveFrom(o) & 7) === (from & 7))
      const sameRank = rivals.some((o) => moveFrom(o) >> 3 === from >> 3)
      if (!sameFile) disambig = FILES[from & 7]
      else if (!sameRank) disambig = String((from >> 3) + 1)
      else disambig = squareName(from)
    }
    san = SAN_LETTERS[type] + disambig + (flags & FLAG_CAPTURE ? 'x' : '') + squareName(to)
  }
  pos.make(m)
  if (pos.inCheck()) san += pos.legalMoves().length ? '+' : '#'
  pos.unmake(m)
  return san
}
