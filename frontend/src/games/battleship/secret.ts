// 線上對戰時自己的佈局：開局只送出 SHA-256(佈局 + salt)，佈局和 salt 留在這台裝置，結束後才公開。
// 斷線重連時事件是從伺服器的歷史重播的，裡面沒有佈局，所以要另外存在 localStorage（同一個瀏覽器換分頁也拿得回來）。

import { serializeLayout, type Layout } from './rules'

export type Secret = { layout: Layout; salt: string; hash: string; at: number }

const PREFIX = 'games:battleship:secret:'
/** 房間最多活 24 小時，存放超過兩天的佈局一定用不到了 */
const KEEP_MS = 2 * 24 * 60 * 60 * 1000

/** 存不了 localStorage（無痕、封鎖網站資料）時至少這個分頁還記得 */
const memory = new Map<string, Secret>()

/** 連雜湊一起當 key：按了兩次「準備好了」（第一次的還在路上）也不會蓋掉真正送出的那一份 */
function key(code: string, seat: number, round: number, hash: string) {
  return `${PREFIX}${code}:${seat}:${round}:${hash}`
}

export function newSalt(): string {
  // crypto.getRandomValues 在 http（staging）也能用
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 佈局的承諾值；用 hash-wasm 是因為 crypto.subtle 只在 HTTPS 能用 */
export async function commitHash(layout: Layout, salt: string): Promise<string> {
  const { sha256 } = await import('hash-wasm')
  return sha256(`${serializeLayout(layout)}|${salt}`)
}

export function saveSecret(code: string, seat: number, round: number, secret: Secret) {
  const k = key(code, seat, round, secret.hash)
  memory.set(k, secret)
  try {
    localStorage.setItem(k, JSON.stringify(secret))
    // 順便清掉很久以前的
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const name = localStorage.key(i)
      if (!name?.startsWith(PREFIX) || name === k) continue
      const old = JSON.parse(localStorage.getItem(name) ?? 'null') as Partial<Secret> | null
      if (!old || typeof old.at !== 'number' || Date.now() - old.at > KEEP_MS) localStorage.removeItem(name)
    }
  } catch {
    // 存不了就只留在記憶體，重新整理後會拿不回來
  }
}

/** 拿回自己這局送出的那一份佈局；找不到或內容對不上就當作沒有 */
export function loadSecret(code: string, seat: number, round: number, hash: string): Secret | null {
  const k = key(code, seat, round, hash)
  let secret = memory.get(k) ?? null
  if (!secret) {
    try {
      secret = JSON.parse(localStorage.getItem(k) ?? 'null') as Secret | null
    } catch {
      secret = null
    }
  }
  if (!secret || secret.hash !== hash || !Array.isArray(secret.layout) || typeof secret.salt !== 'string') return null
  memory.set(k, secret)
  return secret
}
