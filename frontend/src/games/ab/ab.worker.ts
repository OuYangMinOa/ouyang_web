// 1A2B 的重計算（找最佳猜測、賽後分析）放在 Worker，避免卡住畫面
import { CODES, analyze, chooseGuess, poolAfter, type Clue, type StepAnalysis } from './logic'

export type AbRequest = { id: number; type: 'next'; clues: Clue[] } | { id: number; type: 'analyze'; clues: Clue[] }

export type AbResponse =
  { id: number; type: 'next'; guess: string | null } | { id: number; type: 'analyze'; steps: StepAnalysis[] }

self.onmessage = (e: MessageEvent<AbRequest>) => {
  const req = e.data
  let res: AbResponse
  if (req.type === 'next') {
    const g = chooseGuess(poolAfter(req.clues))
    res = { id: req.id, type: 'next', guess: g < 0 ? null : CODES[g] }
  } else {
    res = { id: req.id, type: 'analyze', steps: analyze(req.clues).steps }
  }
  self.postMessage(res)
}
