import { randInt, shuffle, type Entry } from './pool'

/** 「一定要分開」：一行一組，同一行的人不會分在同一組，例如「小明、小華」 */
export function parseApart(text: string): string[][] {
  return text
    .split('\n')
    .map((line) =>
      [
        ...new Set(
          line
            .split(/[,，、/／\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ],
    )
    .filter((names) => names.length >= 2)
}

/** n 個人分成 k 組，每組人數差不超過 1；多出來的人隨機分給某幾組 */
export function groupSizes(n: number, k: number): number[] {
  const base = Math.floor(n / k)
  const extra = n % k
  const bonus = new Set(shuffle(Array.from({ length: k }, (_, i) => i)).slice(0, extra))
  return Array.from({ length: k }, (_, i) => base + (bonus.has(i) ? 1 : 0))
}

export type GroupResult = { groups: Entry[][] } | { error: string }

const ATTEMPTS = 300

/**
 * 隨機平均分組，同時遵守「一定要分開」。
 * 做法：限制最多的人先放，每個人隨機挑一個還有空位、也沒有衝突的組（空位多的組機率高）；卡住就整個重來，試幾百次都不行就回報。
 */
export function makeGroups(entries: Entry[], k: number, apart: string[][]): GroupResult {
  const n = entries.length
  if (n === 0) return { error: '名單是空的' }
  k = Math.max(1, Math.min(k, n))

  // 同名的人都算；衝突用名單裡的 id 記
  const idsByName = new Map<string, number[]>()
  for (const e of entries) idsByName.set(e.name, [...(idsByName.get(e.name) ?? []), e.id])
  const conflicts = new Map<number, Set<number>>(entries.map((e) => [e.id, new Set()]))
  for (const names of apart) {
    const ids = names.flatMap((name) => idsByName.get(name) ?? [])
    if (ids.length > k) return { error: `「${names.join('、')}」有 ${ids.length} 人要分開，但只有 ${k} 組` }
    for (const a of ids) for (const b of ids) if (a !== b) conflicts.get(a)!.add(b)
  }

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const sizes = groupSizes(n, k)
    const groups: Entry[][] = sizes.map(() => [])
    // 先洗牌再依衝突數排序：衝突多的先放，同樣多的順序是隨機的
    const order = shuffle(entries).sort((a, b) => conflicts.get(b.id)!.size - conflicts.get(a.id)!.size)
    let ok = true
    for (const e of order) {
      const mine = conflicts.get(e.id)!
      const options = groups
        .map((_, g) => g)
        .filter((g) => groups[g].length < sizes[g] && !groups[g].some((m) => mine.has(m.id)))
      if (options.length === 0) {
        ok = false
        break
      }
      // 依剩下的空位數加權，沒有條件時每種分法的機率才會一樣
      const slots = options.flatMap((g) => Array<number>(sizes[g] - groups[g].length).fill(g))
      groups[slots[randInt(slots.length)]].push(e)
    }
    if (ok) return { groups: groups.map((g) => shuffle(g)) }
  }
  return { error: '「一定要分開」的條件太多，找不到符合的分法，請減少條件或增加組數' }
}

export function formatGroups(groups: Entry[][]): string {
  return groups.map((g, i) => `第 ${i + 1} 組（${g.length} 人）：${g.map((e) => e.name).join('、')}`).join('\n')
}
