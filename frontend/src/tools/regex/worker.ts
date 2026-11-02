// 正規表示式在 worker 裡執行：遇到災難性回溯時，主畫面可以直接把 worker 停掉，頁面不會卡死
import { MAX_MATCHES, type FromWorker, type Match, type ToWorker } from './protocol'

function post(msg: FromWorker) {
  self.postMessage(msg)
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const { id, pattern, flags, text, replacement } = e.data
  const t0 = performance.now()
  try {
    // d：取得每個群組的位置，只在這裡用，不影響取代結果
    const re = new RegExp(pattern, flags.includes('d') ? flags : flags + 'd')
    const matches: Match[] = []
    let truncated = false
    const toMatch = (m: RegExpExecArray): Match => ({
      start: m.index,
      end: m.index + m[0].length,
      value: m[0],
      groups: m.slice(1).map((value, k) => {
        const pos = m.indices?.[k + 1]
        return { value, start: pos?.[0], end: pos?.[1] }
      }),
    })

    if (re.global) {
      for (const m of text.matchAll(re)) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true
          break
        }
        matches.push(toMatch(m as RegExpExecArray))
      }
    } else {
      const m = re.exec(text)
      if (m) matches.push(toMatch(m))
    }

    const replaced = replacement === null ? null : text.replace(new RegExp(pattern, flags), replacement)
    post({ id, ok: true, matches, truncated, replaced, ms: performance.now() - t0 })
  } catch (err) {
    post({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
