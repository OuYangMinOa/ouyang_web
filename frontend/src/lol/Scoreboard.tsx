import { useEffect, useState, type ReactNode } from 'react'
import { championIcon, ddragonVersion, getChampionNames, type GameStats, type Participant, type PlayerFrame, type Team, type TeamFrame } from './api'
import { TeamLogo } from './components'
import { formatGameTime, formatGold } from './util'

const DRAGONS: Record<string, string> = {
  infernal: '炎龍',
  ocean: '海龍',
  mountain: '山龍',
  cloud: '風龍',
  hextech: '海克斯龍',
  chemtech: '化工龍',
  elder: '遠古龍',
}

const ROLES: Record<string, string> = { top: '上路', jungle: '打野', mid: '中路', bottom: '下路', support: '輔助' }

function useChampionNames(version: string) {
  const [names, setNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let alive = true
    getChampionNames(version).then((n) => alive && setNames(n))
    return () => {
      alive = false
    }
  }, [version])
  return names
}

/** 選手名字前面的隊伍代碼拿掉：「HLE Zeus」→「Zeus」 */
function playerName(name: string) {
  const space = name.indexOf(' ')
  return space > 0 ? name.slice(space + 1) : name
}

function Dragons({ dragons }: { dragons: string[] }) {
  if (dragons.length === 0) return <span className="muted">—</span>
  return (
    <span className="lol-dragons">
      {dragons.map((d, i) => (
        <span key={i} className={`lol-dragon ${d}`} title={DRAGONS[d] ?? d} aria-label={DRAGONS[d] ?? d} />
      ))}
    </span>
  )
}

type SideProps = {
  side: 'blue' | 'red'
  team: Team | undefined
  code: string
  frame: TeamFrame
  players: Participant[]
  version: string
  names: Record<string, string>
  live: boolean
}

function PlayerRow({ meta, p, version, names, live }: { meta: Participant; p: PlayerFrame | undefined; version: string; names: Record<string, string>; live: boolean }) {
  const champion = names[meta.championId] ?? meta.championId
  const health = p && p.maxHealth > 0 ? p.currentHealth / p.maxHealth : 0
  return (
    <li className="lol-player-row">
      <span className="lol-champ">
        <img src={championIcon(version, meta.championId)} alt={champion} title={champion} loading="lazy" />
        {p && <span className="lol-level">{p.level}</span>}
      </span>
      <span className="lol-player-name">
        <strong>{playerName(meta.summonerName)}</strong>
        <small>
          {ROLES[meta.role] ?? meta.role} · {champion}
        </small>
        {live && p && (
          <span className={`lol-hp ${p.currentHealth === 0 ? 'dead' : ''}`} aria-hidden="true">
            <span style={{ width: `${health * 100}%` }} />
          </span>
        )}
      </span>
      {p && (
        <>
          <span className="lol-kda" title="擊殺 / 死亡 / 助攻">
            {p.kills}/{p.deaths}/{p.assists}
          </span>
          <span className="lol-cs" title="補刀">
            {p.creepScore}
          </span>
          <span className="lol-pgold" title="金錢">
            {formatGold(p.totalGold)}
          </span>
        </>
      )}
    </li>
  )
}

function SidePanel({ side, team, code, frame, players, version, names, live }: SideProps) {
  return (
    <section className={`lol-side ${side}`}>
      <header className="lol-side-head">
        {team && <TeamLogo team={team} size={24} />}
        <strong>{team?.code ?? code}</strong>
        <span className="lol-side-tag">{side === 'blue' ? '藍方' : '紅方'}</span>
      </header>
      <ol className="lol-players">
        {players.map((meta) => (
          <PlayerRow
            key={meta.participantId}
            meta={meta}
            p={frame.participants.find((p) => p.participantId === meta.participantId)}
            version={version}
            names={names}
            live={live}
          />
        ))}
      </ol>
    </section>
  )
}

/** 一局的數據：擊殺、金錢、塔、龍、巴龍，以及十位選手 */
export default function Scoreboard({ stats, teams }: { stats: GameStats; teams: Team[] }) {
  const { metadata, frame, start } = stats
  const version = ddragonVersion(metadata.patchVersion)
  const names = useChampionNames(version)
  const blue = frame.blueTeam
  const red = frame.redTeam
  const blueMeta = metadata.blueTeamMetadata
  const redMeta = metadata.redTeamMetadata
  const teamOf = (id: string) => teams.find((t) => t.id === id)
  // 沒有隊伍 id 對照時，從選手名字的前綴猜隊伍代碼
  const codeOf = (players: Participant[]) => players[0]?.summonerName.split(' ')[0] ?? ''
  const blueTeam = teamOf(blueMeta.esportsTeamId)
  const redTeam = teamOf(redMeta.esportsTeamId)
  const live = frame.gameState !== 'finished'
  const elapsed = formatGameTime(Date.parse(frame.rfc460Timestamp) - start)
  const totalGold = blue.totalGold + red.totalGold
  const diff = blue.totalGold - red.totalGold

  let status = `比賽時間約 ${elapsed}`
  if (frame.gameState === 'paused') status = `暫停中 · ${elapsed}`
  if (frame.gameState === 'finished') status = `已結束 · 約 ${elapsed}`

  const rows: { label: string; blue: ReactNode; red: ReactNode }[] = [
    { label: '金錢', blue: formatGold(blue.totalGold), red: formatGold(red.totalGold) },
    { label: '推塔', blue: blue.towers, red: red.towers },
    { label: '水晶', blue: blue.inhibitors, red: red.inhibitors },
    { label: '巴龍', blue: blue.barons, red: red.barons },
    { label: '小龍', blue: <Dragons dragons={blue.dragons} />, red: <Dragons dragons={red.dragons} /> },
  ]

  return (
    <div className="lol-board">
      <div className="lol-board-head">
        <span className="lol-board-team blue">{blueTeam?.code ?? codeOf(blueMeta.participantMetadata)}</span>
        <span className="lol-board-kills">
          <span className="blue">{blue.totalKills}</span>
          <span className="lol-score-sep">:</span>
          <span className="red">{red.totalKills}</span>
        </span>
        <span className="lol-board-team red">{redTeam?.code ?? codeOf(redMeta.participantMetadata)}</span>
      </div>
      <p className="lol-board-status muted">
        {live && frame.gameState !== 'paused' && <span className="lol-dot" aria-hidden="true" />}
        {status}
        {live && '（延遲約一分鐘）'}
      </p>

      <div className="lol-gold-bar" role="img" aria-label={`金錢差 ${diff >= 0 ? '藍方' : '紅方'}領先 ${formatGold(Math.abs(diff))}`}>
        <span className="blue" style={{ width: `${totalGold ? (blue.totalGold / totalGold) * 100 : 50}%` }} />
        <span className="red" />
      </div>
      <p className="lol-gold-diff">
        {diff === 0 ? '金錢持平' : `${diff > 0 ? '藍方' : '紅方'}領先 ${formatGold(Math.abs(diff))}`}
      </p>

      <dl className="lol-team-stats">
        {rows.map((r) => (
          <div key={r.label}>
            <dd className="blue">{r.blue}</dd>
            <dt>{r.label}</dt>
            <dd className="red">{r.red}</dd>
          </div>
        ))}
      </dl>

      <div className="lol-sides">
        <SidePanel
          side="blue"
          team={blueTeam}
          code={codeOf(blueMeta.participantMetadata)}
          frame={blue}
          players={blueMeta.participantMetadata}
          version={version}
          names={names}
          live={live}
        />
        <SidePanel
          side="red"
          team={redTeam}
          code={codeOf(redMeta.participantMetadata)}
          frame={red}
          players={redMeta.participantMetadata}
          version={version}
          names={names}
          live={live}
        />
      </div>
    </div>
  )
}
