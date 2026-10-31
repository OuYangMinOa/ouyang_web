import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../api'
import { useAuth } from '../../auth'
import { load, save } from './storage'

/**
 * 自訂快捷鍵（俄羅斯方塊、魔法氣泡共用）：沒登入存在瀏覽器，有登入就存在帳號（後端 game_settings.rs），換裝置也一樣。
 * 每個遊戲用一個 `KeyScheme` 說明有哪些動作和預設鍵。
 * 按鍵用 `KeyboardEvent.code`（實體按鍵的位置，不受輸入法和大小寫影響）；Shift、Ctrl 不分左右。
 */

export type Keys<A extends string = string> = Record<A, string[]>

export type KeyScheme<A extends string = string> = {
  /** 網址和 localStorage 用的遊戲 id：設定存在 `/games/<game>/settings` */
  game: string
  actions: { action: A; label: string }[]
  defaults: Keys<A>
}

/** 每個動作最多綁幾個鍵 */
export const SLOTS = 2

/** 左右兩顆一樣的修飾鍵當成同一顆 */
export function normalize(code: string): string {
  return /^(Shift|Control)(Left|Right)$/.test(code) ? code.replace(/(Left|Right)$/, '') : code
}

/** 不能拿來當快捷鍵的：Backspace 用來清除，Tab 留給鍵盤操作頁面，Alt 和 Win/⌘ 會被系統搶走 */
export function bindable(code: string): boolean {
  return !!code && !/^(Backspace|Tab|Alt|Meta|OS|ContextMenu)/.test(code)
}

/** 從 localStorage 或伺服器讀到的資料可能是舊版或壞掉的，整理成完整的設定 */
export function sanitize<A extends string>(scheme: KeyScheme<A>, raw: unknown): Keys<A> {
  const keys = { ...scheme.defaults }
  if (!raw || typeof raw !== 'object') return keys
  const used = new Set<string>()
  for (const { action } of scheme.actions) {
    const codes = (raw as Record<string, unknown>)[action]
    if (!Array.isArray(codes)) continue
    keys[action] = codes
      .filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9]{1,32}$/.test(c) && bindable(c))
      .filter((c) => !used.has(c) && (used.add(c), true))
      .slice(0, SLOTS)
  }
  return keys
}

export function actionOf<A extends string>(scheme: KeyScheme<A>, keys: Keys<A>, code: string): A | undefined {
  const key = normalize(code)
  return scheme.actions.find(({ action }) => keys[action].includes(key))?.action
}

/** 把 `code` 設成某個動作的第 `slot` 個鍵；原本在別的動作上就從那邊拿掉 */
export function bind<A extends string>(scheme: KeyScheme<A>, keys: Keys<A>, action: A, slot: number, code: string): Keys<A> {
  const key = normalize(code)
  const next = {} as Keys<A>
  for (const { action: a } of scheme.actions) next[a] = keys[a].filter((c) => c !== key)
  const codes = [...next[action]]
  codes.splice(Math.min(slot, codes.length), 1, key)
  next[action] = codes.slice(0, SLOTS)
  return next
}

export function unbind<A extends string>(keys: Keys<A>, action: A, slot: number): Keys<A> {
  return { ...keys, [action]: keys[action].filter((_, i) => i !== slot) }
}

export function isDefault<A extends string>(scheme: KeyScheme<A>, keys: Keys<A>): boolean {
  return scheme.actions.every(({ action }) => keys[action].join() === scheme.defaults[action].join())
}

const NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: '空白鍵',
  Shift: 'Shift',
  Control: 'Ctrl',
  Escape: 'Esc',
  Enter: 'Enter',
  CapsLock: 'Caps Lock',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadEnter: '數字鍵 Enter',
}

/** 按鍵代碼給人看的名稱 */
export function keyName(code: string): string {
  if (NAMES[code]) return NAMES[code]
  const m = /^(?:Key|Digit)(.)$/.exec(code)
  if (m) return m[1]
  if (code.startsWith('Numpad')) return `數字鍵 ${code.slice(6)}`
  return code
}

/** 某個動作的鍵，用「 / 」連起來；沒設定顯示「（未設定）」 */
export function keyNames<A extends string>(keys: Keys<A>, action: A): string {
  return keys[action].map(keyName).join(' / ') || '（未設定）'
}

/** 目前的快捷鍵；改了就存起來（有登入的話也存到帳號） */
export function useKeys<A extends string>(scheme: KeyScheme<A>) {
  const { user, loading } = useAuth()
  const storageKey = `${scheme.game}:keys`
  const endpoint = `/games/${scheme.game}/settings`
  const [keys, setKeys] = useState<Keys<A>>(() => sanitize(scheme, load<unknown>(storageKey, null)))
  const [error, setError] = useState<string | null>(null)
  /** 伺服器的設定回來之前就改過的話，不要被蓋掉 */
  const changed = useRef(false)
  /** 一個接一個送，順序才不會亂 */
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const userId = user?.id
  useEffect(() => {
    if (loading || !userId) return
    let cancelled = false
    changed.current = false
    api<{ keys: unknown }>(endpoint)
      .then((r) => {
        // 帳號還沒存過就沿用這個瀏覽器的設定
        if (cancelled || changed.current || !r.keys) return
        const next = sanitize(scheme, r.keys)
        setKeys(next)
        save(storageKey, next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [loading, userId, scheme, endpoint, storageKey])

  /** 改成新的設定；null 是恢復預設 */
  const change = useCallback(
    (next: Keys<A> | null) => {
      changed.current = true
      setKeys(next ?? scheme.defaults)
      save(storageKey, next)
      if (!userId) return
      queue.current = queue.current
        .then(() => api(endpoint, { method: 'PUT', body: JSON.stringify({ keys: next }) }))
        .then(() => setError(null))
        .catch((e) => setError(`沒能存到帳號：${errorMessage(e)}`))
    },
    [userId, scheme, endpoint, storageKey],
  )

  return { scheme, keys, change, error, synced: !!userId }
}

export type KeySettings<A extends string = string> = ReturnType<typeof useKeys<A>>
