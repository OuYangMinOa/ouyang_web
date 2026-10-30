import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CITY_POINTS,
  depthLevel,
  EEW_SOURCES,
  estimateIntensity,
  hypocentralKm,
  intensityLevel,
  intensityUnit,
  P_WAVE_KMS,
  S_WAVE_KMS,
  taipeiTime,
  timeAgo,
  usePreference,
  useRemote,
  type Eew,
  type QuakeReport,
  type QuakeSnapshot,
} from './data'
import { L, TAIWAN_CENTER, useLayers, useLeafletMap } from './map'
import { SourceList } from './WeatherHub'
import './weather.css'

/** 速報在發震後這麼久內都算「進行中」，顯示在最上面 */
const ACTIVE_MS = 3 * 60 * 1000

const LIST_TABS: { id: string; label: string; source: string }[] = [
  { id: 'cwa', label: '台灣（氣象署）', source: 'cwa' },
  { id: 'usgs_taiwan', label: '台灣附近', source: 'usgs' },
  { id: 'jma', label: '日本', source: 'jma' },
  { id: 'cenc', label: '中國', source: 'cenc' },
  { id: 'usgs_global', label: '全球 M4.5+', source: 'usgs' },
]

/** 每個來源只留最新的一筆（比發震時間，同一個地震再比第幾報） */
function latestPerSource(list: Eew[]) {
  const latest = new Map<string, Eew>()
  for (const eew of list) {
    const prev = latest.get(eew.source)
    const newer =
      !prev ||
      Date.parse(eew.origin_time) > Date.parse(prev.origin_time) ||
      (prev.event_id === eew.event_id && (eew.serial ?? 0) >= (prev.serial ?? 0))
    if (newer) latest.set(eew.source, eew)
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.origin_time) - Date.parse(a.origin_time))
}

type Feed = { eew: Eew[]; lists: Record<string, QuakeReport[]>; live: boolean }

/** 連到 /api/weather/quakes/ws 收即時速報，斷線就自動重連；和 HTTP 抓到的快照合在一起 */
function useQuakeFeed(initial: QuakeSnapshot | null): Feed {
  const [pushed, setPushed] = useState<Eew[]>([])
  const [live, setLive] = useState(false)

  useEffect(() => {
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 2000
    let stopped = false

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${location.host}/api/weather/quakes/ws`)
      socket.onopen = () => {
        setLive(true)
        delay = 2000
      }
      socket.onmessage = (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (message.type === 'snapshot') setPushed((prev) => latestPerSource([...prev, ...message.eew]))
        if (message.type === 'eew') setPushed((prev) => latestPerSource([...prev, message.eew]))
      }
      socket.onclose = () => {
        setLive(false)
        if (stopped) return
        retry = setTimeout(connect, delay)
        delay = Math.min(delay * 2, 30000)
      }
    }

    connect()
    return () => {
      stopped = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [])

  const eew = useMemo(() => latestPerSource([...(initial?.eew ?? []), ...pushed]), [initial, pushed])
  return { eew, lists: initial?.lists ?? {}, live }
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), active ? 250 : 15000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function IntensityBadge({ value, source }: { value?: string; source: string }) {
  if (!value) return <span className="muted">—</span>
  return (
    <span className={`eq-intensity eq-level-${intensityLevel(value, source)}`}>
      {intensityUnit(source)} {value}
    </span>
  )
}

function ActiveAlert({
  eew,
  now,
  cityId,
  onCity,
}: {
  eew: Eew
  now: number
  cityId: string
  onCity: (id: string) => void
}) {
  const city = CITY_POINTS.find((c) => c.id === cityId) ?? CITY_POINTS[1]
  const origin = Date.parse(eew.origin_time)
  const distance = hypocentralKm(eew, city.lat, city.lon)
  const sArrival = origin + (distance / S_WAVE_KMS) * 1000
  const remaining = Math.ceil((sArrival - now) / 1000)
  const estimate = eew.magnitude !== undefined ? estimateIntensity(eew.magnitude, distance) : undefined
  const level = intensityLevel(eew.max_intensity, eew.source)

  return (
    <section className={`card eew-alert eq-level-${level}`} role="alert" aria-live="assertive">
      <div className="eew-alert-head">
        <span className="eew-badge">{eew.is_cancel ? '取消' : eew.is_training ? '測試' : '地震速報'}</span>
        <strong>{EEW_SOURCES[eew.source]}</strong>
        <span className="muted">
          第 {eew.serial ?? 1} 報{eew.is_final ? '（最終）' : ''}・{timeAgo(eew.origin_time, now)}
        </span>
      </div>
      <p className="eew-alert-title">
        {eew.hypocenter || '震央不明'}　規模 {eew.magnitude?.toFixed(1) ?? '—'}
      </p>
      <dl className="facts">
        <div>
          <dt>發震時間</dt>
          <dd>{taipeiTime(eew.origin_time)}</dd>
        </div>
        <div>
          <dt>深度</dt>
          <dd>{eew.depth_km !== undefined ? `${eew.depth_km} km` : '—'}</dd>
        </div>
        <div>
          <dt>預估最大{intensityUnit(eew.source)}</dt>
          <dd>
            <IntensityBadge value={eew.max_intensity} source={eew.source} />
          </dd>
        </div>
      </dl>
      <div className="eew-countdown">
        <label>
          我在
          <select value={city.id} onChange={(e) => onCity(e.target.value)}>
            {CITY_POINTS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <p className="eew-seconds" aria-live="off">
          {remaining > 0 ? (
            <>
              S 波 <strong>{remaining}</strong> 秒後抵達
            </>
          ) : (
            'S 波已抵達'
          )}
        </p>
        <p className="muted">
          距離震源約 {Math.round(distance)} km
          {estimate !== undefined && <>・預估當地震度 {estimate}（僅供參考）</>}
        </p>
      </div>
    </section>
  )
}

function QuakeMap({
  items,
  active,
  focus,
  now,
}: {
  items: QuakeReport[]
  active: Eew[]
  focus?: QuakeReport
  now: number
}) {
  const container = useRef<HTMLDivElement>(null)
  const map = useLeafletMap(container, TAIWAN_CENTER, 6)

  useLayers(
    map,
    (group) => {
      const bounds = L.latLngBounds([])
      for (const q of items) {
        const radius = Math.max(3, ((q.magnitude ?? 3) - 2) * 3)
        L.circleMarker([q.lat, q.lon], { radius, className: `eq-dot eq-depth-${depthLevel(q.depth_km)}` })
          .bindTooltip(
            `<strong>${q.location}</strong><br>${taipeiTime(q.time)}<br>規模 ${q.magnitude ?? '—'}・深度 ${q.depth_km ?? '—'} km`,
          )
          .addTo(group)
        bounds.extend([q.lat, q.lon])
      }
      if (active.length === 0 && bounds.isValid()) map?.fitBounds(bounds, { padding: [24, 24], maxZoom: 7 })
    },
    [items, active.length],
  )

  // 速報：震央與 P／S 波的擴散圓，每次 now 更新就重畫
  useLayers(
    map,
    (group) => {
      for (const eew of active) {
        const elapsed = (now - Date.parse(eew.origin_time)) / 1000
        L.marker([eew.lat, eew.lon], {
          icon: L.divIcon({ className: 'eq-epicenter', html: '<span></span>', iconSize: [28, 28] }),
          keyboard: false,
        }).addTo(group)
        if (elapsed > 0 && elapsed < 300) {
          L.circle([eew.lat, eew.lon], {
            radius: elapsed * P_WAVE_KMS * 1000,
            className: 'eq-wave-p',
            interactive: false,
          }).addTo(group)
          L.circle([eew.lat, eew.lon], {
            radius: elapsed * S_WAVE_KMS * 1000,
            className: 'eq-wave-s',
            interactive: false,
          }).addTo(group)
        }
      }
    },
    [active, Math.floor(now / 500)],
  )

  useEffect(() => {
    if (map && active[0]) map.setView([active[0].lat, active[0].lon], 7)
  }, [map, active[0]?.event_id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (map && focus) map.setView([focus.lat, focus.lon], Math.max(map.getZoom(), 7))
  }, [map, focus])

  return <div ref={container} className="weather-map" role="region" aria-label="地震分布圖" />
}

function QuakeTable({
  items,
  source,
  onFocus,
}: {
  items: QuakeReport[]
  source: string
  onFocus: (q: QuakeReport) => void
}) {
  if (items.length === 0) return <p className="muted">最近沒有資料。</p>
  // USGS 沒有震度
  const showIntensity = source !== 'usgs'
  return (
    <div className="table-wrap">
      <table className="responsive quake-table">
        <thead>
          <tr>
            <th>時間</th>
            <th>地點</th>
            <th>規模</th>
            <th>深度</th>
            {showIntensity && <th>{intensityUnit(source)}</th>}
            <th aria-label="動作" />
          </tr>
        </thead>
        <tbody>
          {items.map((q) => (
            <tr key={q.id}>
              <td data-label="時間">{taipeiTime(q.time)}</td>
              <td data-label="地點" className="primary">
                {q.location}
              </td>
              <td data-label="規模">
                <span className={`eq-mag eq-depth-${depthLevel(q.depth_km)}`}>{q.magnitude?.toFixed(1) ?? '—'}</span>
              </td>
              <td data-label="深度">{q.depth_km !== undefined ? `${q.depth_km} km` : '—'}</td>
              {showIntensity && (
                <td data-label={intensityUnit(source)}>
                  <IntensityBadge value={q.max_intensity} source={source} />
                </td>
              )}
              <td className="actions">
                <button type="button" className="secondary" onClick={() => onFocus(q)}>
                  地圖
                </button>
                {q.url && (
                  <a className="quake-link" href={q.url} target="_blank" rel="noreferrer">
                    詳細
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function QuakePage() {
  const { data, error } = useRemote<QuakeSnapshot>('/weather/quakes', 3 * 60 * 1000)
  const feed = useQuakeFeed(data)
  const [test, setTest] = useState<Eew | null>(null)
  const [cityId, setCityId] = usePreference<string>('quake-city', 'taipei')
  const [tab, setTab] = useState<string>()
  const [focus, setFocus] = useState<QuakeReport>()

  const allEew = useMemo(() => (test ? latestPerSource([...feed.eew, test]) : feed.eew), [feed.eew, test])
  const roughNow = useNow(false)
  const active = useMemo(
    () => allEew.filter((e) => roughNow - Date.parse(e.origin_time) < ACTIVE_MS && !e.is_cancel),
    [allEew, roughNow],
  )
  const now = useNow(active.length > 0)

  const tabs = LIST_TABS.filter((t) => t.id !== 'cwa' || feed.lists.cwa)
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]
  const items = feed.lists[current.id] ?? []

  function runTest() {
    setTest({
      source: 'cwa',
      event_id: `test-${Date.now()}`,
      serial: 1,
      origin_time: new Date(Date.now() - 3000).toISOString(),
      hypocenter: '花蓮縣近海（測試）',
      lat: 23.9,
      lon: 121.75,
      magnitude: 6.2,
      depth_km: 15,
      max_intensity: '5弱',
      is_final: false,
      is_cancel: false,
      is_warn: false,
      is_training: true,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="weather-page">
      <div className="weather-head">
        <h1>地震</h1>
        <span className={`live-dot ${feed.live ? 'on' : ''}`}>{feed.live ? '即時連線中' : '重新連線中…'}</span>
      </div>

      {active.map((eew) => (
        <ActiveAlert key={`${eew.source}-${eew.event_id}`} eew={eew} now={now} cityId={cityId} onCity={setCityId} />
      ))}

      {error && !data && <p className="error">{error}</p>}

      <QuakeMap items={items} active={active} focus={focus} now={now} />
      <ul className="legend" aria-label="震源深度圖例">
        <li>
          <span className="eq-swatch eq-depth-shallow" aria-hidden="true" />
          淺層（&lt;30 km）
        </li>
        <li>
          <span className="eq-swatch eq-depth-mid" aria-hidden="true" />
          中層（30–70 km）
        </li>
        <li>
          <span className="eq-swatch eq-depth-deep" aria-hidden="true" />
          深層（≥70 km）
        </li>
      </ul>

      <h2>最近的地震速報</h2>
      {allEew.length === 0 ? (
        <p className="muted">還沒有收到速報。</p>
      ) : (
        <ul className="eew-list">
          {allEew.map((e) => (
            <li key={`${e.source}-${e.event_id}`} className="card">
              <span className="muted">
                {EEW_SOURCES[e.source]}・{taipeiTime(e.origin_time)}
                {e.is_training && '・測試'}
              </span>
              <strong>{e.hypocenter}</strong>
              <span>
                規模 {e.magnitude?.toFixed(1) ?? '—'}・深度 {e.depth_km !== undefined ? `${e.depth_km} km` : '—'}・
                <IntensityBadge value={e.max_intensity} source={e.source} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button type="button" className="secondary" onClick={runTest}>
          測試速報畫面
        </button>
      </div>

      <h2>地震報告</h2>
      <div className="detail-tabs" role="tablist" aria-label="地震報告來源">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === current.id}
            className={t.id === current.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <QuakeTable
        items={items}
        source={current.source}
        onFocus={(q) => {
          setFocus(q)
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }}
      />

      {data && (
        <>
          <details className="feed-status">
            <summary>速報連線狀態</summary>
            <ul>
              {data.feeds.map((f) => (
                <li key={f.path}>
                  <span className={`live-dot ${f.connected ? 'on' : ''}`}>{f.name}</span>
                  <span className="muted">
                    {f.connected ? (f.via === 'relay' ? '經由 relay' : '直接連線') : (f.last_error ?? '未連線')}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <SourceList sources={data.sources} updatedAt={data.updated_at} />
        </>
      )}
      <p className="muted fineprint">
        速報來自 <a href="https://wolfx.jp/">wolfx</a> 轉發的各國地震速報；地震報告來自 USGS、日本氣象廳、中國地震台網
        {feed.lists.cwa ? '與中央氣象署' : ''}。S 波抵達時間與當地震度都只是估計，請以官方警報為準。
      </p>
    </div>
  )
}
