import { chooseMove, type Level } from './ai'

export type AiRequest = { id: number; moves: number[]; level: Level }
export type AiResponse = { id: number; move: number }

// tsconfig 用的是 DOM 型別，這裡把 self 當成 worker 的介面
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<AiRequest>) => void) | null
  postMessage: (data: AiResponse) => void
}

// 置換表留在 worker 裡，同一局後面幾手可以沿用前面算過的局面
ctx.onmessage = (e) => {
  const { id, moves, level } = e.data
  ctx.postMessage({ id, move: chooseMove(moves, level) })
}
