// 1A2B 對戰：雙方各藏一組數字，輪流猜對方的（純邏輯，電腦和線上共用）
//
// 對局完全由「事件」推出來：線上模式的事件是房間的歷史（伺服器依序轉送給兩邊），
// 對電腦時是本地的陣列。兩邊用同一個 reduceVersus 從頭重播，結果就一定一樣。
//
// 線上防作弊（轉送伺服器會把訊息廣播給雙方，祕密數字絕對不能送出去）：
// - 開局時各自送出 commit = SHA-256(`數字:salt`)，salt 是 16 bytes 的亂數，對方不能靠 5040 種窮舉回推。
// - 對方的猜測由「被猜的那一方」的瀏覽器自動算 A／B 並回報。
// - 結束後雙方公開數字和 salt，用戶端驗證雜湊和每一次回報（verifySide），不一致就判那一方輸。

import type { RoomEvent, Seat } from '../shared/useRoom'
import { isValidCode, score, validFeedback, type Clue } from './logic'

export type AbEvent =
  | { type: 'commit'; round: number; hash: string }
  | { type: 'guess'; round: number; code: string }
  /** 回報對手第 n 次（從 0 起算）猜測的結果 */
  | { type: 'answer'; round: number; n: number; a: number; b: number }
  | { type: 'resign'; round: number }
  | { type: 'reveal'; round: number; secret: string; salt: string }
  | { type: 'restart'; round: number }

/** 一次猜測；a、b 是 null 表示對方還沒回報 */
export type Guess = { code: string; a: number | null; b: number | null }

export type Side = {
  commit: string | null
  /** 這個座位「猜對方」的紀錄 */
  guesses: Guess[]
  reveal: { secret: string; salt: string } | null
}

export type Result = {
  /** null 是平手 */
  winner: Seat | null
  reason: 'solved' | 'resign'
  /** 猜中的是第幾次（認輸時是 null） */
  turns: number | null
}

export type VersusState = {
  /** 第幾局（從 0 起算）：決定誰先猜 */
  round: number
  first: Seat
  sides: [Side, Side]
  /** 雙方都藏好數字了 */
  started: boolean
  result: Result | null
}

export function other(seat: Seat): Seat {
  return seat === 0 ? 1 : 0
}

/** 第 round 局由哪個座位先猜：每局交換 */
export function firstSeat(round: number): Seat {
  return round % 2 === 0 ? 0 : 1
}

function emptySide(): Side {
  return { commit: null, guesses: [], reveal: null }
}

export function newVersus(round = 0): VersusState {
  return { round, first: firstSeat(round), sides: [emptySide(), emptySide()], started: false, result: null }
}

export function isWin(g: Guess | undefined): boolean {
  return g?.a === 4
}

function answered(g: Guess | undefined): boolean {
  return g !== undefined && g.a !== null
}

/**
 * 輪到誰猜（還沒開始或已經結束是 null）。
 * 先手猜完換後手，後手猜完換先手，所以只看雙方猜了幾次。先手猜中之後，後手還有同一回合的最後一次。
 */
export function turnOf(state: VersusState): Seat | null {
  if (!state.started || state.result) return null
  const f = state.first
  const s = other(f)
  return state.sides[f].guesses.length === state.sides[s].guesses.length ? f : s
}

/** 這個座位現在能不能猜：輪到他、上一次已經有回報，而且還沒猜中（猜中後等對手的最後一次） */
export function canGuess(state: VersusState, seat: Seat): boolean {
  if (turnOf(state) !== seat) return false
  const mine = state.sides[seat].guesses
  if (mine.length && !answered(mine[mine.length - 1])) return false
  return !mine.some(isWin)
}

/**
 * 依回合判斷勝負：第 k 回合先手猜中，要等後手第 k 次的回報（也猜中就平手）；
 * 後手在第 k 回合猜中，要等先手第 k 次的回報確定沒猜中。回報還沒到就先不判。
 */
function decide(state: VersusState): Result | null {
  const f = state.first
  const s = other(f)
  const fg = state.sides[f].guesses
  const sg = state.sides[s].guesses
  for (let k = 0; k < fg.length; k++) {
    const mine = fg[k]
    const theirs = sg[k] as Guess | undefined
    if (!answered(mine)) return null
    if (isWin(mine)) {
      if (!answered(theirs)) return null
      return { winner: isWin(theirs) ? null : f, reason: 'solved', turns: k + 1 }
    }
    if (!answered(theirs)) return null
    if (isWin(theirs)) return { winner: s, reason: 'solved', turns: k + 1 }
  }
  return null
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return !!data && typeof data === 'object'
}

/** 把事件從頭重播成目前局面；不合法、不是輪到那個座位、不是這一局的事件都忽略 */
export function reduceVersus(events: readonly RoomEvent<AbEvent>[]): VersusState {
  let state = newVersus()
  for (const { seat, data } of events) {
    if (!isRecord(data) || data.round !== state.round) continue
    state = apply(state, seat, data as AbEvent)
  }
  return state
}

function apply(state: VersusState, seat: Seat, e: AbEvent): VersusState {
  const sides: [Side, Side] = [state.sides[0], state.sides[1]]
  const me = sides[seat]
  const them = sides[other(seat)]
  switch (e.type) {
    case 'commit': {
      if (me.commit !== null || typeof e.hash !== 'string' || e.hash.length > 128) return state
      sides[seat] = { ...me, commit: e.hash }
      return { ...state, sides, started: sides[0].commit !== null && sides[1].commit !== null }
    }
    case 'guess': {
      if (typeof e.code !== 'string' || !isValidCode(e.code) || !canGuess(state, seat)) return state
      if (me.guesses.some((g) => g.code === e.code)) return state
      sides[seat] = { ...me, guesses: [...me.guesses, { code: e.code, a: null, b: null }] }
      return settle({ ...state, sides })
    }
    case 'answer': {
      // 只能依序回報對方的猜測，回報過的不能改
      if (!state.started || state.result) return state
      const n = them.guesses.findIndex((g) => g.a === null)
      if (n < 0 || e.n !== n) return state
      if (!Number.isInteger(e.a) || !Number.isInteger(e.b) || !validFeedback(e.a, e.b)) return state
      const guesses = them.guesses.slice()
      guesses[n] = { ...guesses[n], a: e.a, b: e.b }
      sides[other(seat)] = { ...them, guesses }
      return settle({ ...state, sides })
    }
    case 'resign':
      if (state.result) return state
      return { ...state, result: { winner: other(seat), reason: 'resign', turns: null } }
    case 'reveal': {
      if (!state.result || me.reveal || typeof e.secret !== 'string' || typeof e.salt !== 'string') return state
      if (e.salt.length > 128) return state
      sides[seat] = { ...me, reveal: { secret: e.secret, salt: e.salt } }
      return { ...state, sides }
    }
    case 'restart':
      return state.result ? newVersus(state.round + 1) : state
    default:
      return state
  }
}

function settle(state: VersusState): VersusState {
  const result = decide(state)
  return result ? { ...state, result } : state
}

/** 這個座位猜對方的線索（只算已經有回報的），給賽後分析和電腦用 */
export function cluesOf(state: VersusState, seat: Seat): Clue[] {
  return state.sides[seat].guesses.filter(answered).map((g) => ({ guess: g.code, a: g.a!, b: g.b! }))
}

/** 對手還沒回報的第一次猜測（要由 seat 這一方回報） */
export function pendingAnswer(state: VersusState, seat: Seat): { n: number; code: string } | null {
  if (!state.started || state.result) return null
  const n = state.sides[other(seat)].guesses.findIndex((g) => g.a === null)
  return n < 0 ? null : { n, code: state.sides[other(seat)].guesses[n].code }
}

// ---- 驗證 ----

export type Check =
  /** 還沒公開（或雜湊工具還沒載入） */
  | 'pending'
  | 'ok'
  /** 公開的數字和開局的 commit 對不上 */
  | 'bad-commit'
  /** 某一次回報和公開的數字對不上 */
  | 'bad-answer'

export function commitInput(secret: string, salt: string): string {
  return `${secret}:${salt}`
}

/** 檢查 seat 這一方有沒有說謊：公開的數字要符合 commit，而且他對每一次猜測的回報都要對 */
export function verifySide(state: VersusState, seat: Seat, sha256: ((s: string) => string) | null): Check {
  const side = state.sides[seat]
  // 還沒藏好數字就結束（開局前認輸）：沒有承諾過什麼，也不可能回報過
  if (side.commit === null) return 'ok'
  if (!side.reveal || !sha256) return 'pending'
  const { secret, salt } = side.reveal
  if (!isValidCode(secret) || side.commit !== sha256(commitInput(secret, salt))) return 'bad-commit'
  for (const g of state.sides[other(seat)].guesses) {
    if (g.a === null) continue
    const real = score(g.code, secret)
    if (real.a !== g.a || real.b !== g.b) return 'bad-answer'
  }
  return 'ok'
}

export function isBad(check: Check): boolean {
  return check === 'bad-commit' || check === 'bad-answer'
}

/** 考慮驗證之後的最終結果：說謊的一方判輸（兩邊都說謊就算平手） */
export function finalResult(result: Result, checks: [Check, Check]): Result & { cheater: Seat | 'both' | null } {
  const bad = isBad
  if (bad(checks[0]) && bad(checks[1])) return { ...result, winner: null, cheater: 'both' }
  for (const seat of [0, 1] as const) {
    if (bad(checks[seat])) return { ...result, winner: other(seat), cheater: seat }
  }
  return { ...result, cheater: null }
}

/** 16 bytes 的亂數 salt；getRandomValues 在 http 也能用（crypto.subtle 不行） */
export function randomSalt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

let hasher: Promise<(s: string) => string> | null = null

/** 載入 SHA-256（hash-wasm 含 wasm，用到才下載）；回傳同步的雜湊函式，重播事件時才不用 await */
export function loadSha256(): Promise<(s: string) => string> {
  hasher ??= import('hash-wasm')
    .then(({ createSHA256 }) => createSHA256())
    .then((h) => (s: string) => h.init().update(s).digest('hex'))
    .catch((e: unknown) => {
      hasher = null
      throw e
    })
  return hasher
}
