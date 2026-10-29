// 象棋規則：棋盤是 90 格的陣列，index = row * 9 + col；row 0 是黑方底線（上方），row 9 是紅方底線（下方）。
// 棋子用整數：正數紅方、負數黑方，絕對值是兵種。

export type Side = 1 | -1
export const RED: Side = 1
export const BLACK: Side = -1

export const KING = 1
export const ADVISOR = 2
export const ELEPHANT = 3
export const HORSE = 4
export const ROOK = 5
export const CANNON = 6
export const PAWN = 7

export type Board = number[]
/** 棋步編碼成一個整數：from | to << 8，方便 AI 用陣列存 */
export type Move = number
export type Position = { board: Board; turn: Side }

export type MoveRecord = {
  move: Move
  piece: number
  captured: number
  /** 這步之後對方是否被將軍 */
  check: boolean
  notation: string
}

export type Result = { winner: Side | null; reason: string }

export type Game = {
  /** positions[0] 是開局，positions[i + 1] 是走完 records[i] 之後的局面 */
  positions: Position[]
  records: MoveRecord[]
  result: Result | null
}

export const ROWS = 10
export const COLS = 9

export function encodeMove(from: number, to: number): Move {
  return from | (to << 8)
}
export function moveFrom(m: Move): number {
  return m & 255
}
export function moveTo(m: Move): number {
  return m >> 8
}

const RED_NAMES = ['', '帥', '仕', '相', '傌', '俥', '炮', '兵']
const BLACK_NAMES = ['', '將', '士', '象', '馬', '車', '包', '卒']

export function pieceName(p: number): string {
  return p > 0 ? RED_NAMES[p] : BLACK_NAMES[-p]
}

export function sideName(side: Side): string {
  return side === RED ? '紅方' : '黑方'
}

export function initialBoard(): Board {
  const b: Board = new Array(90).fill(0)
  const back = [ROOK, HORSE, ELEPHANT, ADVISOR, KING, ADVISOR, ELEPHANT, HORSE, ROOK]
  for (let c = 0; c < 9; c++) {
    b[c] = -back[c]
    b[81 + c] = back[c]
  }
  b[2 * 9 + 1] = b[2 * 9 + 7] = -CANNON
  b[7 * 9 + 1] = b[7 * 9 + 7] = CANNON
  for (let c = 0; c < 9; c += 2) {
    b[3 * 9 + c] = -PAWN
    b[6 * 9 + c] = PAWN
  }
  return b
}

function inPalace(side: Side, r: number, c: number): boolean {
  if (c < 3 || c > 5) return false
  return side === RED ? r >= 7 && r <= 9 : r >= 0 && r <= 2
}

function crossed(side: Side, r: number): boolean {
  return side === RED ? r <= 4 : r >= 5
}

const ORTHO = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]
const DIAG = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
]
// 馬：[dr, dc, 馬腿 dr, 馬腿 dc]
const HORSE_STEPS = [
  [-2, -1, -1, 0],
  [-2, 1, -1, 0],
  [2, -1, 1, 0],
  [2, 1, 1, 0],
  [-1, -2, 0, -1],
  [1, -2, 0, -1],
  [-1, 2, 0, 1],
  [1, 2, 0, 1],
]

/** 產生不考慮「自己被將軍」的棋步，推進 out；capturesOnly 只產生吃子步（AI 靜態搜尋用） */
export function genMoves(board: Board, side: Side, out: Move[], capturesOnly = false): void {
  for (let from = 0; from < 90; from++) {
    const p = board[from]
    if (p * side <= 0) continue
    const r = (from / 9) | 0
    const c = from - r * 9
    const add = (to: number) => {
      const t = board[to]
      if (t * side > 0) return
      if (capturesOnly && t === 0) return
      out.push(from | (to << 8))
    }
    switch (p * side) {
      case KING:
        for (const [dr, dc] of ORTHO) {
          const nr = r + dr
          const nc = c + dc
          if (inPalace(side, nr, nc)) add(nr * 9 + nc)
        }
        break
      case ADVISOR:
        for (const [dr, dc] of DIAG) {
          const nr = r + dr
          const nc = c + dc
          if (inPalace(side, nr, nc)) add(nr * 9 + nc)
        }
        break
      case ELEPHANT:
        for (const [dr, dc] of DIAG) {
          const nr = r + 2 * dr
          const nc = c + 2 * dc
          if (nr < 0 || nr > 9 || nc < 0 || nc > 8 || crossed(side, nr)) continue
          if (board[(r + dr) * 9 + c + dc] !== 0) continue // 塞象眼
          add(nr * 9 + nc)
        }
        break
      case HORSE:
        for (const [dr, dc, lr, lc] of HORSE_STEPS) {
          const nr = r + dr
          const nc = c + dc
          if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue
          if (board[(r + lr) * 9 + c + lc] !== 0) continue // 蹩馬腿
          add(nr * 9 + nc)
        }
        break
      case ROOK:
        for (const [dr, dc] of ORTHO) {
          let nr = r + dr
          let nc = c + dc
          while (nr >= 0 && nr <= 9 && nc >= 0 && nc <= 8) {
            const to = nr * 9 + nc
            add(to)
            if (board[to] !== 0) break
            nr += dr
            nc += dc
          }
        }
        break
      case CANNON:
        for (const [dr, dc] of ORTHO) {
          let nr = r + dr
          let nc = c + dc
          let screen = false
          while (nr >= 0 && nr <= 9 && nc >= 0 && nc <= 8) {
            const to = nr * 9 + nc
            const t = board[to]
            if (!screen) {
              if (t === 0) {
                if (!capturesOnly) out.push(from | (to << 8))
              } else screen = true
            } else if (t !== 0) {
              if (t * side < 0) out.push(from | (to << 8))
              break
            }
            nr += dr
            nc += dc
          }
        }
        break
      case PAWN: {
        const nr = r - side
        if (nr >= 0 && nr <= 9) add(nr * 9 + c)
        if (crossed(side, r)) {
          if (c > 0) add(from - 1)
          if (c < 8) add(from + 1)
        }
        break
      }
    }
  }
}

export function findKing(board: Board, side: Side): number {
  const k = KING * side
  // 帥／將只會在九宮裡，只掃那 9 格
  const rows = side === RED ? [7, 8, 9] : [0, 1, 2]
  for (const r of rows) for (let c = 3; c <= 5; c++) if (board[r * 9 + c] === k) return r * 9 + c
  return -1
}

/** sq 這格（帥／將所在）是否被 by 方攻擊；含「王不見王」 */
export function isAttacked(board: Board, sq: number, by: Side): boolean {
  const r = (sq / 9) | 0
  const c = sq - r * 9
  const rook = ROOK * by
  const cannon = CANNON * by
  const king = KING * by
  for (const [dr, dc] of ORTHO) {
    let nr = r + dr
    let nc = c + dc
    let first = true
    while (nr >= 0 && nr <= 9 && nc >= 0 && nc <= 8) {
      const t = board[nr * 9 + nc]
      if (t !== 0) {
        if (first) {
          if (t === rook || (t === king && dc === 0)) return true
          first = false
        } else {
          if (t === cannon) return true
          break
        }
      }
      nr += dr
      nc += dc
    }
  }
  const horse = HORSE * by
  for (const [dr, dc] of HORSE_STEPS) {
    const hr = r + dr
    const hc = c + dc
    if (hr < 0 || hr > 9 || hc < 0 || hc > 8 || board[hr * 9 + hc] !== horse) continue
    // 馬腿在被攻擊格的斜角相鄰格
    const lr = Math.abs(dr) === 2 ? r + Math.sign(dr) : r + dr
    const lc = Math.abs(dc) === 2 ? c + Math.sign(dc) : c + dc
    if (board[lr * 9 + lc] === 0) return true
  }
  const pawn = PAWN * by
  const pr = r + by // 兵往 -by 方向走，所以從 r + by 那格往前一步就到 r
  if (pr >= 0 && pr <= 9 && board[pr * 9 + c] === pawn) return true
  if (crossed(by, r)) {
    if (c > 0 && board[sq - 1] === pawn) return true
    if (c < 8 && board[sq + 1] === pawn) return true
  }
  return false
}

export function inCheck(board: Board, side: Side): boolean {
  const k = findKing(board, side)
  return k < 0 || isAttacked(board, k, -side as Side)
}

export function makeBoard(board: Board, m: Move): Board {
  const next = board.slice()
  next[moveTo(m)] = next[moveFrom(m)]
  next[moveFrom(m)] = 0
  return next
}

export function legalMoves(pos: Position): Move[] {
  const pseudo: Move[] = []
  genMoves(pos.board, pos.turn, pseudo)
  const b = pos.board.slice()
  const out: Move[] = []
  for (const m of pseudo) {
    const from = m & 255
    const to = m >> 8
    const moved = b[from]
    const captured = b[to]
    b[to] = moved
    b[from] = 0
    if (!inCheck(b, pos.turn)) out.push(m)
    b[from] = moved
    b[to] = captured
  }
  return out
}

// ---- 中文記譜 ----

const RED_NUM = '一二三四五六七八九'
const BLACK_NUM = '１２３４５６７８９'

function num(side: Side, n: number): string {
  return (side === RED ? RED_NUM : BLACK_NUM)[n - 1]
}

/** 各自從右手往左數：紅方在下面，右手是 col 8；黑方在上面面朝下，右手是 col 0 */
function fileOf(side: Side, c: number): number {
  return side === RED ? 9 - c : c + 1
}

/** 用走之前的棋盤產生記譜，例如「炮二平五」「馬８進７」「前俥進一」 */
export function notate(board: Board, m: Move): string {
  const from = moveFrom(m)
  const to = moveTo(m)
  const p = board[from]
  const side: Side = p > 0 ? RED : BLACK
  const type = Math.abs(p)
  const fr = (from / 9) | 0
  const fc = from - fr * 9
  const tr = (to / 9) | 0
  const tc = to - tr * 9
  const name = pieceName(p)

  let head = name + num(side, fileOf(side, fc))
  // 仕、相走斜線，就算同一直線有兩個也不會混淆，照慣例仍寫路數
  if (type !== ADVISOR && type !== ELEPHANT && type !== KING) {
    const same: number[] = []
    for (let r = 0; r < 10; r++) if (board[r * 9 + fc] === p) same.push(r)
    if (same.length > 1) {
      // 由前往後排：紅方的前方是 row 小的一邊
      if (side === BLACK) same.reverse()
      const idx = same.indexOf(fr)
      let tag: string
      if (same.length === 2) tag = idx === 0 ? '前' : '後'
      else if (same.length === 3) tag = '前中後'[idx]
      else tag = num(side, idx + 1)
      head = tag + name
    }
  }

  if (fr === tr) return `${head}平${num(side, fileOf(side, tc))}`
  const forward = (fr - tr) * side > 0
  const action = forward ? '進' : '退'
  if (type === HORSE || type === ELEPHANT || type === ADVISOR) return `${head}${action}${num(side, fileOf(side, tc))}`
  return `${head}${action}${num(side, Math.abs(tr - fr))}`
}

// ---- 對局 ----

export function newGame(): Game {
  return { positions: [{ board: initialBoard(), turn: RED }], records: [], result: null }
}

export function currentPosition(game: Game): Position {
  return game.positions[game.positions.length - 1]
}

export function positionKey(pos: Position): string {
  let s = pos.turn === RED ? 'r' : 'b'
  for (let i = 0; i < 90; i++) s += String.fromCharCode(72 + pos.board[i])
  return s
}

/** 連續 60 回合（120 步）沒有吃子就判和 */
export const NO_CAPTURE_LIMIT = 120

function judge(game: Game): Result | null {
  const pos = currentPosition(game)
  const mover = -pos.turn as Side
  if (legalMoves(pos).length === 0) {
    return { winner: mover, reason: inCheck(pos.board, pos.turn) ? '將死' : '困斃' }
  }

  // 只看最後一次吃子之後的局面，吃子後不可能回到之前的局面
  const records = game.records
  let lastCapture = records.length - 1
  while (lastCapture >= 0 && records[lastCapture].captured === 0) lastCapture--
  const sinceCapture = records.length - 1 - lastCapture
  const firstIdx = lastCapture + 1 // positions 裡吃子之後的第一個局面

  const key = positionKey(pos)
  const seen: number[] = []
  for (let i = firstIdx; i < game.positions.length - 1; i++) {
    if (game.positions[i].turn === pos.turn && positionKey(game.positions[i]) === key) seen.push(i)
  }
  if (seen.length >= 2) {
    // 第三次出現同一局面：若只有一方在這段期間每步都將軍，是長將，判將軍的一方負；其他情況和棋
    const start = seen[0]
    const allCheck = { [RED]: true, [BLACK]: true } as Record<Side, boolean>
    for (let k = start; k < records.length; k++) {
      const by = game.positions[k].turn
      if (!records[k].check) allCheck[by] = false
    }
    if (allCheck[RED] !== allCheck[BLACK]) {
      const loser: Side = allCheck[RED] ? RED : BLACK
      return { winner: -loser as Side, reason: '長將判負' }
    }
    return { winner: null, reason: '同一局面重複三次' }
  }
  if (sinceCapture >= NO_CAPTURE_LIMIT) return { winner: null, reason: '六十回合未吃子' }
  return null
}

/** 走一步；不合法或對局已結束就回傳 null */
export function applyMove(game: Game, m: Move): Game | null {
  if (game.result) return null
  const pos = currentPosition(game)
  if (!legalMoves(pos).includes(m)) return null
  const board = makeBoard(pos.board, m)
  const turn = -pos.turn as Side
  const record: MoveRecord = {
    move: m,
    piece: pos.board[moveFrom(m)],
    captured: pos.board[moveTo(m)],
    check: inCheck(board, turn),
    notation: notate(pos.board, m),
  }
  const next: Game = { positions: [...game.positions, { board, turn }], records: [...game.records, record], result: null }
  next.result = judge(next)
  return next
}

/** 退回到只走了 plies 步的局面 */
export function truncate(game: Game, plies: number): Game {
  const n = Math.max(0, Math.min(plies, game.records.length))
  return { positions: game.positions.slice(0, n + 1), records: game.records.slice(0, n), result: null }
}

export function resign(game: Game, side: Side): Game {
  if (game.result) return game
  return { ...game, result: { winner: -side as Side, reason: `${sideName(side)}認輸` } }
}

/** 給 AI 判斷重複局面用：最後一次吃子之後的局面（不含目前局面） */
export function historySinceCapture(game: Game): Position[] {
  let i = game.records.length - 1
  while (i >= 0 && game.records[i].captured === 0) i--
  return game.positions.slice(i + 1, -1)
}
