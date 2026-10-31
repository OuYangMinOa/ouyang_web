import { Link } from 'react-router'
import { LiveBadge, MatchRow, TeamLogo } from './components'
import { useLol } from './context'
import MatchView from './MatchView'
import { formatClock, formatCountdown, relativeDay, useNow } from './util'
import type { Match } from './api'

// 沒有比賽時給的官方頻道
const CHANNELS = [
  { label: 'YouTube · LoL Esports', url: 'https://www.youtube.com/@lolesports/streams' },
  { label: 'Twitch · riotgames', url: 'https://www.twitch.tv/riotgames' },
  { label: 'lolesports.com', url: 'https://lolesports.com/' },
]

function NextMatch({ match }: { match: Match }) {
  const now = useNow()
  const [a, b] = match.teams
  return (
    <Link to={`/lol/match/${match.id}`} className="lol-next card">
      <p className="muted">
        下一場 · {match.blockName} · BO{match.bestOf}
      </p>
      <div className="lol-next-teams">
        {a && (
          <span className="lol-next-team">
            <TeamLogo team={a} size={56} />
            <strong>{a.code}</strong>
          </span>
        )}
        <span className="lol-vs">VS</span>
        {b && (
          <span className="lol-next-team">
            <TeamLogo team={b} size={56} />
            <strong>{b.code}</strong>
          </span>
        )}
      </div>
      <p className="lol-next-time">
        {relativeDay(match.startTime)} {formatClock(match.startTime)}
      </p>
      <p className="lol-countdown" aria-live="off">
        {formatCountdown(new Date(match.startTime).getTime() - now)}
      </p>
    </Link>
  )
}

function formatRange(start: string, end: string) {
  const [, sm, sd] = start.split('-').map(Number)
  const [, em, ed] = end.split('-').map(Number)
  return `${sm}/${sd} – ${em}/${ed}`
}

/** 賽況：正在打的比賽（直播＋即時數據）、下一場倒數、接下來和最近的結果 */
export default function Overview() {
  const { tournament, matches, live, error } = useLol()
  const liveIds = new Set(live.map((e) => e.match.id))
  const upcoming = (matches ?? []).filter((m) => m.state === 'unstarted' && !liveIds.has(m.id))
  const recent = (matches ?? []).filter((m) => m.state === 'completed').slice(-6).reverse()
  const year = tournament?.startDate.slice(0, 4)

  return (
    <>
      <div className="lol-head">
        <h1>{year ? `${year} 世界大賽` : 'LoL 世界賽'}</h1>
        {tournament && <span className="muted">{formatRange(tournament.startDate, tournament.endDate)}</span>}
      </div>

      {error && <p className="error">{matches ? `更新失敗：${error}` : `載入失敗：${error}`}</p>}
      {!matches && !error && <p className="muted lol-empty">載入中…</p>}

      {live.length > 0 && (
        <section className="lol-section">
          <h2>
            <LiveBadge /> 正在比賽
          </h2>
          {live.map((e) => (
            <MatchView key={e.match.id} id={e.match.id} compact />
          ))}
        </section>
      )}

      {matches && live.length === 0 && (
        <section className="lol-section">
          {upcoming[0] ? (
            <NextMatch match={upcoming[0]} />
          ) : (
            <p className="muted lol-empty">{matches.length > 0 ? '這屆的比賽都打完了。' : '還沒有賽程。'}</p>
          )}
          <p className="lol-channels">
            <span className="muted">現在沒有比賽，官方頻道：</span>
            {CHANNELS.map((c) => (
              <a key={c.url} href={c.url} target="_blank" rel="noreferrer">
                {c.label} ↗
              </a>
            ))}
          </p>
        </section>
      )}

      {upcoming.length > (live.length === 0 ? 1 : 0) && (
        <section className="lol-section">
          <h2>接下來</h2>
          <div className="lol-list">
            {upcoming.slice(live.length === 0 ? 1 : 0, 6).map((m) => (
              <MatchRow key={m.id} match={m} showDay />
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="lol-section">
          <h2>最近結果</h2>
          <div className="lol-list">
            {recent.map((m) => (
              <MatchRow key={m.id} match={m} showDay />
            ))}
          </div>
          <Link to="/lol/schedule" className="lol-more">
            完整賽程 ›
          </Link>
        </section>
      )}
    </>
  )
}
