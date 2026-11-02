import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errorMessage } from '../api'
import { useAuth } from '../auth'

/**
 * 側邊欄的釘選：沒登入存在瀏覽器，有登入就存在帳號（後端 nav_pins.rs），換裝置也一樣。
 * 每個側邊欄用一個 scope（APP 的 id）分開存，值是釘選的網址，依釘選的先後。
 */

type PinMap = Record<string, string[]>

const STORAGE_KEY = 'nav-pins'

/** localStorage 或伺服器的資料可能是舊版或壞掉的，只留下格式對的 */
function sanitize(raw: unknown): PinMap {
  const pins: PinMap = {}
  if (!raw || typeof raw !== 'object') return pins
  for (const [scope, paths] of Object.entries(raw)) {
    if (Array.isArray(paths)) pins[scope] = paths.filter((p): p is string => typeof p === 'string')
  }
  return pins
}

function loadLocal(): PinMap {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
  } catch {
    return {}
  }
}

function saveLocal(pins: PinMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pins))
  } catch {
    // 存不了就算了，只是下次不會記得
  }
}

type NavPins = {
  pins: PinMap
  toggle: (scope: string, path: string) => void
  error: string | null
}

const NavPinsContext = createContext<NavPins | null>(null)

/** 頁首的手機選單和側邊欄同時用到，放在最外層讓兩邊共用同一份 */
export function NavPinsProvider({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const [pins, setPins] = useState<PinMap>(loadLocal)
  const [error, setError] = useState<string | null>(null)
  /** 伺服器的資料回來之前就改過的 scope，不要被蓋掉 */
  const changed = useRef(new Set<string>())
  /** 一個接一個送，順序才不會亂 */
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const userId = user?.id
  useEffect(() => {
    if (loading || !userId) return
    let cancelled = false
    changed.current.clear()
    api<{ pins: unknown }>('/nav/pins')
      .then((r) => {
        if (cancelled) return
        // 帳號還沒存過的 scope 就沿用這個瀏覽器的
        const server = sanitize(r.pins)
        setPins((local) => {
          const next = { ...local }
          for (const [scope, paths] of Object.entries(server)) if (!changed.current.has(scope)) next[scope] = paths
          saveLocal(next)
          return next
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [loading, userId])

  const toggle = useCallback(
    (scope: string, path: string) => {
      const current = pins[scope] ?? []
      const paths = current.includes(path) ? current.filter((p) => p !== path) : [...current, path]
      const next = { ...pins, [scope]: paths }
      changed.current.add(scope)
      setPins(next)
      saveLocal(next)
      if (!userId) return
      queue.current = queue.current
        .then(() => api(`/nav/pins/${scope}`, { method: 'PUT', body: JSON.stringify({ paths }) }))
        .then(() => setError(null))
        .catch((e) => setError(`沒能存到帳號：${errorMessage(e)}`))
    },
    [pins, userId],
  )

  return <NavPinsContext value={{ pins, toggle, error }}>{children}</NavPinsContext>
}

// oxlint-disable-next-line react/only-export-components
export function useNavPins(scope: string) {
  const context = useContext(NavPinsContext)
  if (!context) throw new Error('useNavPins must be used inside <NavPinsProvider>')
  const { pins, toggle, error } = context
  return {
    paths: pins[scope] ?? [],
    toggle: (path: string) => toggle(scope, path),
    error,
  }
}
