import { Link } from 'react-router'
import {
  aqiLevel,
  intensityClass,
  isOfficialWestPacific,
  stormName,
  taipeiTime,
  timeAgo,
  useRemote,
  weatherCode,
  type ForecastReport,
  type QuakeSnapshot,
  type SourceStatus,
  type TyphoonReport,
} from './data'
import './weather.css'

/** 頁尾的資料來源與更新時間；有來源抓不到就標出來 */
export function SourceList({ sources, updatedAt }: { sources: SourceStatus[]; updatedAt: string }) {
  return (
    <ul className="source-list" aria-label="資料來源">
      {sources.map((s) => (
        <li key={s.id} className={s.ok ? '' : 'down'} title={s.error}>
          <span className={`live-dot ${s.ok ? 'on' : ''}`}>{s.name}</span>
          {!s.ok && <span className="muted">暫時無法連線</span>}
        </li>
      ))}
      <li className="muted">更新於 {taipeiTime(updatedAt)}</li>
    </ul>
  )
}

function TyphoonCard() {
  const { data, error } = useRemote<TyphoonReport>('/weather/typhoons', 10 * 60 * 1000)
  const storms = (data?.storms ?? []).filter(isOfficialWestPacific)
  return (
    <Link to="/weather/typhoon" className="hub-card">
      <span className="hub-card-icon" aria-hidden="true">
        🌀
      </span>
      <span className="hub-card-body">
        <strong>颱風</strong>
        {error && !data && <span className="error">{error}</span>}
        {!data && !error && <span className="muted">載入中…</span>}
        {data &&
          (storms.length === 0 ? (
            <span className="muted">西北太平洋目前沒有颱風。</span>
          ) : (
            storms.map((s) => (
              <span key={s.id}>
                {stormName(s)}・{intensityClass(s.current.wind_kt).label}・距台灣{' '}
                {s.distance_to_taiwan_km.toLocaleString()} km
              </span>
            ))
          ))}
        <span className="muted">傳統與 AI 兩種預報路徑</span>
      </span>
    </Link>
  )
}

function ForecastCard() {
  const { data, error } = useRemote<ForecastReport>('/weather/forecast', 15 * 60 * 1000)
  const pick = ['taipei', 'taichung', 'kaohsiung', 'hualien']
  const cities = (data?.cities ?? []).filter((c) => pick.includes(c.id))
  return (
    <Link to="/weather/forecast" className="hub-card">
      <span className="hub-card-icon" aria-hidden="true">
        ⛅
      </span>
      <span className="hub-card-body">
        <strong>全台天氣</strong>
        {error && !data && <span className="error">{error}</span>}
        {!data && !error && <span className="muted">載入中…</span>}
        <span className="hub-cities">
          {cities.map((c) =>
            c.current ? (
              <span key={c.id}>
                {c.name.slice(0, 2)} {weatherCode(c.current.weather_code, c.current.is_day === 1).icon}{' '}
                {Math.round(c.current.temperature_2m)}°
              </span>
            ) : null,
          )}
        </span>
        {cities[0]?.air && <span className="muted">臺北空氣品質：{aqiLevel(cities[0].air.us_aqi).label}</span>}
      </span>
    </Link>
  )
}

function QuakeCard() {
  const { data, error } = useRemote<QuakeSnapshot>('/weather/quakes', 3 * 60 * 1000)
  const latest = (data?.lists.cwa ?? data?.lists.usgs_taiwan ?? [])[0]
  return (
    <Link to="/weather/quake" className="hub-card">
      <span className="hub-card-icon" aria-hidden="true">
        📈
      </span>
      <span className="hub-card-body">
        <strong>地震</strong>
        {error && !data && <span className="error">{error}</span>}
        {!data && !error && <span className="muted">載入中…</span>}
        {latest && (
          <span>
            台灣最近：{latest.location}・規模 {latest.magnitude?.toFixed(1) ?? '—'}・{timeAgo(latest.time)}
          </span>
        )}
        <span className="muted">台灣、日本、中國的即時地震速報</span>
      </span>
    </Link>
  )
}

export default function WeatherHub() {
  return (
    <div className="weather-page">
      <h1>天氣與環境</h1>
      <div className="hub-grid">
        <TyphoonCard />
        <ForecastCard />
        <QuakeCard />
      </div>
      <p className="muted fineprint">
        資料每 3～15 分鐘更新一次；颱風強度依中央氣象署的分級，風速以 m/s 與蒲福風級表示。
      </p>
    </div>
  )
}
