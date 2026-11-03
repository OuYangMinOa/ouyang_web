import { Suspense, useEffect, useRef } from 'react'
import { Link, useParams } from 'react-router'
import { LobbyChip } from './lobby/LobbyBar'
import { useLobby } from './lobby/useLobby'
import { findGame } from './registry'
import { PageMusic } from './shared/PageMusic'
import './games.css'

export default function GamePage() {
  const { id } = useParams()
  const game = findGame(id)
  const { follow } = useLobby()
  const page = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLElement>(null)

  // 標題列的高度（在遊戲室裡、窄螢幕會換成兩行）寫進 --game-head-h，盤面照「標題列底下還剩多高」縮放
  useEffect(() => {
    const pageEl = page.current
    const headEl = head.current
    if (!pageEl || !headEl) return
    const observer = new ResizeObserver(() => pageEl.style.setProperty('--game-head-h', `${headEl.offsetHeight}px`))
    observer.observe(headEl)
    return () => observer.disconnect()
  }, [game])

  if (!game) {
    return (
      <>
        <p className="muted">找不到這個遊戲。</p>
        <Link to="/games">← 回到小遊戲</Link>
      </>
    )
  }

  const Game = game.component
  return (
    <div className="game-page" ref={page}>
      <header className="game-head" ref={head}>
        <Link to="/games" className="game-back" aria-label="回到小遊戲" title="回到小遊戲">
          ←
        </Link>
        <h1>
          <span aria-hidden="true">{game.icon}</span> {game.name}
        </h1>
        <LobbyChip />
        {game.music && <PageMusic key={game.id} game={game.id} load={game.music} />}
      </header>
      <Suspense fallback={<p className="muted">載入中…</p>}>
        {/* key：從一個遊戲切到另一個、或跟著遊戲室換了房間時整個重來，不沿用狀態 */}
        <Game key={`${game.id}:${follow}`} />
      </Suspense>
    </div>
  )
}
