// 天氣與環境：後端 /api/weather/* 的資料格式（backend/src/weather/），以及共用的換算與格式化

import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api'

export type SourceStatus = { id: string; name: string; ok: boolean; error?: string }

// ---------- 颱風 ----------

export type TrackPoint = {
  /** UTC；日本氣象廳的過去路徑沒有時間 */
  time?: string
  lat: number
  lon: number
  wind_kt?: number
  gust_kt?: number
  pressure_hpa?: number
  category?: string
  /** 70% 機率圓半徑 */
  radius_km?: number
  /** 暴風圈半徑 */
  storm_radius_km?: number
}

export type Forecast = {
  agency: string
  issued?: string
  /** 最後一點是目前位置 */
  past: TrackPoint[]
  forecast: TrackPoint[]
  /** [lat, lon] */
  cone?: [number, number][]
}

export type AiForecast = {
  model: string
  track_id: string
  init_time: string
  mean: TrackPoint[]
  /** 每個成員的 [預報第幾小時, lat, lon] */
  members: [number, number, number][][]
}

export type Storm = {
  id: string
  name_en?: string
  name_zh?: string
  number?: string
  current: TrackPoint
  west_pacific: boolean
  distance_to_taiwan_km: number
  closest_forecast_km?: number
  agencies: Record<string, Forecast>
  ai?: AiForecast
}

export type TyphoonReport = { updated_at: string; storms: Storm[]; sources: SourceStatus[] }

/** 顯示順序與名稱；顏色對應 weather.css 的 --agency-<id> */
export const AGENCIES: { id: string; name: string; short: string }[] = [
  { id: 'cwa', name: '中央氣象署', short: '台灣' },
  { id: 'jma', name: '日本氣象廳', short: '日本' },
  { id: 'jtwc', name: '美軍聯合颱風警報中心', short: 'JTWC' },
  { id: 'nhc', name: '美國國家颶風中心', short: 'NHC' },
]

export function agencyName(id: string) {
  return AGENCIES.find((a) => a.id === id)?.name ?? id.toUpperCase()
}

/** 有官方資料、而且在西北太平洋的才算「影響台灣這一區的颱風」 */
export function isOfficialWestPacific(storm: Storm) {
  return storm.west_pacific && Object.keys(storm.agencies).length > 0
}

export function stormName(storm: Storm) {
  if (storm.name_zh) return storm.name_en ? `${storm.name_zh}（${storm.name_en}）` : storm.name_zh
  if (storm.name_en) return storm.name_en
  if (storm.ai && Object.keys(storm.agencies).length === 0) return `熱帶擾動 ${storm.ai.track_id}`
  return '熱帶性低氣壓'
}

/** 日本的颱風編號 2631 → 第 31 號 */
export function stormNumber(storm: Storm) {
  return storm.number ? `第 ${Number(storm.number.slice(2))} 號` : undefined
}

export const KT_TO_MS = 0.514444

/** 台灣的颱風強度分級（依近中心最大風速） */
export function intensityClass(windKt?: number): { level: number; label: string } {
  if (windKt === undefined) return { level: -1, label: '—' }
  const ms = windKt * KT_TO_MS
  if (ms < 17.2) return { level: 0, label: '熱帶性低氣壓' }
  if (ms < 32.7) return { level: 1, label: '輕度颱風' }
  if (ms < 51) return { level: 2, label: '中度颱風' }
  return { level: 3, label: '強烈颱風' }
}

/** 蒲福風級 */
export function beaufort(ms: number) {
  const limits = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37.0, 41.5, 46.2, 51.0, 56.1, 61.3]
  const index = limits.findIndex((limit) => ms < limit)
  return index === -1 ? 17 : index
}

export function windText(kt?: number) {
  if (kt === undefined) return '—'
  const ms = kt * KT_TO_MS
  return `${Math.round(ms)} m/s（${beaufort(ms)} 級）`
}

// ---------- 天氣 ----------

export type CityWeather = {
  id: string
  name: string
  region: string
  lat: number
  lon: number
  current: {
    time: string
    temperature_2m: number
    relative_humidity_2m: number
    apparent_temperature: number
    precipitation: number
    weather_code: number
    wind_speed_10m: number
    wind_direction_10m: number
    wind_gusts_10m: number
    is_day: number
  } | null
  hourly: {
    time: string[]
    temperature_2m: number[]
    precipitation_probability: number[]
    weather_code: number[]
  } | null
  daily: {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
    precipitation_probability_max: number[]
    precipitation_sum: number[]
    uv_index_max: number[]
    sunrise: string[]
    sunset: string[]
  } | null
  air: { time: string; us_aqi: number; pm2_5: number; pm10: number } | null
}

export type ForecastReport = { updated_at: string; cities: CityWeather[]; sources: SourceStatus[] }

export const REGIONS = ['北部', '中部', '南部', '東部', '離島']

/** WMO 天氣代碼 → 圖示與說明（Open-Meteo 用的就是這套） */
export function weatherCode(code: number, isDay = true): { icon: string; label: string } {
  if (code === 0) return isDay ? { icon: '☀️', label: '晴' } : { icon: '🌙', label: '晴' }
  if (code === 1) return isDay ? { icon: '🌤️', label: '大致晴朗' } : { icon: '🌙', label: '大致晴朗' }
  if (code === 2) return { icon: '⛅', label: '多雲' }
  if (code === 3) return { icon: '☁️', label: '陰' }
  if (code === 45 || code === 48) return { icon: '🌫️', label: '霧' }
  if (code >= 51 && code <= 57) return { icon: '🌦️', label: '毛毛雨' }
  if (code === 61 || code === 80) return { icon: '🌦️', label: '小雨' }
  if (code === 63 || code === 81) return { icon: '🌧️', label: '雨' }
  if (code === 65 || code === 82) return { icon: '🌧️', label: '大雨' }
  if (code === 66 || code === 67) return { icon: '🌧️', label: '凍雨' }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: '🌨️', label: '雪' }
  if (code >= 95) return { icon: '⛈️', label: '雷雨' }
  return { icon: '🌡️', label: '—' }
}

/** 美國 AQI 的六個等級；顏色對應 weather.css 的 --aqi-<level> */
export function aqiLevel(aqi: number): { level: number; label: string } {
  const levels = ['良好', '普通', '對敏感族群不健康', '對所有族群不健康', '非常不健康', '危害']
  const index = [50, 100, 150, 200, 300].findIndex((limit) => aqi <= limit)
  const level = index === -1 ? 5 : index
  return { level, label: levels[level] }
}

const COMPASS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北']

/** 風向是「從哪裡吹來」 */
export function windDirection(degrees: number) {
  return `${COMPASS[Math.round(degrees / 45) % 8]}風`
}

// ---------- 地震 ----------

export type Eew = {
  source: 'cwa' | 'jma' | 'sc' | 'fj'
  event_id: string
  serial?: number
  origin_time: string
  report_time?: string
  hypocenter: string
  lat: number
  lon: number
  magnitude?: number
  depth_km?: number
  max_intensity?: string
  is_final: boolean
  is_cancel: boolean
  is_warn: boolean
  is_training: boolean
}

export type QuakeReport = {
  id: string
  time: string
  location: string
  lat: number
  lon: number
  magnitude?: number
  depth_km?: number
  max_intensity?: string
  url?: string
  info?: string
}

export type FeedStatus = {
  path: string
  name: string
  connected: boolean
  via?: 'relay' | 'direct'
  last_message_at?: string
  last_error?: string
}

export type QuakeSnapshot = {
  updated_at: string
  eew: Eew[]
  lists: Record<string, QuakeReport[]>
  feeds: FeedStatus[]
  sources: SourceStatus[]
}

export const EEW_SOURCES: Record<Eew['source'], string> = {
  cwa: '中央氣象署',
  jma: '日本氣象廳',
  sc: '四川地震局',
  fj: '福建地震局',
}

/** 台灣、日本的是震度（0～7），中國的是烈度（1～12），單位不一樣 */
export function intensityUnit(source: string) {
  return source === 'sc' || source === 'fj' || source === 'cenc' ? '烈度' : '震度'
}

/** 震度的危險程度 0～3，用來決定顏色；中國烈度大約減 2 對到震度 */
export function intensityLevel(intensity: string | undefined, source: string) {
  if (!intensity) return 0
  let value = parseFloat(intensity)
  if (Number.isNaN(value)) return 0
  if (intensityUnit(source) === '烈度') value -= 2
  if (intensity.endsWith('強')) value += 0.5
  if (value >= 5) return 3
  if (value >= 4) return 2
  if (value >= 3) return 1
  return 0
}

/** 震源深度分三級：淺層（<30 km）、中層（<70 km）、深層 */
export function depthLevel(depth?: number) {
  if (depth === undefined) return 'mid'
  if (depth < 30) return 'shallow'
  if (depth < 70) return 'mid'
  return 'deep'
}

// ---------- 共用 ----------

const TAIPEI_TIME = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** 一律用台灣時間顯示：10/31 14:00 */
export function taipeiTime(iso?: string) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const parts = Object.fromEntries(TAIPEI_TIME.formatToParts(date).map((p) => [p.type, p.value]))
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`
}

/** 「3 分鐘前」 */
export function timeAgo(iso: string, now = Date.now()) {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${Math.max(seconds, 0)} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分鐘前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小時前`
  return `${Math.floor(seconds / 86400)} 天前`
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function formatLatLon(lat: number, lon: number) {
  const ns = lat >= 0 ? `北緯 ${lat.toFixed(1)}°` : `南緯 ${(-lat).toFixed(1)}°`
  const normalized = ((lon + 540) % 360) - 180
  const ew = normalized >= 0 ? `東經 ${normalized.toFixed(1)}°` : `西經 ${(-normalized).toFixed(1)}°`
  return `${ns}、${ew}`
}

type Remote<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** 抓一次，之後每 `refreshMs` 重抓（後端有快取，重抓很便宜） */
export function useRemote<T>(path: string, refreshMs: number): Remote<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    api<T>(path)
      .then((value) => {
        if (cancelled) return
        setData(value)
        setError(null)
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
    const timer = setTimeout(() => setTick((t) => t + 1), refreshMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [path, refreshMs, tick])

  return { data, error, loading: data === null && error === null, reload: () => setTick((t) => t + 1) }
}

/** 存在 localStorage 的小偏好（選的縣市、模式），讀寫失敗就只在這次有效 */
export function usePreference<T extends string>(key: string, fallback: T, allowed?: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key) as T | null
      if (stored !== null && (!allowed || allowed.includes(stored))) return stored
    } catch {
      // 讀不到就用預設值
    }
    return fallback
  })

  function update(next: T) {
    setValue(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      // 存不了就只在這次有效
    }
  }

  return [value, update] as const
}

/** 縣市政府附近的座標（和 backend/src/weather/forecast.rs 的 CITIES 一樣），地震頁算 S 波抵達時間用 */
export const CITY_POINTS: { id: string; name: string; lat: number; lon: number }[] = [
  { id: 'keelung', name: '基隆市', lat: 25.1283, lon: 121.7419 },
  { id: 'taipei', name: '臺北市', lat: 25.0375, lon: 121.5637 },
  { id: 'new-taipei', name: '新北市', lat: 25.012, lon: 121.4657 },
  { id: 'taoyuan', name: '桃園市', lat: 24.9937, lon: 121.301 },
  { id: 'hsinchu-city', name: '新竹市', lat: 24.8039, lon: 120.9647 },
  { id: 'hsinchu', name: '新竹縣', lat: 24.8387, lon: 121.0178 },
  { id: 'yilan', name: '宜蘭縣', lat: 24.757, lon: 121.7533 },
  { id: 'miaoli', name: '苗栗縣', lat: 24.5602, lon: 120.8214 },
  { id: 'taichung', name: '臺中市', lat: 24.1477, lon: 120.6736 },
  { id: 'changhua', name: '彰化縣', lat: 24.0752, lon: 120.544 },
  { id: 'nantou', name: '南投縣', lat: 23.9097, lon: 120.6838 },
  { id: 'yunlin', name: '雲林縣', lat: 23.7092, lon: 120.4313 },
  { id: 'chiayi-city', name: '嘉義市', lat: 23.4801, lon: 120.4491 },
  { id: 'chiayi', name: '嘉義縣', lat: 23.4588, lon: 120.293 },
  { id: 'tainan', name: '臺南市', lat: 22.9908, lon: 120.2133 },
  { id: 'kaohsiung', name: '高雄市', lat: 22.6273, lon: 120.3014 },
  { id: 'pingtung', name: '屏東縣', lat: 22.6762, lon: 120.488 },
  { id: 'hualien', name: '花蓮縣', lat: 23.9772, lon: 121.6044 },
  { id: 'taitung', name: '臺東縣', lat: 22.7583, lon: 121.1444 },
  { id: 'penghu', name: '澎湖縣', lat: 23.5711, lon: 119.5793 },
  { id: 'kinmen', name: '金門縣', lat: 24.4321, lon: 118.3171 },
  { id: 'lienchiang', name: '連江縣', lat: 26.1602, lon: 119.9497 },
]

export const P_WAVE_KMS = 6.5
export const S_WAVE_KMS = 3.5

/** 震源到某地的距離（公里，含深度） */
export function hypocentralKm(quake: { lat: number; lon: number; depth_km?: number }, lat: number, lon: number) {
  const surface = distanceKm(quake.lat, quake.lon, lat, lon)
  return Math.hypot(surface, quake.depth_km ?? 10)
}

/**
 * 粗估某地的震度：PGA = 1.657·e^(1.533·M)·r^(-1.607)（台灣常用的衰減式），再換成震度。
 * 只是估計，實際震度會因地盤差很多。
 */
export function estimateIntensity(magnitude: number, distance: number) {
  const pga = 1.657 * Math.exp(1.533 * magnitude) * Math.pow(Math.max(distance, 1), -1.607)
  const limits: [number, string][] = [
    [0.8, '0'],
    [2.5, '1'],
    [8, '2'],
    [25, '3'],
    [80, '4'],
    [140, '5弱'],
    [250, '5強'],
    [440, '6弱'],
    [800, '6強'],
  ]
  return limits.find(([limit]) => pga < limit)?.[1] ?? '7'
}
