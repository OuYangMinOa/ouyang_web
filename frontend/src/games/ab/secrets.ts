// 線上對戰時自己藏的數字：只存在這個瀏覽器，絕對不送出去（伺服器只會看到 commit）。
//
// 重連時是從房間歷史重播事件，數字不在歷史裡，所以要存起來才回報得了對手的猜測。
// 用 localStorage：關掉分頁再開、或登入後換分頁（座位認帳號）都還找得回來。
// 房間代碼過期後可能被重新發出，所以連 commit 一起存，對得上才算是這一局的。

import type { Seat } from '../shared/useRoom'
import { load, save } from '../shared/storage'

const KEY = 'ab:secrets'
/** 房間最多活 24 小時，存兩天就夠了 */
const TTL_MS = 2 * 24 * 60 * 60 * 1000

export type Secret = { secret: string; salt: string }
type Entry = Secret & { commit: string; at: number }

function id(code: string, seat: Seat, round: number) {
  return `${code}:${seat}:${round}`
}

function entries(): Record<string, Entry> {
  const all = load<unknown>(KEY, {})
  return all && typeof all === 'object' ? (all as Record<string, Entry>) : {}
}

export function storeSecret(code: string, seat: Seat, round: number, entry: Secret & { commit: string }) {
  const now = Date.now()
  const kept = Object.fromEntries(Object.entries(entries()).filter(([, e]) => now - e.at < TTL_MS))
  kept[id(code, seat, round)] = { ...entry, at: now }
  save(KEY, kept)
}

/** 找這一局自己藏的數字；commit 對不上（別的房間、或在別的裝置藏的）就當作沒有 */
export function loadSecret(code: string, seat: Seat, round: number, commit: string | null): Secret | null {
  if (commit === null) return null
  const e = entries()[id(code, seat, round)]
  if (!e || e.commit !== commit || typeof e.secret !== 'string' || typeof e.salt !== 'string') return null
  return { secret: e.secret, salt: e.salt }
}
