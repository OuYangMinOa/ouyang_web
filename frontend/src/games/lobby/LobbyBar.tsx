import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from 'react-router'
import { findGame } from '../registry'
import { ChatBox } from '../shared/Party'
import { useInvite } from '../shared/share'
import { lobbyPath, playingPath, useLobby, watchingNow, type Lobby } from './useLobby'
import './lobby.css'

/** 現在在玩的那一間：不在那一頁（被換頁、重新整理後）就可以回去，上場的人「回到」、觀戰的人「觀戰」 */
function useRejoin(lobby: Lobby) {
  const location = useLocation()
  const { playing } = lobby
  const game = playing ? findGame(playing.game) : undefined
  const here =
    playing !== null &&
    location.pathname === `/games/${playing.game}` &&
    new URLSearchParams(location.search).get('room') === playing.room
  const canGo = playing !== null && !here && game !== undefined
  const watching = watchingNow(lobby)
  const canRejoin = canGo && !watching
  const canWatch = canGo && watching
  return { game, canRejoin, canWatch }
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

/** 聊天紀錄裡最後一則的 id，沒有是 0 */
function lastLine(lobby: Lobby): number {
  return lobby.chat.at(-1)?.id ?? 0
}

/**
 * 遊戲頁標題列上的遊戲室：代碼和人數（點了回遊戲室）、聊天、邀請、換遊戲。
 * 遊戲室開的房間不再顯示自己的代碼，大家只看得到這一個。
 * `chat`：可以在遊戲頁打開遊戲室的聊天（棋類、大逃殺沒有自己的聊天室，上場和觀戰的人邊看邊聊）。
 * 派對遊戲有自己的聊天室，而且有些話不能讓場上的人看到（答案、身分），所以不開。
 */
export function LobbyChip({ chat = false }: { chat?: boolean }) {
  const lobby = useLobby()
  const navigate = useNavigate()
  const invite = useInvite(lobby.inviteUrl)
  const { game, canRejoin, canWatch } = useRejoin(lobby)
  const [chatOpen, setChatOpen] = useState(false)
  /** 看過的最後一則；連上前是 null，拿到聊天紀錄時當作都看過了 */
  const [seen, setSeen] = useState<number | null>(null)
  const latest = lastLine(lobby)
  // 在 render 裡依 props 更新 state：打開聊天、或第一次拿到紀錄時，把目前的訊息都算看過
  if ((chatOpen || seen === null) && lobby.chat.length > 0 && seen !== latest) setSeen(latest)
  const { code, state, playing } = lobby
  if (!code) return null

  const unread = chatOpen
    ? 0
    : lobby.chat.filter((l) => l.id > (seen ?? latest) && l.pid !== null && l.pid !== lobby.you).length

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
        {canWatch && playing && (
          <button type="button" className="secondary" onClick={() => navigate(playingPath(playing))}>
            觀戰{game?.name}
          </button>
        )}
        {chat && !lobby.error && (
          <button
            type="button"
            className={chatOpen ? undefined : 'secondary'}
            onClick={() => setChatOpen(!chatOpen)}
            aria-expanded={chatOpen}
            aria-label={unread > 0 ? `聊天（${unread} 則新訊息）` : '聊天'}
          >
            聊天
            {unread > 0 && <span className="lobby-chat-badge">{unread > 9 ? '9+' : unread}</span>}
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
      {/* 頁面內容區是 container（container query 用），fixed 的面板放在裡面會以它定位，所以掛到 body */}
      {chat && chatOpen && createPortal(<LobbyChat lobby={lobby} onClose={() => setChatOpen(false)} />, document.body)}
    </div>
  )
}

/** 遊戲頁上的遊戲室聊天：浮在畫面右下角，Esc 或 × 關掉 */
function LobbyChat({ lobby, onClose }: { lobby: Lobby; onClose: () => void }) {
  return (
    <div
      className="lobby-chat-panel"
      role="dialog"
      aria-label="遊戲室聊天"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <button type="button" className="secondary lobby-chat-close" onClick={onClose} aria-label="關閉聊天" title="關閉">
        ×
      </button>
      <ChatBox party={lobby} title="遊戲室聊天" />
    </div>
  )
}

/** 小遊戲大廳最上面：已經在遊戲室裡時，取代「開遊戲室」的入口 */
export function LobbyBar() {
  const lobby = useLobby()
  const navigate = useNavigate()
  const invite = useInvite(lobby.inviteUrl)
  const { game, canRejoin, canWatch } = useRejoin(lobby)
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
        {canWatch && playing && (
          <button type="button" className="secondary" onClick={() => navigate(playingPath(playing))}>
            觀戰{game?.name}
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
