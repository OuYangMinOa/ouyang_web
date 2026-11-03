import { useLocation, useNavigate } from 'react-router'
import { findGame } from '../registry'
import { includes, lobbyPath, playingPath, useLobby } from './useLobby'
import './lobby.css'

/** 在遊戲室裡的時候，小遊戲每一頁的最上面：回遊戲室、回到現在在玩的那一間 */
export function LobbyBar() {
  const lobby = useLobby()
  const navigate = useNavigate()
  const location = useLocation()
  const { code, playing, state } = lobby
  if (!code) return null

  const online = state?.players.filter((p) => p.online).length ?? 0
  const game = playing ? findGame(playing.game) : undefined
  const here =
    playing !== null &&
    location.pathname === `/games/${playing.game}` &&
    new URLSearchParams(location.search).get('room') === playing.room
  const canRejoin = playing !== null && !here && includes(playing, lobby.you)

  let status: string
  if (lobby.error) status = lobby.error
  else if (!lobby.connected) status = '連線中…'
  else status = `${online} 人在線${game ? ` · 正在玩${game.name}` : ''}`

  return (
    <div className="lobby-bar">
      <span className="lobby-bar-info">
        <span aria-hidden="true">🏠</span> 遊戲室 <strong>{code}</strong>
        <span className={lobby.error ? 'error' : 'muted'}>{status}</span>
      </span>
      <span className="lobby-bar-actions">
        {canRejoin && game && (
          <button type="button" onClick={() => navigate(playingPath(playing))}>
            回到{game.name}
          </button>
        )}
        <button type="button" className="secondary" onClick={() => navigate(lobbyPath(code))}>
          {lobby.isHost ? '換遊戲' : '回遊戲室'}
        </button>
      </span>
    </div>
  )
}
