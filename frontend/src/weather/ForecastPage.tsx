import { useMemo } from 'react'
import {
  aqiLevel,
  REGIONS,
  usePreference,
  useRemote,
  weatherCode,
  windDirection,
  beaufort,
  type CityWeather,
  type ForecastReport,
} from './data'
import { SourceList } from './WeatherHub'
import './weather.css'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** "2026-10-31" → 「今天」「明天」「週六」 */
function dayLabel(date: string, index: number) {
  if (index === 0) return '今天'
  if (index === 1) return '明天'
  const [y, m, d] = date.split('-').map(Number)
  return `週${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`
}

/** 逐時預報的那個小時是不是白天（用當天的日出日落，時間都是台灣時間的字串，可以直接比） */
function isDaytime(time: string, daily: CityWeather['daily']) {
  const index = daily?.time.indexOf(time.slice(0, 10)) ?? -1
  if (!daily || index < 0) {
    const hour = Number(time.slice(11, 13))
    return hour >= 6 && hour < 18
  }
  return time >= daily.sunrise[index] && time < daily.sunset[index]
}

function shortDate(date: string) {
  const [, m, d] = date.split('-').map(Number)
  return `${m}/${d}`
}

function AqiBadge({ aqi }: { aqi?: number }) {
  if (aqi === undefined) return null
  const { level, label } = aqiLevel(aqi)
  return (
    <span className={`aqi-badge aqi-${level}`} title={`空氣品質指標（美國 AQI）：${label}`}>
      AQI {aqi}
    </span>
  )
}

function CityCard({ city, selected, onSelect }: { city: CityWeather; selected: boolean; onSelect: () => void }) {
  const current = city.current
  const daily = city.daily
  const code = current ? weatherCode(current.weather_code, current.is_day === 1) : null
  return (
    <button
      type="button"
      className={`city-card ${selected ? 'active' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="city-card-top">
        <strong>{city.name}</strong>
        <AqiBadge aqi={city.air?.us_aqi} />
      </span>
      {current && code ? (
        <>
          <span className="city-card-now">
            <span className="city-icon" aria-hidden="true">
              {code.icon}
            </span>
            <span className="city-temp">{Math.round(current.temperature_2m)}°</span>
          </span>
          <span className="city-card-meta">
            {code.label}
            {daily && (
              <>
                {' · '}
                {Math.round(daily.temperature_2m_min[0])}–{Math.round(daily.temperature_2m_max[0])}°{' · '}☂{' '}
                {daily.precipitation_probability_max[0] ?? 0}%
              </>
            )}
          </span>
        </>
      ) : (
        <span className="muted">沒有資料</span>
      )}
    </button>
  )
}

function CityDetail({ city }: { city: CityWeather }) {
  const { current, hourly, daily, air } = city
  if (!current) return null
  const code = weatherCode(current.weather_code, current.is_day === 1)
  const facts: [string, string][] = [
    ['體感溫度', `${Math.round(current.apparent_temperature)}°`],
    ['相對濕度', `${current.relative_humidity_2m}%`],
    [
      '風',
      `${windDirection(current.wind_direction_10m)} ${current.wind_speed_10m.toFixed(1)} m/s（${beaufort(current.wind_speed_10m)} 級）`,
    ],
    ['陣風', `${current.wind_gusts_10m.toFixed(1)} m/s`],
    ['降雨量', `${current.precipitation} mm`],
  ]
  if (daily) {
    facts.push(['紫外線', `${Math.round(daily.uv_index_max[0] ?? 0)}`])
    facts.push(['日出／日落', `${daily.sunrise[0]?.slice(11)} ／ ${daily.sunset[0]?.slice(11)}`])
  }
  if (air) {
    facts.push(['PM2.5', `${Math.round(air.pm2_5)} μg/m³`])
    facts.push(['空氣品質', `${aqiLevel(air.us_aqi).label}（AQI ${air.us_aqi}）`])
  }

  return (
    <section className="card city-detail" aria-label={`${city.name}天氣`}>
      <div className="city-detail-head">
        <span className="city-detail-icon" aria-hidden="true">
          {code.icon}
        </span>
        <div>
          <h2>{city.name}</h2>
          <p className="muted">
            {code.label} · 觀測 {current.time.slice(11)}
          </p>
        </div>
        <span className="city-detail-temp">{Math.round(current.temperature_2m)}°</span>
      </div>
      <dl className="facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {hourly && (
        <>
          <h3 className="sub-head">未來 24 小時</h3>
          <ol className="hourly" aria-label="逐時預報">
            {hourly.time.map((time, i) => {
              const c = weatherCode(hourly.weather_code[i], isDaytime(time, daily))
              return (
                <li key={time}>
                  <span className="muted">{time.slice(11, 13)} 時</span>
                  <span aria-label={c.label} title={c.label}>
                    {c.icon}
                  </span>
                  <strong>{Math.round(hourly.temperature_2m[i])}°</strong>
                  <span className="rain">☂ {hourly.precipitation_probability[i] ?? 0}%</span>
                </li>
              )
            })}
          </ol>
        </>
      )}

      {daily && (
        <>
          <h3 className="sub-head">一週預報</h3>
          <ol className="daily" aria-label="一週預報">
            {daily.time.map((date, i) => {
              const c = weatherCode(daily.weather_code[i])
              return (
                <li key={date}>
                  <span className="daily-day">
                    <strong>{dayLabel(date, i)}</strong>
                    <span className="muted">{shortDate(date)}</span>
                  </span>
                  <span className="daily-icon" aria-hidden="true">
                    {c.icon}
                  </span>
                  <span className="daily-label">{c.label}</span>
                  <span className="rain">☂ {daily.precipitation_probability_max[i] ?? 0}%</span>
                  <span className="daily-temp">
                    {Math.round(daily.temperature_2m_min[i])}° /{' '}
                    <strong>{Math.round(daily.temperature_2m_max[i])}°</strong>
                  </span>
                </li>
              )
            })}
          </ol>
        </>
      )}
    </section>
  )
}

export default function ForecastPage() {
  const { data, error } = useRemote<ForecastReport>('/weather/forecast', 15 * 60 * 1000)
  const [cityId, setCityId] = usePreference<string>('weather-city', 'taipei')
  const byRegion = useMemo(
    () => REGIONS.map((region) => ({ region, cities: (data?.cities ?? []).filter((c) => c.region === region) })),
    [data],
  )
  const city = data?.cities.find((c) => c.id === cityId) ?? data?.cities[0]

  return (
    <div className="weather-page">
      <h1>全台天氣</h1>
      {error && !data && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">載入中…</p>}
      {data && (
        <>
          {city && <CityDetail city={city} />}
          {byRegion.map(({ region, cities }) => (
            <section key={region}>
              <h2>{region}</h2>
              <div className="city-grid">
                {cities.map((c) => (
                  <CityCard
                    key={c.id}
                    city={c}
                    selected={c.id === city?.id}
                    onSelect={() => {
                      setCityId(c.id)
                      window.scrollTo({ top: 0, behavior: 'smooth' })
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
          <SourceList sources={data.sources} updatedAt={data.updated_at} />
          <p className="muted fineprint">
            天氣與空氣品質來自 <a href="https://open-meteo.com/">Open-Meteo</a>（模式預報，CC BY 4.0），空氣品質是美國
            AQI 標準，和環境部的 AQI 略有不同。
          </p>
        </>
      )}
    </div>
  )
}
