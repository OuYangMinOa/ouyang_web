import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { LobbyBar } from './lobby/LobbyBar'
import { lobbyPath, useLobby } from './lobby/useLobby'
import { GAME_CATEGORIES, GAMES } from './registry'
import './games.css'
import './lobby/lobby.css'

/** 分組的說明，排在分組標題旁邊 */
const CATEGORY_HINTS: Record<(typeof GAME_CATEGORIES)[number], string> = {
  多人對戰: '線上和很多人一起打，人不夠由電腦補位',
  派對: '開個房間和朋友一起玩，規則由伺服器主持',
  雙人對戰: '跟電腦下、同一台輪流下，或開房間線上對戰',
  單人: '一個人慢慢玩',
}

export default function GamesHub() {
  return (
    <div className="games-hub">
      <h1>小遊戲</h1>
      <LobbyBar />
      <LobbyEntry />
      {GAME_CATEGORIES.map((category) => {
        const games = GAMES.filter((g) => g.category === category)
        if (games.length === 0) return null
        return (
          <section key={category} className="games-section" aria-labelledby={`games-${category}`}>
            <header className="games-section-head">
              <h2 id={`games-${category}`}>{category}</h2>
              <span className="muted">{CATEGORY_HINTS[category]}</span>
            </header>
            <ul className="games-grid">
              {games.map((game) => (
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
          </section>
        )
      })}
    </div>
  )
}

/** 開遊戲室或用代碼加入；已經在遊戲室裡時上面的 `LobbyBar` 取代這裡 */
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
    <section className="lobby-entry" aria-label="遊戲室">
      <span className="lobby-entry-icon" aria-hidden="true">
        🏠
      </span>
      <span className="lobby-entry-text">
        <strong>和朋友一起玩</strong>
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
