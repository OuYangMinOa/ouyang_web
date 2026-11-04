import { useCallback, useEffect, useState } from 'react'

/**
 * 邀請連結：手機叫出系統的分享選單，沒有（或使用者取消）就複製到剪貼簿，`copied` 會亮兩秒。
 * 連剪貼簿都不能用（http 的手機網頁）時跳出對話框讓人自己複製。
 */
export function useInvite(url: string | null, title = '一起來玩') {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const share = useCallback(async () => {
    if (!url) return
    if (navigator.share) {
      try {
        await navigator.share({ title, url })
        return
      } catch {
        // 使用者取消分享，改成複製
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      window.prompt('複製這個連結給朋友：', url)
    }
  }, [url, title])

  const copy = useCallback(async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      window.prompt('複製這個連結給朋友：', url)
    }
  }, [url])

  return { share, copy, copied }
}
