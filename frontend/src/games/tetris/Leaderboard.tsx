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

export type ScoreRun = { score: number; lines: number; level: number; duration_ms: number }

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

  /** 上傳一局的成績（要登入），回傳更新後的排行榜 */
  const submit = useCallback(async (run: ScoreRun): Promise<ScoreBoard> => {
    const b = await api<ScoreBoard>('/games/tetris/scores', { method: 'POST', body: JSON.stringify(run) })
    setBoard(b)
    setError(null)
    return b
  }, [])

  return { board, error, submit }
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
