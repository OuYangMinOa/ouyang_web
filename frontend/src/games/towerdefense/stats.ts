import { useSyncExternalStore, type CSSProperties } from 'react'
import type { MonsterSpec, TdView, TowerLevel, TowerSpec } from './online'

/** 迷宮塔防的介面共用的小東西：每個 tick 都在變的數字、座位的顏色、把數值寫成文字 */

/** 每個 tick 都在變的數字（錢、生命、怪物數、這一波還有幾隻沒出來）放在這裡，只有用到的小元件跟著重畫 */
export type Stats = { gold: number[]; lives: number[]; counts: number[]; kills: number[]; left: number[] }

const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i])

export function createStats() {
  let value: Stats = { gold: [], lives: [], counts: [], kills: [], left: [] }
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: Stats) {
      const keys = ['gold', 'lives', 'counts', 'kills', 'left'] as const
      if (keys.every((k) => same(value[k], next[k]))) return
      // 存一份自己的：送進來的陣列之後可能被原地改掉
      value = { gold: [...next.gold], lives: [...next.lives], counts: [...next.counts], kills: [...next.kills], left: [...next.left] }
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type StatsStore = ReturnType<typeof createStats>

export function useStats(store: StatsStore): Stats {
  return useSyncExternalStore(store.subscribe, store.get)
}

/** 座位的顏色（塔底座的色環也是這個） */
export function seatColor(seat: number): CSSProperties {
  return { '--seat': `var(--td-p${seat % 8})` } as CSSProperties
}

export function goldOf(view: TdView, stats: Stats, seat: number | null): number {
  if (seat === null) return 0
  return stats.gold[seat] ?? view.players[seat]?.gold ?? 0
}

const fixed = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(n < 1 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, ''))

/** 一級的數值寫成一行（圖鑑用） */
export function levelText(tower: TowerSpec, level: TowerLevel): string {
  if (tower.id === 'beacon') return `範圍 ${fixed(level.range)} 格內的塔傷害 +${Math.round(level.buff * 100)}%`
  const parts = [`傷害 ${fixed(level.damage)}`, `射程 ${fixed(level.range)}`, `${fixed(level.cooldown)} 秒一發`]
  if (level.dot) parts.push(`中毒每秒 ${fixed(level.dot)}、${fixed(level.duration)} 秒`)
  if (level.slow) parts.push(`減速 ${Math.round(level.slow * 100)}%、${fixed(level.duration)} 秒`)
  if (level.splash) parts.push(`範圍 ${fixed(level.splash)}`)
  if (level.chain) parts.push(`連鎖 ${level.chain} 隻`)
  return parts.join('・')
}

/** 一項數值：名稱、現在的值，升級後會變的話再附上升級後的值 */
export type StatCell = { label: string; value: string; next?: string }

/** 一級的數值拆成一格一格（塔的面板用）；給了 `next` 就標出升級後哪幾項會變 */
export function statCells(tower: TowerSpec, level: TowerLevel, next?: TowerLevel): StatCell[] {
  const rows: [string, (l: TowerLevel) => string | null][] =
    tower.id === 'beacon'
      ? [
          ['範圍', (l) => `${fixed(l.range)} 格`],
          ['傷害加成', (l) => `+${Math.round(l.buff * 100)}%`],
        ]
      : [
          ['傷害', (l) => fixed(l.damage)],
          ['射程', (l) => fixed(l.range)],
          ['裝填', (l) => `${fixed(l.cooldown)} 秒`],
          ['每秒傷害', (l) => fixed(Math.round((l.damage / l.cooldown) * 10) / 10)],
          ['中毒', (l) => (l.dot ? `每秒 ${fixed(l.dot)}・${fixed(l.duration)} 秒` : null)],
          ['減速', (l) => (l.slow ? `${Math.round(l.slow * 100)}%・${fixed(l.duration)} 秒` : null)],
          ['爆炸範圍', (l) => (l.splash ? fixed(l.splash) : null)],
          ['連鎖', (l) => (l.chain ? `${l.chain} 隻` : null)],
        ]
  const cells: StatCell[] = []
  for (const [label, read] of rows) {
    const value = read(level)
    if (value === null) continue
    const after = next ? read(next) : null
    cells.push(after !== null && after !== value ? { label, value, next: after } : { label, value })
  }
  return cells
}

export function reachText(tower: TowerSpec): string {
  if (tower.id === 'beacon') return '輔助'
  const kind = tower.magic ? '魔法' : '物理'
  return tower.air && tower.ground ? `${kind}・對空對地` : tower.air ? `${kind}・只打飛行` : `${kind}・打不到飛行`
}

/** 一座塔到這一級一共花了多少 */
export function spentOn(tower: TowerSpec, level: number): number {
  return tower.levels.slice(0, level).reduce((sum, l) => sum + l.cost, 0)
}

/** 怪物的特性寫成幾個短短的標籤（下一波的預告、圖鑑用） */
export function traitsOf(m: MonsterSpec): string[] {
  const traits: string[] = []
  if (m.lives > 1) traits.push('魔王')
  if (m.air) traits.push('飛行')
  if (m.phys < 1) traits.push(`物理抗性 ${Math.round((1 - m.phys) * 100)}%`)
  if (m.magic < 1) traits.push(`魔法抗性 ${Math.round((1 - m.magic) * 100)}%`)
  if (m.regen > 0) traits.push('會回血')
  if (m.split) traits.push(`分裂 ×${m.split.count}`)
  if (m.speed >= 1.5) traits.push('跑得快')
  if (m.slowable < 1) traits.push('減速減半')
  return traits
}
