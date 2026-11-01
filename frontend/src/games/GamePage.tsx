import { Suspense } from 'react'
import { Link, useParams } from 'react-router'
import { findGame } from './registry'
import { PageMusic } from './shared/PageMusic'
import './games.css'

export default function GamePage() {
  const { id } = useParams()
  const game = findGame(id)

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
    <>
      <div className="game-title">
        <Link to="/games" className="game-back" aria-label="回到小遊戲">
          ←
        </Link>
        <h1>
          <span aria-hidden="true">{game.icon}</span> {game.name}
        </h1>
        {game.music && <PageMusic key={game.id} game={game.id} load={game.music} />}
      </div>
      <Suspense fallback={<p className="muted">載入中…</p>}>
        {/* key：從一個遊戲切到另一個時整個重來，不沿用狀態 */}
        <Game key={game.id} />
      </Suspense>
    </>
  )
}
