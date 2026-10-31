// 數獨：解題器、難度分級、題目產生（純邏輯，不含 React，方便測試與放進 Worker）

/** 81 格，由左到右、由上到下；0 表示空格 */
export type Grid = number[]

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert'

/**
 * 解題技巧等級：
 * 1 = 只需 naked / hidden single
 * 2 = 再加上 locked candidates（pointing / claiming）、naked / hidden pair
 * 3 = 再加上 naked / hidden triple、X-Wing、XY-Wing
 * 4 = 以上都解不開（需要更進階的技巧或試誤）
 */
export type Level = 1 | 2 | 3 | 4

export const LEVEL_OF: Record<Difficulty, Level> = { easy: 1, medium: 2, hard: 3, expert: 4 }

export const rowOf = (i: number) => Math.floor(i / 9)
export const colOf = (i: number) => i % 9
export const boxOf = (i: number) => Math.floor(i / 27) * 3 + Math.floor((i % 9) / 3)

/** 27 個單位：9 列、9 行、9 宮 */
export const UNITS: number[][] = []
for (let r = 0; r < 9; r++) UNITS.push(Array.from({ length: 9 }, (_, c) => r * 9 + c))
for (let c = 0; c < 9; c++) UNITS.push(Array.from({ length: 9 }, (_, r) => r * 9 + c))
for (let b = 0; b < 9; b++)
  UNITS.push(
    Array.from({ length: 9 }, (_, k) => (Math.floor(b / 3) * 3 + Math.floor(k / 3)) * 9 + (b % 3) * 3 + (k % 3)),
  )

/** 每格的 20 個同列／行／宮的格子 */
export const PEERS: number[][] = Array.from({ length: 81 }, (_, i) => {
  const set = new Set<number>()
  for (const u of [UNITS[rowOf(i)], UNITS[9 + colOf(i)], UNITS[18 + boxOf(i)]])
    for (const j of u) if (j !== i) set.add(j)
  return [...set]
})

const ALL = 0x3fe // 位元 1..9
const bit = (d: number) => 1 << d

const POP = new Uint8Array(1024)
for (let m = 1; m < 1024; m++) POP[m] = POP[m >> 1] + (m & 1)
export const popcount = (m: number) => POP[m]

function digitsOf(mask: number): number[] {
  const out: number[] = []
  for (let d = 1; d <= 9; d++) if (mask & bit(d)) out.push(d)
  return out
}

export function shuffle<T>(arr: T[], random: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// ---- 暴力解（判斷唯一解、產生完整盤面） ----

/**
 * 回溯 + 每次挑候選最少的格子。找到 limit 個解就停。
 * random 有給時候選數字的順序隨機，用來產生隨機完整解。
 */
export function solve(grid: Grid, limit = 2, random?: () => number): { count: number; solution: Grid | null } {
  const cells = grid.slice()
  const rows = new Uint16Array(9)
  const cols = new Uint16Array(9)
  const boxes = new Uint16Array(9)
  for (let i = 0; i < 81; i++) {
    const v = cells[i]
    if (!v) continue
    const m = bit(v)
    const r = rowOf(i)
    const c = colOf(i)
    const b = boxOf(i)
    // 題目本身就有衝突 → 無解
    if (rows[r] & m || cols[c] & m || boxes[b] & m) return { count: 0, solution: null }
    rows[r] |= m
    cols[c] |= m
    boxes[b] |= m
  }
  let count = 0
  let solution: Grid | null = null

  function search(): boolean {
    let best = -1
    let bestMask = 0
    let bestCount = 10
    for (let i = 0; i < 81; i++) {
      if (cells[i]) continue
      const m = ALL & ~(rows[rowOf(i)] | cols[colOf(i)] | boxes[boxOf(i)])
      const n = POP[m]
      if (n < bestCount) {
        best = i
        bestMask = m
        bestCount = n
        if (n <= 1) break
      }
    }
    if (best < 0) {
      count++
      if (!solution) solution = cells.slice()
      return count >= limit
    }
    if (bestCount === 0) return false
    const r = rowOf(best)
    const c = colOf(best)
    const b = boxOf(best)
    const ds = digitsOf(bestMask)
    if (random) shuffle(ds, random)
    for (const d of ds) {
      const m = bit(d)
      cells[best] = d
      rows[r] |= m
      cols[c] |= m
      boxes[b] |= m
      const stop = search()
      rows[r] &= ~m
      cols[c] &= ~m
      boxes[b] &= ~m
      cells[best] = 0
      if (stop) return true
    }
    return false
  }

  search()
  return { count, solution }
}

export function countSolutions(grid: Grid, limit = 2): number {
  return solve(grid, limit).count
}

export function randomSolution(random: () => number = Math.random): Grid {
  return solve(Array(81).fill(0), 1, random).solution!
}

// ---- 邏輯解（難度分級） ----

class Logic {
  values: number[]
  cand: number[]
  level: Level = 1

  constructor(grid: Grid) {
    this.values = grid.slice()
    this.cand = Array(81).fill(0)
    for (let i = 0; i < 81; i++) {
      if (this.values[i]) continue
      let m = ALL
      for (const p of PEERS[i]) if (this.values[p]) m &= ~bit(this.values[p])
      this.cand[i] = m
    }
  }

  place(i: number, d: number) {
    this.values[i] = d
    this.cand[i] = 0
    for (const p of PEERS[i]) this.cand[p] &= ~bit(d)
  }

  /** 從 cells 裡（排除 keep）消去 mask；有消到就回傳 true */
  eliminate(cells: number[], mask: number, keep: (i: number) => boolean): boolean {
    let changed = false
    for (const i of cells) {
      if (this.values[i] || keep(i) || !(this.cand[i] & mask)) continue
      this.cand[i] &= ~mask
      changed = true
    }
    return changed
  }

  singles(): boolean {
    for (let i = 0; i < 81; i++) {
      if (!this.values[i] && POP[this.cand[i]] === 1) {
        this.place(i, 31 - Math.clz32(this.cand[i]))
        return true
      }
    }
    for (const unit of UNITS) {
      for (let d = 1; d <= 9; d++) {
        let pos = -1
        let n = 0
        for (const i of unit) {
          if (this.values[i] === d) {
            n = -1
            break
          }
          if (this.cand[i] & bit(d)) {
            pos = i
            n++
          }
        }
        if (n === 1) {
          this.place(pos, d)
          return true
        }
      }
    }
    return false
  }

  /** pointing（宮 → 列／行）與 claiming（列／行 → 宮） */
  lockedCandidates(): boolean {
    for (let u = 0; u < 27; u++) {
      for (let d = 1; d <= 9; d++) {
        const pos = UNITS[u].filter((i) => !this.values[i] && this.cand[i] & bit(d))
        if (pos.length < 2) continue
        const targets: number[] = []
        if (u >= 18) {
          if (pos.every((i) => rowOf(i) === rowOf(pos[0]))) targets.push(rowOf(pos[0]))
          if (pos.every((i) => colOf(i) === colOf(pos[0]))) targets.push(9 + colOf(pos[0]))
        } else if (pos.every((i) => boxOf(i) === boxOf(pos[0]))) targets.push(18 + boxOf(pos[0]))
        for (const t of targets) if (this.eliminate(UNITS[t], bit(d), (i) => pos.includes(i))) return true
      }
    }
    return false
  }

  /** naked subset：k 格的候選聯集剛好 k 個數字 → 單位內其他格消去這些數字 */
  nakedSubset(k: number): boolean {
    for (const unit of UNITS) {
      const open = unit.filter((i) => !this.values[i] && POP[this.cand[i]] <= k)
      for (const combo of combinations(open, k)) {
        let m = 0
        for (const i of combo) m |= this.cand[i]
        if (POP[m] === k && this.eliminate(unit, m, (i) => combo.includes(i))) return true
      }
    }
    return false
  }

  /** hidden subset：k 個數字在單位內只出現在同樣 k 格 → 那 k 格消去其他候選 */
  hiddenSubset(k: number): boolean {
    for (const unit of UNITS) {
      const missing = digitsOf(ALL & ~unit.reduce((m, i) => m | (this.values[i] ? bit(this.values[i]) : 0), 0))
      for (const ds of combinations(missing, k)) {
        const dm = ds.reduce((m, d) => m | bit(d), 0)
        const cells = unit.filter((i) => !this.values[i] && this.cand[i] & dm)
        if (cells.length !== k) continue
        // 每個數字都要真的出現在這些格子裡，否則是矛盾盤面，交給別的技巧
        if (!ds.every((d) => cells.some((i) => this.cand[i] & bit(d)))) continue
        let changed = false
        for (const i of cells) {
          if (this.cand[i] & ~dm) {
            this.cand[i] &= dm
            changed = true
          }
        }
        if (changed) return true
      }
    }
    return false
  }

  xWing(): boolean {
    for (let d = 1; d <= 9; d++) {
      for (const byRow of [true, false]) {
        const lines: { line: number; pos: number[] }[] = []
        for (let l = 0; l < 9; l++) {
          const unit = UNITS[byRow ? l : 9 + l]
          const pos = unit
            .filter((i) => !this.values[i] && this.cand[i] & bit(d))
            .map((i) => (byRow ? colOf(i) : rowOf(i)))
          if (pos.length === 2) lines.push({ line: l, pos })
        }
        for (let x = 0; x < lines.length; x++)
          for (let y = x + 1; y < lines.length; y++) {
            const a = lines[x]
            const b = lines[y]
            if (a.pos[0] !== b.pos[0] || a.pos[1] !== b.pos[1]) continue
            for (const p of a.pos) {
              const cross = UNITS[byRow ? 9 + p : p]
              const keep = (i: number) =>
                (byRow ? rowOf(i) : colOf(i)) === a.line || (byRow ? rowOf(i) : colOf(i)) === b.line
              if (this.eliminate(cross, bit(d), keep)) return true
            }
          }
      }
    }
    return false
  }

  xyWing(): boolean {
    const bivalue = (i: number) => !this.values[i] && POP[this.cand[i]] === 2
    for (let pivot = 0; pivot < 81; pivot++) {
      if (!bivalue(pivot)) continue
      const pm = this.cand[pivot]
      const wings = PEERS[pivot].filter((p) => bivalue(p) && POP[this.cand[p] & pm] === 1)
      for (let x = 0; x < wings.length; x++)
        for (let y = x + 1; y < wings.length; y++) {
          const a = this.cand[wings[x]]
          const b = this.cand[wings[y]]
          const z = a & b & ~pm
          // 兩翼各分到 pivot 的不同數字，且共享第三個數字 z
          if (POP[z] !== 1 || (a & pm) === (b & pm)) continue
          const seen = PEERS[wings[x]].filter((i) => PEERS[wings[y]].includes(i))
          if (this.eliminate(seen, z, (i) => i === pivot)) return true
        }
    }
    return false
  }

  run(): { level: Level; solved: boolean } {
    for (;;) {
      if (this.singles()) continue
      if (this.values.every((v) => v)) return { level: this.level, solved: true }
      if (this.lockedCandidates() || this.nakedSubset(2) || this.hiddenSubset(2)) {
        this.level = Math.max(this.level, 2) as Level
        continue
      }
      if (this.nakedSubset(3) || this.hiddenSubset(3) || this.xWing() || this.xyWing()) {
        this.level = 3
        continue
      }
      return { level: 4, solved: false }
    }
  }
}

function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = []
  const pick: T[] = []
  function rec(start: number) {
    if (pick.length === k) {
      out.push(pick.slice())
      return
    }
    for (let i = start; i <= arr.length - (k - pick.length); i++) {
      pick.push(arr[i])
      rec(i + 1)
      pick.pop()
    }
  }
  rec(0)
  return out
}

/** 用人類技巧解題，回傳需要的最高技巧等級（解不開是 4） */
export function grade(puzzle: Grid): Level {
  return new Logic(puzzle).run().level
}

/** 測試用：邏輯解停下來時的盤面與候選數 */
export function logicState(puzzle: Grid) {
  const l = new Logic(puzzle)
  const r = l.run()
  return { ...r, values: l.values, cand: l.cand }
}

// ---- 產生題目 ----

/** 各難度的目標提示數範圍（含） */
const CLUES: Record<Difficulty, [number, number]> = {
  easy: [38, 42],
  medium: [30, 34],
  hard: [25, 29],
  expert: [17, 27],
}

export type Generated = { puzzle: Grid; solution: Grid; level: Level; clues: number }

/**
 * 隨機完整解 → 以中心對稱成對挖洞，每挖一次確認仍是唯一解、且不超過目標技巧等級。
 * 結果等級不對或提示太多就重來；超過時間預算就交出目前最接近的。
 */
export function generate(difficulty: Difficulty, random: () => number = Math.random, budgetMs = 800): Generated {
  const target = LEVEL_OF[difficulty]
  const [lo, hi] = CLUES[difficulty]
  const start = Date.now()
  let best: Generated | null = null

  for (;;) {
    const solution = randomSolution(random)
    const puzzle = solution.slice()
    const goal = lo + Math.floor(random() * (hi - lo + 1))
    let clues = 81
    const order = shuffle(
      Array.from({ length: 41 }, (_, i) => i),
      random,
    )
    for (const i of order) {
      if (clues <= goal) break
      const pair = i === 40 ? [40] : [i, 80 - i]
      if (clues - pair.length < lo) continue
      for (const j of pair) puzzle[j] = 0
      const ok = countSolutions(puzzle) === 1 && (target === 4 || grade(puzzle) <= target)
      if (ok) clues -= pair.length
      else for (const j of pair) puzzle[j] = solution[j]
    }
    const level = grade(puzzle)
    const result = { puzzle, solution, level, clues }
    if (level === target && clues <= hi) return result
    // 備案：等級最接近的優先，同等級取提示少的
    const off = (r: Generated) => Math.abs(r.level - target) * 100 + r.clues
    if (!best || off(result) < off(best)) best = result
    if (Date.now() - start > budgetMs) return best
  }
}

// ---- 盤面工具（畫面用） ----

/** 某格填 d 會不會跟同列／行／宮已有的數字衝突 */
export function conflicts(values: Grid, i: number): boolean {
  const v = values[i]
  return v !== 0 && PEERS[i].some((p) => values[p] === v)
}
