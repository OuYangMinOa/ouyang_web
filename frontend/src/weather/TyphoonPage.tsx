import { useMemo, useState } from 'react'
import {
  AGENCIES,
  agencyName,
  formatLatLon,
  intensityClass,
  isOfficialWestPacific,
  stormName,
  stormNumber,
  taipeiTime,
  usePreference,
  useRemote,
  windText,
  type Storm,
  type TrackPoint,
  type TyphoonReport,
} from './data'
import TyphoonMap from './TyphoonMap'
import { SourceList } from './WeatherHub'
import './weather.css'

/** 詳細資料分頁裡 AI 系集的代號（其他分頁是預報單位的 id） */
const AI_TAB = 'ai'

function hasOfficial(storm: Storm) {
  return Object.keys(storm.agencies).length > 0
}

export function IntensityTag({ windKt }: { windKt?: number }) {
  const { level, label } = intensityClass(windKt)
  return <span className={`tc-tag tc-level-${Math.max(level, 0)}`}>{label}</span>
}

function StormChip({ storm, selected, onSelect }: { storm: Storm; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={`storm-chip ${selected ? 'active' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span
        className={`storm-dot tc-level-${Math.max(intensityClass(storm.current.wind_kt).level, 0)}`}
        aria-hidden="true"
      />
      <span className="storm-chip-name">{stormName(storm)}</span>
      {stormNumber(storm) && <span className="muted">{stormNumber(storm)}</span>}
      {!hasOfficial(storm) && <span className="muted">僅 AI</span>}
    </button>
  )
}

function CurrentInfo({ storm }: { storm: Storm }) {
  const { current } = storm
  const facts: [string, string][] = [
    ['位置', formatLatLon(current.lat, current.lon)],
    ['定位時間', taipeiTime(current.time)],
    ['近中心最大風速', windText(current.wind_kt)],
    ['瞬間最大陣風', windText(current.gust_kt)],
    ['中心氣壓', current.pressure_hpa ? `${current.pressure_hpa} hPa` : '—'],
    ['暴風半徑', current.storm_radius_km ? `${current.storm_radius_km} km` : '—'],
    ['距離台灣', `${storm.distance_to_taiwan_km.toLocaleString()} km`],
  ]
  if (storm.closest_forecast_km !== undefined) {
    facts.push(['預報最接近台灣', `${storm.closest_forecast_km.toLocaleString()} km`])
  }
  return (
    <dl className="facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function TrackTable({ points, caption }: { points: TrackPoint[]; caption: string }) {
  if (points.length === 0) return <p className="muted">這個來源沒有提供預報點。</p>
  const showRadius = points.some((p) => p.radius_km !== undefined)
  return (
    <div className="table-wrap">
      <table className="responsive track-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th>時間</th>
            <th>位置</th>
            <th>強度</th>
            <th>最大風速</th>
            <th>氣壓</th>
            {showRadius && <th>70% 機率半徑</th>}
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={`${p.time}-${i}`}>
              <td data-label="時間" className="primary">
                {taipeiTime(p.time)}
              </td>
              <td data-label="位置">{formatLatLon(p.lat, p.lon)}</td>
              <td data-label="強度">{p.wind_kt !== undefined ? <IntensityTag windKt={p.wind_kt} /> : '—'}</td>
              <td data-label="最大風速">{windText(p.wind_kt)}</td>
              <td data-label="氣壓">{p.pressure_hpa ? `${p.pressure_hpa} hPa` : '—'}</td>
              {showRadius && <td data-label="機率半徑">{p.radius_km ? `${p.radius_km} km` : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function TyphoonPage() {
  const { data, error } = useRemote<TyphoonReport>('/weather/typhoons', 10 * 60 * 1000)
  const [showAi, setShowAi] = usePreference<'on' | 'off'>('typhoon-ai', 'on', ['on', 'off'])
  const [selectedId, setSelectedId] = useState<string>()
  const [hidden, setHidden] = useState<string[]>([])
  const [tableTab, setTableTab] = useState<string>()

  // 官方和 AI 畫在同一張圖；有官方資料的排前面，只有 AI 追蹤的熱帶擾動排後面
  const storms = useMemo(
    () => [...(data?.storms ?? [])].sort((a, b) => Number(hasOfficial(b)) - Number(hasOfficial(a))),
    [data],
  )
  const selected = storms.find((s) => s.id === selectedId) ?? storms[0]

  const available = AGENCIES.filter((a) => storms.some((s) => s.agencies[a.id]))
  const shown = available.map((a) => a.id).filter((id) => !hidden.includes(id))
  const anyAi = storms.some((s) => s.ai)
  const tabs = selected
    ? [
        ...AGENCIES.filter((a) => selected.agencies[a.id]).map((a) => ({
          id: a.id,
          label: a.name,
        })),
        ...(selected.ai ? [{ id: AI_TAB, label: 'AI 系集平均' }] : []),
      ]
    : []
  const tab = tabs.find((t) => t.id === tableTab) ?? tabs[0]
  const westPacific = storms.filter(isOfficialWestPacific).length

  function toggleAgency(id: string) {
    setHidden((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <div className="weather-page">
      <div className="weather-head">
        <h1>颱風</h1>
      </div>
      <p className="muted weather-lead">
        各國氣象單位的官方預報和 Google DeepMind 的 AI 系集預報畫在同一張圖。官方：虛線是預報路徑，外圈是 70%
        機率範圍；AI：粗線是平均路徑，細灰線是每個系集成員，越分散代表越不確定。
      </p>

      {error && !data && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">載入中…</p>}

      {data && (
        <>
          {storms.length === 0 ? (
            <div className="card empty-state">
              <p className="empty-icon" aria-hidden="true">
                🌤️
              </p>
              <p>目前全球沒有活動中的颱風或熱帶擾動。</p>
            </div>
          ) : (
            <>
              <div className="storm-chips">
                {storms.map((storm) => (
                  <StormChip
                    key={storm.id}
                    storm={storm}
                    selected={storm.id === selected?.id}
                    onSelect={() => setSelectedId(storm.id)}
                  />
                ))}
              </div>

              <div className="map-controls" role="group" aria-label="地圖圖層">
                {available.map((a) => (
                  <label key={a.id} className={`legend-toggle agency-${a.id}`}>
                    <input type="checkbox" checked={!hidden.includes(a.id)} onChange={() => toggleAgency(a.id)} />
                    <span className="legend-line" aria-hidden="true" />
                    {a.name}
                  </label>
                ))}
                {anyAi && (
                  <label className="legend-toggle layer-ai">
                    <input
                      type="checkbox"
                      checked={showAi === 'on'}
                      onChange={(e) => setShowAi(e.target.checked ? 'on' : 'off')}
                    />
                    <span className="legend-line" aria-hidden="true" />
                    AI 系集（Weather Lab）
                  </label>
                )}
              </div>

              <TyphoonMap storms={storms} selectedId={selected?.id} agencies={shown} ai={showAi === 'on'} />
              <IntensityLegend />

              {selected && (
                <section className="card storm-detail">
                  <div className="storm-detail-head">
                    <h2>{stormName(selected)}</h2>
                    <IntensityTag windKt={selected.current.wind_kt} />
                    {stormNumber(selected) && <span className="chip subtle">{stormNumber(selected)}</span>}
                  </div>
                  <CurrentInfo storm={selected} />

                  <div className="detail-tabs" role="tablist" aria-label="預報來源">
                    {tabs.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={t.id === tab?.id}
                        className={t.id === tab?.id ? 'active' : ''}
                        onClick={() => setTableTab(t.id)}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  {tab?.id === AI_TAB && selected.ai ? (
                    <>
                      <p className="muted">
                        起報時間：{taipeiTime(selected.ai.init_time)}・系集成員 {selected.ai.members.length} 個
                      </p>
                      <TrackTable
                        points={selected.ai.mean.filter((_, i) => i > 0 && i % 2 === 0)}
                        caption="AI 系集平均預報"
                      />
                    </>
                  ) : (
                    tab && (
                      <>
                        <p className="muted">
                          發布時間：
                          {taipeiTime(selected.agencies[tab.id].issued)}
                        </p>
                        <TrackTable points={selected.agencies[tab.id].forecast} caption={`${tab.label}預報`} />
                      </>
                    )
                  )}
                </section>
              )}
            </>
          )}

          {westPacific === 0 && storms.length > 0 && (
            <p className="muted">西北太平洋目前沒有颱風，上面是其他海域的熱帶氣旋。</p>
          )}

          <SourceList sources={data.sources} updatedAt={data.updated_at} />
          <p className="muted fineprint">
            官方資料：{available.map((a) => agencyName(a.id)).join('、') || '—'}
            ；JTWC 與 NHC 經由 GDACS 取得。AI 預報是 Google DeepMind 的實驗性資料（即時資料依其使用條款，過去資料為 CC
            BY 4.0），僅供參考。防颱請以中央氣象署發布為準。
          </p>
        </>
      )}
    </div>
  )
}

export function IntensityLegend() {
  return (
    <ul className="legend" aria-label="強度圖例">
      {['熱帶性低氣壓', '輕度颱風', '中度颱風', '強烈颱風'].map((label, level) => (
        <li key={label}>
          <span className={`storm-dot tc-level-${level}`} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  )
}
