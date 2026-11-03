import { lazy } from 'react'

const RELOADED_AT = 'chunk-reload-at'

/**
 * 和 React 的 lazy 一樣，但下載失敗時重新整理一次。
 * 每次部署 chunk 的檔名都會換，舊檔就不在了：網頁開著跨過部署的人一換頁就載入失敗，整個畫面變空白。
 * 換頁時網址已經是新頁面，重新整理就直接拿到新版。一分鐘內只重整一次，真的連不上時才不會一直重整。
 * 只用在進頁面時載入的元件；頁面途中才載入的東西（遊戲音樂、電腦 AI…）重整會弄丟進度，不要用。
 */
export const lazyPage: typeof lazy = (load) =>
  lazy(() =>
    load().catch((error: unknown) => {
      if (!claimReload()) throw error
      location.reload()
      // 等重新整理，這段時間 Suspense 繼續顯示「載入中…」
      return new Promise<never>(() => {})
    }),
  )

function claimReload() {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT))
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem(RELOADED_AT, String(Date.now()))
    return true
  } catch {
    return false
  }
}
