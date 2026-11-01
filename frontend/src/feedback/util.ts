import { useEffect, useRef } from 'react'

export function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 每隔一段時間執行一次（分頁在背景時暫停，切回來馬上跑一次），用來看對方有沒有新留言 */
export function usePolling(callback: () => void, ms: number) {
  const saved = useRef(callback)
  useEffect(() => {
    saved.current = callback
  })
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') saved.current()
    }
    const timer = setInterval(tick, ms)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [ms])
}
