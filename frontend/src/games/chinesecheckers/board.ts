/**
 * 跳棋的棋盤形狀和走法，和 backend/src/chinesecheckers.rs 一模一樣（格子編號、方向、長跳）。
 * 前端用來標出能走到的格子、算出連跳的路徑；送出去之後伺服器還會再驗證一次。
 *
 * 座標用立方座標 (x, y, z)，x + y + z = 0；星形是「三個都 ≥ -4」和「三個都 ≤ 4」兩個大三角形的聯集。
 * 格子編號：z 從 -8 到 8 一列一列、每列 x 從小到大，0 是最上面的尖端、60 是正中央、120 是最下面的尖端。
 */

export const CELLS = 121
export const PIECES = 10

export type Coord = readonly [number, number, number]
/** 伺服器送的盤面：121 個字，`.` 是空格，數字是座位 */
export type BoardText = string

/** 六個方向（立方座標的差） */
const DIRS: Coord[] = [
  [1, -1, 0],
  [1, 0, -1],
  [0, 1, -1],
  [-1, 1, 0],
  [-1, 0, 1],
  [0, -1, 1],
]

/** 每個角的尖端。沒有旋轉時照順時針：0 右上、1 右下、2 下、3 左下、4 左上、5 上；k 的對面是 k + 3 */
const TIPS: Coord[] = [
  [8, -4, -4],
  [4, -8, 4],
  [-4, -4, 8],
  [-8, 4, 4],
  [-4, 8, -4],
  [4, 4, -8],
]

function inStar([x, y, z]: Coord): boolean {
  return (x >= -4 && y >= -4 && z >= -4) || (x <= 4 && y <= 4 && z <= 4)
}

function cornerOf([x, y, z]: Coord): number | null {
  if (x >= 5) return 0
  if (y <= -5) return 1
  if (z >= 5) return 2
  if (x <= -5) return 3
  if (y >= 5) return 4
  if (z <= -5) return 5
  return null
}

const slot = ([x, , z]: Coord) => (z + 8) * 17 + (x + 8)

export const COORDS: Coord[] = []
const LOOKUP = new Array<number>(17 * 17).fill(-1)
for (let z = -8; z <= 8; z++) {
  for (let x = -8; x <= 8; x++) {
    const c: Coord = [x, -x - z, z]
    if (inStar(c)) {
      LOOKUP[slot(c)] = COORDS.length
      COORDS.push(c)
    }
  }
}

/** 每個角的 10 格 */
export const CORNERS: number[][] = [0, 1, 2, 3, 4, 5].map((k) =>
  COORDS.flatMap((c, i) => (cornerOf(c) === k ? [i] : [])),
)

export const target = (corner: number) => (corner + 3) % 6

function at(c: Coord): number | null {
  if (c.some((v) => Math.abs(v) > 8)) return null
  const i = LOOKUP[slot(c)]
  return i < 0 ? null : i
}

/** 從 `cell` 往方向 `d` 走 `k` 格 */
function step(cell: number, d: number, k: number): number | null {
  const c = COORDS[cell]
  const v = DIRS[d]
  return at([c[0] + v[0] * k, c[1] + v[1] * k, c[2] + v[2] * k])
}

/** 這一手的棋從 `origin` 出發（那格當作已經空了），現在停在 `from`，跳一次能落在哪些格子 */
function hopsFrom(board: BoardText, origin: number, from: number, long: boolean): number[] {
  const occupied = (c: number) => c !== origin && board[c] !== '.'
  const out: number[] = []
  for (let d = 0; d < DIRS.length; d++) {
    // 往這個方向找第一顆棋，一般跳法只看相鄰那格
    let k = 1
    let over: number | null = null
    for (;;) {
      const c = step(from, d, k)
      if (c === null) break
      if (occupied(c)) {
        over = k
        break
      }
      if (!long) break
      k++
    }
    if (over === null) continue
    // 棋後面要有一樣多的空格，再落在下一格
    let clear = true
    for (let j = over + 1; j < 2 * over && clear; j++) {
      const c = step(from, d, j)
      clear = c !== null && !occupied(c)
    }
    const land = clear ? step(from, d, 2 * over) : null
    if (land !== null && !occupied(land)) out.push(land)
  }
  return out
}

/** `from` 上的棋這一手能到的格子 → 路徑（含起點），連跳的用跳最少次的路徑 */
export function destinations(board: BoardText, from: number, long: boolean): Map<number, number[]> {
  const paths = new Map<number, number[]>()
  for (let d = 0; d < DIRS.length; d++) {
    const n = step(from, d, 1)
    if (n !== null && board[n] === '.') paths.set(n, [from, n])
  }
  // 連跳：盤面在這一手裡不會變（只有起點空出來），BFS 找到的就是不重複經過的路徑
  const parent = new Map<number, number>([[from, from]])
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const land of hopsFrom(board, from, cur, long)) {
      if (parent.has(land)) continue
      parent.set(land, cur)
      queue.push(land)
      const path = [land]
      for (let c = land; c !== from; ) {
        c = parent.get(c)!
        path.push(c)
      }
      paths.set(land, path.reverse())
    }
  }
  return paths
}

/** 兩格之間要走幾步（立方座標的距離），相鄰是 1 */
export function distance(a: number, b: number): number {
  const p = COORDS[a]
  const q = COORDS[b]
  return Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]))
}

const SQ3 = Math.sqrt(3) / 2

/** 沒有旋轉時的位置（相鄰兩格距離 1，正中央是 0, 0，y 往下） */
const BASE = COORDS.map(([x, , z]) => ({ x: x + z / 2, y: z * SQ3 }))

export type Point = { x: number; y: number }

/** 自己的角轉到最下面（沒有旋轉時角 2 在最下面），要順時針轉幾個 60° */
export const turnsFor = (corner: number) => (2 - corner + 6) % 6

/** 每一格在畫面上的位置：整張棋盤順時針轉 `turns` 個 60°（星形轉 60° 還是一樣的形狀，外框不用變） */
export function layout(turns: number, scale: number): Point[] {
  const angle = (turns * Math.PI) / 3
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return BASE.map(({ x, y }) => ({ x: (x * cos - y * sin) * scale, y: (x * sin + y * cos) * scale }))
}

/** 六邊形的六個頂點，照順序夾在角 k 和 k + 1 中間 */
const HEX: Coord[] = [
  [4, -4, 0],
  [0, -4, 4],
  [-4, 0, 4],
  [-4, 4, 0],
  [0, 4, -4],
  [4, 0, -4],
]

/**
 * 星形最外圈那些洞連起來的 12 邊形（尖端和凹進去的角輪流）。
 * 畫的時候加一圈粗的圓角邊（stroke-linejoin: round），就是往外推、尖端圓圓的棋盤。
 */
export function starOutline(points: Point[]): Point[] {
  return [0, 1, 2, 3, 4, 5].flatMap((k) => [points[at(TIPS[k])!], points[at(HEX[k])!]])
}

/** 一個角的三個頂點（尖端和底邊兩端的洞） */
export function cornerTriangle(points: Point[], corner: number): Point[] {
  const cells = CORNERS[corner].map((i) => points[i])
  const cx = cells.reduce((s, p) => s + p.x, 0) / cells.length
  const cy = cells.reduce((s, p) => s + p.y, 0) / cells.length
  // 離中心最遠的三格就是三個頂點
  return [...cells].sort((a, b) => Math.hypot(b.x - cx, b.y - cy) - Math.hypot(a.x - cx, a.y - cy)).slice(0, 3)
}

/** 凸多邊形每邊往外推 `margin`、轉角是半徑 `margin` 的圓弧，回傳 SVG path（畫虛線框用，和粗圓角邊的外緣一樣） */
export function roundedOutline(vertices: Point[], margin: number): string {
  const n = vertices.length
  // 螢幕座標 y 往下：面積是正的表示順時針，圓弧也要順時針畫
  const area = vertices.reduce((s, p, i) => s + p.x * vertices[(i + 1) % n].y - vertices[(i + 1) % n].x * p.y, 0)
  const sweep = area > 0 ? 1 : 0
  const sign = area > 0 ? 1 : -1
  const pt = (x: number, y: number) => `${x.toFixed(2)} ${y.toFixed(2)}`
  const arc = `A${margin.toFixed(2)} ${margin.toFixed(2)} 0 0 ${sweep} `
  let first = ''
  let d = ''
  for (let i = 0; i < n; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % n]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    // 這條邊往外的法向量
    const nx = (sign * (b.y - a.y)) / len
    const ny = (sign * (a.x - b.x)) / len
    const start = pt(a.x + nx * margin, a.y + ny * margin)
    if (i === 0) first = start
    d += `${i === 0 ? 'M' : arc}${start}L${pt(b.x + nx * margin, b.y + ny * margin)}`
  }
  // 最後繞過第一個頂點接回起點
  return `${d}${arc}${first}Z`
}

export const polygon = (points: Point[]) => points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
