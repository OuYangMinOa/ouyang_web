import { Link } from 'react-router'
import { MatchRow, TeamLogo } from './components'
import { useLol } from './context'
import { SWISS_TARGET, formatDay, isTbd, swissTable, type SwissRow } from './util'
import type { Match, Stage } from './api'

const STATUS: Record<SwissRow['status'], string> = { qualified: '晉級', eliminated: '淘汰', playing: '比賽中' }

function SwissTable({ matches }: { matches: Match[] }) {
  const rows = swissTable(matches)
  if (rows.length === 0) return <p className="muted lol-empty">還沒有對戰組合。</p>
  // 戰績相同的名次一樣
  const ranks = rows.map((r) => rows.findIndex((x) => x.wins === r.wins && x.losses === r.losses) + 1)

  return (
    <>
      <p className="muted lol-note">
        {SWISS_TARGET} 勝晉級淘汰賽、{SWISS_TARGET} 敗淘汰。
      </p>
      <table className="responsive lol-swiss">
        <thead>
          <tr>
            <th>名次</th>
            <th>隊伍</th>
            <th>戰績</th>
            <th>狀態</th>
            <th>對戰紀錄</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.team.code} className={r.status}>
              <td data-label="名次" className="lol-rank">
                {ranks[i]}
              </td>
              <td data-label="隊伍" className="primary">
                <span className="lol-team-cell">
                  <TeamLogo team={r.team} size={28} />
                  <span>
                    <strong>{r.team.code}</strong> <span className="lol-team-name muted">{r.team.name}</span>
                  </span>
                </span>
              </td>
              <td data-label="戰績" className="lol-record">
                {r.wins}–{r.losses}
              </td>
              <td data-label="狀態">
                <span className={`lol-status ${r.status}`}>{STATUS[r.status]}</span>
              </td>
              <td data-label="對戰紀錄">
                <span className="lol-history">
                  {r.history.length === 0 && <span className="muted">—</span>}
                  {r.history.map((h) => (
                    <Link
                      key={h.matchId}
                      to={`/lol/match/${h.matchId}`}
                      className={`lol-pill ${h.won ? 'win' : 'loss'}`}
                      title={`${h.won ? '勝' : '敗'} ${h.opponent.name}`}
                    >
                      {h.won ? '勝' : '敗'} {h.opponent.code}
                    </Link>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** 淘汰賽對戰表：每一輪（八強、四強、決賽）一欄，照時間排 */
function Bracket({ matches }: { matches: Match[] }) {
  const rounds = new Map<string, Match[]>()
  for (const m of matches) rounds.set(m.blockName, [...(rounds.get(m.blockName) ?? []), m])

  return (
    <div className="lol-bracket">
      {[...rounds].map(([name, list]) => (
        <div key={name} className="lol-round">
          <h3>{name}</h3>
          <div className="lol-round-matches">
            {list.map((m) => (
              <div key={m.id} className="lol-bracket-match">
                <span className="muted lol-bracket-day">{formatDay(m.startTime)}</span>
                <MatchRow match={m} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function StageSection({ stage, matches }: { stage: Stage; matches: Match[] }) {
  const ids = new Set(stage.matchIds)
  const list = matches.filter((m) => ids.has(m.id))
  if (list.length === 0) return null
  let body = (
    <div className="lol-list">
      {list.map((m) => (
        <MatchRow key={m.id} match={m} showDay />
      ))}
    </div>
  )
  if (stage.slug.includes('swiss')) body = <SwissTable matches={list} />
  else if (/knockout|playoff|bracket/.test(stage.slug)) body = <Bracket matches={list} />

  return (
    <section className="lol-section">
      <h2>{stage.name}</h2>
      {body}
    </section>
  )
}

/** 戰績：瑞士輪積分、淘汰賽對戰表、入圍賽結果。
 * 已經有隊伍的階段由新到舊排（正在打的在最上面），對手還沒確定的階段放最後 */
export default function Standings() {
  const { matches, stages, error } = useLol()
  const known = (s: Stage) => (matches ?? []).some((m) => s.matchIds.includes(m.id) && !m.teams.some(isTbd))
  const ordered = [...stages.filter(known).reverse(), ...stages.filter((s) => !known(s))]

  return (
    <>
      <div className="lol-head">
        <h1>戰績</h1>
      </div>
      {error && <p className="error">{matches ? `更新失敗：${error}` : `載入失敗：${error}`}</p>}
      {!matches && !error && <p className="muted lol-empty">載入中…</p>}
      {matches && stages.length === 0 && !error && <p className="muted lol-empty">還沒有分組資料。</p>}
      {matches &&
        ordered.map((s) => <StageSection key={s.slug} stage={s} matches={matches} />)}
    </>
  )
}
