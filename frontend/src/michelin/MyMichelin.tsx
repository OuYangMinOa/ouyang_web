// /michelin/me：我的米其林足跡。集章進度（吃過幾家）、想吃清單、吃過的日期、訂位提醒，
// 以及從照片的拍攝地點找出去過的店。資料在後端（michelin.rs），登入才有。

import { useState, type ChangeEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { errorMessage } from '../api'
import {
  AWARDS,
  GUIDE_EDITION,
  REGIONS,
  RESTAURANTS,
  awardClass,
  awardRank,
  type Restaurant,
} from './data'
import { formatWhen, useMine, type Mark, type Mine } from './mine'
import { groupMatches, readPhoto, type PhotoMatch, type PhotoSpot } from './photos'
import { AwardBadge } from './RestaurantCard'
import './michelin.css'

const byId = new Map(RESTAURANTS.map((r) => [r.id, r]))

function mapLink(r: Restaurant) {
  return `/michelin?r=${encodeURIComponent(r.id)}`
}

function shortDate(date: string) {
  const [y, m, d] = date.split('-')
  return `${y}/${Number(m)}/${Number(d)}`
}

export default function MyMichelin() {
  const mine = useMine()
  const { pathname } = useLocation()

  if (!mine.loggedIn) {
    return (
      <div className="mich-me-page">
        <h1>我的米其林足跡</h1>
        <div className="card narrow">
          <p>登入後可以記下想吃、吃過的店，看看自己吃過幾家米其林，也可以設定訂位提醒。</p>
          <Link to="/login" state={{ from: pathname }} className="mich-me-login">
            登入
          </Link>
        </div>
      </div>
    )
  }

  const been = [...mine.marks.values()].filter((m) => m.status === 'been' && byId.has(m.restaurant))
  const want = [...mine.marks.values()].filter((m) => m.status === 'want' && byId.has(m.restaurant))

  return (
    <div className="mich-me-page">
      <h1>我的米其林足跡</h1>
      <p className="muted">
        在<Link to="/michelin">地圖</Link>上點一家，就能記成想吃或吃過。{GUIDE_EDITION} 年版的星級和必比登共 {RESTAURANTS.length} 家。
      </p>
      {mine.error && <p className="error">{mine.error}</p>}
      {!mine.loaded ? (
        <p className="muted">載入中…</p>
      ) : (
        <>
          <Stamps been={been} />
          <WantList want={want} mine={mine} />
          <BeenList been={been} mine={mine} />
          <Reminders mine={mine} />
          <FromPhotos mine={mine} />
        </>
      )}
    </div>
  )
}

/** 集章進度：每個獎項吃過幾家，再分地區 */
function Stamps({ been }: { been: Mark[] }) {
  const done = new Set(been.map((m) => m.restaurant))
  const count = (rs: Restaurant[]) => rs.filter((r) => done.has(r.id)).length
  const tiers = AWARDS.map((a) => {
    const rs = RESTAURANTS.filter((r) => r.award === a.value)
    return { award: a.value, label: a.value === 'bib' ? '必比登' : a.label, total: rs.length, done: count(rs), rs }
  })
  return (
    <section className="mich-me-section" aria-labelledby="mich-stamps">
      <h2 id="mich-stamps">
        集章進度 <span className="mich-me-total">{done.size} / {RESTAURANTS.length}</span>
      </h2>
      <div className="mich-tiers">
        {tiers.map((t) => (
          <div key={t.award} className={`mich-tier mich-${awardClass(t.award)}`}>
            <div className="mich-tier-head">
              <AwardBadge award={t.award} />
              <strong>{t.label}</strong>
              <span className="mich-tier-count">
                {t.done} / {t.total}
              </span>
            </div>
            {/* 家數少的一家一格印章，多的用進度條 */}
            {t.total <= 12 ? (
              <ol className="mich-stamp-row">
                {[...t.rs].sort((a, b) => Number(done.has(b.id)) - Number(done.has(a.id))).map((r) => (
                  <li key={r.id} className={done.has(r.id) ? 'is-done' : undefined} title={r.name}>
                    <Link to={mapLink(r)} aria-label={`${r.name}${done.has(r.id) ? '（吃過）' : ''}`}>
                      {r.name.slice(0, 1)}
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="mich-bar" role="progressbar" aria-valuemin={0} aria-valuemax={t.total} aria-valuenow={t.done} aria-label={t.label}>
                <span style={{ width: `${(t.done / t.total) * 100}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
      <table className="mich-regions">
        <caption className="mich-sr">各地區吃過幾家</caption>
        <tbody>
          {REGIONS.map((region) => {
            const rs = RESTAURANTS.filter((r) => region.cities.includes(r.city))
            const n = count(rs)
            return (
              <tr key={region.slug}>
                <th scope="row">
                  <Link to={`/michelin/${region.slug}`}>{region.name}</Link>
                </th>
                <td>
                  <div className="mich-bar is-thin" aria-hidden="true">
                    <span style={{ width: `${(n / rs.length) * 100}%` }} />
                  </div>
                </td>
                <td className="mich-regions-n">
                  {n} / {rs.length}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

function RestaurantLine({ r, children, extra }: { r: Restaurant; children?: ReactNode; extra?: ReactNode }) {
  return (
    <li className="mich-me-row">
      <AwardBadge award={r.award} />
      <span className="mich-item-body">
        <Link to={mapLink(r)}>
          <strong>{r.name}</strong>
        </Link>
        <span className="muted">
          {r.city}
          {r.district}・{r.cuisine}
          {extra}
        </span>
      </span>
      <span className="mich-me-actions">{children}</span>
    </li>
  )
}

function sortByAward(marks: Mark[]) {
  return [...marks].sort((a, b) => awardRank(byId.get(b.restaurant)!.award) - awardRank(byId.get(a.restaurant)!.award))
}

function WantList({ want, mine }: { want: Mark[]; mine: Mine }) {
  const [error, setError] = useState<string | null>(null)
  const run = (task: Promise<void>) => task.catch((e) => setError(errorMessage(e)))
  return (
    <section className="mich-me-section" aria-labelledby="mich-want">
      <h2 id="mich-want">
        想吃 <span className="mich-me-total">{want.length}</span>
      </h2>
      {error && <p className="error">{error}</p>}
      {want.length === 0 ? (
        <p className="muted">還沒有。在地圖上的店家卡片按「♡ 想吃」就會出現在這裡。</p>
      ) : (
        <>
          <ul className="mich-me-list">
            {sortByAward(want).map((m) => {
              const r = byId.get(m.restaurant)!
              return (
                <RestaurantLine key={m.restaurant} r={r}>
                  <button type="button" className="secondary" onClick={() => run(mine.setMark(r.id, 'been'))}>
                    ✓ 吃過了
                  </button>
                  <button type="button" className="secondary" onClick={() => run(mine.setMark(r.id, null))} aria-label={`把${r.name}從想吃拿掉`}>
                    移除
                  </button>
                </RestaurantLine>
              )
            })}
          </ul>
          <p className="mich-me-hint">
            跟朋友決定不了吃哪家？<Link to="/games/dinner">開一間「吃哪家」投票</Link>，想吃清單可以直接拿來提名。
          </p>
        </>
      )}
    </section>
  )
}

function BeenList({ been, mine }: { been: Mark[]; mine: Mine }) {
  const [error, setError] = useState<string | null>(null)
  // 日期欄的上限：今天（sv-SE 的寫法剛好是 YYYY-MM-DD）
  const [today] = useState(() => new Date().toLocaleDateString('sv-SE'))
  // 有日期的照日期新到舊，沒填日期的放後面
  const rows = [...been].sort((a, b) => (b.visited_on ?? '').localeCompare(a.visited_on ?? ''))
  return (
    <section className="mich-me-section" aria-labelledby="mich-been">
      <h2 id="mich-been">
        吃過 <span className="mich-me-total">{been.length}</span>
      </h2>
      {error && <p className="error">{error}</p>}
      {rows.length === 0 ? (
        <p className="muted">還沒有。在店家卡片按「✓ 吃過」，或用下面的「從照片找」一次標好。</p>
      ) : (
        <ul className="mich-me-list">
          {rows.map((m) => {
            const r = byId.get(m.restaurant)!
            return (
              <RestaurantLine key={m.restaurant} r={r}>
                <input
                  type="date"
                  value={m.visited_on ?? ''}
                  max={today}
                  aria-label={`哪一天吃${r.name}`}
                  onChange={(e) => mine.setMark(r.id, 'been', e.target.value || null).catch((err) => setError(errorMessage(err)))}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => mine.setMark(r.id, null).catch((err) => setError(errorMessage(err)))}
                  aria-label={`把${r.name}從吃過拿掉`}
                >
                  移除
                </button>
              </RestaurantLine>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Reminders({ mine }: { mine: Mine }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="mich-me-section" aria-labelledby="mich-reminders">
      <h2 id="mich-reminders">
        訂位提醒 <span className="mich-me-total">{mine.reminders.filter((x) => !x.sent_at).length}</span>
      </h2>
      {error && <p className="error">{error}</p>}
      {mine.reminders.length === 0 ? (
        <p className="muted">還沒有。在店家卡片按「⏰ 訂位提醒」，填上店家開放訂位的時間，時間到了會跳通知。</p>
      ) : (
        <ul className="mich-me-list">
          {mine.reminders.map((x) => {
            const r = byId.get(x.restaurant)
            if (!r) return null
            return (
              <RestaurantLine
                key={x.id}
                r={r}
                extra={
                  <span className="mich-me-when">
                    {formatWhen(x.remind_at)} 提醒{x.sent_at ? '（已送出）' : ''}
                    {x.note && `・${x.note}`}
                  </span>
                }
              >
                <button type="button" className="secondary" onClick={() => mine.removeReminder(x.id).catch((e) => setError(errorMessage(e)))}>
                  刪除
                </button>
              </RestaurantLine>
            )
          })}
        </ul>
      )}
    </section>
  )
}

type Scan = { total: number; read: number; located: number; matches: PhotoMatch[] | null }

function FromPhotos({ mine }: { mine: Mine }) {
  const [scan, setScan] = useState<Scan | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])]
    e.target.value = ''
    if (files.length === 0) return
    setMessage(null)
    const spots: PhotoSpot[] = []
    setScan({ total: files.length, read: 0, located: 0, matches: null })
    for (let i = 0; i < files.length; i++) {
      const spot = await readPhoto(files[i])
      if (spot) spots.push(spot)
      // 每 10 張更新一次進度，不要每張都重畫
      if (i % 10 === 9 || i === files.length - 1) setScan({ total: files.length, read: i + 1, located: spots.length, matches: null })
    }
    const matches = groupMatches(spots)
    setScan({ total: files.length, read: files.length, located: spots.length, matches })
    // 預設勾還沒記成吃過的
    setChosen(new Set(matches.filter((m) => mine.marks.get(m.restaurant.id)?.status !== 'been').map((m) => m.restaurant.id)))
  }

  async function save(matches: PhotoMatch[]) {
    setSaving(true)
    setMessage(null)
    let saved = 0
    try {
      for (const m of matches.filter((x) => chosen.has(x.restaurant.id))) {
        // 已經記過日期的不蓋掉，沒有的用最早那張照片的日期
        const current = mine.marks.get(m.restaurant.id)
        const date = current?.status === 'been' && current.visited_on ? current.visited_on : m.first
        await mine.setMark(m.restaurant.id, 'been', date)
        saved += 1
      }
      setMessage(`標好了 ${saved} 家。`)
      setChosen(new Set())
    } catch (e) {
      setMessage(`${saved > 0 ? `標好 ${saved} 家之後` : ''}失敗了：${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const matches = scan?.matches ?? null
  return (
    <section className="mich-me-section" aria-labelledby="mich-photos">
      <h2 id="mich-photos">從照片找吃過的店</h2>
      <p className="muted mich-me-hint">
        選一批照片，用照片裡的拍攝地點找出你在哪幾家米其林拍過照。照片只在這個瀏覽器裡讀，不會上傳。
        手機的相簿選取器有時會拿掉拍攝地點，可以改在電腦上選從手機傳過來的原始檔（JPEG、iPhone 的 HEIC 都可以）。
      </p>
      <label className="mich-file">
        <span className="mich-file-button">選擇照片</span>
        <input type="file" accept="image/jpeg,image/heic,image/heif,.jpg,.jpeg,.heic,.heif" multiple onChange={onFiles} />
      </label>
      {scan && (
        <p className="mich-me-progress" role="status">
          讀了 {scan.read} / {scan.total} 張，其中 {scan.located} 張有拍攝地點
          {matches && `，在 ${matches.length} 家米其林附近`}。
        </p>
      )}
      {matches && matches.length === 0 && scan && (
        <p className="muted">{scan.located === 0 ? '這些照片都沒有拍攝地點。' : '這些照片都不是在米其林餐廳附近拍的。'}</p>
      )}
      {matches && matches.length > 0 && (
        <>
          <ul className="mich-me-list">
            {matches.map((m) => {
              const r = m.restaurant
              const status = mine.marks.get(r.id)?.status
              const dates = m.first && m.last && m.first !== m.last ? `${shortDate(m.first)}～${shortDate(m.last)}` : m.first ? shortDate(m.first) : '日期不明'
              return (
                <RestaurantLine
                  key={r.id}
                  r={r}
                  extra={
                    <span className="mich-me-when">
                      {m.photos} 張・{dates}・{Math.round(m.meters)} 公尺內{status === 'been' && '・已經記成吃過'}
                    </span>
                  }
                >
                  <label className="mich-check">
                    <input
                      type="checkbox"
                      checked={chosen.has(r.id)}
                      onChange={() =>
                        setChosen((prev) => {
                          const next = new Set(prev)
                          if (next.has(r.id)) next.delete(r.id)
                          else next.add(r.id)
                          return next
                        })
                      }
                    />
                    標成吃過
                  </label>
                </RestaurantLine>
              )
            })}
          </ul>
          <p className="muted mich-me-hint">照片定位在室內常常不準，附近剛好有別家時可能會認錯，存之前看一下。</p>
          <button type="button" onClick={() => save(matches)} disabled={saving || chosen.size === 0}>
            把勾選的 {chosen.size} 家標成吃過
          </button>
        </>
      )}
      {message && <p className="mich-me-progress">{message}</p>}
    </section>
  )
}
