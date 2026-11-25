// 選中的店家卡片：地址、電話、Google 地圖，加上想吃／吃過、訂位提醒和「資料有誤」回報。
// 提醒和回報展開在卡片裡，不用離開地圖。

import { useEffect, useState, type FormEvent, type Ref } from 'react'
import { Link, useLocation } from 'react-router'
import { errorMessage } from '../api'
import { enablePush, permissionState, restorePush, type PushState } from '../chat/push'
import { createThread } from '../feedback/api'
import {
  awardClass,
  awardLabel,
  changeOf,
  displayPhone,
  formatDistance,
  googleMapsUrl,
  guideUrl,
  telHref,
  type Award,
  type Restaurant,
} from './data'
import { formatWhen, type MarkStatus, type Mine } from './mine'

/** 列表、卡片上的小徽章：星級用 ★，必比登用「必」 */
export function AwardBadge({ award }: { award: Award }) {
  return (
    <span className={`mich-badge mich-${awardClass(award)}`} title={awardLabel(award)}>
      <span aria-hidden="true">{award === 'bib' ? '必' : '★'.repeat(award)}</span>
      <span className="mich-sr">{awardLabel(award)}</span>
    </span>
  )
}

type Panel = 'remind' | 'report' | 'login' | null

type Props = {
  r: Restaurant
  /** 離目前位置多遠（公尺）；沒定位是 null */
  distance: number | null
  mine: Mine
  onClose: () => void
  ref: Ref<HTMLElement>
}

export function RestaurantCard({ r, distance, mine, onClose, ref }: Props) {
  const { pathname, search } = useLocation()
  const [panel, setPanel] = useState<Panel>(null)
  const [error, setError] = useState<string | null>(null)
  // 換一家時收起展開的東西（在 render 時調整，不用等 effect 再畫一次）
  const [shownFor, setShownFor] = useState(r.id)
  if (shownFor !== r.id) {
    setShownFor(r.id)
    setPanel(null)
    setError(null)
  }

  const mark = mine.marks.get(r.id)
  const change = changeOf(r)
  const pending = mine.reminders.filter((x) => x.restaurant === r.id && !x.sent_at).length

  async function toggle(status: MarkStatus) {
    if (!mine.loggedIn) {
      setPanel('login')
      return
    }
    setError(null)
    try {
      await mine.setMark(r.id, mark?.status === status ? null : status)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function open(next: Exclude<Panel, null>) {
    setPanel((current) => (current === next ? null : next))
  }

  return (
    <article ref={ref} className="michelin-card" aria-labelledby="michelin-card-name">
      <div className="michelin-card-head">
        <AwardBadge award={r.award} />
        <h2 id="michelin-card-name">{r.name}</h2>
        <button type="button" className="secondary michelin-close" onClick={onClose} aria-label="關閉" title="關閉（Esc）">
          ✕
        </button>
      </div>
      <p className="michelin-card-meta">
        <span>{awardLabel(r.award)}</span>
        {r.green && <span className="mich-green">綠星</span>}
        {change && <span className={`mich-change is-${change.kind}`}>{change.label}</span>}
        <span>{r.cuisine}</span>
        <span title="價位">{'$'.repeat(r.price)}</span>
        {distance !== null && <span title="直線距離">距離 {formatDistance(distance)}</span>}
        <a className="mich-guide-link" href={guideUrl(r)} target="_blank" rel="noreferrer">
          米其林介紹 ↗
        </a>
      </p>
      <p className="michelin-card-address">
        {r.address}
        {r.approx && <span className="muted">（地圖上是約略位置）</span>}
      </p>
      {/* 兩顆按鈕，手機上也排得下一列 */}
      <div className="michelin-actions">
        {r.phone ? (
          <a className="mich-action" href={telHref(r.phone)} aria-label={`打電話 ${displayPhone(r.phone)}`}>
            <span aria-hidden="true">☎</span>
            {displayPhone(r.phone)}
          </a>
        ) : (
          <span className="mich-action is-empty">沒有公開電話</span>
        )}
        <a className="mich-action primary" href={googleMapsUrl(r)} target="_blank" rel="noreferrer">
          Google 地圖
        </a>
      </div>

      <div className="michelin-tools">
        <button
          type="button"
          className="mich-tool is-want"
          aria-pressed={mark?.status === 'want'}
          onClick={() => toggle('want')}
        >
          <span aria-hidden="true">{mark?.status === 'want' ? '♥' : '♡'}</span> 想吃
        </button>
        <button
          type="button"
          className="mich-tool is-been"
          aria-pressed={mark?.status === 'been'}
          onClick={() => toggle('been')}
        >
          <span aria-hidden="true">✓</span> 吃過
        </button>
        <button
          type="button"
          className="mich-tool"
          aria-expanded={panel === 'remind'}
          aria-label={pending > 0 ? `訂位提醒（${pending} 個）` : '訂位提醒'}
          onClick={() => (mine.loggedIn ? open('remind') : setPanel('login'))}
        >
          {/* 手機上三顆按鈕擠一列，只寫「提醒」 */}
          <span aria-hidden="true">⏰</span>
          {/* 包成一塊：按鈕是 flex，分開的話「訂位」和「提醒」中間會多出間距 */}
          <span>
            <span className="mich-tool-long">訂位</span>提醒
          </span>
          {pending > 0 && <span className="mich-count">{pending}</span>}
        </button>
      </div>
      {panel === 'login' && (
        <p className="mich-panel mich-panel-hint">
          登入後才能記下想吃、吃過，和設定訂位提醒。
          <Link to="/login" state={{ from: pathname + search }}>
            登入
          </Link>
        </p>
      )}
      {panel === 'remind' && <ReminderPanel r={r} mine={mine} />}
      {panel === 'report' && <ReportPanel r={r} />}
      {error && <p className="error mich-panel-error">{error}</p>}
      <p className="michelin-card-foot">
        <button type="button" className="link mich-report-link" aria-expanded={panel === 'report'} onClick={() => open('report')}>
          資料有誤？回報給我
        </button>
      </p>
    </article>
  )
}

const LEADS = [
  { minutes: 0, label: '準時' },
  { minutes: 5, label: '5 分鐘前' },
  { minutes: 30, label: '30 分鐘前' },
  { minutes: 24 * 60, label: '前一天' },
]

/** datetime-local 的格式（本地時間）：2026-12-01T12:00 */
function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 預設明天中午：很多店是中午開放訂位 */
function tomorrowNoon() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(12, 0, 0, 0)
  return localInput(d)
}

function ReminderPanel({ r, mine }: { r: Restaurant; mine: Mine }) {
  const [opensAt, setOpensAt] = useState(tomorrowNoon)
  const [earliest] = useState(() => localInput(new Date()))
  const [lead, setLead] = useState(5)
  const [note, setNote] = useState('')
  const [push, setPush] = useState<PushState | 'checking'>('checking')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const mineHere = mine.reminders.filter((x) => x.restaurant === r.id)

  // 這個瀏覽器之前開過通知就重新登記，沒有的話顯示「開啟通知」
  useEffect(() => {
    let alive = true
    restorePush()
      .then((subscription) => alive && setPush(subscription ? 'on' : permissionState()))
      .catch(() => alive && setPush(permissionState()))
    return () => {
      alive = false
    }
  }, [])

  async function turnOn() {
    setError(null)
    try {
      await enablePush()
      setPush('on')
    } catch (e) {
      setError(errorMessage(e))
      setPush(permissionState())
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const opens = new Date(opensAt)
    if (Number.isNaN(opens.getTime())) {
      setError('請選開放訂位的時間')
      return
    }
    const at = new Date(opens.getTime() - lead * 60_000)
    if (at.getTime() < Date.now()) {
      setError('提醒的時間已經過了，換一個時間')
      return
    }
    const text = [`${formatWhen(opens.toISOString())} 開放訂位`, note.trim()].filter(Boolean).join('・')
    setSaving(true)
    try {
      await mine.addReminder(r.id, at, text)
      setNote('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="mich-panel" onSubmit={submit}>
      <p className="muted mich-panel-intro">
        米其林沒有公開什麼時候開放訂位。看到店家公告的時間後填在這裡，時間到了會跳通知。
      </p>
      <div className="mich-panel-row">
        <label>
          開放訂位的時間
          <input type="datetime-local" value={opensAt} min={earliest} onChange={(e) => setOpensAt(e.target.value)} required />
        </label>
        <label>
          提醒我
          <select value={lead} onChange={(e) => setLead(Number(e.target.value))}>
            {LEADS.map((l) => (
              <option key={l.minutes} value={l.minutes}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="備註（選填），例如：開放 1 月的位子"
        aria-label="備註"
        maxLength={60}
      />
      <PushStatus push={push} onTurnOn={turnOn} />
      <button type="submit" disabled={saving}>
        設定提醒
      </button>
      {error && <p className="error">{error}</p>}
      {mineHere.length > 0 && (
        <ul className="mich-reminders">
          {mineHere.map((x) => (
            <li key={x.id} className={x.sent_at ? 'is-sent' : undefined}>
              <span>
                <strong>{formatWhen(x.remind_at)} 提醒</strong>
                {x.sent_at && '（已送出）'}
                {x.note && <span className="muted">{x.note}</span>}
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => mine.removeReminder(x.id).catch((err) => setError(errorMessage(err)))}
              >
                刪除
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}

function PushStatus({ push, onTurnOn }: { push: PushState | 'checking'; onTurnOn: () => void }) {
  switch (push) {
    case 'checking':
      return null
    case 'on':
      return <p className="mich-push is-on">✓ 這個瀏覽器的通知已經開了</p>
    case 'off':
      return (
        <p className="mich-push">
          <span>這個瀏覽器還沒開通知，時間到了會收不到。</span>
          <button type="button" className="secondary" onClick={onTurnOn}>
            開啟通知
          </button>
        </p>
      )
    case 'denied':
      return <p className="mich-push">通知被瀏覽器封鎖了：從網址列左邊的圖示把「通知」改成允許，其他開了通知的裝置還是收得到。</p>
    case 'unsupported':
      return <p className="mich-push">這個瀏覽器沒辦法收通知（iPhone 要先把網站加到主畫面）；其他開了通知的裝置還是收得到。</p>
  }
}

const REASONS = ['已經歇業', '地址或地圖位置不對', '電話不對', '其他']

function ReportPanel({ r }: { r: Restaurant }) {
  const [reason, setReason] = useState(REASONS[0])
  const [text, setText] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setState('sending')
    const detail = text.trim()
    const body = [
      `${reason}${detail ? `：${detail}` : ''}`,
      '',
      `餐廳：${r.name}（${r.id}）`,
      `地址：${r.address}`,
      `電話：${r.phone ? displayPhone(r.phone) : '（沒有公開電話）'}`,
      `${window.location.origin}/michelin?r=${r.id}`,
    ].join('\n')
    try {
      await createThread('bug', `米其林地圖：${r.name}資料有誤`, { body, images: [] })
      setState('sent')
    } catch (err) {
      setError(errorMessage(err))
      setState('idle')
    }
  }

  if (state === 'sent') {
    return (
      <p className="mich-panel mich-panel-hint">
        收到了，謝謝！處理進度可以在右上角的「回報 / 許願」看。
      </p>
    )
  }
  return (
    <form className="mich-panel" onSubmit={submit}>
      <div className="mich-reasons" role="radiogroup" aria-label="哪裡不對">
        {REASONS.map((x) => (
          <button key={x} type="button" role="radio" aria-checked={reason === x} className="mich-chip" onClick={() => setReason(x)}>
            {x}
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="補充說明（選填），例如新的地址或電話"
        aria-label="補充說明"
      />
      <button type="submit" disabled={state === 'sending'}>
        送出回報
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
