// 亂數一律用 crypto.getRandomValues（密碼學等級），不用 Math.random

/** 0 ≤ n < max 的均勻亂數；用拒絕取樣避免取餘數造成的偏差 */
export function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf)
  while (buf[0] >= limit)
  return buf[0] % max
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

function format(bytes: Uint8Array): string {
  const h = hex(bytes)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function uuidV4(): string {
  // randomUUID 只在 HTTPS（安全環境）可用，區網用 http 開時改自己組
  if (typeof crypto.randomUUID === 'function' && window.isSecureContext) return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  return format(b)
}

// v7 = 48 位元毫秒時間戳 + 亂數，依時間排序。
// 同一毫秒內產生多個時，rand_a 的 12 位元當作遞增計數器（RFC 9562 方法 1），保證排序正確
let lastMs = -1
let seq = 0

export function uuidV7(): string {
  let ms = Date.now()
  if (ms <= lastMs) {
    ms = lastMs
    seq++
    if (seq > 0xfff) {
      // 計數器用完就借下一毫秒
      ms = ++lastMs
      seq = randomInt(0x800)
    }
  } else {
    lastMs = ms
    seq = randomInt(0x800)
  }
  const b = crypto.getRandomValues(new Uint8Array(16))
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256
  b[6] = 0x70 | (seq >> 8)
  b[7] = seq & 0xff
  b[8] = (b[8] & 0x3f) | 0x80
  return format(b)
}

export type UuidInfo = { version: number; variant: string; time?: number }

/** 解析貼上的 UUID：版本、變體，v1、v6、v7 還能讀出產生的時間 */
export function inspectUuid(s: string): UuidInfo | null {
  const h = s
    .trim()
    .replace(/^urn:uuid:/i, '')
    .replace(/^\{|\}$/g, '')
    .replace(/-/g, '')
    .toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(h)) return null
  const version = parseInt(h[12], 16)
  const v = parseInt(h[16], 16)
  const variant = v < 8 ? 'NCS（舊式）' : v < 12 ? 'RFC 9562' : v < 14 ? 'Microsoft' : '保留'
  let time: number | undefined
  if (version === 7) time = parseInt(h.slice(0, 12), 16)
  // v1／v6：從 1582-10-15 起算的 100 奈秒數
  const greg = (t: bigint) => Number((t - 0x01b21dd213814000n) / 10000n)
  if (version === 1) time = greg(BigInt('0x' + h.slice(13, 16) + h.slice(8, 12) + h.slice(0, 8)))
  if (version === 6) time = greg(BigInt('0x' + h.slice(0, 12) + h.slice(13, 16)))
  if (h === '0'.repeat(32)) return { version: 0, variant: 'Nil UUID（全為 0）' }
  if (h === 'f'.repeat(32)) return { version: 0, variant: 'Max UUID（全為 f）' }
  return { version, variant, time }
}
