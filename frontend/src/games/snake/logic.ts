// 貪食蛇的純規則，不碰 DOM，方便測試

export type Point = { x: number; y: number }
export type Dir = 'up' | 'down' | 'left' | 'right'
export type Speed = 'slow' | 'normal' | 'fast'
export type AppleLevel = 'easy' | 'normal' | 'hard'
/** normal：吃到後繼續從頭前進；reverse：吃到後頭尾交換 */
export type Mode = 'normal' | 'reverse'

export const SIZE = 20

/** 每走一格的毫秒數 */
export const TICK_MS: Record<Speed, number> = { slow: 170, normal: 115, fast: 75 }

/** 蘋果多久換一次位置；null 表示不動 */
export const APPLE_MOVE_MS: Record<AppleLevel, number | null> = { easy: null, normal: 5000, hard: 2000 }

/** 蘋果要跑之前的閃爍警告時間 */
export function appleWarnMs(period: number): number {
  return Math.min(1000, period * 0.4)
}

export const DELTA: Record<Dir, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

export const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

/** 同一拍內最多排幾個轉向 */
const MAX_QUEUE = 3

export type Game = {
  size: number
  /** [0] 是頭 */
  snake: Point[]
  dir: Dir
  /** 還沒套用的轉向；每走一格取出一個 */
  queue: Dir[]
  /** null：棋盤已經被蛇塞滿 */
  apple: Point | null
  /** 蘋果在目前位置待了多久（遊戲時間，暫停時不算） */
  appleAge: number
  score: number
  over: 'dead' | 'won' | null
}

export type StepResult = { game: Game; ate: boolean; reversed: boolean }

export function same(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y
}

/** 從 a 走到相鄰的 b 是哪個方向 */
export function dirBetween(a: Point, b: Point): Dir {
  if (b.x > a.x) return 'right'
  if (b.x < a.x) return 'left'
  return b.y > a.y ? 'down' : 'up'
}

/** 隨機挑一個不在蛇身上的空格；`avoid` 是額外要避開的格子（例如蘋果原本的位置） */
export function randomFree(size: number, snake: Point[], rng: () => number, avoid?: Point | null): Point | null {
  const taken = new Set(snake.map((p) => p.y * size + p.x))
  const free: number[] = []
  for (let i = 0; i < size * size; i++) if (!taken.has(i)) free.push(i)
  let pool = free
  if (avoid) {
    const avoidIdx = avoid.y * size + avoid.x
    const filtered = free.filter((i) => i !== avoidIdx)
    // 只剩那一格就只好留在原地
    if (filtered.length > 0) pool = filtered
  }
  if (pool.length === 0) return null
  const i = pool[Math.floor(rng() * pool.length)]
  return { x: i % size, y: Math.floor(i / size) }
}

export function newGame(size = SIZE, rng: () => number = Math.random): Game {
  const y = Math.floor(size / 2)
  const x = Math.floor(size / 2) - 3
  const snake = [
    { x: x + 2, y },
    { x: x + 1, y },
    { x, y },
  ]
  return { size, snake, dir: 'right', queue: [], apple: randomFree(size, snake, rng), appleAge: 0, score: 0, over: null }
}

/**
 * 排入一個轉向。跟「最後排入的方向」（沒有就是目前方向）相同或相反就忽略，
 * 這樣一拍內快速按「上、左」不會變成直接 180 度回頭撞死。
 */
export function queueTurn(game: Game, d: Dir): Game {
  if (game.over) return game
  const last = game.queue.at(-1) ?? game.dir
  if (d === last || d === OPPOSITE[last] || game.queue.length >= MAX_QUEUE) return game
  return { ...game, queue: [...game.queue, d] }
}

/** 走一格 */
export function step(game: Game, mode: Mode, rng: () => number = Math.random): StepResult {
  if (game.over) return { game, ate: false, reversed: false }

  let dir = game.dir
  const queue = game.queue.slice(1)
  const turn = game.queue[0]
  if (turn && turn !== OPPOSITE[dir]) dir = turn

  const head = game.snake[0]
  const next = { x: head.x + DELTA[dir].x, y: head.y + DELTA[dir].y }
  if (next.x < 0 || next.y < 0 || next.x >= game.size || next.y >= game.size) {
    return { game: { ...game, dir, queue: [], over: 'dead' }, ate: false, reversed: false }
  }

  const ate = game.apple !== null && same(next, game.apple)
  // 沒吃到時尾巴會同時離開，所以可以走進尾巴原本的格子
  const body = ate ? game.snake : game.snake.slice(0, -1)
  if (body.some((p) => same(p, next))) {
    return { game: { ...game, dir, queue: [], over: 'dead' }, ate: false, reversed: false }
  }

  // 成長：吃到時不移除尾巴，蛇直接多一格。必須先長完再反轉，
  // 否則（例如複製尾巴那一格當作成長）反轉後新頭和第二節重疊，方向算不出來而假死。
  let snake = [next, ...body]
  if (!ate) return { game: { ...game, snake, dir, queue }, ate: false, reversed: false }

  let reversed = false
  let nextQueue = queue
  if (mode === 'reverse') {
    snake = snake.reverse()
    // 新方向：原尾端「離開身體」的方向
    dir = dirBetween(snake[1], snake[0])
    // 之前排的轉向是針對舊的頭，反轉後就不算數
    nextQueue = []
    reversed = true
  }

  const apple = randomFree(game.size, snake, rng)
  return {
    game: {
      ...game,
      snake,
      dir,
      queue: nextQueue,
      apple,
      appleAge: 0,
      score: game.score + 1,
      over: apple ? null : 'won',
    },
    ate: true,
    reversed,
  }
}

/** 累積蘋果的時間，到了就換到別的空格 */
export function ageApple(game: Game, dt: number, period: number | null, rng: () => number = Math.random): Game {
  if (game.over || !game.apple || period === null) return game
  const age = game.appleAge + dt
  if (age < period) return { ...game, appleAge: age }
  return { ...game, apple: randomFree(game.size, game.snake, rng, game.apple) ?? game.apple, appleAge: 0 }
}
