// 「篩選」裡的條件：料理分類、價位、想吃／吃過（獎項和搜尋在工具列上，不在這裡）

import { changeOf, cuisineGroupsOf, type Restaurant } from './data'
import type { Mark } from './mine'

export type MineFilter = 'all' | 'want' | 'been' | 'not_been'
/** 標記：綠星、今年新入選、今年升星；勾好幾個是「符合其中一個」 */
export type Tag = 'green' | 'new' | 'up'

export type Filters = {
  /** CUISINE_GROUPS 的 key；空的是不限 */
  cuisines: ReadonlySet<string>
  /** 1～4；空的是不限 */
  prices: ReadonlySet<number>
  tags: ReadonlySet<Tag>
  mine: MineFilter
}

export const NO_FILTERS: Filters = { cuisines: new Set(), prices: new Set(), tags: new Set(), mine: 'all' }

/** 按鈕上的數字：開了幾個條件 */
export function filterCount(f: Filters) {
  return f.cuisines.size + f.prices.size + f.tags.size + (f.mine === 'all' ? 0 : 1)
}

/** 換條件時才重新框地圖；比對用的字串 */
export function filterKey(f: Filters) {
  return [[...f.cuisines].sort().join(','), [...f.prices].sort().join(','), [...f.tags].sort().join(','), f.mine].join('|')
}

export function hasTag(r: Restaurant, tag: Tag) {
  return tag === 'green' ? Boolean(r.green) : changeOf(r)?.kind === tag
}

export function passes(r: Restaurant, f: Filters, marks: ReadonlyMap<string, Mark>) {
  if (f.cuisines.size > 0 && !cuisineGroupsOf(r).some((g) => f.cuisines.has(g))) return false
  if (f.prices.size > 0 && !f.prices.has(r.price)) return false
  if (f.tags.size > 0 && ![...f.tags].some((tag) => hasTag(r, tag))) return false
  const status = marks.get(r.id)?.status
  switch (f.mine) {
    case 'want':
      return status === 'want'
    case 'been':
      return status === 'been'
    case 'not_been':
      return status !== 'been'
    default:
      return true
  }
}
