import type { PingKind } from './online'

/**
 * 標記（ping，像 LoL 那樣在場地上點一下叫隊友看）共用的東西：每一種叫什麼、長什麼樣、輪盤上在哪一邊。
 * 圖是同一條 SVG 路徑（24×24 的線條），介面上用 `<svg>` 畫、場地上用 `Path2D` 畫在疊在上面的畫布，兩邊長得一樣。
 */

export type PingLook = {
  kind: PingKind
  label: string
  path: string
  /** 顏色讀哪一個 CSS 變數；`null` 是用標記的人自己座位的顏色 */
  color: '--danger' | '--ok' | '--td-air' | '--td-gold' | null
  /** 輪盤上的方向（y 往下）；`[0, 0]` 是中間，按一下沒拖就是它 */
  dir: [number, number]
}

export const PINGS: PingLook[] = [
  { kind: 'note', label: '注意這裡', path: 'M12 5.2a6.8 6.8 0 1 0 0 13.6a6.8 6.8 0 1 0 0-13.6ZM12 10.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2Z', color: null, dir: [0, 0] },
  { kind: 'danger', label: '危險', path: 'M12 4.8v9M12 18.6v.2', color: '--danger', dir: [0, -1] },
  { kind: 'omw', label: '我來處理', path: 'M12 4.2v11.2M7.2 10.8l4.8 4.8 4.8-4.8M6.4 19.6h11.2', color: '--td-air', dir: [1, 0] },
  { kind: 'help', label: '這裡要塔', path: 'M6.6 19.6h10.8M8.6 19.6v-8.4h6.8v8.4M7.2 11.2V6.4h2.2v1.9h1.5V6.4h2.2v1.9h1.5V6.4h2.2v4.8Z', color: '--ok', dir: [0, 1] },
  { kind: 'ask', label: '？', path: 'M8.6 9.2a3.4 3.4 0 1 1 5.5 2.7c-1.2.9-2.1 1.5-2.1 3.1M12 18.6v.2', color: '--td-gold', dir: [-1, 0] },
]

export const PING: Record<PingKind, PingLook> = Object.fromEntries(PINGS.map((p) => [p.kind, p])) as Record<PingKind, PingLook>

/** 這個標記在說什麼；「這裡要塔」指著蓋好的塔時是「升級這座」 */
export function pingLabel(kind: PingKind, onTower: boolean): string {
  return kind === 'help' && onTower ? '升級這座' : PING[kind].label
}

/** 輪盤的大小（像素）：拖超過 `WHEEL_DEAD` 才算選了旁邊的，旁邊四個畫在離中間 `WHEEL_REACH` 的地方 */
export const WHEEL_DEAD = 26
export const WHEEL_REACH = 74

/** 按著拖了 (dx, dy)：選到哪一種（上危險、右我來、下要塔、左問號，沒拖就是中間的「注意這裡」） */
export function pickPing(dx: number, dy: number): PingKind {
  if (Math.hypot(dx, dy) < WHEEL_DEAD) return 'note'
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'omw' : 'ask'
  return dy < 0 ? 'danger' : 'help'
}

/** 連按太多次伺服器會擋（`towerdefense.rs` 的 `PING_BURST`、`PING_EVERY`）；這裡先算一次，不用等伺服器回來才知道 */
export function createPingBudget(burst = 4, every = 1500) {
  let tokens = burst
  let at = 0
  return {
    /** 還能不能標記；可以的話用掉一次 */
    take(now: number): boolean {
      tokens = Math.min(burst, tokens + (now - at) / every)
      at = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}
