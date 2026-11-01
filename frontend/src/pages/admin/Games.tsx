import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '../../api'
import { usePolling } from '../../feedback/util'
import { GAMES } from '../../games/registry'
import type { GamesReport, LivePlayer, LiveRoom, SoloRun } from './types'

const REFRESH_MS = 5000

const KIND_LABELS: Record<LiveRoom['kind'], string> = {
  duel: '雙人對戰',
  arena: '大逃殺',
  party: '派對',
}

const PHASE_LABELS: Record<LiveRoom['phase'], string> = {
  waiting: '等人加入',
  idle: '沒人在線',
  lobby: '大廳',
  countdown: '倒數',
  playing: '對局中',
  results: '結算',
}

/** 後端的遊戲 id 和網址上的不一樣的 */
const GAME_ALIASES: Record<string, { id: string; suffix: string }> = {
  minesrace: { id: 'minesweeper', suffix: '競速' },
}

function gameInfo(id: string) {
  const alias = GAME_ALIASES[id]
  const game = GAMES.find((g) => g.id === (alias?.id ?? id))
  return {
    name: game ? `${game.name}${alias?.suffix ?? ''}` : id,
    icon: game?.icon ?? '🎮',
  }
}

function duration(secs: number) {
  if (secs < 60) return `${secs} 秒`
  const minutes = Math.floor(secs / 60)
  if (minutes < 60) return `${minutes} 分`
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`
}

/** 本機開發沒有 X-Forwarded-For，IP 會是 local */
function Ip({ ip }: { ip: string }) {
  if (ip === 'local') return <code>{ip}</code>
  return (
    <a href={`https://ipinfo.io/${encodeURIComponent(ip)}`} target="_blank" rel="noreferrer" title="在 ipinfo.io 查詢">
      <code>{ip}</code>
    </a>
  )
}

function Who({ player }: { player: Pick<LivePlayer, 'name' | 'username' | 'online'> }) {
  return (
    <span className="live-who">
      <span className={player.online ? 'live-dot is-online' : 'live-dot'} title={player.online ? '在線' : '離線'} />
      <strong>{player.name}</strong>
      {/* 帳號：暱稱和帳號名稱不同時才標出帳號；訪客：棋類沒有暱稱，名字本身就是「訪客」 */}
      {player.username
        ? player.username !== player.name && <span className="live-tag">@{player.username}</span>
        : player.name !== '訪客' && <span className="live-tag">訪客</span>}
    </span>
  )
}

function RoomCard({ room }: { room: LiveRoom }) {
  const game = gameInfo(room.game)
  const meta = [
    room.public ? '快速配對' : KIND_LABELS[room.kind],
    room.round > 0 && `第 ${room.round} 局`,
    room.alive !== null && `存活 ${room.alive}`,
    room.bots > 0 && `電腦 ${room.bots}`,
    room.events !== null && `紀錄 ${room.events} 筆`,
    `開了 ${duration(room.age_secs)}`,
  ].filter(Boolean)
  const online = room.players.filter((p) => p.online).length

  return (
    <article className={online ? 'card live-room' : 'card live-room is-idle'}>
      <header>
        <span className="live-game">
          {game.icon} {game.name}
        </span>
        <code className="live-code">{room.code}</code>
        <span className={`live-phase is-${room.phase}`}>{PHASE_LABELS[room.phase] ?? room.phase}</span>
      </header>
      <p className="muted">{meta.join(' · ')}</p>
      {room.players.length ? (
        <ul className="live-players">
          {room.players.map((p) => (
            <li key={p.who}>
              <Who player={p} />
              {p.host && <span className="live-tag is-host">房主</span>}
              {p.status && <span className="muted">{p.status}</span>}
              <span className="live-conn muted">
                {p.ip ? <Ip ip={p.ip} /> : '離線'}
                {p.online_secs !== null && ` · ${duration(p.online_secs)}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted live-empty">沒有人</p>
      )}
    </article>
  )
}

/** 同一個人可能同時在好幾個房間（例如開了兩個分頁），合成一列 */
type Person = {
  who: string
  names: string[]
  username: string | null
  online: boolean
  ips: string[]
  online_secs: number | null
  rooms: { room: LiveRoom; player: LivePlayer }[]
}

function people(rooms: LiveRoom[]): Person[] {
  const map = new Map<string, Person>()
  for (const room of rooms) {
    for (const player of room.players) {
      let person = map.get(player.who)
      if (!person) {
        person = {
          who: player.who,
          names: [],
          username: player.username,
          online: false,
          ips: [],
          online_secs: null,
          rooms: [],
        }
        map.set(player.who, person)
      }
      if (!person.names.includes(player.name)) person.names.push(player.name)
      if (player.ip && !person.ips.includes(player.ip)) person.ips.push(player.ip)
      person.online ||= player.online
      if (player.online_secs !== null) person.online_secs = Math.max(person.online_secs ?? 0, player.online_secs)
      person.rooms.push({ room, player })
    }
  }
  return [...map.values()].sort(
    (a, b) => Number(b.online) - Number(a.online) || (b.online_secs ?? 0) - (a.online_secs ?? 0),
  )
}

function PeopleTable({ persons }: { persons: Person[] }) {
  return (
    <div className="table-wrap">
      <table className="responsive">
        <thead>
          <tr>
            <th>玩家</th>
            <th>在玩</th>
            <th>IP</th>
            <th>連線</th>
          </tr>
        </thead>
        <tbody>
          {persons.map((p) => (
            <tr key={p.who}>
              <td data-label="玩家" className="primary">
                <Who
                  player={{
                    name: p.names.join('、'),
                    username: p.username,
                    online: p.online,
                  }}
                />
              </td>
              <td data-label="在玩">
                <ul className="live-where">
                  {p.rooms.map(({ room, player }) => {
                    const game = gameInfo(room.game)
                    return (
                      <li key={`${room.kind}:${room.code}`}>
                        {game.icon} {game.name} <code>{room.code}</code>
                        <span className="muted">
                          {[player.host && '房主', player.status, !player.online && '離線'].filter(Boolean).join(' · ')}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </td>
              <td data-label="IP">
                {p.ips.length ? (
                  <span className="live-ips">
                    {p.ips.map((ip) => (
                      <Ip key={ip} ip={ip} />
                    ))}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td data-label="連線">
                {p.online_secs !== null ? duration(p.online_secs) : <span className="muted">離線</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SoloTable({ runs }: { runs: SoloRun[] }) {
  return (
    <div className="table-wrap">
      <table className="responsive">
        <thead>
          <tr>
            <th>帳號</th>
            <th>遊戲</th>
            <th>分數</th>
            <th>等級</th>
            <th>遊戲時間</th>
            <th>最後回報</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const game = gameInfo(run.game)
            return (
              <tr key={`${run.game}:${run.username}`}>
                <td data-label="帳號" className="primary">
                  {run.username}
                </td>
                <td data-label="遊戲">
                  {game.icon} {game.name}
                </td>
                <td data-label="分數">{run.score.toLocaleString()}</td>
                <td data-label="等級">{run.level}</td>
                <td data-label="遊戲時間">{duration(Math.floor(run.duration_ms / 1000))}</td>
                <td data-label="最後回報">{duration(run.idle_secs)}前</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const VIEWS = [
  { id: 'rooms', label: '依房間' },
  { id: 'people', label: '依玩家' },
] as const

type View = (typeof VIEWS)[number]['id']

export default function AdminGames() {
  const [report, setReport] = useState<GamesReport | null>(null)
  const [updated, setUpdated] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('rooms')
  const [onlineOnly, setOnlineOnly] = useState(false)
  const [filter, setFilter] = useState('')

  const load = useCallback(() => {
    api<GamesReport>('/admin/games')
      .then((r) => {
        setReport(r)
        setUpdated(new Date())
        setError(null)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])

  useEffect(load, [load])
  usePolling(load, REFRESH_MS)

  const keyword = filter.trim().toLowerCase()
  const has = (text: string | null) => (text ?? '').toLowerCase().includes(keyword)
  const roomMatches = (room: LiveRoom) => has(room.code) || has(gameInfo(room.game).name)
  const playerMatches = (player: LivePlayer) => has(player.name) || has(player.username) || has(player.ip)
  const active = (room: LiveRoom) => room.players.some((p) => p.online)

  const allRooms = report?.rooms ?? []
  const rooms = allRooms.filter(
    (room) => (!onlineOnly || active(room)) && (!keyword || roomMatches(room) || room.players.some(playerMatches)),
  )
  const persons = people(rooms).filter(
    (p) =>
      (!onlineOnly || p.online) &&
      (!keyword || p.rooms.some(({ room, player }) => roomMatches(room) || playerMatches(player))),
  )
  const solo = (report?.solo ?? []).filter((run) => !keyword || has(run.username) || has(gameInfo(run.game).name))

  const everyone = people(allRooms).filter((p) => p.online)
  const stats = report && [
    ['在線的人', everyone.length],
    ['登入的帳號', everyone.filter((p) => p.username).length],
    ['訪客', everyone.filter((p) => !p.username).length],
    ['有人在的房間', `${allRooms.filter(active).length} / ${allRooms.length}`],
    ['單人排行榜', report.solo.length],
  ]

  return (
    <>
      <h1>遊戲狀態</h1>
      <p className="muted">
        現在開著的線上房間、裡面有誰，以及正在玩單人排行榜的帳號。對電腦、同一台輪流下和沒登入的單人遊戲只在瀏覽器裡跑，這裡看不到。
      </p>

      <div className="access-toolbar">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="篩選暱稱、帳號、IP、遊戲或房間代碼"
          aria-label="篩選"
        />
        <button type="button" className="secondary" onClick={load}>
          重新整理
        </button>
        {updated && <span className="muted">每 5 秒自動更新 · 上次 {updated.toLocaleTimeString()}</span>}
      </div>

      {stats && (
        <div className="visit-stats">
          {stats.map(([label, value]) => (
            <div key={label} className="card">
              <span className="muted">{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="access-views">
        <div className="access-tabs">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={view === v.id ? undefined : 'secondary'}
              aria-pressed={view === v.id}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="checks">
          <label>
            <input type="checkbox" checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} />
            只看有人在線的
          </label>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!report && !error && <p className="muted">載入中…</p>}

      {report &&
        view === 'rooms' &&
        (rooms.length ? (
          <div className="live-rooms">
            {rooms.map((room) => (
              <RoomCard key={`${room.kind}:${room.code}`} room={room} />
            ))}
          </div>
        ) : (
          <p className="muted">{keyword || onlineOnly ? '沒有符合的房間。' : '現在沒有開著的房間。'}</p>
        ))}

      {report &&
        view === 'people' &&
        (persons.length ? (
          <PeopleTable persons={persons} />
        ) : (
          <p className="muted">{keyword || onlineOnly ? '沒有符合的玩家。' : '現在沒有人在房間裡。'}</p>
        ))}

      {report && (
        <>
          <h2 className="live-heading">單人排行榜</h2>
          <p className="muted">
            登入後玩俄羅斯方塊、魔法氣泡單人模式的局。暫停或關掉分頁不會通知伺服器，5 分鐘沒有回報就不列出來。
          </p>
          {solo.length ? (
            <SoloTable runs={solo} />
          ) : (
            <p className="muted live-empty">{keyword ? '沒有符合的局。' : '現在沒有人在玩。'}</p>
          )}
        </>
      )}
    </>
  )
}
