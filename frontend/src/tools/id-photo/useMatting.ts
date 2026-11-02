// 去背：直接用「圖片去背」的 worker 與 ISNet 模型（同一份程式、同一份瀏覽器快取），這裡只負責收發訊息
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Backend, FromWorker, ToWorker } from '../remove-bg/protocol'

export type Matting = {
  phase: 'idle' | 'loading' | 'analyze' | 'done' | 'error'
  /** 下載模型的進度（bytes） */
  loaded?: number
  total?: number
  message?: string
}

export type Mask = { id: number; w: number; h: number; data: Uint8Array }

export function useMatting() {
  const [state, setState] = useState<Matting>({ phase: 'idle' })
  const [mask, setMask] = useState<Mask | null>(null)
  const [backend, setBackend] = useState<Backend | null>(null)
  const worker = useRef<Worker | null>(null)
  /** 目前這張圖的編號；worker 回來的舊結果就丟掉 */
  const currentId = useRef(0)

  const onMessage = useCallback((e: MessageEvent<FromWorker>) => {
    const msg = e.data
    switch (msg.type) {
      case 'backend':
        setBackend(msg.backend)
        break
      case 'download':
        if (msg.task === 'isnet') setState({ phase: 'loading', loaded: msg.loaded, total: msg.total })
        break
      case 'analyze':
        if (msg.id === currentId.current) setState({ phase: 'analyze' })
        break
      case 'mask':
        if (msg.id !== currentId.current) break
        setMask({ id: msg.id, w: msg.w, h: msg.h, data: msg.data })
        setState({ phase: 'done' })
        break
      case 'error':
        if (msg.id === currentId.current && msg.task === 'isnet') setState({ phase: 'error', message: msg.message })
        break
    }
  }, [])

  const getWorker = useCallback(() => {
    if (!worker.current) {
      const w = new Worker(new URL('../remove-bg/worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = onMessage
      w.onerror = (e) => {
        console.error(e)
        setState({ phase: 'error', message: '背景執行緒啟動失敗' })
      }
      worker.current = w
    }
    return worker.current
  }, [onMessage])

  useEffect(
    () => () => {
      worker.current?.terminate()
      worker.current = null
    },
    [],
  )

  /** 開始去背；source 是編輯解析度的圖，回傳的遮罩也是同樣尺寸 */
  const run = useCallback(
    async (id: number, source: ImageData) => {
      currentId.current = id
      setMask(null)
      setState({ phase: 'loading' })
      const bitmap = await createImageBitmap(source)
      const msg: ToWorker = { type: 'remove', id, bitmap }
      getWorker().postMessage(msg, [bitmap])
    },
    [getWorker],
  )

  /** 換圖或離開編輯時，讓還在跑的結果作廢 */
  const cancel = useCallback(() => {
    currentId.current++
    setMask(null)
    setState({ phase: 'idle' })
  }, [])

  return { state, mask, backend, run, cancel }
}
