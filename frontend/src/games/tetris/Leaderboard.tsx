import {
  Leaderboard as SharedLeaderboard,
  RunReporter as SharedReporter,
  useLeaderboard as useSharedLeaderboard,
  type BaseEntry,
  type ScoreBoard,
} from '../shared/Leaderboard'

export { CHECKPOINT_MS, formatScore } from '../shared/Leaderboard'

/** 俄羅斯方塊單人模式的排行榜，見後端 tetris_scores.rs */

export type ScoreEntry = BaseEntry & { lines: number; level: number }

/** 回報給伺服器的中間態；盤面用 `Tetris.cells()` */
export type RunState = {
  score: number
  lines: number
  level: number
  pieces: number
  duration_ms: number
  board: string
}

export class RunReporter extends SharedReporter<RunState, ScoreEntry> {
  constructor() {
    super('tetris')
  }
}

export function useLeaderboard() {
  return useSharedLeaderboard<ScoreEntry>('tetris')
}

export function Leaderboard({ board, error }: { board: ScoreBoard<ScoreEntry> | null; error: string | null }) {
  return (
    <SharedLeaderboard
      board={board}
      error={error}
      meta={(e) => (
        <>
          {e.lines} 行 · Lv {e.level}
        </>
      )}
    />
  )
}
