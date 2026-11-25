// 米其林地圖：地圖上標出星級與必比登餐廳，點了看地址、電話，可以開 Google 地圖導航。
// 地區由網址決定（/michelin/:region，對應側邊欄），選中的餐廳放在 ?r=<id>，連結分享出去也會打開同一家。
// 整頁剛好一個畫面高：寬螢幕地圖和清單左右並排，窄螢幕同一塊區域切換「地圖／清單」，不用跟地圖搶捲動。
// 店家卡片浮在地圖下緣，打開、換店時清單和地圖都不會跳。

import { useEffect, useEffectEvent, useMemo, useRef, useState, type Ref } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { L, TAIWAN_CENTER, useLeafletMap } from '../weather/map'
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

/** 縮到比這還遠（看得到大半個台灣）時，全台頁面把每個地區合成一顆泡泡，不然台北 84 家會疊成一團 */
const OVERVIEW_ZOOM = 9
/** 從清單點一家時飛到的縮放 */
const FOCUS_ZOOM = 15
/** 台北、新北、新竹在拉遠時擠在一起，泡泡錯開（像素）：台北往上、新北往右下、新竹往左 */
const BUBBLE_SHIFT: Record<string, [number, number]> = { taipei: [0, -20], 'new-taipei': [44, 18], hsinchu: [-12, 8] }
const TIP: L.TooltipOptions = { direction: 'top', offset: [0, -10], className: 'mich-tip' }
/** 放大到這裡以後，點旁邊直接寫店名 */
const LABEL_ZOOM = 12
/** 圓點的直徑，和 michelin.css 的 --dot 一樣；選中的放大 1.45 倍 */
const DOT: Record<string, number> = { star3: 20, star2: 17, star1: 14, bib: 12 }
const SELECTED_SCALE = 1.45
/** 店名離圓點邊緣多遠，和 michelin.css 的 .mich-name 一樣 */
const LABEL_GAP = 4

/** 畫面上的一塊長方形：左、上、右、下（像素） */
type Box = [number, number, number, number]

type View = 'map' | 'list'
/** 一次點選：從地圖點的不要動地圖（頂多挪一點讓它不被卡片蓋住），從清單點的要飛過去 */
type Pick = { id: string; from: 'map' | 'list' }

function awardClass(award: Award) {
  return award === 'bib' ? 'bib' : `star${award}`
}

/** 星級越高疊得越上面 */
function baseZ(award: Award) {
  return awardRank(award) * 1000
}

function overlapsAny(a: Box, boxes: Box[]) {
  return boxes.some((b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1])
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function byAward(a: Restaurant, b: Restaurant) {
  return awardRank(b.award) - awardRank(a.award) || a.city.localeCompare(b.city, 'zh-Hant') || a.name.localeCompare(b.name, 'zh-Hant')
}

function matches(r: Restaurant, q: string) {
  if (!q) return true
  const lower = q.toLowerCase()
  return [r.name, r.cuisine, r.address, r.district].some((field) => field.toLowerCase().includes(lower))
}

/** 把地圖框到這些店（animate 時用飛的） */
function fitTo(map: L.Map, rs: Restaurant[], animate: boolean) {
  if (rs.length === 0) return
  const bounds = L.latLngBounds(rs.map((r) => [r.lat, r.lng]))
  const options = { padding: [36, 36] as L.PointTuple, maxZoom: FOCUS_ZOOM }
  if (animate && !reducedMotion()) map.flyToBounds(bounds, { ...options, duration: 0.8 })
  else map.fitBounds(bounds, { ...options, animate: false })
}

/** 讓這一點落在「卡片上方那塊看得到的地圖」正中間，而不是被卡片蓋住的畫面中心 */
function centerAbove(map: L.Map, r: Restaurant, zoom: number, coveredBottom: number) {
  return map.unproject(map.project([r.lat, r.lng], zoom).add([0, coveredBottom / 2]), zoom)
}

/** 近的用平移，遠的或要換縮放的才用飛的（飛的會先拉遠再拉近，距離短時看起來像在晃） */
function moveTo(map: L.Map, center: L.LatLng, zoom: number) {
  if (reducedMotion()) {
    map.setView(center, zoom, { animate: false })
  } else if (zoom === map.getZoom() && map.getBounds().pad(0.5).contains(center)) {
    map.panTo(center, { duration: 0.45 })
  } else {
    map.flyTo(center, zoom, { duration: 0.8 })
  }
}

const RESET_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'

/** 列表、卡片上的小徽章：星級用 ★，必比登用「必」 */
function AwardBadge({ award }: { award: Award }) {
  return (
    <span className={`mich-badge mich-${awardClass(award)}`} title={awardLabel(award)}>
      <span aria-hidden="true">{award === 'bib' ? '必' : '★'.repeat(award)}</span>
      <span className="mich-sr">{awardLabel(award)}</span>
    </span>
  )
}

export default function MichelinMap() {
  const { region: regionSlug } = useParams()
  const region = REGIONS.find((r) => r.slug === regionSlug)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState<Set<Award>>(() => new Set())
  const [view, setView] = useState<View>('map')
  const [pick, setPick] = useState<Pick | null>(null)

  const q = query.trim()
  const inRegion = useMemo(
    () => RESTAURANTS.filter((r) => !region || region.cities.includes(r.city)).sort(byAward),
    [region],
  )
  const visible = useMemo(() => inRegion.filter((r) => !hidden.has(r.award) && matches(r, q)), [inRegion, hidden, q])
  const selectedId = params.get('r')
  const selected = RESTAURANTS.find((r) => r.id === selectedId)

  const container = useRef<HTMLDivElement>(null)
  const sideRef = useRef<HTMLElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  const markers = useRef(new Map<string, L.Marker>())
  /** 每個店名的寬高（量一次就記住；字型載入完會重量） */
  const labelSizes = useRef(new Map<string, [number, number]>())
  const handledPick = useRef<Pick | null>(null)
  const viewReady = useRef(false)
  const fittedQuery = useRef(q)
  const map = useLeafletMap(container, TAIWAN_CENTER, 7, { wheelZoom: true })

  function select(id: string | null) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (id) next.set('r', id)
        else next.delete('r')
        return next
      },
      { replace: true },
    )
  }

  function choose(id: string, from: Pick['from']) {
    select(id)
    // 每次都是新的物件：再點一次同一家也會再飛過去一次
    setPick({ id, from })
  }

  /** 現在框地圖要框哪些店：有在搜尋就框搜尋結果，沒有就框整個地區 */
  function fitTargets() {
    return q && visible.length > 0 ? visible : inRegion
  }

  /** 卡片蓋住地圖下緣多高 */
  function coveredBottom() {
    const card = cardRef.current
    return card ? card.offsetHeight + 16 : 0
  }

  /** 把清單捲到這一家（清單自己捲，不動整頁） */
  function scrollListTo(id: string) {
    const side = sideRef.current
    const item = side?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
    if (!side || !item) return
    const head = side.querySelector<HTMLElement>('.michelin-shown')?.offsetHeight ?? 0
    const top = item.getBoundingClientRect().top - side.getBoundingClientRect().top + side.scrollTop
    if (top - head < side.scrollTop || top + item.offsetHeight > side.scrollTop + side.clientHeight) {
      side.scrollTo({ top: top - head, behavior: reducedMotion() ? 'auto' : 'smooth' })
    }
  }

  // ---- 地圖上的事件（Leaflet 的監聽器只綁一次，用 effect event 拿到最新的狀態） ----

  const onMarkerClick = useEffectEvent((id: string) => choose(id, 'map'))
  const onMapClick = useEffectEvent(() => {
    if (params.get('r')) select(null)
  })
  const onBubbleClick = useEffectEvent((slug: string) => navigate(`/michelin/${slug}`))
  const onReset = useEffectEvent(() => map && fitTo(map, fitTargets(), true))

  // 每家店一個標記，只建一次；篩選、選取只改 class，不重建，滑鼠底下的點才不會閃
  useEffect(() => {
    if (!map) return
    const group = L.layerGroup().addTo(map)
    const all = markers.current
    for (const r of RESTAURANTS) {
      const marker = L.marker([r.lat, r.lng], {
        icon: L.divIcon({
          className: `mich-pin mich-${awardClass(r.award)}`,
          // 店名平常藏著，放大後由下面的排版決定要不要寫出來
          html: `<span></span><b class="mich-name">${escapeHtml(r.name)}</b>`,
          iconSize: [28, 28],
        }),
        // 鍵盤用清單操作就好，兩百個標記都能 Tab 到反而難用
        keyboard: false,
        zIndexOffset: baseZ(r.award),
        riseOnHover: true,
        riseOffset: 5000,
      })
        .bindTooltip(r.name, TIP)
        .on('click', () => onMarkerClick(r.id))
        .addTo(group)
      all.set(r.id, marker)
    }
    // 點地圖空白處關掉卡片（點到標記不會傳到這裡）
    const closeOnMapClick = () => onMapClick()
    map.on('click', closeOnMapClick)
    return () => {
      map.off('click', closeOnMapClick)
      group.remove()
      all.clear()
    }
  }, [map])

  // 「顯示全部」按鈕，放在縮放按鈕下面
  useEffect(() => {
    if (!map) return
    const control = new L.Control({ position: 'topleft' })
    control.onAdd = () => {
      const bar = L.DomUtil.create('div', 'leaflet-bar mich-reset')
      const button = L.DomUtil.create('a', '', bar)
      button.href = '#'
      button.setAttribute('role', 'button')
      button.title = '顯示全部'
      button.setAttribute('aria-label', '顯示全部')
      button.innerHTML = RESET_ICON
      L.DomEvent.disableClickPropagation(bar)
      L.DomEvent.on(button, 'click', (e) => {
        L.DomEvent.preventDefault(e)
        onReset()
      })
      return bar
    }
    control.addTo(map)
    return () => {
      control.remove()
    }
  }, [map])

  // 篩掉的藏起來、選中的放大
  useEffect(() => {
    const shown = new Set(visible.map((r) => r.id))
    for (const [id, marker] of markers.current) {
      const el = marker.getElement()
      el?.classList.toggle('is-hidden', !shown.has(id) && id !== selected?.id)
      el?.classList.toggle('is-selected', id === selected?.id)
    }
  }, [map, visible, selected])

  // 選中的那家疊到最上面
  useEffect(() => {
    const marker = selected && markers.current.get(selected.id)
    if (!selected || !marker) return
    marker.setZIndexOffset(100000)
    return () => {
      marker.setZIndexOffset(baseZ(selected.award))
    }
  }, [map, selected])

  // 店名直接寫在點旁邊：選中的一定寫；放大到 LABEL_ZOOM 以後其他店也寫，星級高的先排，
  // 先試右邊再試左邊，會壓到別的店名或圓點就不寫（那家滑過去還是有提示框）。
  // 只跟縮放有關、跟平移無關，所以只在縮放時重排。
  useEffect(() => {
    if (!map) return
    const all = markers.current
    const sizes = labelSizes.current
    const shown = selected && !visible.includes(selected) ? [selected, ...visible] : visible

    const layout = (zoom: number) => {
      const points = shown.map((r) => {
        const half = (DOT[awardClass(r.award)] * (r === selected ? SELECTED_SCALE : 1)) / 2
        return { r, half, p: map.project([r.lat, r.lng], zoom) }
      })
      const dots: Box[] = points.map(({ p, half }) => [p.x - half, p.y - half, p.x + half, p.y + half])
      // 選中的排第一個；其他照清單順序（星級高的在前）
      const order = points.filter(({ r }) => r === selected || zoom >= LABEL_ZOOM)
      order.sort((a, b) => Number(b.r === selected) - Number(a.r === selected))

      const placed: Box[] = []
      const sides = new Map<string, 'right' | 'left'>()
      for (const { r, p, half } of order) {
        const isSelected = r === selected
        const key = isSelected ? `${r.id}:selected` : r.id
        let size = sizes.get(key)
        if (!size) {
          const label = all.get(r.id)?.getElement()?.querySelector<HTMLElement>('.mich-name')
          if (!label?.offsetWidth) continue
          size = [label.offsetWidth, label.offsetHeight]
          sizes.set(key, size)
        }
        const [w, h] = size
        const start = half + LABEL_GAP
        const right: Box = [p.x + start, p.y - h / 2, p.x + start + w, p.y + h / 2]
        const left: Box = [p.x - start - w, p.y - h / 2, p.x - start, p.y + h / 2]
        const fits = (box: Box) => !overlapsAny(box, placed) && !overlapsAny(box, dots)
        const side = fits(right) ? 'right' : fits(left) ? 'left' : isSelected ? 'right' : null
        if (!side) continue
        placed.push(side === 'right' ? right : left)
        sides.set(r.id, side)
      }

      for (const r of RESTAURANTS) {
        const marker = all.get(r.id)
        const el = marker?.getElement()
        if (!marker || !el) continue
        const side = sides.get(r.id)
        el.classList.toggle('has-name', side !== undefined)
        el.classList.toggle('is-left', side === 'left')
        // 已經寫出店名的不用再跳提示框
        if (side && marker.getTooltip()) marker.unbindTooltip()
        else if (!side && !marker.getTooltip()) marker.bindTooltip(r.name, TIP)
      }
    }

    // 滾輪、按鈕縮放：一開始就知道要縮到哪，店名跟著點一起移過去；飛行、手指縮放：每一格重排
    const onZoomAnim = (e: L.ZoomAnimEvent) => layout(e.zoom)
    let frame = 0
    const onZoom = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => layout(map.getZoom()))
    }
    // 網頁字型晚一點才載入，寬度會變
    const onFonts = () => {
      sizes.clear()
      layout(map.getZoom())
    }
    map.on('zoomanim', onZoomAnim)
    map.on('zoom', onZoom)
    document.fonts.addEventListener('loadingdone', onFonts)
    layout(map.getZoom())
    return () => {
      cancelAnimationFrame(frame)
      map.off('zoomanim', onZoomAnim)
      map.off('zoom', onZoom)
      document.fonts.removeEventListener('loadingdone', onFonts)
    }
  }, [map, visible, selected])

  // 全台頁面拉遠時：圓點收起來，改成每個地區一顆泡泡（點了進那個地區）
  useEffect(() => {
    if (!map || region) return
    const el = map.getContainer()
    const update = () => el.classList.toggle('is-overview', map.getZoom() < OVERVIEW_ZOOM)
    update()
    // 飛行途中每一格都會觸發，越過門檻的那一刻就切換，不用等飛完
    map.on('zoom', update)
    const group = L.layerGroup().addTo(map)
    for (const reg of REGIONS) {
      const rs = visible.filter((r) => reg.cities.includes(r.city))
      if (rs.length === 0) continue
      const lat = rs.reduce((sum, r) => sum + r.lat, 0) / rs.length
      const lng = rs.reduce((sum, r) => sum + r.lng, 0) / rs.length
      const [dx, dy] = BUBBLE_SHIFT[reg.slug] ?? [0, 0]
      const bubble = L.marker([lat, lng], {
        icon: L.divIcon({
          className: 'mich-bubble',
          html: `<span style="--dx:${dx}px;--dy:${dy}px"><b>${reg.name}</b>${rs.length}</span>`,
          iconSize: [0, 0],
        }),
        zIndexOffset: 200000,
      })
        .on('click', () => onBubbleClick(reg.slug))
        .addTo(group)
      bubble.getElement()?.setAttribute('aria-label', `${reg.name} ${rs.length} 家`)
    }
    return () => {
      map.off('zoom', update)
      el.classList.remove('is-overview')
      group.remove()
    }
  }, [map, region, visible])

  // 打開頁面：直接框好（網址帶著某家就直接停在那家）；之後換地區用飛的
  const onRegion = useEffectEvent(() => {
    if (!map) return
    const first = !viewReady.current
    viewReady.current = true
    if (first && selected) {
      map.setView(centerAbove(map, selected, FOCUS_ZOOM, coveredBottom()), FOCUS_ZOOM, { animate: false })
      scrollListTo(selected.id)
      return
    }
    fitTo(map, fitTargets(), !first)
  })
  useEffect(() => {
    if (map) onRegion()
  }, [map, regionSlug])

  // 搜尋：停手一下再把地圖框到搜尋結果；清空就框回整個地區
  const onQuerySettled = useEffectEvent(() => {
    fittedQuery.current = q
    if (map) fitTo(map, fitTargets(), true)
  })
  useEffect(() => {
    if (!map || q === fittedQuery.current) return
    const timer = setTimeout(onQuerySettled, 450)
    return () => clearTimeout(timer)
  }, [map, q])

  // 點了一家：等網址裡的選取也更新、卡片畫出來（才量得到高度）再移動地圖
  const onPick = useEffectEvent((p: Pick) => {
    if (!map || !selected) return
    if (p.from === 'map') {
      scrollListTo(p.id)
      // 地圖上點的：使用者正在看這一帶，不改縮放，只在被卡片蓋住時挪一點
      map.panInside([selected.lat, selected.lng], {
        paddingTopLeft: [24, 56],
        paddingBottomRight: [24, coveredBottom() + 24],
        animate: !reducedMotion(),
      })
      return
    }
    const zoom = Math.max(map.getZoom(), FOCUS_ZOOM)
    moveTo(map, centerAbove(map, selected, zoom, coveredBottom()), zoom)
  })
  useEffect(() => {
    if (!pick || pick === handledPick.current || pick.id !== selected?.id) return
    handledPick.current = pick
    onPick(pick)
  }, [map, pick, selected])

  // Esc 關掉卡片
  const onEscape = useEffectEvent(() => select(null))
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (e.target instanceof HTMLInputElement && e.target.value) return
      onEscape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  /** 滑鼠移到清單上的某一家時，地圖上那顆點跟著放大 */
  function highlight(r: Restaurant, on: boolean) {
    const marker = markers.current.get(r.id)
    if (!marker) return
    marker.getElement()?.classList.toggle('is-hover', on)
    if (r.id !== selected?.id) marker.setZIndexOffset(on ? 50000 : baseZ(r.award))
  }

  function toggle(award: Award) {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(award)) next.delete(award)
      else next.add(award)
      return next
    })
  }

  function clearFilters() {
    setQuery('')
    setHidden(new Set())
  }

  function pickFromList(id: string) {
    setView('map')
    choose(id, 'list')
  }

  const counts = new Map<Award, number>()
  for (const r of inRegion) counts.set(r.award, (counts.get(r.award) ?? 0) + 1)
  const oneCity = region?.cities.length === 1

  return (
    <div className="michelin-page">
      {regionSlug && !region && <Navigate to="/michelin" replace />}

      <div className="michelin-head">
        <div className="michelin-title">
          <h1>{region ? `${region.name}的米其林` : '米其林地圖'}</h1>
          <p className="muted">
            {GUIDE_EDITION} 年版・{inRegion.length} 家
          </p>
        </div>
        <div className="michelin-view" role="group" aria-label="顯示方式">
          <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>
            地圖
          </button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            清單 <span className="mich-count">{visible.length}</span>
          </button>
        </div>
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
            const on = !hidden.has(a.value)
            return (
              <button
                key={a.value}
                type="button"
                className={`mich-toggle mich-${awardClass(a.value)}`}
                aria-pressed={on}
                disabled={count === 0}
                title={`${on ? '隱藏' : '顯示'}${a.label}`}
                onClick={() => toggle(a.value)}
              >
                {a.value === 'bib' ? (
                  <span className="mich-glyph">必比登</span>
                ) : (
                  <>
                    <span className="mich-glyph" aria-hidden="true">
                      {'★'.repeat(a.value)}
                    </span>
                    <span className="mich-sr">{a.label}</span>
                  </>
                )}
                <span className="mich-count">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="michelin-body" data-view={view}>
        <div className="michelin-main">
          <div ref={container} className="michelin-map" role="region" aria-label="米其林餐廳地圖" />
          {selected && <RestaurantCard ref={cardRef} r={selected} onClose={() => select(null)} />}
        </div>

        <section ref={sideRef} className="michelin-side" aria-label="餐廳清單">
          <p className="michelin-shown">
            {visible.length === inRegion.length ? `共 ${visible.length} 家` : `顯示 ${visible.length} / ${inRegion.length} 家`}
          </p>
          {visible.length === 0 ? (
            <div className="michelin-empty">
              <p className="muted">沒有符合的餐廳。</p>
              <button type="button" className="secondary" onClick={clearFilters}>
                清除搜尋和篩選
              </button>
            </div>
          ) : (
            <ol className="michelin-list">
              {visible.map((r) => (
                <li key={r.id} data-id={r.id}>
                  <button
                    type="button"
                    className={r.id === selected?.id ? 'is-selected' : undefined}
                    aria-current={r.id === selected?.id ? 'true' : undefined}
                    onClick={() => pickFromList(r.id)}
                    onPointerEnter={(e) => e.pointerType === 'mouse' && highlight(r, true)}
                    onPointerLeave={(e) => e.pointerType === 'mouse' && highlight(r, false)}
                    onFocus={() => highlight(r, true)}
                    onBlur={() => highlight(r, false)}
                  >
                    <AwardBadge award={r.award} />
                    <span className="mich-item-body">
                      <strong>{r.name}</strong>
                      <span className="muted">
                        {oneCity ? r.district : `${r.city}${r.district}`}・{r.cuisine}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p className="michelin-fineprint muted">
            資料整理自
            <a href="https://guide.michelin.com/tw/zh_TW" target="_blank" rel="noreferrer">
              米其林指南官網
            </a>
            （{GUIDE_EDITION} 年版，{DATA_UPDATED}整理），只收星級和必比登。營業時間、訂位和店家是否還在營業，請以官網或店家公告為準。
          </p>
        </section>
      </div>
    </div>
  )
}

function RestaurantCard({ r, onClose, ref }: { r: Restaurant; onClose: () => void; ref: Ref<HTMLElement> }) {
  return (
    <article ref={ref} className="michelin-card" aria-labelledby="michelin-card-name">
      <div className="michelin-card-head">
        <AwardBadge award={r.award} />
        <h2 id="michelin-card-name">{r.name}</h2>
        <button type="button" className="secondary michelin-close" onClick={onClose} aria-label="關閉" title="關閉（Esc）">
          ✕
        </button>
      </div>
      <p className="michelin-card-meta">
        <span>{awardLabel(r.award)}</span>
        {r.green && <span className="mich-green">綠星</span>}
        <span>{r.cuisine}</span>
        <span title="價位">{'$'.repeat(r.price)}</span>
        <a className="mich-guide-link" href={guideUrl(r)} target="_blank" rel="noreferrer">
          米其林介紹 ↗
        </a>
      </p>
      <p className="michelin-card-address">
        {r.address}
        {r.approx && <span className="muted">（地圖上是約略位置）</span>}
      </p>
      {/* 兩顆按鈕，手機上也排得下一列 */}
      <div className="michelin-actions">
        {r.phone ? (
          <a className="mich-action" href={telHref(r.phone)} aria-label={`打電話 ${displayPhone(r.phone)}`}>
            <span aria-hidden="true">☎</span>
            {displayPhone(r.phone)}
          </a>
        ) : (
          <span className="mich-action is-empty">沒有公開電話</span>
        )}
        <a className="mich-action primary" href={googleMapsUrl(r)} target="_blank" rel="noreferrer">
          Google 地圖
        </a>
      </div>
    </article>
  )
}
