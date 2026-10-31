/** 名單裡的一筆；同名的人各算一筆，id 是在名單裡的位置 */
export type Entry = { id: number; name: string }

/** 一行一個，也接受逗號、頓號分隔 */
export function parseNames(text: string): Entry[] {
  return text
    .split(/[\n,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name, id) => ({ id, name }))
}

/** 獎項：一行一個，「頭獎*2」「二獎 x3」代表有幾份 */
export function parsePrizes(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[\n,，、]/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(.*?)\s*[*×xX]\s*(\d{1,3})$/.exec(line)
    const name = m && m[1] ? m[1] : line
    const times = m && m[1] ? Math.min(Number(m[2]), 200) : 1
    for (let i = 0; i < times; i++) out.push(name)
  }
  return out
}

/** 0 ≤ 結果 < n 的均勻亂數，用 crypto 避免 Math.random 的偏差 */
export function randInt(n: number): number {
  if (n <= 1) return 0
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf)
  while (buf[0] >= limit)
  return buf[0] % n
}

export function shuffle<T>(list: readonly T[]): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 抽籤用的顏色數量，跟 index.css 的 --lot-1 … --lot-10 一致 */
export const COLORS = 10

/** 第 i 個的顏色；總數除以顏色數餘 1 時，最後一個會跟第一個相鄰（轉盤頭尾相接），改用別的顏色 */
export function colorIndex(i: number, total: number): number {
  if (total > 1 && i === total - 1 && total % COLORS === 1) return 2
  return (i % COLORS) + 1
}

export const colorVar = (i: number, total: number) => `var(--lot-${colorIndex(i, total)})`

/** 跟著人走的顏色（用名單裡的 id），彈珠、籤和名次表用同一個 */
export const entryColor = (id: number) => `var(--lot-${(id % COLORS) + 1})`

// 記住上次的名單與選項；localStorage 可能讀寫失敗（無痕模式等），失敗就用預設值
const PREFIX = 'tools:lottery:'

export function load<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (raw === null) return fallback
    const v: unknown = JSON.parse(raw)
    return valid(v) ? v : fallback
  } catch {
    return fallback
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // 存不了就只在這次有效
  }
}

/** 可以取消的等待；元件卸載或按「跳過」時用 */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/** 每個畫面更新一次 onFrame(進度 0~1)；skip() 會讓動畫直接跳到結尾 */
export function animate(ms: number, signal: AbortSignal, onFrame: (t: number) => void, skip?: { current: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const start = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const t = skip?.current ? 1 : Math.min(1, (now - start) / ms)
      onFrame(t)
      if (t < 1) raf = requestAnimationFrame(frame)
      else resolve()
    }
    raf = requestAnimationFrame(frame)
    signal.addEventListener(
      'abort',
      () => {
        cancelAnimationFrame(raf)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
