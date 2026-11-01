import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { latestPerSource, type Eew } from './data'

type QuakeFeed = {
  /** 連上之後收到的速報，每個來源最新一筆（含「測試速報畫面」模擬的） */
  eew: Eew[]
  live: boolean
  /** 只在這個分頁裡模擬一筆速報 */
  simulate: (eew: Eew) => void
}

const QuakeFeedContext = createContext<QuakeFeed | null>(null)

/**
 * 整個網站共用一條 /api/weather/quakes/ws：頁首的速報警報和地震頁都從這裡拿資料。
 * 斷線就自動重連，間隔從 2 秒加倍到 30 秒。
 */
export function QuakeFeedProvider({ children }: { children: ReactNode }) {
  const [eew, setEew] = useState<Eew[]>([])
  const [live, setLive] = useState(false)

  useEffect(() => {
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 2000
    let stopped = false

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${location.host}/api/weather/quakes/ws`)
      socket.onopen = () => {
        setLive(true)
        delay = 2000
      }
      socket.onmessage = (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (message.type === 'snapshot') setEew((prev) => latestPerSource([...prev, ...message.eew]))
        if (message.type === 'eew') setEew((prev) => latestPerSource([...prev, message.eew]))
      }
      socket.onclose = () => {
        setLive(false)
        if (stopped) return
        retry = setTimeout(connect, delay)
        delay = Math.min(delay * 2, 30000)
      }
    }

    connect()
    return () => {
      stopped = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [])

  const simulate = useCallback((test: Eew) => setEew((prev) => latestPerSource([...prev, test])), [])
  const value = useMemo(() => ({ eew, live, simulate }), [eew, live, simulate])
  return <QuakeFeedContext value={value}>{children}</QuakeFeedContext>
}

// oxlint-disable-next-line react/only-export-components
export function useQuakeFeed(): QuakeFeed {
  const feed = useContext(QuakeFeedContext)
  if (!feed) throw new Error('useQuakeFeed 要放在 <QuakeFeedProvider> 裡面')
  return feed
}
