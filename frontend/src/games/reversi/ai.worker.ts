import { chooseMove, type Level } from './ai'
import type { Disc } from './rules'

export type AiRequest = { id: number; board: number[]; color: Disc; level: Level }
export type AiResponse = { id: number; move: number }

// tsconfig 用的是 DOM 型別，這裡把 self 當成 worker 的介面
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AiRequest>) => void) | null
  postMessage: (data: AiResponse) => void
}

ctx.onmessage = (e) => {
  const { id, board, color, level } = e.data
  ctx.postMessage({ id, move: chooseMove(board, color, level) })
}
