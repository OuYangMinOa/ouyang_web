import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '../../auth'
import { useInLobbyRoom } from '../lobby/useLobby'
import { useInvite } from './share'
import type { Room, Seat } from './useRoom'

/** 訪客的座位只認這個分頁，提醒可以登入（登入後回到同一個房間） */
function LoginHint() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (user || loading) return null
  return (
    <p className="muted">
      目前是訪客，換分頁或裝置就回不到這一局。
      <Link to="/login" state={{ from: location.pathname + location.search }}>
        登入
      </Link>
      後會用帳號認座位。
    </p>
  )
}

/**
 * 線上模式的房間面板：建立／加入房間、顯示代碼與邀請連結、連線狀態。
 * `seatNames` 是兩個座位在這個遊戲裡的名稱，例如 ['黑棋', '白棋']。
 */
export function OnlinePanel<T>({ room, seatNames }: { room: Room<T>; seatNames: [string, string] }) {
  const [draft, setDraft] = useState('')
  const invite = useInvite(room.inviteUrl)
  const inLobby = useInLobbyRoom(room.code)

  function submit(e: FormEvent) {
    e.preventDefault()
    if (draft.trim()) room.join(draft)
  }

  if (!room.code) {
    return (
      <div className="online-panel">
        <button type="button" onClick={room.create} disabled={room.busy}>
          建立房間
        </button>
        <form className="inline-form" onSubmit={submit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            placeholder="房間代碼"
            maxLength={8}
            autoCapitalize="characters"
            autoComplete="off"
            aria-label="房間代碼"
          />
          <button type="submit" className="secondary" disabled={!draft.trim()}>
            加入
          </button>
        </form>
        {room.error && <p className="error">{room.error}</p>}
        <LoginHint />
      </div>
    )
  }

  const opponent: Seat | null = room.seat === null ? null : room.seat === 0 ? 1 : 0
  let status: string
  if (room.error) status = room.error
  else if (!room.connected) status = '連線中…'
  else if (!room.peerOnline) status = room.seat === 0 ? '等待對手加入…' : '對手離線，等待重新連線…'
  else status = '對手已連線'

  return (
    <div className="online-panel">
      {/* 遊戲室開的房間：代碼、邀請、離開都在標題列的遊戲室 */}
      {!inLobby && (
        <div className="room-code">
          <span className="muted">房間代碼</span>
          <strong>{room.code}</strong>
        </div>
      )}
      <p className={room.error ? 'error' : 'muted'}>{status}</p>
      {room.seat !== null && opponent !== null && (
        <p className="muted">
          你是 <strong>{seatNames[room.seat]}</strong>，對手是 {seatNames[opponent]}
        </p>
      )}
      <div className="game-toolbar">
        {room.errorCode === 'replaced' && (
          <button type="button" onClick={room.reconnect}>
            在這裡繼續
          </button>
        )}
        {room.errorCode === 'not_found' && !inLobby && (
          <button type="button" onClick={room.create} disabled={room.busy}>
            建立新房間
          </button>
        )}
        {!inLobby && (
          <>
            <button type="button" className="secondary" onClick={invite.share}>
              {invite.copied ? '已複製連結' : '邀請對手'}
            </button>
            <button type="button" className="secondary" onClick={room.leave}>
              離開房間
            </button>
          </>
        )}
      </div>
      <LoginHint />
    </div>
  )
}
