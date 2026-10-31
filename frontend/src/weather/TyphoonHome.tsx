import { lazy, Suspense } from 'react'
import { Link } from 'react-router'
import {
  formatLatLon,
  intensityClass,
  isOfficialWestPacific,
  stormName,
  stormNumber,
  taipeiTime,
  useRemote,
  windText,
  type TyphoonReport,
} from './data'
import './weather.css'

// 地圖（Leaflet）只在真的有颱風時才下載
const TyphoonMap = lazy(() => import('./TyphoonMap'))

/** 首頁的颱風區：西北太平洋有颱風才出現 */
export default function TyphoonHome() {
  const { data } = useRemote<TyphoonReport>('/weather/typhoons', 10 * 60 * 1000)
  const storms = (data?.storms ?? []).filter(isOfficialWestPacific)
  if (storms.length === 0) return null
  const agencies = ['cwa', 'jma', 'jtwc'].filter((id) => storms.some((s) => s.agencies[id]))
  // 首頁只畫一家，優先用中央氣象署
  const primary = agencies.slice(0, 1)

  return (
    <section className="home-section typhoon-home" aria-labelledby="typhoon-home-title">
      <div className="home-wrap">
        <p className="kicker">
          <span>⚠</span> TYPHOON WATCH
        </p>
        <h2 id="typhoon-home-title" className="typhoon-home-title">
          颱風動態
        </h2>
        <div className="typhoon-home-grid">
          <ul className="typhoon-home-list">
            {storms.map((storm) => {
              const { level, label } = intensityClass(storm.current.wind_kt)
              return (
                <li key={storm.id} className="card">
                  <div className="storm-detail-head">
                    <span className={`storm-dot tc-level-${Math.max(level, 0)}`} aria-hidden="true" />
                    <h3>{stormName(storm)}</h3>
                    <span className={`tc-tag tc-level-${Math.max(level, 0)}`}>{label}</span>
                  </div>
                  <p className="muted">
                    {stormNumber(storm) ?? ''} {formatLatLon(storm.current.lat, storm.current.lon)}・
                    {taipeiTime(storm.current.time)}
                  </p>
                  <p>
                    最大風速 {windText(storm.current.wind_kt)}
                    {storm.current.pressure_hpa ? `・${storm.current.pressure_hpa} hPa` : ''}
                  </p>
                  <p>
                    距離台灣 <strong>{storm.distance_to_taiwan_km.toLocaleString()} km</strong>
                    {storm.closest_forecast_km !== undefined && (
                      <>，預報最近 {storm.closest_forecast_km.toLocaleString()} km</>
                    )}
                  </p>
                </li>
              )
            })}
            <li>
              <Link className="work-link" to="/weather/typhoon">
                看完整路徑與 AI 預報 →
              </Link>
            </li>
          </ul>
          <Suspense fallback={<div className="weather-map typhoon-home-map" />}>
            <TyphoonMap storms={storms} mode="official" agencies={primary} className="typhoon-home-map" />
          </Suspense>
        </div>
      </div>
    </section>
  )
}
