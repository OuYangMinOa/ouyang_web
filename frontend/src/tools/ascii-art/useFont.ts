import { useEffect, useReducer, useState } from 'react'
import { isLoaded, loadFont } from './fonts'

export type FontStatus = 'ready' | 'loading' | 'error'

/** 確保字型已下載；載入完成後重新渲染 */
export function useFont(name: string): FontStatus {
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    if (isLoaded(name)) return
    let alive = true
    loadFont(name).then(
      () => alive && refresh(),
      () => alive && setFailed(name),
    )
    return () => {
      alive = false
    }
  }, [name])

  if (isLoaded(name)) return 'ready'
  return failed === name ? 'error' : 'loading'
}
