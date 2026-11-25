// 工具列「篩選」按鈕打開的面板：浮在地圖上面，點外面或按 Esc 收起來，改了馬上套用。

import { useEffect, useRef, type RefObject } from 'react'
import { CUISINE_GROUPS, DROPPED, GUIDE_EDITION, cuisineGroupsOf, type Restaurant } from './data'
import { NO_FILTERS, hasTag, type Filters, type MineFilter, type Tag } from './filters'
import type { Mine } from './mine'

type Props = {
  id: string
  filters: Filters
  onChange: (next: Filters) => void
  /** 這個地區所有的店（算每個條件有幾家） */
  inRegion: Restaurant[]
  mine: Mine
  onClose: () => void
  /** 打開面板的按鈕：點它不算「點外面」 */
  toggle: RefObject<HTMLElement | null>
}

const MINE_OPTIONS: { value: MineFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'want', label: '想吃' },
  { value: 'been', label: '吃過' },
  { value: 'not_been', label: '還沒吃過' },
]

const TAGS: { value: Tag; label: string }[] = [
  { value: 'green', label: '綠星' },
  { value: 'new', label: `${GUIDE_EDITION} 新入選` },
  { value: 'up', label: `${GUIDE_EDITION} 升星` },
]

function toggled<T>(set: ReadonlySet<T>, value: T) {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

export function FilterPanel({ id, filters, onChange, inRegion, mine, onClose, toggle }: Props) {
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (panel.current?.contains(target) || toggle.current?.contains(target)) return
      onClose()
    }
    // 比卡片的 Esc 先收到：只收起面板，不要連卡片一起關掉
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
      toggle.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, toggle])

  const cuisineCounts = new Map<string, number>()
  const priceCounts = new Map<number, number>()
  for (const r of inRegion) {
    for (const g of cuisineGroupsOf(r)) cuisineCounts.set(g, (cuisineCounts.get(g) ?? 0) + 1)
    priceCounts.set(r.price, (priceCounts.get(r.price) ?? 0) + 1)
  }
  const been = inRegion.filter((r) => mine.marks.get(r.id)?.status === 'been').length
  const want = inRegion.filter((r) => mine.marks.get(r.id)?.status === 'want').length
  const mineCounts: Record<MineFilter, number | null> = { all: null, want, been, not_been: inRegion.length - been }

  return (
    <div ref={panel} id={id} className="michelin-filters" role="group" aria-label="篩選">
      <fieldset>
        <legend>料理</legend>
        <div className="mich-chips">
          {CUISINE_GROUPS.filter((g) => (cuisineCounts.get(g.key) ?? 0) > 0 || filters.cuisines.has(g.key)).map((g) => (
            <button
              key={g.key}
              type="button"
              className="mich-chip"
              aria-pressed={filters.cuisines.has(g.key)}
              onClick={() => onChange({ ...filters, cuisines: toggled(filters.cuisines, g.key) })}
            >
              {g.label} <span className="mich-count">{cuisineCounts.get(g.key) ?? 0}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>價位</legend>
        <div className="mich-chips">
          {[1, 2, 3, 4].map((price) => (
            <button
              key={price}
              type="button"
              className="mich-chip"
              aria-pressed={filters.prices.has(price)}
              disabled={!priceCounts.get(price) && !filters.prices.has(price)}
              onClick={() => onChange({ ...filters, prices: toggled(filters.prices, price) })}
            >
              {'$'.repeat(price)} <span className="mich-count">{priceCounts.get(price) ?? 0}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>標記</legend>
        <div className="mich-chips">
          {TAGS.map((t) => {
            const n = inRegion.filter((r) => hasTag(r, t.value)).length
            return (
              <button
                key={t.value}
                type="button"
                className="mich-chip"
                aria-pressed={filters.tags.has(t.value)}
                disabled={n === 0 && !filters.tags.has(t.value)}
                onClick={() => onChange({ ...filters, tags: toggled(filters.tags, t.value) })}
              >
                {t.label} <span className="mich-count">{n}</span>
              </button>
            )
          })}
        </div>
        <p className="muted mich-filters-note">
          {GUIDE_EDITION} 年掉出星級的：{DROPPED.map((d) => `${d.name}（${d.city}，${d.last}→${d.now}）`).join('、')}。
          「入選」的店不在這張地圖上。
        </p>
      </fieldset>
      {mine.loggedIn && (
        <fieldset>
          <legend>我的</legend>
          <div className="mich-chips" role="radiogroup" aria-label="想吃、吃過">
            {MINE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                className="mich-chip"
                aria-checked={filters.mine === o.value}
                onClick={() => onChange({ ...filters, mine: o.value })}
              >
                {o.label}
                {mineCounts[o.value] !== null && <span className="mich-count"> {mineCounts[o.value]}</span>}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="michelin-filters-foot">
        <button type="button" className="secondary" onClick={() => onChange(NO_FILTERS)}>
          清除
        </button>
        <button type="button" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  )
}
