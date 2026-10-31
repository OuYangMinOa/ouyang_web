import { useCallback, useEffect, useRef, type RefObject } from 'react'

/** 跟後端 visits.rs 的 ACTIONS 對應 */
export type VisitAction = 'open' | 'click' | 'scan' | 'error'

/** 錯誤可能一直重複，每次瀏覽最多送這麼多筆 */
const MAX_ERRORS = 20
const SESSION_KEY = 'visit-session'

// crypto.randomUUID 只在 HTTPS 能用，getRandomValues 沒有這個限制
function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 每個分頁一個 id（重新整理不變），後端靠它把同一次瀏覽的事件串起來 */
function sessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY)
    if (!id) {
      id = randomId()
      sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return randomId()
  }
}

function send(page: string, action: VisitAction, detail: string) {
  // keepalive：關掉分頁前的最後一筆也送得出去；帳號由後端從 session cookie 認
  fetch(`/api/visits/${page}`, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId(), action, detail }),
  }).catch(() => {})
}

/**
 * 隱藏頁面的瀏覽紀錄（系統管理 › 頁面訪客）：進來時送 open，`root` 裡的按鈕被點時送 click，
 * 頁面上的 JS 錯誤送 error。其他事件用回傳的 `track` 自己送。
 * 按鈕的名稱取 `data-track`，沒有就用按鈕上的字。
 */
export function useVisitTracking(page: string, root: RefObject<HTMLElement | null>) {
  const errors = useRef(0)
  const opened = useRef(false)

  const track = useCallback(
    (action: VisitAction, detail = '') => {
      if (action === 'error' && ++errors.current > MAX_ERRORS) return
      send(page, action, detail)
    },
    [page],
  )

  useEffect(() => {
    // StrictMode 在開發時會跑兩次 effect，ref 會留著，所以只送一次
    if (!opened.current) {
      opened.current = true
      track('open')
    }

    function onClick(e: MouseEvent) {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('button, [data-track]')
      if (!el || !root.current?.contains(el)) return
      track('click', el.dataset.track ?? el.textContent?.trim().replace(/\s+/g, ' ') ?? '')
    }
    function onError(e: ErrorEvent | Event) {
      const target = e.target as (HTMLElement & { src?: string; href?: string }) | null
      if (e instanceof ErrorEvent) {
        track('error', `${e.message} @${e.filename}:${e.lineno}:${e.colno}`)
      } else if (target && (target.src || target.href)) {
        track('error', `resource: ${target.src || target.href}`)
      }
    }
    function onRejection(e: PromiseRejectionEvent) {
      const reason = e.reason
      track('error', `promise: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`)
    }

    document.addEventListener('click', onClick, true)
    window.addEventListener('error', onError, true)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('error', onError, true)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [track, root])

  return track
}
