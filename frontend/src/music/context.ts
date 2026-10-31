import { createContext, useContext } from 'react'
import type { Track } from './tracks'

export type Player = {
  /** 還在載入是 null */
  tracks: Track[] | null
  loadError: string
  /** 正在播（或暫停中）的檔名 */
  current: string | null
  playing: boolean
  /** 從 `list` 這份清單裡播 `name`，上一首／下一首就在這份清單裡走 */
  play: (name: string, list: string[]) => void
  /** 整份清單從頭播，或隨機播 */
  playAll: (list: string[], shuffle: boolean) => void
  toggle: () => void
  favorites: Set<string>
  toggleFavorite: (name: string) => void
}

export const PlayerContext = createContext<Player | null>(null)

/** 播放器在 MusicApp 裡，切換「全部」「收藏」頁面時不會中斷 */
export function usePlayer(): Player {
  const player = useContext(PlayerContext)
  if (!player) throw new Error('usePlayer 要在 <MusicApp> 裡面用')
  return player
}
