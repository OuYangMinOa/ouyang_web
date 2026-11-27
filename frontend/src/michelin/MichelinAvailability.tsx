// /michelin/availability：星級餐廳近兩週的空位（要登入）。
// 資料是家裡電腦上的爬蟲每 3 小時上傳的（backend/src/michelin_availability.rs），這頁只讀最新的那一次。

import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { ApiError, api, errorMessage } from '../api'
import { useAuth } from '../auth'
import { REGIONS } from './data'
import { formatWhen } from './mine'
import { AwardBadge } from './RestaurantCard'
import {
  STALE_HOURS,
  ago,
  buildRows,
  dayLabel,
  isWeekend,
  phoneHref,
  safeUrl,
  sourceLabel,
  statusLabel,
  taipeiTime,
  upcomingDays,
  type Availability,
  type DayCell,
  type Row,
} from './availability'
import './michelin.css'

type Loaded = { user: number; data: Availability | null; error: string | null }

/** 人數、只看有空位、地區記在這個瀏覽器（讀寫失敗就用預設值） */
function useStored<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback
    }
  })
  const set = (next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // 無痕模式之類存不了，這次有效就好
    }
  }
  return [value, set] as const
}

export default function MichelinAvailability() {
  const { user, loading } = useAuth()
  const { pathname } = useLocation()
  const userId = user?.id ?? null
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const current = userId !== null && loaded?.user === userId ? loaded : null

  useEffect(() => {
    if (userId === null) return
    let alive = true
    api<{ availability: Availability | null }>('/michelin/availability')
      .then((r) => alive && setLoaded({ user: userId, data: r.availability, error: null }))
      .catch((e) => {
        if (!alive) return
        const message = e instanceof ApiError && e.status === 401 ? '登入過期了，請重新登入。' : errorMessage(e)
        setLoaded({ user: userId, data: null, error: message })
      })
    return () => {
      alive = false
    }
  }, [userId])

  if (loading) return <p className="muted">載入中…</p>
  if (userId === null) {
    return (
      <div className="mich-av-page">
        <h1>星級餐廳空位</h1>
        <div className="card narrow">
          <p>登入後可以看台灣米其林星級餐廳近兩週還有哪些時段可以訂（2、4、6 位）。</p>
          <Link to="/login" state={{ from: pathname }} className="mich-me-login">
            登入
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mich-av-page">
      <h1>星級餐廳空位</h1>
      {!current ? (
        <p className="muted">載入中…</p>
      ) : current.error ? (
        <p className="error">{current.error}</p>
      ) : !current.data ? (
        <div className="mich-me-section">
          <p>還沒有資料。空位是家裡電腦上的爬蟲跑完上傳的，等它跑完一次就會出現。</p>
        </div>
      ) : (
        <Board data={current.data} />
      )}
    </div>
  )
}

function Board({ data }: { data: Availability }) {
  const parties = data.parties.length > 0 ? data.parties : [2]
  const [storedParty, setParty] = useStored('michelin-availability-party', parties[0])
  const party = parties.includes(storedParty) ? storedParty : parties[0]
  const [onlyOpen, setOnlyOpen] = useStored('michelin-availability-open', false)
  const [region, setRegion] = useStored('michelin-availability-region', 'all')
  // 已經過去的時段要濾掉；頁面一直開著時每分鐘重算一次
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const rows = useMemo(() => buildRows(data, party, taipeiTime(now)), [data, party, now])
  const days = upcomingDays(data, taipeiTime(now))
  const cities = REGIONS.find((r) => r.slug === region)?.cities
  // 統計跟著地區走，「只看有空位」只影響下面列出哪些
  const inRegion = cities ? rows.filter((row) => row.restaurant && cities.includes(row.restaurant.city)) : rows
  const shown = onlyOpen ? inRegion.filter((row) => row.slots > 0) : inRegion
  const withData = inRegion.filter((r) => r.hasData).length
  const open = inRegion.filter((r) => r.slots > 0)
  const slots = open.reduce((n, r) => n + r.slots, 0)
  const fresh = open.reduce((n, r) => n + r.fresh, 0)
  const hours = (now - Date.parse(data.checked_at)) / 3_600_000

  return (
    <>
      <p className="muted mich-av-lead">
        {days.length > 0 && `${dayLabel(days[0])}～${dayLabel(days[days.length - 1])}・`}
        {formatWhen(data.checked_at)} 查詢（{ago(data.checked_at, now)}）
      </p>
      {hours > STALE_HOURS && (
        <p className="mich-av-stale" role="status">
          已經 {Math.floor(hours)} 小時沒有更新。爬蟲在家裡的電腦上跑，電腦沒開或出錯時就不會更新，現在的空位可能不一樣了。
        </p>
      )}

      <div className="mich-av-controls">
        <div className="mich-av-party" role="group" aria-label="用餐人數">
          {parties.map((n) => (
            <button key={n} type="button" aria-pressed={party === n} onClick={() => setParty(n)}>
              {n} 位
            </button>
          ))}
        </div>
        <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="地區">
          <option value="all">全部地區</option>
          {REGIONS.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.name}
            </option>
          ))}
        </select>
        <label className="mich-check">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
          只看有空位
        </label>
      </div>

      <p className="mich-av-summary">
        {inRegion.length} 家裡 {withData} 家讀到訂位資料，<strong>{open.length} 家</strong>有 {party} 位的時段，共 {slots} 個
        {fresh > 0 && <>，其中 <span className="mich-av-new-text">{fresh} 個是新釋出的</span></>}。
      </p>

      {shown.length === 0 ? (
        <p className="muted">{onlyOpen ? `這個地區目前沒有 ${party} 位的空位。` : '這個地區沒有星級餐廳。'}</p>
      ) : (
        <ul className="mich-av-list">
          {shown.map((row) => (
            <RestaurantRow key={row.place.name} row={row} party={party} />
          ))}
        </ul>
      )}

      <p className="muted mich-me-hint mich-av-foot">
        爬蟲每 3 小時用瀏覽器打開 inline、TableCheck、SevenRooms 的公開訂位頁，讀出頁面上顯示的時段，不會幫你訂位；
        能不能訂以訂位頁為準。「新」是跟前一次查詢比起來新出現的時段，多半是有人取消。TableCheck 列的是可以選的時間，
        方案和座位要進訂位頁再確認。
      </p>
    </>
  )
}

function cellClass(cell: DayCell) {
  if (cell.times.length > 0) return cell.fresh.size > 0 ? 'is-open is-new' : 'is-open'
  if (!cell.day) return 'is-none'
  return cell.day.status === 'full' ? 'is-full' : 'is-off'
}

function cellTitle(cell: DayCell) {
  return `${dayLabel(cell.date)}${cell.times.length > 0 ? `${cell.times.length} 個時段` : statusLabel(cell.day)}`
}

function RestaurantRow({ row, party }: { row: Row; party: number }) {
  const { place, restaurant: r, result, first } = row
  const url = safeUrl(place.url)
  const tel = place.phone ? phoneHref(place.phone) : null
  const summary = first ? (
    <>
      <strong>
        {dayLabel(first.date)} {first.time}
      </strong>{' '}
      起・{row.slots} 個時段
      {row.fresh > 0 && <span className="mich-av-new-text">・{row.fresh} 個新釋出</span>}
    </>
  ) : row.hasData ? (
    `近兩週沒有 ${party} 位的時段`
  ) : (
    result?.note || '沒有讀到訂位資料'
  )
  const meta = [
    result ? sourceLabel(result.source) : null,
    result?.checked_at ? `${formatWhen(result.checked_at)} 讀到` : null,
    row.hasData && result?.note ? result.note : null,
  ].filter(Boolean)

  return (
    <li className={`mich-av-row${row.slots > 0 ? ' has-slots' : ''}`}>
      <div className="mich-av-head">
        {r && <AwardBadge award={r.award} />}
        <span className="mich-av-name">
          {r ? (
            <Link to={`/michelin?r=${encodeURIComponent(r.id)}`}>
              <strong>{place.name}</strong>
            </Link>
          ) : (
            <strong>{place.name}</strong>
          )}
          {r && (
            <span className="muted">
              {r.city}
              {r.district}・{r.cuisine}
            </span>
          )}
        </span>
        {url && (
          <a className="mich-av-book" href={url} target="_blank" rel="noopener noreferrer">
            {result?.source === 'manual' ? '官網' : '去訂位'}
          </a>
        )}
      </div>

      {row.cells.length > 0 && row.hasData && (
        <ol className="mich-av-strip" aria-hidden="true">
          {row.cells.map((cell) => (
            <li key={cell.date} className={cellClass(cell)} title={cellTitle(cell)}>
              <span className={isWeekend(cell.date) ? 'is-weekend' : undefined}>{Number(cell.date.slice(8))}</span>
            </li>
          ))}
        </ol>
      )}

      {row.hasData ? (
        <details className="mich-av-details">
          <summary>{summary}</summary>
          <ul className="mich-av-days">
            {row.cells.map((cell) => (
              <li key={cell.date}>
                <span className="mich-av-date">{dayLabel(cell.date)}</span>
                {cell.times.length > 0 ? (
                  <span className="mich-av-slots">
                    {cell.times.map((t) => (
                      <span key={t} className={`mich-av-slot${cell.fresh.has(t) ? ' is-new' : ''}`}>
                        {t}
                        {cell.fresh.has(t) && <span className="mich-av-new-tag">新</span>}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="muted">{statusLabel(cell.day)}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="muted mich-av-empty">{summary}</p>
      )}

      {(meta.length > 0 || tel) && (
        <p className="mich-av-meta">
          {meta.join('・')}
          {tel && (
            <>
              {meta.length > 0 && '・'}
              <a href={tel}>{place.phone}</a>
            </>
          )}
        </p>
      )}
    </li>
  )
}
