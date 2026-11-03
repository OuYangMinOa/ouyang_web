import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api'
import { useAuth } from '../../auth'
import { load, save } from './storage'

/** 連續改動（例如拖滑桿）停下來這麼久才存到帳號 */
const SAVE_DELAY_MS = 500

/**
 * 個人設定（快捷鍵、操作手感）：沒登入存在瀏覽器，有登入就存在帳號（後端 game_settings.rs），換裝置也一樣。
 * 伺服器的格式是 `{ [field]: 值 }`，讀到 null 是還沒存過；存 null 是恢復預設。
 * `clean` 把 localStorage 或伺服器讀到的資料（可能是舊版或壞掉的）整理成完整的設定，null 時給預設值。
 */
export function useAccountSetting<T>(storageKey: string, endpoint: string, field: string, clean: (raw: unknown) => T) {
  const { user, loading } = useAuth()
  const [value, setValue] = useState<T>(() => clean(load<unknown>(storageKey, null)))
  const [error, setError] = useState<string | null>(null)
  /** 伺服器的設定回來之前就改過的話，不要被蓋掉 */
  const changed = useRef(false)
  /** 一個接一個送，順序才不會亂 */
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  /** 還沒送出去的最新設定 */
  const pending = useRef<{ value: T | null } | null>(null)
  const timer = useRef(0)
  const cleanRef = useRef(clean)
  useEffect(() => {
    cleanRef.current = clean
  })

  const userId = user?.id
  useEffect(() => {
    if (loading || !userId) return
    let cancelled = false
    changed.current = false
    api<Record<string, unknown>>(endpoint)
      .then((r) => {
        // 帳號還沒存過就沿用這個瀏覽器的設定
        if (cancelled || changed.current || r[field] == null) return
        const next = cleanRef.current(r[field])
        setValue(next)
        save(storageKey, next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [loading, userId, endpoint, field, storageKey])

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    const p = pending.current
    pending.current = null
    if (!p) return
    queue.current = queue.current
      .then(() => api(endpoint, { method: 'PUT', body: JSON.stringify({ [field]: p.value }) }))
      .then(() => setError(null))
      .catch((e) => setError(`沒能存到帳號：${errorMessage(e)}`))
  }, [endpoint, field])
  // 離開頁面前把還沒送的送出去
  useEffect(() => flush, [flush])

  /** 改成新的設定；null 是恢復預設 */
  const change = useCallback(
    (next: T | null) => {
      changed.current = true
      setValue(next ?? cleanRef.current(null))
      save(storageKey, next)
      if (!userId) return
      pending.current = { value: next }
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(flush, SAVE_DELAY_MS)
    },
    [userId, storageKey, flush],
  )

  return { value, change, error, synced: !!userId }
}
