import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { lobbyPath, useLobby } from './lobby/useLobby'
import { GAMES } from './registry'
import './games.css'
import './lobby/lobby.css'

export default function GamesHub() {
  return (
    <>
      <h1>小遊戲</h1>
      <LobbyEntry />
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

/** 開遊戲室或用代碼加入；已經在遊戲室裡時上面的列就有入口，這裡不用再顯示 */
function LobbyEntry() {
  const lobby = useLobby()
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')
  if (lobby.code) return null

  function submit(e: FormEvent) {
    e.preventDefault()
    const code = draft.trim()
    if (code) navigate(lobbyPath(code.toUpperCase()))
  }

  return (
    <section className="lobby-entry">
      <span className="lobby-entry-text">
        <strong>
          <span aria-hidden="true">🏠</span> 和朋友一起玩
        </strong>
        <span className="muted">開一間遊戲室，邀請一次就好：房主選遊戲，大家一起過去，玩完換下一款也不用重開房間。</span>
      </span>
      <span className="lobby-entry-actions">
        <button type="button" onClick={lobby.create} disabled={lobby.busy}>
          開遊戲室
        </button>
        <form className="inline-form" onSubmit={submit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            placeholder="遊戲室代碼"
            maxLength={8}
            autoCapitalize="characters"
            autoComplete="off"
            aria-label="遊戲室代碼"
          />
          <button type="submit" className="secondary" disabled={!draft.trim()}>
            加入
          </button>
        </form>
      </span>
      {lobby.error && <p className="error">{lobby.error}</p>}
    </section>
  )
}
