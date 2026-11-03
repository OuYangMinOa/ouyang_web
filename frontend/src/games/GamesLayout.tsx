import { Outlet } from 'react-router'
import { LobbyContext, useLobbyConnection } from './lobby/useLobby'

/**
 * 整個小遊戲區共用一條遊戲室的連線，玩遊戲的時候也連著，房主換遊戲時大家才跟得過去。
 * 遊戲室的狀態顯示在各頁自己的標題列（遊戲頁的 `LobbyChip`、大廳的 `LobbyBar`）。
 */
export default function GamesLayout() {
  const lobby = useLobbyConnection()
  return (
    <LobbyContext value={lobby}>
      <Outlet />
    </LobbyContext>
  )
}
