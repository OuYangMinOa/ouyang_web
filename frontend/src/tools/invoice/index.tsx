import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { decodeImageFile } from '../../datamatrix/scanner'
import { persist, store, useReport } from './api'
import {
  PRIZE_TABLE,
  checkFull,
  checkLast3,
  formatMoney,
  nextDraw,
  parseInvoiceQr,
  periodLabel,
  type Period,
  type Prize,
} from './prize'
import Scanner, { type ScanStatus } from './Scanner'
import './invoice.css'

type Mode = 'last3' | 'full'

/** 對過的一張；結果每次依最新的中獎號碼重新算，還沒開獎的那期之後再打開就會有結果 */
type Check = {
  id: number
  period: string
  /** 3 碼（快速對獎）或 8 碼 */
  number: string
  /** 掃描到的字軌，例如 AB */
  track?: string
  scanned?: boolean
  at: number
}

const MAX_HISTORY = 300

const isCheck = (v: unknown): v is Check => {
  const c = v as Check
  return !!c && typeof c.id === 'number' && typeof c.period === 'string' && /^\d{3}$|^\d{8}$/.test(c.number)
}

function loadHistory(): Check[] {
  const saved = store<unknown>('history', [])
  return Array.isArray(saved) ? saved.filter(isCheck).slice(0, MAX_HISTORY) : []
}

let nextId = Date.now()

type Verdict = {
  tone: 'win' | 'maybe' | 'miss' | 'info'
  title: string
  detail?: string
  /** 確定中的獎（8 碼對中，或末三碼就確定的六獎／增開六獎） */
  prize: Prize | null
  /** 只輸入末三碼，還要核對完整號碼 */
  pending: boolean
}

/** 期別的開獎月份：結束月的下一個月 */
const drawMonth = (periodId: string) => ((Number(periodId.slice(3)) + 1) % 12) + 1

function judge(number: string, period: Period | undefined, periodId: string, newest: string | undefined): Verdict {
  if (!period) {
    const later = newest !== undefined && periodId > newest
    return {
      tone: 'info',
      title: later ? '這期還沒開獎' : '查不到這期的號碼',
      detail: later ? `${drawMonth(periodId)} 月 25 日開獎，之後再打開就會自動對獎` : '只提供最近幾期',
      prize: null,
      pending: false,
    }
  }
  if (number.length === 8) {
    const prize = checkFull(number, period)
    return prize
      ? { tone: 'win', title: `中${prize.name}！`, detail: formatMoney(prize.amount), prize, pending: false }
      : { tone: 'miss', title: '沒中', prize: null, pending: false }
  }
  const { sure, maybe } = checkLast3(number, period)
  if (maybe.length > 0) {
    return {
      tone: 'maybe',
      title: sure ? `至少中${sure.name}（${formatMoney(sure.amount)}）` : '可能中獎！',
      detail: `末三碼與${maybe.join('、')}相同，請輸入完整 8 碼核對`,
      prize: sure,
      pending: true,
    }
  }
  if (sure) return { tone: 'win', title: `中${sure.name}！`, detail: formatMoney(sure.amount), prize: sure, pending: false }
  return { tone: 'miss', title: '沒中', prize: null, pending: false }
}

/** 號碼末三碼加強顯示，對獎時最先看這裡 */
function Num({ value }: { value: string }) {
  return (
    <span className="inv-num">
      {value.slice(0, -3)}
      <b>{value.slice(-3)}</b>
    </span>
  )
}

const today = () => new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD（本機時區）
/** 相機只在 HTTPS（或 localhost）能用 */
const canUseCamera = () => !!navigator.mediaDevices?.getUserMedia
const shortDate = (iso: string) => iso.replaceAll('-', '/')

export default function Invoice() {
  const { report, loading, error, reload } = useReport()
  const [now] = useState(today)
  const [upcoming] = useState(() => nextDraw(new Date()))
  const periods = useMemo(() => report?.periods ?? [], [report])
  const byId = useMemo(() => new Map(periods.map((p) => [p.id, p])), [periods])
  const newest = periods[0]?.id

  const [selected, setSelected] = useState<string | null>(null)
  const period = (selected && byId.get(selected)) || periods[0]
  const [mode, setMode] = useState<Mode>(() => (store<unknown>('mode', 'last3') === 'full' ? 'full' : 'last3'))
  const [input, setInput] = useState('')
  /** 剛剛對的結果，顯示在輸入框下面 */
  const [last, setLast] = useState<{ number: string; period: string; track?: string } | null>(null)
  /** 末三碼可能中獎，等待輸入完整號碼核對的那一筆 */
  const [confirming, setConfirming] = useState<Check | null>(null)
  const [confirmInput, setConfirmInput] = useState('')
  const [history, setHistory] = useState<Check[]>(loadHistory)
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function saveHistory(next: Check[]) {
    const trimmed = next.slice(0, MAX_HISTORY)
    setHistory(trimmed)
    persist('history', trimmed)
  }

  function addCheck(c: Omit<Check, 'id' | 'at'>): Check {
    const check = { ...c, id: ++nextId, at: Date.now() }
    saveHistory([check, ...history])
    return check
  }

  const verdictOf = (c: Pick<Check, 'number' | 'period'>) => judge(c.number, byId.get(c.period), c.period, newest)

  function changeMode(m: Mode) {
    setMode(m)
    persist('mode', m)
    setInput('')
    inputRef.current?.focus()
  }

  function onInput(value: string) {
    if (!period) return
    const digits = value.replace(/\D/g, '').slice(0, mode === 'last3' ? 3 : 8)
    const need = mode === 'last3' ? 3 : 8
    if (digits.length < need) {
      setInput(digits)
      return
    }
    // 輸入滿了就馬上對，清空讓下一張接著輸入
    setInput('')
    setLast({ number: digits, period: period.id })
    if (mode === 'full' && history.some((c) => c.period === period.id && c.number === digits)) {
      setConfirming(null)
      return
    }
    const check = addCheck({ period: period.id, number: digits })
    const verdict = judge(digits, period, period.id, newest)
    setConfirming(verdict.pending ? check : null)
    setConfirmInput('')
  }

  function onConfirm(value: string) {
    if (!confirming) return
    const digits = value.replace(/\D/g, '').slice(0, 8)
    setConfirmInput(digits)
    if (digits.length < 8 || !digits.endsWith(confirming.number)) return
    // 把那筆末三碼的紀錄換成完整號碼
    saveHistory(history.map((c) => (c.id === confirming.id ? { ...c, number: digits } : c)))
    setLast({ number: digits, period: confirming.period })
    setConfirming(null)
    setConfirmInput('')
  }

  function handleCodes(codes: string[]): boolean {
    const invoice = codes.map(parseInvoiceQr).find((x) => x !== null)
    if (!invoice) {
      // 掃到右邊那個 QR Code（** 開頭）或其他條碼
      if (codes.some((c) => c.startsWith('**'))) setScanStatus({ tone: 'info', title: '這是右邊的 QR Code', detail: '請對準左邊那個' })
      return false
    }
    const verdict = judge(invoice.number, byId.get(invoice.periodId), invoice.periodId, newest)
    const label = `${invoice.track}-${invoice.number}`
    if (history.some((c) => c.period === invoice.periodId && c.number === invoice.number)) {
      setLast({ number: invoice.number, period: invoice.periodId, track: invoice.track })
      setScanStatus({ tone: verdict.tone, title: `${label} 已經對過了`, detail: verdict.title })
      return true
    }
    addCheck({ period: invoice.periodId, number: invoice.number, track: invoice.track, scanned: true })
    setLast({ number: invoice.number, period: invoice.periodId, track: invoice.track })
    setScanStatus({ tone: verdict.tone, title: `${label}　${verdict.title}`, detail: verdict.detail })
    if (verdict.tone === 'win') navigator.vibrate?.([80, 60, 80])
    return true
  }

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 3000)
  }

  // 要在點擊的當下同步呼叫 click()，iOS 才會打開相機
  function openScanner() {
    setScanStatus(null)
    if (canUseCamera()) setScanning(true)
    else fileRef.current?.click()
  }

  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    showToast('辨識中…')
    try {
      const raw = await decodeImageFile(file)
      setScanStatus(null)
      if (!handleCodes([raw])) showToast('這不是電子發票左邊的 QR Code，請重拍')
      else setToast(null)
    } catch {
      showToast('找不到 QR Code，請靠近一點重拍左邊那個')
    }
  }

  const lastVerdict = last ? verdictOf(last) : null
  const lastPeriod = last ? byId.get(last.period) : undefined

  const summary = useMemo(() => {
    let wins = 0
    let amount = 0
    let pending = 0
    for (const c of history) {
      const v = judge(c.number, byId.get(c.period), c.period, newest)
      if (v.pending) pending++
      else if (v.prize) {
        wins++
        amount += v.prize.amount
      }
    }
    return { wins, amount, pending }
  }, [history, byId, newest])

  const expired = period ? now > period.claim_end : false
  const notYet = period ? now < period.claim_start : false
  const daysLeft = period ? Math.ceil((Date.parse(period.claim_end) - Date.parse(now)) / 86_400_000) : 0

  if (!report) {
    return (
      <div className="inv">
        {loading ? (
          <p className="muted">載入中獎號碼…</p>
        ) : (
          <div className="stack">
            <p className="error">{error}</p>
            <button type="button" onClick={reload}>
              重試
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="inv">
      {error && (
        <p className="inv-warn">
          {error}，先顯示上次的資料。
          <button type="button" className="link" onClick={reload}>
            重試
          </button>
        </p>
      )}

      {period && (
        <section className="card inv-period">
          <label className="inv-select">
            期別
            <select value={period.id} onChange={(e) => setSelected(e.target.value)}>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {periodLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            {shortDate(period.draw_date)} 開獎・領獎 {shortDate(period.claim_start)}～{shortDate(period.claim_end)}
            {expired ? (
              <span className="inv-tag off">已過領獎期限</span>
            ) : notYet ? (
              <span className="inv-tag">{shortDate(period.claim_start)} 起可領</span>
            ) : (
              <span className="inv-tag on">還有 {daysLeft} 天</span>
            )}
          </p>
          <dl className="inv-numbers">
            <div>
              <dt>特別獎</dt>
              <dd>
                <Num value={period.special} />
                <small>{formatMoney(10_000_000)}</small>
              </dd>
            </div>
            <div>
              <dt>特獎</dt>
              <dd>
                <Num value={period.grand} />
                <small>{formatMoney(2_000_000)}</small>
              </dd>
            </div>
            <div className="inv-first">
              <dt>頭獎</dt>
              <dd>
                {period.first.map((n) => (
                  <Num key={n} value={n} />
                ))}
                <small>{formatMoney(200_000)}，末 3～7 碼相同有二～六獎</small>
              </dd>
            </div>
            {period.extra.length > 0 && (
              <div>
                <dt>增開六獎</dt>
                <dd>
                  {period.extra.map((n) => (
                    <span key={n} className="inv-num">
                      <b>{n}</b>
                    </span>
                  ))}
                  <small>末 3 碼相同 200 元</small>
                </dd>
              </div>
            )}
          </dl>
          <details className="inv-rules">
            <summary>獎金對照</summary>
            <table>
              <tbody>
                {PRIZE_TABLE.map((p) => (
                  <tr key={p.name}>
                    <th scope="row">{p.name}</th>
                    <td>{p.rule}</td>
                    <td>{formatMoney(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              同一張對中多個獎只能領最大的。資料來自
              <a href={period.link} target="_blank" rel="noreferrer" className="text-link">
                財政部稅務入口網
              </a>
              ，實際以官方公告為準。
            </p>
          </details>
          {newest && upcoming.label !== periodLabel(periods[0]) && (
            <p className="muted">
              下一期：{upcoming.label}，{upcoming.date.getMonth() + 1}/{upcoming.date.getDate()} 開獎
            </p>
          )}
        </section>
      )}

      {period && (
        <section className="card inv-check">
          <div className="inv-modes" role="radiogroup" aria-label="對獎方式">
            {(
              [
                ['last3', '末 3 碼快速對'],
                ['full', '完整 8 碼'],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? 'active' : ''}
                onClick={() => changeMode(m)}
              >
                {label}
              </button>
            ))}
          </div>
          <label>
            {mode === 'last3' ? `輸入發票號碼的末 3 碼（${periodLabel(period)}）` : `輸入 8 碼發票號碼（${periodLabel(period)}）`}
            <input
              ref={inputRef}
              className="inv-input"
              inputMode="numeric"
              autoComplete="off"
              enterKeyHint="next"
              placeholder={mode === 'last3' ? '000' : '00000000'}
              value={input}
              onChange={(e) => onInput(e.target.value)}
              aria-describedby="inv-result"
            />
          </label>

          <div id="inv-result" className={`inv-result ${lastVerdict?.tone ?? 'idle'}`} aria-live="polite">
            {last && lastVerdict ? (
              <>
                <span className="inv-result-number">
                  {last.track && `${last.track}-`}
                  <Num value={last.number} />
                  {lastPeriod && last.period !== period.id && <small>（{periodLabel(lastPeriod)}）</small>}
                </span>
                <strong>{lastVerdict.title}</strong>
                {lastVerdict.detail && <span>{lastVerdict.detail}</span>}
                {lastVerdict.prize && lastPeriod && now > lastPeriod.claim_end && <span>（已過領獎期限）</span>}
              </>
            ) : (
              <span className="muted">輸入滿 {mode === 'last3' ? 3 : 8} 碼就會馬上對獎，輸入框會清空讓你接著輸入下一張。</span>
            )}
          </div>

          {confirming && (
            <label className="inv-confirm">
              完整號碼（末三碼 {confirming.number}）
              <input
                className="inv-input"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                placeholder={`_____${confirming.number}`}
                value={confirmInput}
                onChange={(e) => onConfirm(e.target.value)}
              />
              {confirmInput.length === 8 && !confirmInput.endsWith(confirming.number) && (
                <span className="error">末三碼跟剛剛輸入的 {confirming.number} 不同</span>
              )}
            </label>
          )}

          <button type="button" className="inv-scan" onClick={openScanner}>
            <span aria-hidden="true">📷</span> 掃描電子發票 QR Code
          </button>
          <p className="muted">
            掃證明聯左邊的 QR Code，會自動看出是哪一期再對獎。相機打不開時可以
            <button type="button" className="link inv-photo" onClick={() => fileRef.current?.click()}>
              改用拍照
            </button>
            。
          </p>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
          {toast && (
            <p className="inv-toast" role="status">
              {toast}
            </p>
          )}
        </section>
      )}

      <section className="card inv-history">
        <div className="inv-history-head">
          <h3>對過的發票</h3>
          {history.length > 0 && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (confirm('清除全部紀錄？')) {
                  saveHistory([])
                  setConfirming(null)
                }
              }}
            >
              全部清除
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="muted">還沒有紀錄。對過的號碼會存在這台裝置的瀏覽器裡。</p>
        ) : (
          <>
            <p className="inv-summary">
              共 {history.length} 張・中獎 <strong>{summary.wins}</strong> 張，合計 <strong>{formatMoney(summary.amount)}</strong>
              {summary.pending > 0 && `・${summary.pending} 張待核對`}
            </p>
            <ul>
              {history.map((c) => {
                const v = verdictOf(c)
                const p = byId.get(c.period)
                return (
                  <li key={c.id} className={v.tone}>
                    <span className="inv-history-number">
                      {c.track && `${c.track}-`}
                      {c.number.length === 3 ? `末三碼 ${c.number}` : <Num value={c.number} />}
                      <small>
                        {p ? periodLabel(p) : `${c.period.slice(0, 3)} 年 ${Number(c.period.slice(3))} 月期`}
                        {c.scanned && '・掃描'}
                      </small>
                    </span>
                    <span className="inv-history-result">
                      {v.title}
                      {v.prize && !v.pending && <small>{formatMoney(v.prize.amount)}</small>}
                    </span>
                    <button
                      type="button"
                      className="link inv-remove"
                      aria-label="刪除這筆"
                      onClick={() => {
                        saveHistory(history.filter((x) => x.id !== c.id))
                        if (confirming?.id === c.id) setConfirming(null)
                      }}
                    >
                      ✕
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </section>

      {scanning && (
        <Scanner
          status={scanStatus}
          onCodes={handleCodes}
          onError={() => {
            setScanning(false)
            showToast('無法開啟相機，請確認已允許相機權限，或改用拍照')
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  )
}
