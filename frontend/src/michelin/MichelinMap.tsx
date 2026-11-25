// 米其林地圖：地圖上標出星級與必比登餐廳，點了看地址、電話，可以開 Google 地圖導航。
// 地區由網址決定（/michelin/:region，對應側邊欄），選中的餐廳放在 ?r=<id>，連結分享出去也會打開同一家。

import { useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router'
import { L, TAIWAN_CENTER, useLayers, useLeafletMap } from '../weather/map'
import {
  AWARDS,
  DATA_UPDATED,
  GUIDE_EDITION,
  REGIONS,
  RESTAURANTS,
  awardLabel,
  awardRank,
  displayPhone,
  googleMapsUrl,
  guideUrl,
  telHref,
  type Award,
  type Restaurant,
} from './data'
import './michelin.css'

const RADIUS: Record<string, number> = { 3: 10, 2: 9, 1: 7.5, bib: 6 }

function awardClass(award: Award) {
  return award === 'bib' ? 'bib' : `star${award}`
}

/** 列表和卡片上的小徽章：星級用 ★，必比登用「必」 */
function AwardBadge({ award }: { award: Award }) {
  return (
    <span className={`mich-badge mich-${awardClass(award)}`} title={awardLabel(award)}>
      <span aria-hidden="true">{award === 'bib' ? '必' : '★'.repeat(award)}</span>
      <span className="mich-sr">{awardLabel(award)}</span>
    </span>
  )
}

function byAward(a: Restaurant, b: Restaurant) {
  return awardRank(b.award) - awardRank(a.award) || a.city.localeCompare(b.city, 'zh-Hant') || a.name.localeCompare(b.name, 'zh-Hant')
}

function matches(r: Restaurant, query: string) {
  if (!query) return true
  const q = query.toLowerCase()
  return [r.name, r.cuisine, r.address, r.district].some((field) => field.toLowerCase().includes(q))
}

export default function MichelinMap() {
  const { region: regionSlug } = useParams()
  const region = REGIONS.find((r) => r.slug === regionSlug)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState<Set<Award>>(() => new Set())

  const inRegion = useMemo(
    () => RESTAURANTS.filter((r) => !region || region.cities.includes(r.city)).sort(byAward),
    [region],
  )
  const visible = useMemo(
    () => inRegion.filter((r) => !hidden.has(r.award) && matches(r, query.trim())),
    [inRegion, hidden, query],
  )
  const selected = RESTAURANTS.find((r) => r.id === params.get('r'))

  const listRef = useRef<HTMLOListElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  /** 從清單點的：手機上清單在卡片下面很遠，點完要把卡片捲進畫面 */
  const revealCard = useRef(false)
  const container = useRef<HTMLDivElement>(null)
  const map = useLeafletMap(container, TAIWAN_CENTER, 7)

  function select(id: string | null) {
    const next = new URLSearchParams(params)
    if (id) next.set('r', id)
    else next.delete('r')
    setParams(next, { replace: true })
  }

  // 換地區時把地圖框到那一區所有的店（切換獎項、搜尋時不動，免得一直跳）
  useEffect(() => {
    if (!map || inRegion.length === 0) return
    if (selected) return
    map.fitBounds(L.latLngBounds(inRegion.map((r) => [r.lat, r.lng])), { padding: [24, 24], maxZoom: 15 })
    // 只在換地區時重新框
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, inRegion])

  // 選了一家就飛過去
  useEffect(() => {
    if (!map || !selected) return
    map.flyTo([selected.lat, selected.lng], Math.max(map.getZoom(), 15), { duration: 0.6 })
  }, [map, selected])

  useEffect(() => {
    if (!revealCard.current) return
    revealCard.current = false
    const card = cardRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    // 卡片貼在畫面底部，上面還看得到一部分地圖
    if (rect.top < 0 || rect.bottom > window.innerHeight) card.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [selected])

  // 列表在桌機是自己捲動的欄位：把選中的那一列捲進來（手機的列表跟著頁面捲，不去動它）
  useEffect(() => {
    const list = listRef.current
    if (!selected || !list || list.scrollHeight <= list.clientHeight) return
    const item = list.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected.id)}"]`)
    if (!item) return
    const top = item.offsetTop - list.offsetTop
    if (top < list.scrollTop || top + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: top - 8, behavior: 'smooth' })
    }
  }, [selected])

  useLayers(
    map,
    (group) => {
      // 必比登先畫、三星最後畫，大的點才不會被小的蓋住；選中的那家放最上面
      const order = [...visible].sort((a, b) => awardRank(a.award) - awardRank(b.award))
      for (const r of order) {
        if (r.id === selected?.id) continue
        L.circleMarker([r.lat, r.lng], { radius: RADIUS[r.award], className: `mich-dot mich-${awardClass(r.award)}` })
          .bindTooltip(r.name, { direction: 'top', offset: [0, -6] })
          .on('click', () => select(r.id))
          .addTo(group)
      }
      if (selected) {
        L.circleMarker([selected.lat, selected.lng], {
          radius: RADIUS[selected.award] + 3,
          className: `mich-dot mich-${awardClass(selected.award)} is-selected`,
        })
          .bindTooltip(selected.name, { direction: 'top', offset: [0, -9], permanent: true })
          .addTo(group)
      }
    },
    [visible, selected],
  )

  if (regionSlug && !region) return <Navigate to="/michelin" replace />

  function toggle(award: Award) {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(award)) next.delete(award)
      else next.add(award)
      return next
    })
  }

  function pickFromList(id: string) {
    revealCard.current = true
    select(id)
  }

  const counts = new Map<Award, number>()
  for (const r of inRegion) counts.set(r.award, (counts.get(r.award) ?? 0) + 1)

  return (
    <div className="michelin-page">
      <div className="michelin-head">
        <h1>{region ? `${region.name}的米其林` : '米其林地圖'}</h1>
        <span className="muted">
          {GUIDE_EDITION} 台灣米其林指南・{inRegion.length} 家
        </span>
      </div>

      <div className="michelin-toolbar">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋店名、料理或地址"
          aria-label="搜尋店名、料理或地址"
        />
        <div className="michelin-awards" role="group" aria-label="顯示哪些獎項">
          {AWARDS.map((a) => {
            const count = counts.get(a.value) ?? 0
            return (
              <button
                key={a.value}
                type="button"
                className={`mich-toggle mich-${awardClass(a.value)}`}
                aria-pressed={!hidden.has(a.value)}
                disabled={count === 0}
                onClick={() => toggle(a.value)}
              >
                <span className="mich-swatch" aria-hidden="true" />
                {a.label}
                <span className="mich-count">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="michelin-body">
        <div className="michelin-main">
          <div ref={container} className="michelin-map" role="region" aria-label="米其林餐廳地圖" />
        </div>

        {/* 桌機是地圖右邊那一欄（和地圖等高，清單自己捲）；手機接在地圖下面，選中的店家卡片緊貼著地圖 */}
        <section className="michelin-side" aria-label="餐廳清單">
          {selected ? (
            <RestaurantCard ref={cardRef} r={selected} onClose={() => select(null)} />
          ) : (
            <p className="muted michelin-hint">點地圖上的圓點或下面的清單，看地址和電話。</p>
          )}
          <p className="muted michelin-shown">
            {visible.length === inRegion.length ? `共 ${visible.length} 家` : `顯示 ${visible.length} / ${inRegion.length} 家`}
          </p>
          {visible.length === 0 ? (
            <p className="muted">沒有符合的餐廳。</p>
          ) : (
            <ol className="michelin-list" ref={listRef}>
              {visible.map((r) => (
                <li key={r.id} data-id={r.id}>
                  <button
                    type="button"
                    className={r.id === selected?.id ? 'is-selected' : ''}
                    aria-current={r.id === selected?.id ? 'true' : undefined}
                    onClick={() => pickFromList(r.id)}
                  >
                    <AwardBadge award={r.award} />
                    <span className="mich-item-body">
                      <strong>{r.name}</strong>
                      <span className="muted">
                        {region?.cities.length === 1 ? r.district : `${r.city}${r.district}`}・{r.cuisine}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <p className="michelin-fineprint muted">
        資料整理自
        <a href="https://guide.michelin.com/tw/zh_TW" target="_blank" rel="noreferrer">
          米其林指南官網
        </a>
        （{GUIDE_EDITION} 年版，{DATA_UPDATED}整理），只收星級和必比登。營業時間、訂位和店家是否還在營業，請以官網或店家公告為準。
      </p>
    </div>
  )
}

function RestaurantCard({ r, onClose, ref }: { r: Restaurant; onClose: () => void; ref: Ref<HTMLElement> }) {
  return (
    <article ref={ref} className="card michelin-card" aria-labelledby="michelin-card-name">
      <div className="michelin-card-head">
        <AwardBadge award={r.award} />
        <h2 id="michelin-card-name">{r.name}</h2>
        <button type="button" className="secondary michelin-close" onClick={onClose} aria-label="關閉">
          ✕
        </button>
      </div>
      <p className="michelin-card-meta">
        <span>{awardLabel(r.award)}</span>
        {r.green && <span className="mich-green">綠星</span>}
        <span>{r.cuisine}</span>
        <span title="價位">{'$'.repeat(r.price)}</span>
      </p>
      <dl className="michelin-facts">
        <dt>地址</dt>
        <dd>
          {r.address}
          {r.approx && <span className="muted">（地圖上是約略位置）</span>}
        </dd>
        <dt>電話</dt>
        <dd>{r.phone ? <a href={telHref(r.phone)}>{displayPhone(r.phone)}</a> : <span className="muted">官網沒有提供</span>}</dd>
      </dl>
      <div className="michelin-actions">
        <a className="mich-action primary" href={googleMapsUrl(r)} target="_blank" rel="noreferrer">
          Google 地圖導航
        </a>
        <a className="mich-action" href={guideUrl(r)} target="_blank" rel="noreferrer">
          米其林介紹
        </a>
      </div>
    </article>
  )
}
