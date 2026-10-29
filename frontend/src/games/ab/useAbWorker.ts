import { useCallback, useEffect, useRef } from 'react'
import type { AbRequest, AbResponse } from './ab.worker'

type Body<T> = T extends unknown ? Omit<T, 'id'> : never
type Reply<K> = Extract<AbResponse, { type: K }>

/** 回傳一個送工作給 Worker 的函式；元件卸載時終止 Worker，未完成的請求就不會回來 */
export function useAbWorker() {
  const worker = useRef<Worker | null>(null)
  const pending = useRef(new Map<number, (res: AbResponse) => void>())
  const seq = useRef(0)

  useEffect(() => {
    const waiting = pending.current
    return () => {
      worker.current?.terminate()
      worker.current = null
      waiting.clear()
    }
  }, [])

  return useCallback(<R extends Body<AbRequest>>(req: R): Promise<Reply<R['type']>> => {
    if (!worker.current) {
      const w = new Worker(new URL('./ab.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<AbResponse>) => {
        const done = pending.current.get(e.data.id)
        pending.current.delete(e.data.id)
        done?.(e.data)
      }
      worker.current = w
    }
    const id = ++seq.current
    return new Promise((resolve) => {
      pending.current.set(id, (res) => resolve(res as Reply<R['type']>))
      worker.current!.postMessage({ ...req, id })
    })
  }, [])
}
