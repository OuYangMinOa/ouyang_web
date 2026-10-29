// 踩地雷的純規則，不碰 DOM，方便測試

export type Level = 'beginner' | 'intermediate' | 'expert'

export const LEVELS: Record<Level, { label: string; cols: number; rows: number; mines: number }> = {
  beginner: { label: '初級', cols: 9, rows: 9, mines: 10 },
  intermediate: { label: '中級', cols: 16, rows: 16, mines: 40 },
  expert: { label: '高級', cols: 30, rows: 16, mines: 99 },
}

export type Cell = {
  mine: boolean
  /** 周圍八格的雷數 */
  adj: number
  open: boolean
  flag: boolean
}

/** ready：還沒點第一下，雷還沒埋 */
export type Status = 'ready' | 'playing' | 'won' | 'lost'

export type Game = {
  cols: number
  rows: number
  mines: number
  cells: Cell[]
  status: Status
  /** 已打開的安全格數 */
  opened: number
}

export function newGame(cols: number, rows: number, mines: number): Game {
  const cells = Array.from({ length: cols * rows }, () => ({ mine: false, adj: 0, open: false, flag: false }))
  return { cols, rows, mines, cells, status: 'ready', opened: 0 }
}

export function neighbors(i: number, cols: number, rows: number): number[] {
  const r = Math.floor(i / cols)
  const c = i % cols
  const out: number[] = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue
      const nr = r + dr
      const nc = c + dc
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push(nr * cols + nc)
    }
  }
  return out
}

export function flagCount(game: Game): number {
  return game.cells.reduce((n, c) => n + (c.flag ? 1 : 0), 0)
}

function copyCells(game: Game): Cell[] {
  return game.cells.map((c) => ({ ...c }))
}

/** 埋雷：避開第一下那格和它周圍八格，讓第一下一定打開一片 */
function layMines(cells: Cell[], game: Game, safe: number, rng: () => number) {
  const { cols, rows, mines } = game
  const zone = new Set([safe, ...neighbors(safe, cols, rows)])
  let pool = cells.map((_, i) => i).filter((i) => !zone.has(i))
  // 雷太多、放不下時（自訂大小才會發生）只保證第一下那格
  if (pool.length < mines) pool = cells.map((_, i) => i).filter((i) => i !== safe)
  const count = Math.min(mines, pool.length)
  // 部分 Fisher–Yates：只洗前 count 個
  for (let k = 0; k < count; k++) {
    const j = k + Math.floor(rng() * (pool.length - k))
    ;[pool[k], pool[j]] = [pool[j], pool[k]]
    cells[pool[k]].mine = true
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i].adj = neighbors(i, cols, rows).reduce((n, j) => n + (cells[j].mine ? 1 : 0), 0)
  }
}

/** 從 starts 開始打開，空白格往外擴散；用堆疊迭代，大棋盤也不會爆堆疊。回傳是否踩到雷 */
function flood(cells: Cell[], game: Game, starts: number[]): { opened: number; boom: boolean } {
  const stack = [...starts]
  let opened = 0
  let boom = false
  while (stack.length > 0) {
    const i = stack.pop()!
    const cell = cells[i]
    if (cell.open || cell.flag) continue
    cell.open = true
    if (cell.mine) {
      boom = true
      continue
    }
    opened++
    if (cell.adj === 0) {
      for (const j of neighbors(i, game.cols, game.rows)) if (!cells[j].open && !cells[j].flag) stack.push(j)
    }
  }
  return { opened, boom }
}

function settle(game: Game, cells: Cell[], opened: number, boom: boolean): Game {
  const total = game.opened + opened
  if (boom) return { ...game, cells, opened: total, status: 'lost' }
  if (total === game.cells.length - game.mines) {
    // 贏了就把剩下的雷都插上旗
    for (const c of cells) if (c.mine) c.flag = true
    return { ...game, cells, opened: total, status: 'won' }
  }
  return { ...game, cells, opened: total, status: 'playing' }
}

function over(game: Game): boolean {
  return game.status === 'won' || game.status === 'lost'
}

/** 挖開一格；對已打開的數字格就當作 chord */
export function reveal(game: Game, i: number, rng: () => number = Math.random): Game {
  if (over(game)) return game
  const cell = game.cells[i]
  if (cell.flag) return game
  if (cell.open) return chord(game, i)
  const cells = copyCells(game)
  if (game.status === 'ready') layMines(cells, game, i, rng)
  const { opened, boom } = flood(cells, game, [i])
  return settle(game, cells, opened, boom)
}

/** 數字格周圍的旗數等於數字時，一次打開其餘未插旗的鄰格 */
export function chord(game: Game, i: number): Game {
  if (game.status !== 'playing') return game
  const cell = game.cells[i]
  if (!cell.open || cell.adj === 0) return game
  const around = neighbors(i, game.cols, game.rows)
  const flags = around.filter((j) => game.cells[j].flag).length
  if (flags !== cell.adj) return game
  const targets = around.filter((j) => !game.cells[j].open && !game.cells[j].flag)
  if (targets.length === 0) return game
  const cells = copyCells(game)
  const { opened, boom } = flood(cells, game, targets)
  return settle(game, cells, opened, boom)
}

export function toggleFlag(game: Game, i: number): Game {
  if (over(game) || game.cells[i].open) return game
  const cells = game.cells.slice()
  cells[i] = { ...cells[i], flag: !cells[i].flag }
  return { ...game, cells }
}
