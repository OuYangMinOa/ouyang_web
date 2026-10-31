import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { api, errorMessage } from '../../api'
import { useAuth } from '../../auth'

/**
 * 單人模式的排行榜（俄羅斯方塊、魔法氣泡共用）：每個帳號只留最高分。
 * 後端見 tetris_scores.rs、puyo_scores.rs，網址都是 `/games/<game>/scores`、`/games/<game>/runs`。
 */

export type BaseEntry = {
  rank: number
  username: string
  score: number
  duration_ms: number
  achieved_at: string
}

export type ScoreBoard<E extends BaseEntry = BaseEntry> = {
  top: E[]
  me: E | null
  /** 上傳時才有：這次有沒有刷新自己的紀錄 */
  best?: boolean
}

/** 每隔多久（遊戲時間）回報一次進度，後端最多容許 20 秒沒回報 */
export const CHECKPOINT_MS = 5000

/**
 * 一局的成績上傳：開局時跟伺服器拿 run id，玩的時候定期回報中間態，結束時交出最後的狀態。
 * 伺服器靠這些中間態確認真的有玩。請求一個接一個送，順序不會亂。
 */
export class RunReporter<S, E extends BaseEntry = BaseEntry> {
  private base: string
  private id: Promise<string | null>
  private queue: Promise<unknown>

  constructor(game: string) {
    this.base = `/games/${game}/runs`
    this.id = api<{ id: string }>(this.base, { method: 'POST' })
      .then((r) => r.id)
      .catch(() => null)
    this.queue = this.id
  }

  private async send<T>(action: 'checkpoints' | 'finish', state: S): Promise<T> {
    const id = await this.id
    if (!id) throw new Error('沒能跟伺服器開始這一局，成績無法上傳')
    return api<T>(`${this.base}/${id}/${action}`, { method: 'POST', body: JSON.stringify(state) })
  }

  /** 回報進度；失敗就算了，結束時伺服器會再檢查（掉太多次這局就不算） */
  report(state: S) {
    this.queue = this.queue.then(() => this.send('checkpoints', state)).catch(() => {})
  }

  /** 結束並上傳，回傳更新後的排行榜 */
  finish(state: S): Promise<ScoreBoard<E>> {
    const done = this.queue.then(() => this.send<ScoreBoard<E>>('finish', state))
    this.queue = done.catch(() => {})
    return done
  }
}

export function useLeaderboard<E extends BaseEntry>(game: string) {
  const { user, loading } = useAuth()
  const [board, setBoard] = useState<ScoreBoard<E> | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 登入狀態確定後再抓，才拿得到自己的名次
  const userId = user?.id
  useEffect(() => {
    if (loading) return
    let cancelled = false
    api<ScoreBoard<E>>(`/games/${game}/scores`)
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
  }, [loading, userId, game])

  /** 上傳完拿到的新排行榜 */
  const update = useCallback((b: ScoreBoard<E>) => {
    setBoard(b)
    setError(null)
  }, [])

  return { board, error, update }
}

export function formatScore(n: number): string {
  return n.toLocaleString('en-US')
}

type MetaFn<E> = (entry: E) => ReactNode

function Row<E extends BaseEntry>({ entry, mine, meta }: { entry: E; mine: boolean; meta: MetaFn<E> }) {
  return (
    <li className={mine ? 'game-rank mine' : 'game-rank'}>
      <span className="game-rank-no">{entry.rank}</span>
      <span className="game-rank-name">{entry.username}</span>
      <span className="game-rank-score">{formatScore(entry.score)}</span>
      <span className="game-rank-meta">{meta(entry)}</span>
    </li>
  )
}

/** `meta`：分數下面那行小字（行數、等級、連鎖…） */
export function Leaderboard<E extends BaseEntry>({
  board,
  error,
  meta,
}: {
  board: ScoreBoard<E> | null
  error: string | null
  meta: MetaFn<E>
}) {
  const { user, loading } = useAuth()
  const location = useLocation()
  const me = board?.me
  const meShown = me && board.top.some((e) => e.rank === me.rank)
  return (
    <div className="game-help game-scores">
      <strong>🏆 單人排行榜</strong>
      {error ? (
        <p className="error">{error}</p>
      ) : !board ? (
        <p className="muted">載入中…</p>
      ) : board.top.length === 0 ? (
        <p className="muted">還沒有人上榜，來搶第一名吧！</p>
      ) : (
        <ol className="game-ranks">
          {board.top.map((e) => (
            <Row key={e.rank} entry={e} mine={e.rank === me?.rank} meta={meta} />
          ))}
          {me && !meShown && (
            <>
              <li className="game-rank-gap" aria-hidden="true">
                ⋯
              </li>
              <Row entry={me} mine meta={meta} />
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
