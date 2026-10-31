import {
  Leaderboard as SharedLeaderboard,
  RunReporter as SharedReporter,
  useLeaderboard as useSharedLeaderboard,
  type BaseEntry,
  type ScoreBoard,
} from '../shared/Leaderboard'

/** 魔法氣泡單人模式的排行榜，見後端 puyo_scores.rs */

export type ScoreEntry = BaseEntry & { max_chain: number; level: number }

/** 回報給伺服器的中間態；盤面用 `Puyo.cells()` */
export type RunState = {
  score: number
  level: number
  pieces: number
  popped: number
  lost: number
  max_chain: number
  duration_ms: number
  board: string
}

export class RunReporter extends SharedReporter<RunState, ScoreEntry> {
  constructor() {
    super('puyo')
  }
}

export function useLeaderboard() {
  return useSharedLeaderboard<ScoreEntry>('puyo')
}

export function Leaderboard({ board, error }: { board: ScoreBoard<ScoreEntry> | null; error: string | null }) {
  return (
    <SharedLeaderboard
      board={board}
      error={error}
      meta={(e) => (
        <>
          最大 {e.max_chain} 連鎖 · Lv {e.level}
        </>
      )}
    />
  )
}
