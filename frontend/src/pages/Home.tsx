import { useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { Link } from 'react-router'
import { api, errorMessage } from '../api'
import { appPath, visibleApps } from '../apps/registry'
import { useAuth } from '../auth'
import DoodleSun from '../components/DoodleSun'
import MistScene from '../components/MistScene'
import StickerSun from '../components/StickerSun'
import SunStage from '../components/SunStage'
import { useAppearance } from '../theme'
import TyphoonHome from '../weather/TyphoonHome'
import './Home.css'
import { BOT, LEAD, OWNER, PROFILE, WORKS } from './homeContent'

type Message = { id: number; content: string; created_at: string }
type Health = { status: string; env: string; commit: string; db: boolean }

const YEAR = new Date().getFullYear()

function Intro() {
  // 塗鴉風格換成手畫的太陽、山嵐換成一幅不會動的山景、貼紙換成一張太陽貼紙，都不載入 three.js
  const { style } = useAppearance()
  return (
    <section className="home-intro">
      <div className="home-wrap home-intro-grid">
        <div className="home-intro-copy">
          <h1 className="home-name">{OWNER}</h1>
          <p className="home-lead">{LEAD}</p>
          <dl className="home-profile">
            {PROFILE.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        {style === 'doodle' ? (
          <DoodleSun />
        ) : style === 'mist' ? (
          <MistScene />
        ) : style === 'sticker' ? (
          <StickerSun />
        ) : (
          <SunStage />
        )}
      </div>
    </section>
  )
}

type Item = { glyph: string; name: string; desc: string; tag: string; to?: string; live?: boolean }

function Works() {
  const auth = useAuth()
  const items: Item[] = [
    BOT,
    // 其他項目來自 apps/registry.ts，沒權限的不會出現
    ...visibleApps(auth).map((app) => ({
      glyph: app.glyph,
      name: app.name,
      desc: app.blurb,
      tag: app.tag,
      to: appPath(app),
    })),
  ]

  return (
    <section id="works" className="home-section">
      <div className="home-wrap">
        <header className="home-head">
          <h2>{WORKS.title}</h2>
          <p>{WORKS.note}</p>
        </header>
        <ul className="home-items">
          {items.map((item) => {
            const body = (
              <>
                <span className="home-item-glyph" aria-hidden="true">
                  {item.glyph}
                </span>
                <span className="home-item-name">{item.name}</span>
                <span className="home-item-desc">{item.desc}</span>
                <span className={`home-item-tag ${item.live ? 'live' : ''}`}>{item.tag}</span>
                {item.to && (
                  <span className="home-item-go" aria-hidden="true">
                    →
                  </span>
                )}
              </>
            )
            return (
              <li key={item.name}>
                {item.to ? (
                  <Link className="home-item" to={item.to}>
                    {body}
                  </Link>
                ) : (
                  <div className="home-item">{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

/** 便條紙的傾斜角度由 id 決定，重新整理也不會變 */
function noteTilt(id: number) {
  return `${(((id * 37) % 9) - 4) * 0.5}deg`
}

function Guestbook() {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fresh, setFresh] = useState<number | null>(null)

  useEffect(() => {
    api<Message[]>('/messages').then(setMessages).catch((e) => setError(errorMessage(e)))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      const created = await api<Message>('/messages', {
        method: 'POST',
        body: JSON.stringify({ content: draft }),
      })
      setMessages((prev) => [created, ...prev])
      setFresh(created.id)
      setDraft('')
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <section id="guestbook" className="home-section">
      <div className="home-wrap">
        <header className="home-head">
          <h2>留言牆</h2>
          <p>不用登入，留一句話給我，所有人都看得到。</p>
        </header>
        <form className="note-form" onSubmit={submit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="寫點什麼…"
            maxLength={500}
            aria-label="留言內容"
          />
          <button type="submit" disabled={!draft.trim()}>
            貼上去
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        {messages.length === 0 && !error && <p className="muted notes-empty">還沒有人留言，來當第一個。</p>}
        <ul className="notes">
          {messages.map((m) => (
            <li
              key={m.id}
              className={`note ${m.id === fresh ? 'fresh' : ''}`}
              style={{ '--tilt': noteTilt(m.id) } as CSSProperties}
            >
              <p>{m.content}</p>
              <time>{new Date(m.created_at).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Footer() {
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    api<Health>('/health').then(setHealth).catch(() => setHealth(null))
  }, [])

  const ok = health?.status === 'ok'
  return (
    <footer className="home-foot">
      <div className="home-wrap home-foot-row">
        <span>© {YEAR} 歐陽明崴</span>
        <span className="home-foot-status">
          <span className={`dot ${health ? (ok ? 'ok' : 'bad') : ''}`} aria-hidden="true" />
          {health ? (ok ? '服務正常' : '服務有點狀況') : '連線中…'}・主機在東京
          {health && `・${health.env} ${health.commit.slice(0, 7)}`}
        </span>
      </div>
    </footer>
  )
}

export default function Home() {
  return (
    <div className="home">
      <Intro />
      {/* 西北太平洋有颱風時才會出現 */}
      <TyphoonHome />
      <Works />
      <Guestbook />
      <Footer />
    </div>
  )
}
