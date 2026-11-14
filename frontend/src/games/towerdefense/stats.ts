import { useSyncExternalStore, type CSSProperties } from 'react'
import type { TdView, TowerLevel, TowerSpec } from './online'

/** 迷宮塔防的介面共用的小東西：每個 tick 都在變的數字、座位的顏色、把數值寫成文字 */

/** 每個 tick 都在變的數字（錢、生命、怪物數）放在這裡，只有用到的小元件跟著重畫 */
export type Stats = { gold: number[]; lives: number[]; counts: number[]; kills: number[] }

const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i])

export function createStats() {
  let value: Stats = { gold: [], lives: [], counts: [], kills: [] }
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: Stats) {
      const keys = ['gold', 'lives', 'counts', 'kills'] as const
      if (keys.every((k) => same(value[k], next[k]))) return
      value = next
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

/** 一級的數值寫成一行 */
export function levelText(tower: TowerSpec, level: TowerLevel): string {
  if (tower.id === 'beacon') return `範圍 ${fixed(level.range)} 格內的塔傷害 +${Math.round(level.buff * 100)}%`
  const parts = [`傷害 ${fixed(level.damage)}`, `射程 ${fixed(level.range)}`, `${fixed(level.cooldown)} 秒一發`]
  if (level.dot) parts.push(`中毒每秒 ${fixed(level.dot)}、${fixed(level.duration)} 秒`)
  if (level.slow) parts.push(`減速 ${Math.round(level.slow * 100)}%、${fixed(level.duration)} 秒`)
  if (level.splash) parts.push(`範圍 ${fixed(level.splash)}`)
  if (level.chain) parts.push(`連鎖 ${level.chain} 隻`)
  return parts.join('・')
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
