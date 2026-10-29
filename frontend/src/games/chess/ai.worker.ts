// 電腦思考放在 worker，搜尋最多兩秒也不會卡住畫面
import { chooseMove, type Level } from './ai.ts'
import { Position } from './engine.ts'

export type AiRequest = { moves: number[]; level: Level }
export type AiResponse = { move: number }

self.addEventListener('message', (e: MessageEvent<AiRequest>) => {
  const { moves, level } = e.data
  // 從頭重播（而不是傳 FEN），搜尋才知道之前出現過哪些局面、避開或追求重複和棋
  const pos = Position.fromFen()
  for (const m of moves) pos.make(m)
  const response: AiResponse = { move: chooseMove(pos, level) }
  self.postMessage(response)
})
