// 記住上次的選擇；localStorage 可能讀寫失敗（無痕模式等），失敗就用預設值

/** 每個工具用自己的前綴存設定，彼此不會互相蓋掉 */
export function createStore(prefix: string) {
  return {
    load<T>(key: string, fallback: T): T {
      try {
        const raw = localStorage.getItem(prefix + key)
        return raw === null ? fallback : (JSON.parse(raw) as T)
      } catch {
        return fallback
      }
    },
    save(key: string, value: unknown) {
      try {
        localStorage.setItem(prefix + key, JSON.stringify(value))
      } catch {
        // 存不了就算了
      }
    },
  }
}

export const { load, save } = createStore('tools:encoding:')

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`
}
