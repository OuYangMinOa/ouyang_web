import { Link } from 'react-router'
import { GAMES } from './registry'
import './games.css'

export default function GamesHub() {
  return (
    <>
      <h1>小遊戲</h1>
      <ul className="games-grid">
        {GAMES.map((game) => (
          <li key={game.id}>
            <Link to={`/games/${game.id}`} className="game-card">
              <span className="game-card-icon" aria-hidden="true">
                {game.icon}
              </span>
              <span className="game-card-body">
                <strong>{game.name}</strong>
                <span className="muted">{game.blurb}</span>
                <span className="game-card-tags">
                  {game.tags.map((tag) => (
                    <span key={tag} className="chip subtle">
                      {tag}
                    </span>
                  ))}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
