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
import TyphoonMap, { type TyphoonMode } from './TyphoonMap'
import { SourceList } from './WeatherHub'
import './weather.css'

const MODES: { value: TyphoonMode; label: string }[] = [
  { value: 'official', label: '傳統模式' },
  { value: 'ai', label: 'AI 模式' },
]

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
  const [mode, setMode] = usePreference<TyphoonMode>('typhoon-mode', 'official', ['official', 'ai'])
  const [selectedId, setSelectedId] = useState<string>()
  const [hidden, setHidden] = useState<string[]>([])
  const [compare, setCompare] = useState(true)
  const [tableAgency, setTableAgency] = useState<string>()

  // 傳統模式只列有官方資料的，AI 模式只列有 AI 路徑的
  const storms = useMemo(
    () => (data?.storms ?? []).filter((s) => (mode === 'ai' ? s.ai : Object.keys(s.agencies).length > 0)),
    [data, mode],
  )
  const selected = storms.find((s) => s.id === selectedId) ?? storms[0]

  const available = AGENCIES.filter((a) => storms.some((s) => s.agencies[a.id]))
  const shown = available.map((a) => a.id).filter((id) => !hidden.includes(id))
  const selectedAgencies = selected ? AGENCIES.filter((a) => selected.agencies[a.id]) : []
  const table = selectedAgencies.find((a) => a.id === tableAgency) ?? selectedAgencies[0]
  const westPacific = (data?.storms ?? []).filter(isOfficialWestPacific).length

  function toggleAgency(id: string) {
    setHidden((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <div className="weather-page">
      <div className="weather-head">
        <h1>颱風</h1>
        <div className="mode-switch" role="group" aria-label="預報模式">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={mode === m.value ? 'active' : ''}
              aria-pressed={mode === m.value}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted weather-lead">
        {mode === 'official'
          ? '各國氣象單位發布的官方路徑與強度預報。虛線是預報路徑，外圈是 70% 機率範圍。'
          : 'Google DeepMind Weather Lab 的 AI 系集預報：粗線是平均路徑，細線是每個系集成員，越分散代表越不確定。'}
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
              <p>{mode === 'ai' ? 'AI 目前沒有追蹤中的熱帶氣旋。' : '目前全球沒有活動中的颱風。'}</p>
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

              <div className="map-controls">
                {mode === 'official' ? (
                  available.map((a) => (
                    <label key={a.id} className={`legend-toggle agency-${a.id}`}>
                      <input type="checkbox" checked={!hidden.includes(a.id)} onChange={() => toggleAgency(a.id)} />
                      <span className="legend-line" aria-hidden="true" />
                      {a.name}
                    </label>
                  ))
                ) : (
                  <label className="legend-toggle">
                    <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
                    對照官方路徑
                  </label>
                )}
              </div>

              <TyphoonMap
                storms={storms}
                selectedId={selected?.id}
                mode={mode}
                agencies={shown}
                compareOfficial={compare}
              />
              <IntensityLegend />

              {selected && (
                <section className="card storm-detail">
                  <div className="storm-detail-head">
                    <h2>{stormName(selected)}</h2>
                    <IntensityTag windKt={selected.current.wind_kt} />
                    {stormNumber(selected) && <span className="chip subtle">{stormNumber(selected)}</span>}
                  </div>
                  <CurrentInfo storm={selected} />

                  {mode === 'official' ? (
                    <>
                      <div className="detail-tabs" role="tablist" aria-label="預報單位">
                        {selectedAgencies.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            role="tab"
                            aria-selected={a.id === table?.id}
                            className={a.id === table?.id ? 'active' : ''}
                            onClick={() => setTableAgency(a.id)}
                          >
                            {a.name}
                          </button>
                        ))}
                      </div>
                      {table && (
                        <>
                          <p className="muted">發布時間：{taipeiTime(selected.agencies[table.id].issued)}</p>
                          <TrackTable points={selected.agencies[table.id].forecast} caption={`${table.name}預報`} />
                        </>
                      )}
                    </>
                  ) : (
                    selected.ai && (
                      <>
                        <p className="muted">
                          起報時間：{taipeiTime(selected.ai.init_time)}・系集成員 {selected.ai.members.length} 個
                        </p>
                        <TrackTable
                          points={selected.ai.mean.filter((_, i) => i > 0 && i % 2 === 0)}
                          caption="AI 系集平均預報"
                        />
                      </>
                    )
                  )}
                </section>
              )}
            </>
          )}

          {mode === 'official' && westPacific === 0 && storms.length > 0 && (
            <p className="muted">西北太平洋目前沒有颱風，上面是其他海域的熱帶氣旋。</p>
          )}

          <SourceList sources={data.sources} updatedAt={data.updated_at} />
          <p className="muted fineprint">
            {mode === 'ai'
              ? 'AI 預報是 Google DeepMind 的實驗性資料（即時資料依其使用條款，過去資料為 CC BY 4.0），僅供參考，防颱請以中央氣象署發布為準。'
              : `官方資料：${available.map((a) => agencyName(a.id)).join('、') || '—'}；JTWC 與 NHC 經由 GDACS 取得。防颱請以中央氣象署發布為準。`}
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
