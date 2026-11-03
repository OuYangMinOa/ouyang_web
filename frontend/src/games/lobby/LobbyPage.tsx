import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useAuth } from '../../auth'
import { GAME_CATEGORIES, GAMES, type GameInfo } from '../registry'
import { ChatBox, PartyNotice } from '../shared/Party'
import { loadPartyName, MAX_NAME } from '../shared/useParty'
import { includes, playingPath, useLobby, type Lobby, type LobbyPlayer } from './useLobby'
import '../games.css'
import './lobby.css'

const LOBBY_GAMES = GAMES.filter((g) => g.lobby)

/** `/games/room/:code`：名單、聊天、房主選遊戲 */
export default function LobbyPage() {
  const { code: routeCode } = useParams()
  const lobby = useLobby()
  const navigate = useNavigate()
  const { enter } = lobby

  // 從邀請連結進來就加入這個遊戲室；只看網址換了沒，離開遊戲室時才不會又被加回去
  const entered = useRef<string | null>(null)
  useEffect(() => {
    if (routeCode && entered.current !== routeCode) {
      entered.current = routeCode
      enter(routeCode)
    }
  }, [routeCode, enter])

  function leave() {
    lobby.leave()
    navigate('/games')
  }

  return (
    <>
      <div className="game-title">
        <Link to="/games" className="game-back" aria-label="回到小遊戲">
          ←
        </Link>
        <h1>
          <span aria-hidden="true">🏠</span> 遊戲室
        </h1>
      </div>
      <div className="lobby-page">
        <LobbyHeader lobby={lobby} onLeave={leave} />
        <PartyNotice party={lobby} />
        {lobby.state && lobby.me && (
          <div className="lobby-columns">
            <div className="lobby-main">
              <NowPlaying lobby={lobby} />
              <GamePicker lobby={lobby} />
            </div>
            <div className="lobby-side">
              <Roster lobby={lobby} />
              <ChatBox party={lobby} />
            </div>
          </div>
        )}
        <LoginHint />
      </div>
    </>
  )
}

function LobbyHeader({ lobby, onLeave }: { lobby: Lobby; onLeave: () => void }) {
  const [copied, setCopied] = useState(false)

  async function share() {
    if (!lobby.inviteUrl) return
    if (navigator.share) {
      try {
        await navigator.share({ title: '一起來玩', url: lobby.inviteUrl })
        return
      } catch {
        // 使用者取消分享，改成複製
      }
    }
    try {
      await navigator.clipboard.writeText(lobby.inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('複製這個連結給朋友：', lobby.inviteUrl)
    }
  }

  return (
    <div className="party-header">
      <div className="room-code">
        <span className="muted">遊戲室</span>
        <strong>{lobby.code}</strong>
        {lobby.code && !lobby.connected && !lobby.error && <span className="muted">連線中…</span>}
      </div>
      <div className="game-toolbar">
        {lobby.errorCode === 'replaced' && (
          <button type="button" onClick={lobby.reconnect}>
            在這裡繼續
          </button>
        )}
        {lobby.errorCode === 'not_found' && (
          <button type="button" onClick={lobby.create} disabled={lobby.busy}>
            開新的遊戲室
          </button>
        )}
        <button type="button" className="secondary" onClick={share}>
          {copied ? '已複製連結' : '邀請朋友'}
        </button>
        <button type="button" className="secondary" onClick={onLeave}>
          離開遊戲室
        </button>
      </div>
      {lobby.error && <p className="error">{lobby.error}</p>}
    </div>
  )
}

function nameOf(players: LobbyPlayer[], pid: number): string {
  return players.find((p) => p.pid === pid)?.name ?? '（已離開）'
}

/** 現在在玩的那一間：自己有份就可以回去（被換頁、重新整理後） */
function NowPlaying({ lobby }: { lobby: Lobby }) {
  const navigate = useNavigate()
  const { playing, state } = lobby
  if (!playing || !state) {
    return (
      <p className="lobby-now muted">
        {lobby.isHost ? '選一款遊戲，大家會一起過去。玩完回到這裡就能換下一款。' : '等房主選遊戲…'}
      </p>
    )
  }
  const game = GAMES.find((g) => g.id === playing.game)
  const mine = includes(playing, lobby.you)
  return (
    <section className="lobby-now" aria-label="現在在玩">
      <span className="lobby-now-icon" aria-hidden="true">
        {game?.icon}
      </span>
      <span className="lobby-now-body">
        <strong>正在玩{game?.name ?? playing.game}</strong>
        <span className="muted">
          {playing.players
            ? playing.players.map((pid) => nameOf(state.players, pid)).join(' 對 ')
            : '大家一起'}
          {!mine && '，你這局沒有上場，可以在這裡聊天等下一局'}
        </span>
      </span>
      {mine && (
        <button type="button" onClick={() => navigate(playingPath(playing))}>
          進去玩
        </button>
      )}
    </section>
  )
}

function GamePicker({ lobby }: { lobby: Lobby }) {
  const [picked, setPicked] = useState<GameInfo | null>(null)
  if (!lobby.isHost) return null
  return (
    <section className="lobby-picker" aria-label="選遊戲">
      <h2>{lobby.playing ? '換一款遊戲' : '選遊戲'}</h2>
      {GAME_CATEGORIES.map((category) => {
        const games = LOBBY_GAMES.filter((g) => g.category === category)
        if (games.length === 0) return null
        return (
          <div key={category} className="lobby-category">
            <h3>{category}</h3>
            <ul className="lobby-games">
              {games.map((game) => (
                <li key={game.id}>
                  <button
                    type="button"
                    className={`lobby-game${picked?.id === game.id ? ' picked' : ''}`}
                    aria-pressed={picked?.id === game.id}
                    onClick={() => setPicked(game)}
                  >
                    <span className="lobby-game-icon" aria-hidden="true">
                      {game.icon}
                    </span>
                    <span className="lobby-game-body">
                      <strong>{game.name}</strong>
                      <span className="muted">{game.lobby?.players}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      {picked && <StartPanel key={picked.id} lobby={lobby} game={picked} />}
    </section>
  )
}

/** 選好遊戲之後：兩人的棋類要挑誰上場，其他直接開始 */
function StartPanel({ lobby, game }: { lobby: Lobby; game: GameInfo }) {
  const online = lobby.state?.players.filter((p) => p.online) ?? []
  const [seats, setSeats] = useState<[number | null, number | null]>([null, null])
  const duel = game.lobby?.kind === 'duel'

  // 沒挑的座位、挑的人已經離線的座位，預設是房主和下一個人
  const isOnline = (pid: number | null) => pid !== null && online.some((p) => p.pid === pid)
  const first = isOnline(seats[0]) ? seats[0] : (lobby.you ?? null)
  const second = isOnline(seats[1]) ? seats[1] : (online.find((p) => p.pid !== first)?.pid ?? null)
  const ready = lobby.connected && (!duel || (first !== null && second !== null && first !== second))

  function start() {
    if (!ready) return
    lobby.play(game.id, duel ? [first!, second!] : undefined)
  }

  return (
    <div className="lobby-start">
      <p>
        <strong>
          {game.icon} {game.name}
        </strong>
        <span className="muted"> · {game.lobby?.players}</span>
      </p>
      {duel && (
        <div className="lobby-seats">
          {([0, 1] as const).map((i) => (
            <label key={i}>
              <span>{i === 0 ? '先手' : '後手'}</span>
              <select
                value={(i === 0 ? first : second) ?? ''}
                onChange={(e) => {
                  const pid = Number(e.target.value)
                  setSeats((prev) => (i === 0 ? [pid, prev[1]] : [prev[0], pid]))
                }}
              >
                {online.map((p) => (
                  <option key={p.pid} value={p.pid}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {duel && online.length < 2 && <p className="muted">還要再一個人才能開，按上面的「邀請朋友」。</p>}
      {duel && online.length >= 2 && first === second && <p className="error">請挑兩個不同的人。</p>}
      {lobby.playing && <p className="muted">開始後，正在玩的人也會一起換過來。</p>}
      <button type="button" className="party-start" onClick={start} disabled={!ready}>
        開始玩
      </button>
    </div>
  )
}

function Roster({ lobby }: { lobby: Lobby }) {
  const { state, me, isHost } = lobby
  if (!state || !me) return null
  return (
    <section className="lobby-roster" aria-label="遊戲室的人">
      <h2>{state.players.filter((p) => p.online).length} 人在線</h2>
      <ul className="party-roster">
        {state.players.map((p) => (
          <li key={p.pid} className={`${p.pid === me.pid ? 'me' : ''}${!p.online ? ' offline' : ''}`}>
            <span className="party-roster-name">{p.name}</span>
            {p.pid === state.host && <span className="chip subtle">房主</span>}
            {p.pid === me.pid && <span className="chip subtle">你</span>}
            {!p.online && <span className="chip subtle">離線</span>}
            {isHost && p.pid !== me.pid && (
              <button
                type="button"
                className="party-kick"
                onClick={() => {
                  if (window.confirm(`請 ${p.name} 離開遊戲室？他之後就不能再進來。`)) lobby.kick(p.pid)
                }}
                aria-label={`請 ${p.name} 離開`}
                title="請他離開"
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      <Rename lobby={lobby} />
    </section>
  )
}

/** 改名字：存起來，之後進派對房間、大逃殺也用這個名字 */
function Rename({ lobby }: { lobby: Lobby }) {
  const [name, setName] = useState(() => loadPartyName())

  function submit(e: FormEvent) {
    e.preventDefault()
    lobby.rename(name.trim())
  }

  return (
    <form className="inline-form party-rename" onSubmit={submit}>
      <input
        value={name}
        onChange={(e) => setName([...e.target.value].slice(0, MAX_NAME).join(''))}
        placeholder={lobby.me?.name}
        maxLength={MAX_NAME * 2}
        autoComplete="nickname"
        aria-label="改名字"
      />
      <button type="submit" className="secondary" disabled={!name.trim() || name.trim() === lobby.me?.name}>
        改名
      </button>
    </form>
  )
}

/** 訪客只認這個分頁，提醒可以登入 */
function LoginHint() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (user || loading) return null
  return (
    <p className="muted">
      目前是訪客，換分頁或裝置就回不到這個遊戲室。
      <Link to="/login" state={{ from: location.pathname }}>
        登入
      </Link>
      後會用帳號認人。
    </p>
  )
}
