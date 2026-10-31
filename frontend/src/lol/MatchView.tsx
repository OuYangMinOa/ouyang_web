import { useState } from 'react'
import { errorMessage } from '../api'
import { getEventDetails, getFinalStats, getLiveStats, type EventDetails, type Game, type GameStats, type Match } from './api'
import { LiveBadge, StreamPlayer, TeamLogo } from './components'
import { useLol } from './context'
import Scoreboard from './Scoreboard'
import { formatClock, isAbort, relativeDay, usePolling } from './util'

const DETAILS_INTERVAL = 30_000
const STATS_INTERVAL = 10_000

const GAME_STATE: Record<Game['state'], string> = {
  unstarted: '尚未開始',
  inProgress: '進行中',
  completed: '已結束',
  unneeded: '不需要',
}

/** 一局的內容：進行中顯示即時數據，結束了顯示終局數據和 VOD */
function GamePanel({ game, match }: { game: Game; match: Match }) {
  const [stats, setStats] = useState<GameStats | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'none' | 'error'>('loading')
  const live = game.state === 'inProgress'
  const finished = game.state === 'completed'

  usePolling(
    async (signal) => {
      if (!live && !finished) return
      try {
        const next = live ? await getLiveStats(game.id, signal) : await getFinalStats(game.id, signal)
        setStats(next)
        setState(next ? 'ready' : 'none')
      } catch (e) {
        if (isAbort(e)) throw e
        setState((s) => (s === 'ready' ? s : 'error'))
      }
    },
    live ? STATS_INTERVAL : null,
    `${game.id}:${game.state}`,
  )

  if (!live && !finished) {
    return <p className="muted lol-empty">{game.state === 'unneeded' ? '系列賽已分出勝負，這局不用打。' : '這局還沒開始。'}</p>
  }

  return (
    <div className="lol-game">
      {finished && game.vods.length > 0 && (
        <StreamPlayer streams={game.vods} title={`第 ${game.number} 局重播`} />
      )}
      {state === 'loading' && <p className="muted lol-empty">{live ? '載入即時數據…' : '載入這局的數據…'}</p>}
      {state === 'none' && <p className="muted lol-empty">這局沒有數據。</p>}
      {state === 'error' && <p className="error">數據載入失敗，稍後會再試。</p>}
      {stats && state === 'ready' && <Scoreboard stats={stats} teams={match.teams} />}
    </div>
  )
}

function defaultGame(games: Game[]) {
  return (
    games.find((g) => g.state === 'inProgress') ??
    [...games].reverse().find((g) => g.state === 'completed') ??
    games[0]
  )
}

/** 一場系列賽：比分、直播、每一局的數據與重播 */
export default function MatchView({ id, compact = false }: { id: string; compact?: boolean }) {
  const { matches, live } = useLol()
  const [details, setDetails] = useState<EventDetails | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const scheduled = matches?.find((m) => m.id === id)
  const liveEvent = live.find((e) => e.match.id === id)
  const done = details?.match.state === 'completed'

  usePolling(
    async (signal) => {
      try {
        const next = await getEventDetails(id, signal)
        setDetails(next)
        setError(next ? '' : '找不到這場比賽')
      } catch (e) {
        if (isAbort(e)) throw e
        setError(errorMessage(e))
      }
    },
    done ? null : DETAILS_INTERVAL,
    id,
  )

  if (!details) {
    return error ? <p className="error">載入失敗：{error}</p> : <p className="muted lol-empty">載入中…</p>
  }

  const match: Match = { ...details.match, startTime: scheduled?.startTime ?? '', blockName: scheduled?.blockName ?? '' }
  const [a, b] = match.teams
  const isLive = match.state === 'inProgress' || liveEvent !== undefined
  const streams = details.streams.length > 0 ? details.streams : (liveEvent?.streams ?? [])
  const games = details.games
  const game = games.find((g) => g.id === picked) ?? defaultGame(games)
  const lost = (t: typeof a) => match.state === 'completed' && t.result?.outcome === 'loss'

  return (
    <article className={`lol-match-view ${compact ? 'compact' : ''}`}>
      <header className="lol-mv-head">
        <p className="lol-mv-meta muted">
          {isLive && <LiveBadge />}
          {match.blockName && <span>{match.blockName}</span>}
          {match.startTime && (
            <span>
              {relativeDay(match.startTime)} {formatClock(match.startTime)}
            </span>
          )}
          <span>BO{match.bestOf}</span>
        </p>
        <div className="lol-mv-teams">
          {a && (
            <div className={`lol-mv-team ${lost(a) ? 'lost' : ''}`}>
              <TeamLogo team={a} size={compact ? 48 : 64} />
              <strong>{a.code}</strong>
              <span className="muted">{a.name}</span>
            </div>
          )}
          <div className="lol-mv-score">
            {match.state === 'unstarted' ? (
              <span className="lol-vs">VS</span>
            ) : (
              <>
                {a?.result?.gameWins ?? 0}
                <span className="lol-score-sep">:</span>
                {b?.result?.gameWins ?? 0}
              </>
            )}
          </div>
          {b && (
            <div className={`lol-mv-team ${lost(b) ? 'lost' : ''}`}>
              <TeamLogo team={b} size={compact ? 48 : 64} />
              <strong>{b.code}</strong>
              <span className="muted">{b.name}</span>
            </div>
          )}
        </div>
      </header>

      {isLive && streams.length > 0 && <StreamPlayer streams={streams} title={`${a?.code} 對 ${b?.code} 直播`} />}

      {games.length > 0 && (
        <>
          <div className="lol-games" role="tablist" aria-label="選擇局數">
            {games.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={g.id === game?.id}
                className={`lol-game-tab ${g.state}`}
                onClick={() => setPicked(g.id)}
                disabled={g.state === 'unneeded'}
                title={GAME_STATE[g.state]}
              >
                第 {g.number} 局{g.state === 'inProgress' && <span className="lol-dot" aria-label="進行中" />}
              </button>
            ))}
          </div>
          {game && <GamePanel key={game.id} game={game} match={match} />}
        </>
      )}
    </article>
  )
}
