import { Outlet, useMatch } from 'react-router'
import { LobbyBar } from './lobby/LobbyBar'
import { LobbyContext, useLobbyConnection } from './lobby/useLobby'

/** 整個小遊戲區共用一條遊戲室的連線，玩遊戲的時候也連著，房主換遊戲時大家才跟得過去 */
export default function GamesLayout() {
  const lobby = useLobbyConnection()
  const onLobbyPage = useMatch('/games/room/:code') !== null
  return (
    <LobbyContext value={lobby}>
      {!onLobbyPage && <LobbyBar />}
      <Outlet />
    </LobbyContext>
  )
}
