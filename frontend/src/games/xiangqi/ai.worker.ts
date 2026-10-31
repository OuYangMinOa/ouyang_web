// 在背景執行緒跑搜尋，避免卡住畫面
import { findBestMove, LEVELS, type Level } from './ai.ts'
import type { Move, Position } from './rules.ts'

export type AiRequest = { id: number; position: Position; past: Position[]; level: Level }
export type AiResponse = { id: number; move: Move }

// tsconfig 用的是 DOM lib，self 被當成 Window；Worker 的 postMessage 不需要 targetOrigin
const scope = self as unknown as Worker

scope.addEventListener('message', (e: MessageEvent<AiRequest>) => {
  const { id, position, past, level } = e.data
  const result = findBestMove(position, past, LEVELS[level])
  scope.postMessage({ id, move: result.move } satisfies AiResponse)
})
