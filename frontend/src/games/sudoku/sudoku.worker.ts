// 產生題目要反覆檢查唯一解與難度，放在 Worker 避免手機上卡住畫面
import { generate, type Difficulty, type Generated } from './logic'

export type GenRequest = { id: number; difficulty: Difficulty }
export type GenResponse = { id: number } & Generated

self.onmessage = (e: MessageEvent<GenRequest>) => {
  const res: GenResponse = { id: e.data.id, ...generate(e.data.difficulty) }
  self.postMessage(res)
}
