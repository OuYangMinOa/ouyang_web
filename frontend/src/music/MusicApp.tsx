import { useEffect, useRef, useState, type RefObject } from 'react'
import { Outlet } from 'react-router'
import { api, errorMessage } from '../api'
import { PlayerContext, type Player } from './context'
import Icon from './Icon'
import { formatTime, load, save, shuffled, trackTitle, trackUrl, type Repeat, type Track } from './tracks'
import './music.css'

const REPEAT_NEXT: Record<Repeat, Repeat> = { off: 'all', all: 'one', one: 'off' }
const REPEAT_LABEL: Record<Repeat, string> = { off: '不重複', all: '清單循環', one: '單曲循環' }

/** 空白鍵播放／暫停；焦點在輸入框或按鈕上時交給它們自己處理 */
function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [contenteditable]') !== null
}

/** 音樂 APP 的外框：載入曲目、放 <audio> 和底部播放列，各頁面透過 usePlayer() 控制播放 */
export default function MusicApp() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [loadError, setLoadError] = useState('')
  // base 是使用者按下播放時的那份清單，order 是實際播放順序（隨機時打亂過）
  const [base, setBase] = useState<string[]>([])
  const [order, setOrder] = useState<string[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [playError, setPlayError] = useState('')
  const [shuffle, setShuffle] = useState(() => load('shuffle', false))
  const [repeat, setRepeat] = useState<Repeat>(() => load('repeat', 'off'))
  const [favorites, setFavorites] = useState(() => new Set(load<string[]>('favorites', [])))

  useEffect(() => {
    api<Track[]>('/music')
      .then(setTracks)
      .catch((e) => setLoadError(errorMessage(e)))
  }, [])

  /** 要在點擊的同一個事件裡呼叫 play()，iOS 才會讓它出聲 */
  function start(name: string) {
    const audio = audioRef.current
    if (!audio) return
    setPlayError('')
    setCurrent(name)
    audio.src = trackUrl(name)
    audio.play().catch((e: unknown) => {
      // 很快切到下一首時，上一個 play() 會被中斷，不算錯誤
      if (!(e instanceof DOMException && e.name === 'AbortError')) setPlayError('無法播放')
    })
  }

  function orderFrom(list: string[], first: string, random: boolean) {
    return random ? [first, ...shuffled(list.filter((n) => n !== first))] : list
  }

  function play(name: string, list: string[]) {
    setBase(list)
    setOrder(orderFrom(list, name, shuffle))
    start(name)
  }

  function playAll(list: string[], random: boolean) {
    if (list.length === 0) return
    const first = random ? list[Math.floor(Math.random() * list.length)] : list[0]
    setShuffle(random)
    save('shuffle', random)
    setBase(list)
    setOrder(orderFrom(list, first, random))
    start(first)
  }

  function toggle() {
    const audio = audioRef.current
    if (!audio || !current) return
    if (audio.paused) audio.play().catch(() => setPlayError('無法播放'))
    else audio.pause()
  }

  /** ended 是播完自動接下一首：清單播完、又沒有循環就停下來 */
  function next(ended = false) {
    if (!current || order.length === 0) return
    const i = order.indexOf(current)
    if (i >= 0 && i + 1 < order.length) return start(order[i + 1])
    if (ended && repeat === 'off') return
    // 循環時重新洗牌，每一輪的順序都不一樣
    const again = shuffle ? shuffled(base) : base
    setOrder(again)
    start(again[0])
  }

  function prev() {
    const audio = audioRef.current
    if (!audio || !current) return
    const i = order.indexOf(current)
    // 播超過 3 秒按上一首是回到這首開頭
    if (audio.currentTime > 3 || i <= 0) {
      audio.currentTime = 0
      return
    }
    start(order[i - 1])
  }

  function toggleShuffle() {
    const random = !shuffle
    setShuffle(random)
    save('shuffle', random)
    if (current) setOrder(orderFrom(base, current, random))
  }

  function cycleRepeat() {
    const value = REPEAT_NEXT[repeat]
    setRepeat(value)
    save('repeat', value)
  }

  function toggleFavorite(name: string) {
    const nextFavorites = new Set(favorites)
    if (!nextFavorites.delete(name)) nextFavorites.add(name)
    setFavorites(nextFavorites)
    save('favorites', [...nextFavorites])
  }

  // 手機鎖定畫面、耳機按鍵和鍵盤的媒體鍵
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    session.metadata = current ? new MediaMetadata({ title: trackTitle(current), artist: '歐陽天地 · 音樂' }) : null
    session.setActionHandler('play', toggle)
    session.setActionHandler('pause', toggle)
    session.setActionHandler('previoustrack', prev)
    session.setActionHandler('nexttrack', () => next())
  })
  useEffect(
    () => () => {
      if (!('mediaSession' in navigator)) return
      navigator.mediaSession.metadata = null
      for (const action of ['play', 'pause', 'previoustrack', 'nexttrack'] as const) {
        navigator.mediaSession.setActionHandler(action, null)
      }
    },
    [],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const audio = audioRef.current
      if (e.code !== 'Space' || e.repeat || isTyping(e.target) || !audio || !current) return
      e.preventDefault()
      if (audio.paused) audio.play().catch(() => setPlayError('無法播放'))
      else audio.pause()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current])

  const player: Player = { tracks, loadError, current, playing, play, playAll, toggle, favorites, toggleFavorite }

  return (
    <PlayerContext value={player}>
      <div className="music">
        <Outlet />
        <audio
          ref={audioRef}
          preload="none"
          loop={repeat === 'one'}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => next(true)}
          onError={() => {
            if (current) setPlayError('這首無法播放')
            setPlaying(false)
          }}
        />
        <PlayerBar
          audioRef={audioRef}
          current={current}
          playing={playing}
          error={playError}
          shuffle={shuffle}
          repeat={repeat}
          onToggle={toggle}
          onPrev={prev}
          onNext={() => next()}
          onShuffle={toggleShuffle}
          onRepeat={cycleRepeat}
        />
      </div>
    </PlayerContext>
  )
}

type BarProps = {
  audioRef: RefObject<HTMLAudioElement | null>
  current: string | null
  playing: boolean
  error: string
  shuffle: boolean
  repeat: Repeat
  onToggle: () => void
  onPrev: () => void
  onNext: () => void
  onShuffle: () => void
  onRepeat: () => void
}

/** 底部的播放列；播放進度每秒更新好幾次，只重繪這一塊，不動到上面的清單 */
function PlayerBar({ audioRef, current, playing, error, shuffle, repeat, ...on }: BarProps) {
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(() => load('volume', 1))
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [audioRef, volume])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setTime(audio.currentTime)
    const onDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    const onVolume = () => setMuted(audio.muted)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDuration)
    audio.addEventListener('emptied', onTime)
    audio.addEventListener('emptied', onDuration)
    audio.addEventListener('volumechange', onVolume)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDuration)
      audio.removeEventListener('emptied', onTime)
      audio.removeEventListener('emptied', onDuration)
      audio.removeEventListener('volumechange', onVolume)
    }
  }, [audioRef])

  function seek(value: number) {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = value
    setTime(value)
  }

  function changeVolume(value: number) {
    setVolume(value)
    save('volume', value)
    if (audioRef.current) audioRef.current.muted = value === 0
  }

  const repeatLabel = `重複：${REPEAT_LABEL[repeat]}（點擊切換）`

  return (
    <section className="music-bar" aria-label="播放器">
      <div className="music-now">
        <span className="music-now-title" title={current ? trackTitle(current) : undefined}>
          {current ? trackTitle(current) : '選一首來播放'}
        </span>
        {error && <span className="music-now-error">{error}</span>}
      </div>

      <div className="music-seek">
        <span className="music-time">{formatTime(time)}</span>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(time, duration || 1)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!current || !duration}
          aria-label="播放進度"
          aria-valuetext={`${formatTime(time)} / ${formatTime(duration)}`}
        />
        <span className="music-time">{formatTime(duration)}</span>
      </div>

      <div className="music-controls">
        <button
          type="button"
          className={`music-icon ${shuffle ? 'on' : ''}`}
          onClick={on.onShuffle}
          aria-pressed={shuffle}
          aria-label="隨機播放"
          title="隨機播放"
        >
          <Icon name="shuffle" />
        </button>
        <button type="button" className="music-icon" onClick={on.onPrev} disabled={!current} aria-label="上一首" title="上一首">
          <Icon name="prev" />
        </button>
        <button
          type="button"
          className="music-play"
          onClick={on.onToggle}
          disabled={!current}
          aria-label={playing ? '暫停' : '播放'}
          title={playing ? '暫停（空白鍵）' : '播放（空白鍵）'}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button type="button" className="music-icon" onClick={on.onNext} disabled={!current} aria-label="下一首" title="下一首">
          <Icon name="next" />
        </button>
        <button
          type="button"
          className={`music-icon ${repeat !== 'off' ? 'on' : ''}`}
          onClick={on.onRepeat}
          aria-label={repeatLabel}
          title={repeatLabel}
        >
          <Icon name={repeat === 'one' ? 'repeatOne' : 'repeat'} />
        </button>
      </div>

      <div className="music-volume">
        <button
          type="button"
          className="music-icon"
          onClick={() => {
            if (audioRef.current) audioRef.current.muted = !audioRef.current.muted
          }}
          aria-pressed={muted}
          aria-label={muted ? '取消靜音' : '靜音'}
          title={muted ? '取消靜音' : '靜音'}
        >
          <Icon name={muted || volume === 0 ? 'mute' : 'volume'} />
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => changeVolume(Number(e.target.value))}
          aria-label="音量"
        />
      </div>
    </section>
  )
}
