import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { api, errorMessage } from '../../api'
import { useAuth } from '../../auth'

/** 單人模式的排行榜：每個帳號只留最高分，見後端 tetris_scores.rs */

export type ScoreEntry = {
  rank: number
  username: string
  score: number
  lines: number
  level: number
  duration_ms: number
  achieved_at: string
}

export type ScoreBoard = {
  top: ScoreEntry[]
  me: ScoreEntry | null
  /** 上傳時才有：這次有沒有刷新自己的紀錄 */
  best?: boolean
}

/** 回報給伺服器的中間態；盤面用 `Tetris.cells()` */
export type RunState = {
  score: number
  lines: number
  level: number
  pieces: number
  duration_ms: number
  board: string
}

/** 每隔多久（遊戲時間）回報一次進度，後端最多容許 20 秒沒回報 */
export const CHECKPOINT_MS = 5000

/**
 * 一局的成績上傳：開局時跟伺服器拿 run id，玩的時候定期回報中間態，結束時交出最後的狀態。
 * 伺服器靠這些中間態確認真的有玩（見後端 tetris_scores.rs）。請求一個接一個送，順序不會亂。
 */
export class RunReporter {
  private id: Promise<string | null>
  private queue: Promise<unknown>

  constructor() {
    this.id = api<{ id: string }>('/games/tetris/runs', { method: 'POST' })
      .then((r) => r.id)
      .catch(() => null)
    this.queue = this.id
  }

  private async send<T>(action: 'checkpoints' | 'finish', state: RunState): Promise<T> {
    const id = await this.id
    if (!id) throw new Error('沒能跟伺服器開始這一局，成績無法上傳')
    return api<T>(`/games/tetris/runs/${id}/${action}`, { method: 'POST', body: JSON.stringify(state) })
  }

  /** 回報進度；失敗就算了，結束時伺服器會再檢查（掉太多次這局就不算） */
  report(state: RunState) {
    this.queue = this.queue.then(() => this.send('checkpoints', state)).catch(() => {})
  }

  /** 結束並上傳，回傳更新後的排行榜 */
  finish(state: RunState): Promise<ScoreBoard> {
    const done = this.queue.then(() => this.send<ScoreBoard>('finish', state))
    this.queue = done.catch(() => {})
    return done
  }
}

export function useLeaderboard() {
  const { user, loading } = useAuth()
  const [board, setBoard] = useState<ScoreBoard | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 登入狀態確定後再抓，才拿得到自己的名次
  const userId = user?.id
  useEffect(() => {
    if (loading) return
    let cancelled = false
    api<ScoreBoard>('/games/tetris/scores')
      .then((b) => {
        if (!cancelled) {
          setBoard(b)
          setError(null)
        }
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [loading, userId])

  /** 上傳完拿到的新排行榜 */
  const update = useCallback((b: ScoreBoard) => {
    setBoard(b)
    setError(null)
  }, [])

  return { board, error, update }
}

export function formatScore(n: number): string {
  return n.toLocaleString('en-US')
}

function Row({ entry, mine }: { entry: ScoreEntry; mine: boolean }) {
  return (
    <li className={mine ? 'tetris-rank mine' : 'tetris-rank'}>
      <span className="tetris-rank-no">{entry.rank}</span>
      <span className="tetris-rank-name">{entry.username}</span>
      <span className="tetris-rank-score">{formatScore(entry.score)}</span>
      <span className="tetris-rank-meta">
        {entry.lines} 行 · Lv {entry.level}
      </span>
    </li>
  )
}

export function Leaderboard({ board, error }: { board: ScoreBoard | null; error: string | null }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  const me = board?.me
  const meShown = me && board.top.some((e) => e.rank === me.rank)
  return (
    <div className="tetris-help tetris-scores">
      <strong>🏆 單人排行榜</strong>
      {error ? (
        <p className="error">{error}</p>
      ) : !board ? (
        <p className="muted">載入中…</p>
      ) : board.top.length === 0 ? (
        <p className="muted">還沒有人上榜，來搶第一名吧！</p>
      ) : (
        <ol className="tetris-ranks">
          {board.top.map((e) => (
            <Row key={e.rank} entry={e} mine={e.rank === me?.rank} />
          ))}
          {me && !meShown && (
            <>
              <li className="tetris-rank-gap" aria-hidden="true">
                ⋯
              </li>
              <Row entry={me} mine />
            </>
          )}
        </ol>
      )}
      {!loading && !user && (
        <p className="muted">
          <Link to="/login" state={{ from: location.pathname + location.search }}>
            登入
          </Link>
          後，單人模式的成績會自動登上排行榜。
        </p>
      )}
    </div>
  )
}
