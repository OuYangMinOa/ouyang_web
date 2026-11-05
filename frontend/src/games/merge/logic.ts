/**
 * 數字合併的規則：方塊往一個方向滑到底，碰到相同數字就合成兩倍（一步裡每個方塊只合一次），
 * 每走一步在空格冒出一個新的 2（一成機率是 4）。合出目標方塊算過關，可以繼續玩；
 * 沒有空格、也沒有相鄰的相同數字就結束。
 *
 * 方塊有固定的 id，畫面用 id 對應 DOM，位置改變時用 CSS transition 滑過去。
 */

export type Dir = 'up' | 'down' | 'left' | 'right'
export type Size = 3 | 4 | 5 | 6

export const SIZES: Size[] = [3, 4, 5, 6]

/** 每種盤面的過關目標：4×4 是經典的 2048，小盤面比較難合大數字 */
export const TARGET: Record<Size, number> = { 3: 256, 4: 2048, 5: 4096, 6: 8192 }

/** 每局可以退回幾步 */
export const UNDOS = 3

export type Tile = { id: number; value: number; r: number; c: number }

type Snapshot = { tiles: Tile[]; score: number; moves: number }

export type Game = Snapshot & {
  size: Size
  /** 下一個新方塊的 id；退回時不倒退，id 才不會撞到 */
  nextId: number
  /** 合出目標之後選了繼續玩 */
  keepPlaying: boolean
  undosLeft: number
  /** 退回用：最近幾步之前的盤面，最多留 `undosLeft` 筆 */
  history: Snapshot[]
}

/**
 * 畫面上要畫的方塊：`gone` 是被合併掉的兩塊（滑到合併的位置後被新方塊蓋住），
 * `merged` 是合出來的新方塊、`new` 是新冒出來的，兩種都等滑完才出現。
 */
export type ViewTile = Tile & { kind: 'stay' | 'new' | 'merged' | 'gone' }

export type MoveResult = { game: Game; moved: boolean; gained: number; view: ViewTile[] }

type Rng = () => number

function emptyCells(size: Size, tiles: Tile[]): [number, number][] {
  const used = new Set(tiles.map((t) => t.r * size + t.c))
  const cells: [number, number][] = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (!used.has(r * size + c)) cells.push([r, c])
  }
  return cells
}

/** 在隨機空格放一個新方塊；沒有空格回傳 null */
function spawn(size: Size, tiles: Tile[], id: number, rng: Rng): Tile | null {
  const cells = emptyCells(size, tiles)
  if (cells.length === 0) return null
  const [r, c] = cells[Math.floor(rng() * cells.length)]
  return { id, value: rng() < 0.1 ? 4 : 2, r, c }
}

export function newGame(size: Size, rng: Rng = Math.random): Game {
  const tiles: Tile[] = []
  for (let id = 1; id <= 2; id++) tiles.push(spawn(size, tiles, id, rng)!)
  return { size, tiles, score: 0, moves: 0, nextId: 3, keepPlaying: false, undosLeft: UNDOS, history: [] }
}

/** 一條一條的線，每條從要滑過去的那一邊開始排 */
function lines(size: Size, dir: Dir): [number, number][][] {
  const out: [number, number][][] = []
  for (let i = 0; i < size; i++) {
    const line: [number, number][] = []
    for (let j = 0; j < size; j++) {
      const k = dir === 'left' || dir === 'up' ? j : size - 1 - j
      line.push(dir === 'left' || dir === 'right' ? [i, k] : [k, i])
    }
    out.push(line)
  }
  return out
}

export function move(game: Game, dir: Dir, rng: Rng = Math.random): MoveResult {
  const { size } = game
  const at = new Map(game.tiles.map((t) => [t.r * size + t.c, t]))
  const tiles: Tile[] = []
  const view: ViewTile[] = []
  let nextId = game.nextId
  let gained = 0
  let moved = false

  for (const line of lines(size, dir)) {
    const row = line.map(([r, c]) => at.get(r * size + c)).filter((t) => t !== undefined)
    let slot = 0
    for (let i = 0; i < row.length; slot++) {
      const [r, c] = line[slot]
      const a = row[i]
      const b = row[i + 1]
      if (b && b.value === a.value) {
        const merged = { id: nextId++, value: a.value * 2, r, c }
        tiles.push(merged)
        view.push({ ...a, r, c, kind: 'gone' }, { ...b, r, c, kind: 'gone' }, { ...merged, kind: 'merged' })
        gained += merged.value
        moved = true
        i += 2
      } else {
        if (a.r !== r || a.c !== c) moved = true
        const tile = { ...a, r, c }
        tiles.push(tile)
        view.push({ ...tile, kind: 'stay' })
        i += 1
      }
    }
  }

  if (!moved) return { game, moved: false, gained: 0, view: game.tiles.map((t) => ({ ...t, kind: 'stay' })) }

  const fresh = spawn(size, tiles, nextId++, rng)
  if (fresh) {
    tiles.push(fresh)
    view.push({ ...fresh, kind: 'new' })
  }
  const snapshot: Snapshot = { tiles: game.tiles, score: game.score, moves: game.moves }
  return {
    game: {
      ...game,
      tiles,
      score: game.score + gained,
      moves: game.moves + 1,
      nextId,
      history: game.undosLeft > 0 ? [...game.history, snapshot].slice(-game.undosLeft) : [],
    },
    moved: true,
    gained,
    view,
  }
}

export function canUndo(game: Game): boolean {
  return game.undosLeft > 0 && game.history.length > 0
}

export function undo(game: Game): Game {
  if (!canUndo(game)) return game
  const prev = game.history[game.history.length - 1]
  return { ...game, ...prev, undosLeft: game.undosLeft - 1, history: game.history.slice(0, -1) }
}

/** 還有沒有能走的方向：有空格，或有相鄰的相同數字 */
export function canMove(game: Game): boolean {
  const { size, tiles } = game
  if (tiles.length < size * size) return true
  const grid = new Map(tiles.map((t) => [t.r * size + t.c, t.value]))
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const v = grid.get(r * size + c)
      if ((c + 1 < size && grid.get(r * size + c + 1) === v) || (r + 1 < size && grid.get((r + 1) * size + c) === v))
        return true
    }
  }
  return false
}

export function maxTile(game: Game): number {
  return game.tiles.reduce((m, t) => Math.max(m, t.value), 0)
}

/** 合出目標、還沒選繼續玩 */
export function reachedTarget(game: Game): boolean {
  return !game.keepPlaying && maxTile(game) >= TARGET[game.size]
}

// ---- 存檔檢查：localStorage 裡的東西可能是舊版或被改過，不對就當作沒有存檔 ----

const isInt = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max

function isTiles(v: unknown, size: Size): v is Tile[] {
  if (!Array.isArray(v) || v.length > size * size) return false
  const cells = new Set<number>()
  const ids = new Set<number>()
  for (const t of v as Partial<Tile>[]) {
    if (!t || !isInt(t.id, 1) || !isInt(t.r, 0, size - 1) || !isInt(t.c, 0, size - 1)) return false
    if (!isInt(t.value, 2) || (t.value & (t.value - 1)) !== 0) return false
    const cell = t.r * size + t.c
    if (cells.has(cell) || ids.has(t.id)) return false
    cells.add(cell)
    ids.add(t.id)
  }
  return true
}

export function isGame(v: unknown, size: Size): v is Game {
  const g = v as Partial<Game> | null
  if (!g || g.size !== size || !isTiles(g.tiles, size) || g.tiles.length === 0) return false
  if (!isInt(g.score) || !isInt(g.moves) || !isInt(g.undosLeft, 0, UNDOS) || typeof g.keepPlaying !== 'boolean')
    return false
  if (!isInt(g.nextId, 1) || g.tiles.some((t) => t.id >= g.nextId!)) return false
  if (!Array.isArray(g.history) || g.history.length > g.undosLeft) return false
  return g.history.every(
    (h: Partial<Snapshot>) =>
      !!h && isTiles(h.tiles, size) && h.tiles.every((t) => t.id < g.nextId!) && isInt(h.score) && isInt(h.moves),
  )
}
