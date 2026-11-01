import { useEffect, useState } from 'react'
import { useMusic, type Song } from './music'
import { MusicButton } from './ui'

/**
 * 不分輸贏一直播的背景音樂，給沒有自己配樂的遊戲用，開關放在標題旁邊。
 * 瀏覽器要等使用者點過或按過鍵才准出聲，所以第一次互動之後才開始；切到別的分頁就先停。
 */
export function PageMusic({ game, load }: { game: string; load: () => Promise<{ default: Song }> }) {
  const [song, setSong] = useState<Song | null>(null)
  useEffect(() => {
    let alive = true
    void load().then((m) => alive && setSong(m.default))
    return () => {
      alive = false
    }
  }, [load])
  return song ? <Player game={game} song={song} /> : null
}

function Player({ game, song }: { game: string; song: Song }) {
  const [touched, setTouched] = useState(false)
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    if (touched) return
    const start = () => setTouched(true)
    window.addEventListener('pointerdown', start, { once: true })
    window.addEventListener('keydown', start, { once: true })
    return () => {
      window.removeEventListener('pointerdown', start)
      window.removeEventListener('keydown', start)
    }
  }, [touched])
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const music = useMusic(game, song, touched && visible, 1)
  return (
    <div className="game-title-music">
      <MusicButton music={music} />
    </div>
  )
}
