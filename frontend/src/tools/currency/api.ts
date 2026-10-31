import { useEffect, useMemo, useState } from 'react'

// Frankfurter v2：彙整各國央行的參考匯率，免金鑰、可跨網域呼叫
const API = 'https://api.frankfurter.dev/v2'

// 一律以美元為基準抓全部匯率，其他組合在本機用交叉匯率算，切換貨幣不用再連網
const PIVOT = 'USD'

/** 匯率表：每種貨幣對 1 美元的匯率，以及各自的資料日期（有些央行晚一兩天公布） */
export type RateTable = {
  /** 最新的資料日期 */
  date: string
  fetchedAt: number
  rates: Record<string, { rate: number; date: string }>
}

type Row = { date: string; base: string; quote: string; rate: number }

export function store<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`tools:fx:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(`tools:fx:${key}`, JSON.stringify(value))
  } catch {
    // 存不了就算了，只是下次要重新抓
  }
}

async function getRows(query: string, signal: AbortSignal): Promise<Row[]> {
  const res = await fetch(`${API}/rates?${query}`, { signal })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) message = body.message
    } catch {
      // 錯誤內容不是 JSON
    }
    throw new Error(message)
  }
  return (await res.json()) as Row[]
}

function toTable(rows: Row[]): RateTable | null {
  if (rows.length === 0) return null
  const rates: RateTable['rates'] = {}
  let date = ''
  for (const r of rows) {
    rates[r.quote] = { rate: r.rate, date: r.date }
    if (r.date > date) date = r.date
  }
  rates[PIVOT] ??= { rate: 1, date }
  return { date, fetchedAt: Date.now(), rates }
}

/** amount 個 from 等於多少 to；表裡沒有其中一種就回傳 null */
export function convert(table: RateTable, amount: number, from: string, to: string): number | null {
  const a = table.rates[from]
  const b = table.rates[to]
  if (!a || !b) return null
  return (amount * b.rate) / a.rate
}

/** 這個組合實際用到的資料日期（取兩者中較舊的） */
export function pairDate(table: RateTable, from: string, to: string): string {
  const a = table.rates[from]?.date ?? table.date
  const b = table.rates[to]?.date ?? table.date
  return a < b ? a : b
}

function errorText(err: unknown): string {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return '目前離線'
  return err instanceof Error && err.message !== 'Failed to fetch' ? `無法取得匯率（${err.message}）` : '無法連線到匯率服務'
}

export type RatesState = {
  /** 這份狀態對應的日期（null 是最新） */
  date: string | null
  /** ok：資料是新的；stale：連不上，顯示上次存的；error：沒有資料可以顯示 */
  status: 'loading' | 'ok' | 'stale' | 'error'
  table: RateTable | null
  error?: string
}

// 30 分鐘內抓過就不重抓（資料一天才更新幾次）
const FRESH_MS = 30 * 60 * 1000
const historyCache = new Map<string, RateTable>()

function initialState(date: string | null): RatesState {
  if (date) {
    const t = historyCache.get(date)
    return { date, status: t ? 'ok' : 'loading', table: t ?? null }
  }
  const cached = store<RateTable | null>('latest', null)
  if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return { date, status: 'ok', table: cached }
  return { date, status: 'loading', table: cached }
}

/** 取得匯率表：date 是 YYYY-MM-DD 就是歷史匯率，null 是最新 */
export function useRates(date: string | null) {
  const [attempt, setAttempt] = useState(0)
  const key = `${date ?? 'latest'}#${attempt}`
  // 換日期或重試時的起始狀態：有快取就先顯示快取；attempt 也要列進去：重試時要重新讀快取、判斷是否過期
  const start = useMemo(() => initialState(date), [date, attempt]) // eslint-disable-line react-hooks/exhaustive-deps
  const [result, setResult] = useState<RatesState & { key: string }>({ ...start, key })

  useEffect(() => {
    if (start.status === 'ok') return
    const ctrl = new AbortController()
    getRows(date ? `base=${PIVOT}&date=${date}` : `base=${PIVOT}`, ctrl.signal)
      .then((rows) => {
        const table = toTable(rows)
        if (!table) {
          setResult({ key, date, status: 'error', table: null, error: '這一天沒有匯率資料' })
          return
        }
        if (date) historyCache.set(date, table)
        else persist('latest', table)
        setResult({ key, date, status: 'ok', table })
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        // 最新匯率連不上時，退回上次存下來的
        const stale = !date && start.table
        setResult({ key, date, status: stale ? 'stale' : 'error', table: stale ? start.table : null, error: errorText(err) })
      })
    return () => ctrl.abort()
  }, [key, date, start])

  // 還沒拿到這次請求的結果前，先用起始狀態
  const current: RatesState = result.key === key ? result : start

  // 恢復連線時自動重試
  useEffect(() => {
    if (current.status !== 'stale' && current.status !== 'error') return
    const retry = () => setAttempt((n) => n + 1)
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [current.status])

  return { ...current, retry: () => setAttempt((n) => n + 1) }
}

export type Range = '1m' | '3m' | '1y' | '5y'

export const RANGES: { value: Range; label: string; days: number }[] = [
  { value: '1m', label: '1 個月', days: 30 },
  { value: '3m', label: '3 個月', days: 91 },
  { value: '1y', label: '1 年', days: 365 },
  { value: '5y', label: '5 年', days: 365 * 5 + 1 },
]

export type Point = { date: string; value: number }

export type SeriesState = { key: string; status: 'loading' | 'ok' | 'error'; points: Point[]; error?: string }

const seriesCache = new Map<string, Point[]>()

/** 本機日期的 YYYY-MM-DD */
export function isoDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 走勢：同樣用美元交叉計算，跟上面的換算結果一致 */
export function useSeries(base: string, quote: string, range: Range) {
  const [attempt, setAttempt] = useState(0)
  const key = `${base}/${quote}/${range}`
  const [result, setResult] = useState<SeriesState & { attempt: number }>({ key: '', attempt, status: 'loading', points: [] })

  useEffect(() => {
    if (base === quote || seriesCache.has(key)) return
    const days = RANGES.find((r) => r.value === range)?.days ?? 30
    const from = isoDate(new Date(Date.now() - days * 86400000))
    const quotes = [base, quote].filter((c) => c !== PIVOT).join(',')
    // 5 年的資料改成每週一筆，點數少一點
    const group = range === '5y' ? '&group=week' : ''
    const ctrl = new AbortController()
    getRows(`base=${PIVOT}&quotes=${quotes}&from=${from}${group}`, ctrl.signal)
      .then((rows) => {
        const byDate = new Map<string, Record<string, number>>()
        for (const r of rows) {
          const day = byDate.get(r.date) ?? { [PIVOT]: 1 }
          day[r.quote] = r.rate
          byDate.set(r.date, day)
        }
        const points: Point[] = []
        for (const [date, day] of [...byDate].sort(([a], [b]) => (a < b ? -1 : 1))) {
          if (day[base] && day[quote]) points.push({ date, value: day[quote] / day[base] })
        }
        seriesCache.set(key, points)
        setResult({ key, attempt, status: 'ok', points })
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        setResult({ key, attempt, status: 'error', points: [], error: errorText(err) })
      })
    return () => ctrl.abort()
  }, [key, base, quote, range, attempt])

  const cached = seriesCache.get(key)
  const current: SeriesState = cached
    ? { key, status: 'ok', points: cached }
    : result.key === key && result.attempt === attempt
      ? result
      : { key, status: 'loading', points: [] }
  return { ...current, retry: () => setAttempt((n) => n + 1) }
}
