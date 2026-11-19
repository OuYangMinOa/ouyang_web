import { api } from '../api'

export type Vote = 'love' | 'hate'

/** 跟後端 funcsay.rs 的 Quote 對應 */
export type Quote = {
  id: number
  text: string
  /** 由來、出處；沒有是空字串 */
  source: string
  politics: boolean
  love: number
  hate: number
}

type Listing = {
  quotes: Quote[]
  /** 沒登入是 null */
  mine: { votes: Record<string, Vote>; favorites: number[] } | null
}

export function fetchQuotes() {
  return api<Listing>('/funcsay')
}

export function sendVote(id: number, vote: Vote | null) {
  return api<{ quote: Quote; vote: Vote | null }>(`/funcsay/${id}/vote`, {
    method: 'PUT',
    body: JSON.stringify({ vote }),
  })
}

export function sendFavorite(id: number, favorite: boolean) {
  return api<void>(`/funcsay/${id}/favorite`, { method: 'PUT', body: JSON.stringify({ favorite }) })
}

/** 政治類要不要顯示：Android APP 預設不顯示，這裡也一樣 */
export type Politics = 'hide' | 'all' | 'only'
export const POLITICS: { value: Politics; label: string }[] = [
  { value: 'hide', label: '不含政治' },
  { value: 'all', label: '全部（含政治）' },
  { value: 'only', label: '只看政治' },
]

export type Sort = 'id' | 'newest' | 'love'
export const SORTS: { value: Sort; label: string }[] = [
  { value: 'id', label: '依編號' },
  { value: 'newest', label: '最新加入' },
  { value: 'love', label: '最多讚' },
]

export function byPolitics(quotes: Quote[], politics: Politics) {
  if (politics === 'all') return quotes
  return quotes.filter((q) => q.politics === (politics === 'only'))
}

/** 搜尋語錄、出處或編號 */
export function matches(quote: Quote, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return quote.text.toLowerCase().includes(q) || quote.source.toLowerCase().includes(q) || String(quote.id) === q
}

export function sortQuotes(quotes: Quote[], sort: Sort) {
  const sorted = [...quotes]
  if (sort === 'newest') sorted.sort((a, b) => b.id - a.id)
  else if (sort === 'love') sorted.sort((a, b) => b.love - a.love || a.hate - b.hate || a.id - b.id)
  else sorted.sort((a, b) => a.id - b.id)
  return sorted
}

/** 從 `from` 換成 `to` 之後的票數（先在畫面上改，伺服器回來再換成真正的數字） */
export function applyVote(quote: Quote, from: Vote | null, to: Vote | null): Quote {
  const next = { ...quote }
  if (from) next[from] = Math.max(0, next[from] - 1)
  if (to) next[to] += 1
  return next
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`funcsay:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`funcsay:${key}`, JSON.stringify(value))
  } catch {
    // 存不了就只在這次有效
  }
}
