/** 跟後端 music.rs 的 Track 對應 */
export type Track = {
  name: string
  size: number
  /** Unix 毫秒 */
  modified: number
}

export type Repeat = 'off' | 'all' | 'one'
export type Sort = 'name' | 'newest'

/** 這幾天內加進來的標「新」 */
const NEW_DAYS = 14

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' })

export function trackUrl(name: string) {
  return `/api/music/files/${encodeURIComponent(name)}`
}

/**
 * 分享用的完整網址，直接指向音檔：貼到 Telegram、Discord 會顯示可以直接播的播放條。
 * 中文字保留原樣比較好讀；空白、符號和全形標點照樣編碼，聊天軟體才不會把網址截斷。
 */
export function shareUrl(name: string) {
  const path = [...name].map((c) => (c > '\x7f' && /[\p{L}\p{N}\p{M}]/u.test(c) ? c : encodeURIComponent(c))).join('')
  return `${location.origin}/api/music/files/${path}`
}

/** 顯示用的名稱：去掉副檔名 */
export function trackTitle(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export function isNew(track: Track, now = Date.now()) {
  return now - track.modified < NEW_DAYS * 86_400_000
}

export function sortTracks(tracks: Track[], sort: Sort): Track[] {
  return [...tracks].sort((a, b) =>
    sort === 'newest' ? b.modified - a.modified || collator.compare(a.name, b.name) : collator.compare(a.name, b.name),
  )
}

export function matches(track: Track, query: string) {
  const q = query.trim().toLowerCase()
  return !q || trackTitle(track.name).toLowerCase().includes(q)
}

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatDate(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** Fisher–Yates */
export function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// localStorage 在無痕模式或封鎖網站資料時可能讀寫失敗，失敗就當作沒有存過
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`music:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`music:${key}`, JSON.stringify(value))
  } catch {
    // 存不了就只在這次有效
  }
}
