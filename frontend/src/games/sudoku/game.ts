// 玩家操作（填數字、筆記、擦除、提示）的純函式，回傳新的 Game，不改舊的
import { PEERS, boxOf, colOf, rowOf, type Difficulty, type Grid } from './logic'

export type Game = {
  difficulty: Difficulty
  /** 題目（給定數字），0 是空格 */
  puzzle: Grid
  solution: Grid
  /** 目前盤面（含給定數字） */
  values: Grid
  /** 每格筆記，位元 1..9 */
  notes: number[]
  elapsed: number
  mistakes: number
  hints: number
  done: boolean
}

export const DIFFICULTY_NAME: Record<Difficulty, string> = {
  easy: '簡單',
  medium: '普通',
  hard: '困難',
  expert: '專家',
}

export function createGame(difficulty: Difficulty, puzzle: Grid, solution: Grid): Game {
  return {
    difficulty,
    puzzle,
    solution,
    values: puzzle.slice(),
    notes: Array(81).fill(0),
    elapsed: 0,
    mistakes: 0,
    hints: 0,
    done: false,
  }
}

/** localStorage 讀回來的資料可能是舊版或壞掉的，形狀不對就丟掉 */
export function isGame(x: unknown): x is Game {
  const g = x as Game
  return (
    !!g &&
    typeof g === 'object' &&
    ['easy', 'medium', 'hard', 'expert'].includes(g.difficulty) &&
    [g.puzzle, g.solution, g.values, g.notes].every((a) => Array.isArray(a) && a.length === 81) &&
    typeof g.elapsed === 'number'
  )
}

export const isGiven = (g: Game, i: number) => g.puzzle[i] !== 0

function finish(g: Game): Game {
  return { ...g, done: g.values.every((v, i) => v === g.solution[i]) }
}

/** 填入 d：清掉這格的筆記，以及同列／行／宮裡的 d 筆記；check 開著時填錯算一次錯誤 */
export function place(g: Game, i: number, d: number, check: boolean): Game {
  if (g.done || isGiven(g, i)) return g
  const values = g.values.slice()
  const notes = g.notes.slice()
  if (values[i] === d) {
    // 再按一次同樣的數字等於清掉
    values[i] = 0
    return { ...g, values }
  }
  values[i] = d
  notes[i] = 0
  for (const p of PEERS[i]) notes[p] &= ~(1 << d)
  const wrong = d !== g.solution[i]
  return finish({ ...g, values, notes, mistakes: g.mistakes + (wrong && check ? 1 : 0) })
}

export function toggleNote(g: Game, i: number, d: number): Game {
  if (g.done || isGiven(g, i) || g.values[i]) return g
  const notes = g.notes.slice()
  notes[i] ^= 1 << d
  return { ...g, notes }
}

export function erase(g: Game, i: number): Game {
  if (g.done || isGiven(g, i)) return g
  if (g.values[i]) {
    const values = g.values.slice()
    values[i] = 0
    return { ...g, values }
  }
  if (g.notes[i]) {
    const notes = g.notes.slice()
    notes[i] = 0
    return { ...g, notes }
  }
  return g
}

/**
 * 提示要填哪一格：選取的格子是空的或填錯就填它；
 * 否則挑「依目前正確的數字，候選最少」的格子，通常就是下一步該推的地方。
 */
export function hintCell(g: Game, selected: number | null): number {
  const open = (i: number) => g.values[i] !== g.solution[i]
  if (selected !== null && open(selected)) return selected
  let best = -1
  let bestCount = 10
  for (let i = 0; i < 81; i++) {
    if (!open(i)) continue
    let used = 0
    for (const p of PEERS[i]) if (g.values[p] && g.values[p] === g.solution[p]) used |= 1 << g.values[p]
    let n = 0
    for (let d = 1; d <= 9; d++) if (!(used & (1 << d))) n++
    if (n < bestCount) {
      best = i
      bestCount = n
    }
  }
  return best
}

export function applyHint(g: Game, i: number): Game {
  if (g.done || i < 0) return g
  const next = place({ ...g, values: g.values.map((v, j) => (j === i ? 0 : v)) }, i, g.solution[i], false)
  return { ...next, hints: g.hints + 1 }
}

/** 每個數字已經填了幾個（含給定） */
export function digitCounts(values: Grid): number[] {
  const counts = Array(10).fill(0)
  for (const v of values) counts[v]++
  return counts
}

export function sameHouse(a: number, b: number): boolean {
  return rowOf(a) === rowOf(b) || colOf(a) === colOf(b) || boxOf(a) === boxOf(b)
}

/** 方向鍵移動選取，到邊緣就繞回另一邊 */
export function moveSelection(i: number, key: string): number {
  const r = rowOf(i)
  const c = colOf(i)
  if (key === 'ArrowUp') return ((r + 8) % 9) * 9 + c
  if (key === 'ArrowDown') return ((r + 1) % 9) * 9 + c
  if (key === 'ArrowLeft') return r * 9 + ((c + 8) % 9)
  return r * 9 + ((c + 1) % 9)
}
