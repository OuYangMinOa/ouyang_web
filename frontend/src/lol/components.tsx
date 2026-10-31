import { useState } from 'react'
import { Link } from 'react-router'
import type { Match, Stream, Team } from './api'
import { formatClock, isTbd } from './util'

export function TeamLogo({ team, size = 28 }: { team: Team; size?: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="lol-logo" style={{ width: size, height: size, padding: Math.round(size * 0.12) }} aria-hidden="true">
      {!failed && !isTbd(team) && <img src={team.image} alt="" loading="lazy" onError={() => setFailed(true)} />}
      {(failed || isTbd(team)) && <span className="lol-logo-text">?</span>}
    </span>
  )
}

export function LiveBadge() {
  return <span className="lol-live">LIVE</span>
}

/** 一場系列賽的一列：時間、兩隊、比分；點進去看詳細 */
export function MatchRow({ match, showDay = false }: { match: Match; showDay?: boolean }) {
  const [a, b] = match.teams
  const started = match.state !== 'unstarted'
  const lost = (t: Team) => match.state === 'completed' && t.result?.outcome === 'loss'
  const label = `${a?.name ?? 'TBD'} 對 ${b?.name ?? 'TBD'}`

  return (
    <Link to={`/lol/match/${match.id}`} className={`lol-match ${match.state}`} aria-label={label}>
      <span className="lol-match-meta">
        <span className="lol-match-time">
          {showDay && `${new Date(match.startTime).getMonth() + 1}/${new Date(match.startTime).getDate()} `}
          {formatClock(match.startTime)}
        </span>
        <span className="lol-match-bo">BO{match.bestOf}</span>
        {match.state === 'inProgress' && <LiveBadge />}
      </span>
      <span className="lol-match-teams">
        {a && (
          <span className={`lol-match-team left ${lost(a) ? 'lost' : ''}`}>
            <span className="lol-team-code">{a.code}</span>
            <TeamLogo team={a} />
          </span>
        )}
        <span className="lol-match-score">
          {started ? (
            <>
              {a?.result?.gameWins ?? 0}
              <span className="lol-score-sep">:</span>
              {b?.result?.gameWins ?? 0}
            </>
          ) : (
            <span className="lol-vs">VS</span>
          )}
        </span>
        {b && (
          <span className={`lol-match-team right ${lost(b) ? 'lost' : ''}`}>
            <TeamLogo team={b} />
            <span className="lol-team-code">{b.code}</span>
          </span>
        )}
      </span>
    </Link>
  )
}

/* ---- 直播與 VOD ---- */

const LOCALE_ORDER = ['zh-TW', 'zh-CN', 'en-US']

function rank(stream: Stream) {
  const i = LOCALE_ORDER.indexOf(stream.locale)
  return i === -1 ? LOCALE_ORDER.length : i
}

function providerName(provider: string) {
  if (provider === 'youtube') return 'YouTube'
  if (provider === 'twitch') return 'Twitch'
  return provider
}

function externalUrl(s: Stream) {
  if (s.provider === 'youtube') return `https://www.youtube.com/watch?v=${s.parameter}${s.start ? `&t=${s.start}s` : ''}`
  return `https://www.twitch.tv/${s.parameter}`
}

/** Twitch 只讓 HTTPS 網站（或 localhost）嵌入，網站目前還是 HTTP 時改給連結 */
function embedUrl(s: Stream): string | null {
  if (s.provider === 'youtube') {
    return `https://www.youtube.com/embed/${s.parameter}?rel=0${s.start ? `&start=${s.start}` : ''}`
  }
  if (s.provider === 'twitch' && window.isSecureContext) {
    return `https://player.twitch.tv/?channel=${s.parameter}&parent=${window.location.hostname}&autoplay=false`
  }
  return null
}

/** 直播或 VOD 播放器；有多種語言時可以切換，預設中文、其次英文 */
export function StreamPlayer({ streams, title }: { streams: Stream[]; title: string }) {
  const playable = streams
    .filter((s) => s.provider === 'youtube' || s.provider === 'twitch')
    .sort((x, y) => rank(x) - rank(y) || (x.provider === 'youtube' ? -1 : 1))
  const [picked, setPicked] = useState(0)
  const index = picked < playable.length ? picked : 0
  const stream = playable[index]
  if (!stream) return null
  const src = embedUrl(stream)

  return (
    <div className="lol-stream">
      <div className="lol-stream-frame">
        {src ? (
          <iframe
            key={src}
            src={src}
            title={title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        ) : (
          <div className="lol-stream-blocked">
            <p>這個網站還沒有 HTTPS，Twitch 不讓嵌入播放。</p>
            <a href={externalUrl(stream)} target="_blank" rel="noreferrer">
              到 Twitch 觀看 ↗
            </a>
          </div>
        )}
      </div>
      <div className="lol-stream-bar">
        {playable.length > 1 && (
          <select value={index} onChange={(e) => setPicked(Number(e.target.value))} aria-label="選擇轉播">
            {playable.map((s, i) => (
              <option key={`${s.provider}-${s.parameter}-${s.locale}`} value={i}>
                {s.label} · {providerName(s.provider)}
              </option>
            ))}
          </select>
        )}
        <a href={externalUrl(stream)} target="_blank" rel="noreferrer" className="lol-stream-open">
          在 {providerName(stream.provider)} 開啟 ↗
        </a>
      </div>
    </div>
  )
}
