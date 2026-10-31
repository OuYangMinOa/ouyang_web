import { useEffect, useRef } from 'react'
import type { Level } from './ai'
import type { AiRequest, AiResponse } from './ai.worker'
import type { Disc } from './rules'

export type ComputerJob = { board: Int8Array; color: Disc; level: Level; ply: number }

// 電腦太快落子會讓人來不及看，至少等這麼久
const MIN_DELAY = 300
let nextId = 0

/**
 * job 不是 null 時請 worker 算一步，算完呼叫 onMove(pos, ply)。
 * job 改變（悔棋、重開、換模式）就取消：還在算的 worker 直接終止，結果不會回來。
 */
export function useComputerMove(job: ComputerJob | null, onMove: (pos: number, ply: number) => void) {
  const worker = useRef<Worker | null>(null)

  useEffect(
    () => () => {
      worker.current?.terminate()
      worker.current = null
    },
    [],
  )

  useEffect(() => {
    if (!job) return
    const id = ++nextId
    const started = performance.now()
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const finish = (move: number) => {
      done = true
      timer = setTimeout(() => onMove(move, job.ply), Math.max(0, MIN_DELAY - (performance.now() - started)))
    }
    // worker 無法使用時的備案：在主執行緒用簡單難度算（只看一手，很快）
    const fallback = () => {
      done = true
      void import('./ai').then(({ chooseMove }) => {
        if (!cancelled) finish(chooseMove(job.board, job.color, 'easy'))
      })
    }

    let w = worker.current
    try {
      w ??= new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' })
      worker.current = w
    } catch {
      fallback()
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }
    const current = w
    const onMessage = (e: MessageEvent<AiResponse>) => {
      if (e.data.id === id) finish(e.data.move)
    }
    const onError = () => {
      if (done) return
      current.terminate()
      if (worker.current === current) worker.current = null
      fallback()
    }
    current.addEventListener('message', onMessage)
    current.addEventListener('error', onError)
    const request: AiRequest = { id, board: Array.from(job.board), color: job.color, level: job.level }
    current.postMessage(request)

    return () => {
      cancelled = true
      clearTimeout(timer)
      current.removeEventListener('message', onMessage)
      current.removeEventListener('error', onError)
      if (!done) {
        current.terminate()
        if (worker.current === current) worker.current = null
      }
    }
  }, [job, onMove])
}
