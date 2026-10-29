// localStorage 在無痕模式或封鎖網站資料時可能讀寫失敗，失敗就當作沒有存過

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`games:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`games:${key}`, JSON.stringify(value))
  } catch {
    // 存不了就算了，只是下次不會記得
  }
}
