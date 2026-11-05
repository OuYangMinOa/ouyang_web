import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useAuth } from '../../auth'
import { GAME_CATEGORIES, GAMES, type GameInfo } from '../registry'
import { ChatBox, PartyNotice } from '../shared/Party'
import { loadPartyName, MAX_NAME } from '../shared/useParty'
import { useInvite } from '../shared/share'
import { Segmented } from '../shared/ui'
import { playingPath, useLobby, watchingNow, type Lobby, type LobbyPlayer } from './useLobby'
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
    <div className="lobby-page">
      <LobbyHeader lobby={lobby} onLeave={leave} />
      <PartyNotice party={lobby} />
      {lobby.state && lobby.me && (
        <div className="lobby-columns">
          <div className="lobby-main">
            <NowPlaying lobby={lobby} />
            <InviteCard lobby={lobby} />
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
  )
}

/** 標題列：遊戲室代碼、邀請、離開，以及連線錯誤 */
function LobbyHeader({ lobby, onLeave }: { lobby: Lobby; onLeave: () => void }) {
  const invite = useInvite(lobby.inviteUrl)
  return (
    <>
      <header className="game-head">
        <Link to="/games" className="game-back" aria-label="回到小遊戲" title="回到小遊戲">
          ←
        </Link>
        <h1>
          <span aria-hidden="true">🏠</span> 遊戲室 <span className="lobby-code">{lobby.code}</span>
        </h1>
        {lobby.code && !lobby.connected && !lobby.error && <span className="muted">連線中…</span>}
        <div className="game-head-actions">
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
          <button type="button" className="secondary" onClick={invite.share}>
            {invite.copied ? '已複製連結' : '邀請朋友'}
          </button>
          <button type="button" className="secondary" onClick={onLeave}>
            離開遊戲室
          </button>
        </div>
      </header>
      {lobby.error && <p className="error">{lobby.error}</p>}
    </>
  )
}

/** 只有自己一個人在線時：連結直接擺出來，複製就能傳 */
function InviteCard({ lobby }: { lobby: Lobby }) {
  const invite = useInvite(lobby.inviteUrl)
  const online = lobby.state?.players.filter((p) => p.online).length ?? 0
  if (!lobby.inviteUrl || online >= 2) return null
  return (
    <section className="lobby-invite" aria-label="邀請朋友">
      <p>
        <strong>邀請朋友加入</strong>
        <span className="muted">
          把連結傳給朋友，或請他在小遊戲大廳輸入代碼 <span className="lobby-code">{lobby.code}</span>。
        </span>
      </p>
      <div className="inline-form">
        <input
          readOnly
          value={lobby.inviteUrl}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="邀請連結"
        />
        <button type="button" onClick={invite.copy}>
          {invite.copied ? '已複製' : '複製連結'}
        </button>
      </div>
    </section>
  )
}

function nameOf(players: LobbyPlayer[], pid: number): string {
  return players.find((p) => p.pid === pid)?.name ?? '（已離開）'
}

/** 現在在玩的那一間：被換頁、重新整理後可以回去，上場的人「進去玩」、觀戰的人「進去觀戰」 */
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
  const watching = watchingNow(lobby)
  let who: string
  if (playing.players) {
    who = playing.players.map((pid) => nameOf(state.players, pid)).join(' 對 ')
  } else {
    const watchers = state.players.filter((p) => p.watch).map((p) => p.name)
    who = watchers.length > 0 ? `大家一起，${watchers.join('、')} 觀戰` : '大家一起'
  }
  let hint = ''
  if (watching) hint = playing.players ? '，你這局沒有上場，可以進去觀戰' : '，你選了觀戰'
  return (
    <section className="lobby-now" aria-label="現在在玩">
      <span className="lobby-now-icon" aria-hidden="true">
        {game?.icon}
      </span>
      <span className="lobby-now-body">
        <strong>正在玩{game?.name ?? playing.game}</strong>
        <span className="muted">
          {who}
          {hint}
        </span>
      </span>
      <button type="button" onClick={() => navigate(playingPath(playing))}>
        {watching ? '進去觀戰' : '進去玩'}
      </button>
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
                    onClick={() => setPicked(picked?.id === game.id ? null : game)}
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
      {picked ? (
        <StartPanel key={picked.id} lobby={lobby} game={picked} onCancel={() => setPicked(null)} />
      ) : (
        <p className="muted">點一款遊戲，再按「開始玩」。</p>
      )}
    </section>
  )
}

/**
 * 選好遊戲之後：兩人的棋類要從上場的人裡挑兩個，其他直接開始（選了觀戰的人跟過去看）。
 * 黏在畫面底部，清單很長時也不用捲下去找
 */
function StartPanel({ lobby, game, onCancel }: { lobby: Lobby; game: GameInfo; onCancel: () => void }) {
  const online = lobby.state?.players.filter((p) => p.online) ?? []
  const players = online.filter((p) => !p.watch)
  const watchers = online.length - players.length
  const [seats, setSeats] = useState<[number | null, number | null]>([null, null])
  const duel = game.lobby?.kind === 'duel'

  // 沒挑的座位、挑的人已經離線或改成觀戰的座位，預設是房主（沒選觀戰的話）和下一個人
  const canSit = (pid: number | null) => pid !== null && players.some((p) => p.pid === pid)
  const first = canSit(seats[0]) ? seats[0] : canSit(lobby.you) ? lobby.you : (players[0]?.pid ?? null)
  const second = canSit(seats[1]) ? seats[1] : (players.find((p) => p.pid !== first)?.pid ?? null)
  const ready = lobby.connected && (!duel || (first !== null && second !== null && first !== second))

  function start() {
    if (!ready) return
    lobby.play(game.id, duel ? [first!, second!] : undefined)
  }

  return (
    <div className="lobby-start" role="region" aria-label={`開始玩${game.name}`}>
      <div className="lobby-start-head">
        <p>
          <strong>
            <span aria-hidden="true">{game.icon}</span> {game.name}
          </strong>
          <span className="muted"> · {game.lobby?.players}</span>
        </p>
        <button type="button" className="lobby-start-close" onClick={onCancel} aria-label="取消" title="取消">
          ×
        </button>
      </div>
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
                {players.map((p) => (
                  <option key={p.pid} value={p.pid}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {duel && players.length < 2 && (
        <p className="muted">
          {online.length < 2 ? '還要再一個人才能開，按上面的「邀請朋友」。' : '要上場的人不到兩個，請有人改成「上場」。'}
        </p>
      )}
      {duel && players.length >= 2 && first === second && <p className="error">請挑兩個不同的人。</p>}
      {duel && players.length >= 2 && online.length > 2 && <p className="muted">其他人會跟過去觀戰。</p>}
      {!duel && watchers > 0 && (
        <p className="muted">
          {players.length} 人上場、{watchers} 人觀戰
          {players.length === 0 && '。大家都選了觀戰，到了那邊要有人改成上場才能開始'}
        </p>
      )}
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
            {p.watch && <span className="chip subtle">觀戰</span>}
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
      <Segmented
        label="我要"
        value={me.watch ? 'watch' : 'play'}
        options={[
          { value: 'play', label: '上場' },
          { value: 'watch', label: '觀戰' },
        ]}
        onChange={(v) => lobby.watch(v === 'watch')}
        disabled={!lobby.connected}
      />
      {me.watch && <p className="muted lobby-watch-hint">一樣跟著大家過去，只是不上場、在旁邊看。正在玩的話下一局生效。</p>}
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
