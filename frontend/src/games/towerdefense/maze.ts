import { tileAt, type MapSpec } from './online'

/**
 * 怪物會怎麼走：和伺服器（`backend/src/towerdefense_field.rs`）一模一樣的算法，搬一份到前端，
 * 蓋塔之前就能先算出「蓋在這裡路線會變成怎樣、變長幾格」，不用等伺服器回來。
 * 真正的路線還是以伺服器送來的為準，這裡只拿來預覽。
 *
 * 八個方向都能走（直走 10、斜走 14），但不能從兩座斜對角的塔中間鑽過去；
 * 走到一格的中心時挑旁邊離出口最近的那一格，一樣近就照原本的方向直走。
 */

const ORTH = 10
const DIAG = 14
const UNREACHABLE = 0xffffffff
/** 八個方向，前四個是上下左右（順序和伺服器一樣，一樣近的時候靠它決定走哪邊） */
const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
]
const NO_DIR = 8

/** 從 `c` 往第 `i` 個方向走得到的那一格；出界、被擋住、斜走會擦到角都是 -1 */
function neighbor(w: number, h: number, blocked: Uint8Array, c: number, i: number): number {
  const [dx, dy] = DIRS[i]
  const cx = c % w
  const cy = (c - cx) / w
  const nx = cx + dx
  const ny = cy + dy
  if (nx < 0 || ny < 0 || nx >= w || ny >= h) return -1
  const n = ny * w + nx
  if (blocked[n]) return -1
  if (i >= 4 && (blocked[cy * w + nx] || blocked[ny * w + cx])) return -1
  return n
}

/** 每一格到出口還有多遠（走不到的是 `UNREACHABLE`） */
function distances(w: number, h: number, blocked: Uint8Array, exit: number): Uint32Array {
  const dist = new Uint32Array(w * h).fill(UNREACHABLE)
  // 小小的二元堆積：[距離, 格子]
  const heap: number[] = []
  const push = (d: number, c: number) => {
    let i = heap.length
    heap.push(d, c)
    while (i > 0) {
      const parent = ((i / 2 - 1) >> 1) * 2
      if (heap[parent] <= heap[i]) break
      ;[heap[parent], heap[parent + 1], heap[i], heap[i + 1]] = [heap[i], heap[i + 1], heap[parent], heap[parent + 1]]
      i = parent
    }
  }
  const pop = (): [number, number] => {
    const top: [number, number] = [heap[0], heap[1]]
    const c = heap.pop()!
    const d = heap.pop()!
    if (heap.length) {
      heap[0] = d
      heap[1] = c
      let i = 0
      for (;;) {
        const left = i * 2 + 2
        const right = left + 2
        let least = i
        if (left < heap.length && heap[left] < heap[least]) least = left
        if (right < heap.length && heap[right] < heap[least]) least = right
        if (least === i) break
        ;[heap[least], heap[least + 1], heap[i], heap[i + 1]] = [heap[i], heap[i + 1], heap[least], heap[least + 1]]
        i = least
      }
    }
    return top
  }
  dist[exit] = 0
  push(0, exit)
  while (heap.length) {
    const [d, c] = pop()
    if (d > dist[c]) continue
    for (let i = 0; i < 8; i++) {
      const n = neighbor(w, h, blocked, c, i)
      if (n < 0) continue
      const nd = d + (i < 4 ? ORTH : DIAG)
      if (nd < dist[n]) {
        dist[n] = nd
        push(nd, n)
      }
    }
  }
  return dist
}

/** 下一站：旁邊離出口最近的那一格，一樣近就先照原本的方向（`dir`）走 */
function nextCell(w: number, h: number, blocked: Uint8Array, dist: Uint32Array, c: number, dir: number): [number, number] | null {
  let best = -1
  let bestCost = 0
  let bestDir = NO_DIR
  const consider = (i: number) => {
    const n = neighbor(w, h, blocked, c, i)
    if (n < 0 || dist[n] === UNREACHABLE) return
    const cost = dist[n] + (i < 4 ? ORTH : DIAG)
    if (best < 0 || cost < bestCost) {
      best = n
      bestCost = cost
      bestDir = i
    }
  }
  if (dir < 8) consider(dir)
  for (let i = 0; i < 8; i++) consider(i)
  return best < 0 ? null : [best, bestDir]
}

export type Routes = {
  /** 每一路會走的格子（入口 → 出口） */
  paths: number[][]
  /** 所有路線加起來多長（格；斜走一步算 1.4） */
  length: number
}

/**
 * 照現在的塔（`tower(cell)` 是這一格有沒有塔）算出每一路會怎麼走；`extra` 是「假如這一格也蓋了塔」。
 * 有一路被堵死就回傳 null。
 */
export function routesOf(map: MapSpec, tower: (cell: number) => boolean, extra: number | null = null): Routes | null {
  const { w, h } = map
  const blocked = new Uint8Array(w * h)
  for (let c = 0; c < w * h; c++) blocked[c] = c === extra || tileAt(map, c) === 'rock' || tower(c) ? 1 : 0
  const paths: number[][] = []
  let total = 0
  for (const [spawn, exit] of map.routes) {
    const dist = distances(w, h, blocked, exit)
    if (dist[spawn] === UNREACHABLE) return null
    total += dist[spawn]
    const path = [spawn]
    let c = spawn
    let dir = NO_DIR
    while (c !== exit && path.length <= w * h) {
      const next = nextCell(w, h, blocked, dist, c, dir)
      if (!next) break
      ;[c, dir] = next
      path.push(c)
    }
    paths.push(path)
  }
  return { paths, length: total / ORTH }
}

/** 一條路線有多長（格） */
export function pathLength(map: MapSpec, path: number[]): number {
  let total = 0
  for (let i = 0; i + 1 < path.length; i++) {
    const straight = path[i] % map.w === path[i + 1] % map.w || Math.floor(path[i] / map.w) === Math.floor(path[i + 1] / map.w)
    total += straight ? ORTH : DIAG
  }
  return total / ORTH
}
