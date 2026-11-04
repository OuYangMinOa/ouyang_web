import { Link, useLocation, useNavigate } from 'react-router'
import { findGame } from '../registry'
import { useInvite } from '../shared/share'
import { includes, lobbyPath, playingPath, useLobby, type Lobby } from './useLobby'
import './lobby.css'

/** 現在在玩的那一間：我有份、但不在那一頁（被換頁、重新整理後）就可以回去 */
function useRejoin(lobby: Lobby) {
  const location = useLocation()
  const { playing } = lobby
  const game = playing ? findGame(playing.game) : undefined
  const here =
    playing !== null &&
    location.pathname === `/games/${playing.game}` &&
    new URLSearchParams(location.search).get('room') === playing.room
  const canRejoin = playing !== null && !here && includes(playing, lobby.you) && game !== undefined
  return { game, canRejoin }
}

/** 斷線、被別的分頁搶走、遊戲室關了：可以在這裡接回來或離開 */
function Recover({ lobby }: { lobby: Lobby }) {
  if (lobby.errorCode === 'replaced') {
    return (
      <button type="button" onClick={lobby.reconnect}>
        在這裡繼續
      </button>
    )
  }
  if (lobby.errorCode) {
    return (
      <button type="button" className="secondary" onClick={lobby.leave}>
        離開遊戲室
      </button>
    )
  }
  return null
}

/**
 * 遊戲頁標題列上的遊戲室：代碼和人數（點了回遊戲室）、邀請、換遊戲。
 * 遊戲室開的房間不再顯示自己的代碼，大家只看得到這一個。
 */
export function LobbyChip() {
  const lobby = useLobby()
  const navigate = useNavigate()
  const invite = useInvite(lobby.inviteUrl)
  const { game, canRejoin } = useRejoin(lobby)
  const { code, state, playing } = lobby
  if (!code) return null

  const online = state?.players.filter((p) => p.online).length ?? 0
  let status: string
  if (lobby.error) status = lobby.error
  else if (!lobby.connected) status = '連線中…'
  else status = `${online} 人在線`

  return (
    <div className="lobby-chip" role="group" aria-label={`遊戲室 ${code}`}>
      <Link to={lobbyPath(code)} className="lobby-chip-info" title="回遊戲室">
        <span aria-hidden="true">🏠</span>
        <strong>{code}</strong>
        <span className={lobby.error ? 'lobby-chip-status error' : 'lobby-chip-status'}>{status}</span>
      </Link>
      <span className="lobby-chip-actions">
        <Recover lobby={lobby} />
        {canRejoin && playing && (
          <button type="button" onClick={() => navigate(playingPath(playing))}>
            回到{game?.name}
          </button>
        )}
        {!lobby.error && (
          <>
            <button type="button" className="secondary" onClick={invite.share}>
              {invite.copied ? '已複製連結' : '邀請'}
            </button>
            <button type="button" className="secondary" onClick={() => navigate(lobbyPath(code))}>
              {lobby.isHost ? '換遊戲' : '回遊戲室'}
            </button>
          </>
        )}
      </span>
    </div>
  )
}

/** 小遊戲大廳最上面：已經在遊戲室裡時，取代「開遊戲室」的入口 */
export function LobbyBar() {
  const lobby = useLobby()
  const navigate = useNavigate()
  const invite = useInvite(lobby.inviteUrl)
  const { game, canRejoin } = useRejoin(lobby)
  const { code, playing, state } = lobby
  if (!code) return null

  const online = state?.players.filter((p) => p.online).length ?? 0
  let status: string
  if (lobby.error) status = lobby.error
  else if (!lobby.connected) status = '連線中…'
  else status = `${online} 人在線${game ? ` · 正在玩${game.name}` : ''}`

  return (
    <section className="lobby-bar" aria-label="你所在的遊戲室">
      <span className="lobby-bar-info">
        <span className="lobby-bar-icon" aria-hidden="true">
          🏠
        </span>
        <span className="lobby-bar-text">
          <span>
            你在遊戲室 <strong>{code}</strong>
          </span>
          <span className={lobby.error ? 'error' : 'muted'}>{status}</span>
        </span>
      </span>
      <span className="lobby-bar-actions">
        <Recover lobby={lobby} />
        {canRejoin && playing && (
          <button type="button" onClick={() => navigate(playingPath(playing))}>
            回到{game?.name}
          </button>
        )}
        {!lobby.error && (
          <>
            <button type="button" className={canRejoin ? 'secondary' : undefined} onClick={() => navigate(lobbyPath(code))}>
              {lobby.isHost ? '回遊戲室選遊戲' : '回遊戲室'}
            </button>
            <button type="button" className="secondary" onClick={invite.share}>
              {invite.copied ? '已複製連結' : '邀請朋友'}
            </button>
          </>
        )}
      </span>
    </section>
  )
}
