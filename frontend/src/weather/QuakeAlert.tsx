import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router'
import {
  ACTIVE_MS,
  CITY_POINTS,
  cityPoint,
  EEW_SOURCES,
  eewAtCity,
  intensityValue,
  QUAKE_CITY_KEY,
  useNow,
  usePreference,
  type Eew,
} from './data'
import { useQuakeFeed } from './quakeFeed'
import './quake-alert.css'

const QUAKE_PAGE = '/weather/quake'

function alertKey(eew: Eew) {
  return `${eew.source}-${eew.event_id}`
}

/** 依預估當地震度上色：4 級以下黃、4 級橘、5 弱以上紅 */
function alertLevel(estimate: string | undefined) {
  const value = intensityValue(estimate)
  if (value >= 5) return 3
  if (value >= 4) return 2
  return 1
}

/**
 * 頁首的地震速報，每一頁都看得到（地震頁本身有完整的速報卡，就不重複顯示）。
 * 不分來源，依使用者所在縣市判斷要不要警報（門檻見 `eewAtCity`）；同時有好幾筆時只顯示預估震度最大的。
 */
export default function QuakeAlert() {
  const { eew } = useQuakeFeed()
  const { pathname } = useLocation()
  const [cityId, setCityId] = usePreference<string>(QUAKE_CITY_KEY, 'taipei')
  const [dismissed, setDismissed] = useState<string[]>([])
  const city = cityPoint(cityId)

  const roughNow = useNow(false)
  const recent = useMemo(
    () => eew.filter((e) => !e.is_cancel && roughNow - Date.parse(e.origin_time) < ACTIVE_MS),
    [eew, roughNow],
  )
  const now = useNow(recent.length > 0)

  const alerts = recent
    .filter((e) => now - Date.parse(e.origin_time) < ACTIVE_MS && !dismissed.includes(alertKey(e)))
    .map((e) => ({ eew: e, ...eewAtCity(e, city) }))
    .filter((a) => a.alert)
    .sort(
      (a, b) =>
        intensityValue(b.estimate) - intensityValue(a.estimate) ||
        Number(b.eew.source === 'cwa') - Number(a.eew.source === 'cwa'),
    )
  const top = alerts[0]

  // 分頁標題也加上速報，切到別的分頁時看得到
  const title = top ? `【地震速報】${top.eew.hypocenter || '地震'}` : null
  useEffect(() => {
    if (!title) return
    const original = document.title
    document.title = `${title}｜${original}`
    return () => {
      document.title = original
    }
  }, [title])

  if (!top || pathname === QUAKE_PAGE) return null

  const { eew: quake, estimate, sArrival } = top
  const remaining = Math.ceil((sArrival - now) / 1000)

  return (
    <div className={`quake-alert quake-alert-${alertLevel(estimate)}`} role="alert">
      <div className="quake-alert-inner">
        <p className="quake-alert-main">
          <span className="quake-alert-badge">{quake.is_training ? '測試' : '地震速報'}</span>
          <Link to={QUAKE_PAGE} className="quake-alert-place" title="到地震頁看詳細資訊">
            {quake.hypocenter || '震央不明'}
          </Link>
          <span>
            規模 {quake.magnitude?.toFixed(1) ?? '—'}
            {quake.depth_km !== undefined && `・深度 ${quake.depth_km} km`}
          </span>
          <span className="quake-alert-source">{EEW_SOURCES[quake.source]}</span>
        </p>
        <div className="quake-alert-local">
          <select aria-label="我所在的縣市" value={city.id} onChange={(e) => setCityId(e.target.value)}>
            {CITY_POINTS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="quake-alert-seconds" aria-live="off">
            {remaining > 0 ? (
              <>
                S 波 <strong>{remaining}</strong> 秒後抵達
              </>
            ) : (
              'S 波已抵達'
            )}
          </span>
          {estimate !== undefined && <span>預估震度 {estimate}</span>}
        </div>
        <button
          type="button"
          className="quake-alert-close"
          onClick={() => setDismissed((prev) => [...prev, ...alerts.map((a) => alertKey(a.eew))])}
          aria-label="關閉這則速報"
          title="關閉"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
