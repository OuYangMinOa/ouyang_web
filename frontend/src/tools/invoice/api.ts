import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api'
import type { InvoiceReport, Period } from './prize'

// localStorage 可能讀寫失敗（無痕模式等），失敗就當作沒有
const PREFIX = 'tools:invoice:'

export function store<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // 存不了就只在這次有效
  }
}

const isPeriod = (p: unknown): p is Period => {
  const v = p as Period
  return !!v && typeof v.id === 'string' && typeof v.special === 'string' && Array.isArray(v.first) && Array.isArray(v.extra)
}

/** 上次抓到的號碼；連不上後端時先用它 */
function cachedReport(): InvoiceReport | null {
  const r = store<InvoiceReport | null>('report', null)
  return r && Array.isArray(r.periods) && r.periods.every(isPeriod) ? r : null
}

export type ReportState = {
  report: InvoiceReport | null
  loading: boolean
  /** 抓不到時的訊息；有舊資料時仍然會顯示舊資料 */
  error: string | null
  reload: () => void
}

export function useReport(): ReportState {
  const [report, setReport] = useState<InvoiceReport | null>(cachedReport)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    api<InvoiceReport>('/invoice/winning')
      .then((r) => {
        if (!active) return
        setReport(r)
        setError(null)
        persist('report', r)
      })
      .catch((e: unknown) => {
        if (active) setError(navigator.onLine ? `無法取得中獎號碼（${errorMessage(e)}）` : '目前離線')
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [nonce])

  const reload = useCallback(() => {
    setLoading(true)
    setNonce((n) => n + 1)
  }, [])

  return { report, loading, error, reload }
}
