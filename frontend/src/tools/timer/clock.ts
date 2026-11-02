import { useEffect, useRef, useState } from 'react'

/**
 * 現在的時間（毫秒）。所有計時都存「什麼時候開始／結束」的時間戳，顯示時再相減，
 * 不靠 setInterval 一格一格累加：背景分頁的計時器會被瀏覽器放慢，累加就會越走越慢。
 * performance.now() 在同一頁裡不會因為調整系統時間而跳動；加上 timeOrigin 讓重新整理後也接得上。
 */
export const now = () => performance.timeOrigin + performance.now()

/** 倒數：跑的時候記結束時間，暫停時記剩下多少 */
export type Run = {
  duration: number
  /** 正在跑：什麼時候結束；暫停或還沒開始：null */
  endAt: number | null
  /** 暫停時剩下的毫秒 */
  left: number
}

export const newRun = (duration: number): Run => ({ duration, endAt: null, left: duration })
export const remaining = (r: Run, t: number) => (r.endAt === null ? r.left : Math.max(0, r.endAt - t))
export const startRun = (r: Run, t: number): Run => (r.endAt === null && r.left > 0 ? { ...r, endAt: t + r.left } : r)
export const pauseRun = (r: Run, t: number): Run => (r.endAt === null ? r : { ...r, endAt: null, left: remaining(r, t) })
export const isFresh = (r: Run) => r.endAt === null && r.left === r.duration

/** 倒數顯示：無條件進位到秒（剩 0.2 秒還是顯示 0:01，到 0 才響） */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}

/** 碼表顯示：到百分之一秒 */
export function formatStopwatch(ms: number): string {
  const cs = Math.floor(ms / 10)
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  const tail = `${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${tail}` : `${String(m).padStart(2, '0')}:${tail}`
}

/** 跑的時候定期重繪（只是更新畫面，時間本身每次都重新算） */
export function useNow(active: boolean, interval = 200): number {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setTick((n) => n + 1), interval)
    return () => clearInterval(id)
  }, [active, interval])
  return now()
}

/**
 * 在 endAt 那一刻呼叫 onEnd。只排一個 setTimeout 直接等到結束（不是每秒輪詢），背景分頁也幾乎準時；
 * 萬一提早醒來就再排一次，分頁切回前景時也再檢查一次。
 */
export function useAlarm(endAt: number | null, onEnd: (endAt: number) => void) {
  const ref = useRef(onEnd)
  useEffect(() => {
    ref.current = onEnd
  })
  useEffect(() => {
    if (endAt === null) return
    let timer = 0
    let fired = false
    const check = () => {
      clearTimeout(timer)
      if (fired) return
      const ms = endAt - now()
      if (ms <= 0) {
        fired = true
        ref.current(endAt)
      } else {
        // setTimeout 最多只能等 2^31-1 毫秒
        timer = window.setTimeout(check, Math.min(ms, 0x7fffffff))
      }
    }
    check()
    document.addEventListener('visibilitychange', check)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [endAt])
}

// 記住設定與進行中的計時（重新整理也接得上）；localStorage 可能讀寫失敗，失敗就用預設值
const PREFIX = 'tools:timer:'

export function load<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    const v: unknown = JSON.parse(raw)
    return valid(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // 存不了就只在這次有效
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
export const isRun = (v: unknown): v is Run => {
  const r = v as Run
  return !!r && isNum(r.duration) && isNum(r.left) && (r.endAt === null || isNum(r.endAt))
}
