import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { api, errorMessage, PERMISSIONS } from '../api'
import { appPath, visibleApps } from '../apps/registry'
import { useAuth } from '../auth'
import SunStage from '../components/SunStage'
import TiltCard from '../components/TiltCard'
import './Home.css'

type Message = { id: number; content: string; created_at: string }
type Health = { status: string; env: string; commit: string; db: boolean }

/** 捲到畫面裡才淡入；使用者設定減少動態時直接顯示 */
function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true)
          observer.disconnect()
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className={`reveal ${shown ? 'in' : ''} ${className}`}>
      {children}
    </div>
  )
}

/** 標題逐字浮上來 */
function Rise({ text, start = 0 }: { text: string; start?: number }) {
  return (
    <>
      {[...text].map((char, i) => (
        <span key={i} className="rise" style={{ '--i': start + i } as CSSProperties}>
          {char}
        </span>
      ))}
    </>
  )
}

function Hero() {
  const { user, can } = useAuth()

  return (
    <section className="hero">
      <div className="home-wrap hero-grid">
        <div className="hero-copy">
          <p className="kicker">
            <span>01</span> OUYANG LAB · 個人實驗場
          </p>
          <h1 className="hero-title" aria-label="把想法，做成會動的東西">
            <span className="line" aria-hidden="true">
              <Rise text="把想法，" />
            </span>
            <span className="line" aria-hidden="true">
              <Rise text="做成會" start={4} />
              <em>
                <Rise text="動" start={7} />
              </em>
              <Rise text="的東西" start={8} />
            </span>
          </h1>
          <span className="seal" aria-hidden="true">
            歐陽
          </span>
          <p className="hero-lead">
            歡迎來到歐陽天地。Discord 機器人、順手寫的小工具，還有接下來陸續上線的 APP，都住在這裡。
          </p>
          <div className="hero-actions">
            <a className="btn primary" href="#works">
              看看有什麼 <span aria-hidden="true">↓</span>
            </a>
            {user ? (
              can(PERMISSIONS.adminUsers) && (
                <Link className="btn ghost" to="/admin">
                  系統管理
                </Link>
              )
            ) : (
              <Link className="btn ghost" to="/login">
                登入
              </Link>
            )}
          </div>
          <p className="hero-hint">
            <span className="pulse" aria-hidden="true" />
            拖曳撥動粒子，點一下讓太陽凝聚成「陽」
          </p>
        </div>
        <SunStage />
      </div>
    </section>
  )
}

const SKILLS = ['Claude Code', '知識庫', 'Harness 建置']
const EXPERIENCE = [
  { title: '推薦系統', body: '從資料到上線的推薦流程' },
  { title: '棋牌類強化學習', body: '讓 AI 自己對打、自己變強' },
  { title: '公司 AI 管理方案', body: '把 AI 工具導入團隊並管得住' },
]

function About() {
  return (
    <section id="about" className="home-section">
      <div className="home-wrap">
        <Reveal className="section-head">
          <p className="kicker">
            <span>02</span> ABOUT
          </p>
          <h2>關於我</h2>
        </Reveal>
        <div className="about">
          <Reveal className="about-intro">
            <p className="about-name">
              歐陽明崴
              <span>Software Engineer</span>
            </p>
            <p>
              中央大學物理研究所畢業，現在是軟體工程師。從物理走進程式，喜歡把複雜的問題拆開，再組成真的能用的東西。
            </p>
            <ul className="about-skills" aria-label="擅長">
              {SKILLS.map((skill) => (
                <li key={skill} className="tag">
                  {skill}
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal>
            <p className="about-label">做過</p>
            <ol className="about-list">
              {EXPERIENCE.map((item) => (
                <li key={item.title}>
                  <strong>{item.title}</strong>
                  <span>{item.body}</span>
                </li>
              ))}
            </ol>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

type Work = {
  glyph: string
  title: string
  body: string
  tag: string
  live?: boolean
  link?: { to: string; label: string }
  soon?: boolean
}

function Works() {
  const { can } = useAuth()
  const works: Work[] = [
    {
      glyph: '俠',
      title: '歐陽小俠',
      body: 'Discord 機器人：點歌、音效板、AI 聊天，還有台灣天氣和地震速報。',
      tag: '運作中',
      live: true,
    },
    {
      glyph: '言',
      title: '留言牆',
      body: '留一句話給我。不用登入，所有人都看得到。',
      tag: '就在下面',
      link: { to: '#guestbook', label: '去留言' },
    },
    // APP 卡片來自 apps/registry.ts，沒權限的不會出現
    ...visibleApps(can).map((app) => ({
      glyph: app.glyph,
      title: app.name,
      body: app.blurb,
      tag: app.tag,
      live: app.live,
      link: { to: appPath(app), label: '進入' },
    })),
  ]

  return (
    <section id="works" className="home-section">
      <div className="home-wrap">
        <Reveal className="section-head">
          <p className="kicker">
            <span>03</span> WORKS
          </p>
          <h2>作品與工具</h2>
        </Reveal>
        <div className="works">
          {works.map((work, i) => (
            <Reveal key={work.title} className="work-slot">
              <TiltCard className={`work ${work.soon ? 'soon' : ''}`} style={{ '--d': i } as CSSProperties}>
                <span className="work-glyph depth-3" aria-hidden="true">
                  {work.glyph}
                </span>
                <span className="work-index depth-1">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="depth-2">{work.title}</h3>
                <p className="depth-1">{work.body}</p>
                <div className="work-foot depth-2">
                  <span className={`tag ${work.live ? 'live' : ''}`}>{work.tag}</span>
                  {work.link &&
                    (work.link.to.startsWith('#') ? (
                      <a className="work-link" href={work.link.to}>
                        {work.link.label} →
                      </a>
                    ) : (
                      <Link className="work-link" to={work.link.to}>
                        {work.link.label} →
                      </Link>
                    ))}
                </div>
              </TiltCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

/** 便條紙的傾斜角度由 id 決定，重新整理也不會變 */
function noteTilt(id: number) {
  return `${(((id * 37) % 9) - 4) * 0.7}deg`
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
        <Reveal className="section-head">
          <p className="kicker">
            <span>04</span> GUESTBOOK
          </p>
          <h2>留言牆</h2>
        </Reveal>
        <Reveal>
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
        </Reveal>
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

function StatusBar() {
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    api<Health>('/health').then(setHealth).catch(() => setHealth(null))
  }, [])

  const ok = health?.status === 'ok'
  return (
    <footer className="home-section status">
      <div className="home-wrap status-row">
        <p className="kicker">
          <span>05</span> STATUS
        </p>
        <p className="status-line">
          <span className={`dot ${ok ? 'ok' : 'bad'}`} aria-hidden="true" />
          {health ? (ok ? '一切正常' : '有點狀況') : '連線中…'}
          <span className="sep">/</span>
          東京 ap-northeast-1
          {health && (
            <>
              <span className="sep">/</span>
              {health.env} · {health.commit.slice(0, 7)}
            </>
          )}
        </p>
      </div>
    </footer>
  )
}

export default function Home() {
  return (
    <div className="home">
      <Hero />
      <About />
      <Works />
      <Guestbook />
      <StatusBar />
    </div>
  )
}
