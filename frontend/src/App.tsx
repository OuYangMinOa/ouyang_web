import { useEffect, useState, type FormEvent } from 'react'
import './App.css'

type Health = { status: string; env: string; version: string; db: boolean }
type Message = { id: number; content: string; created_at: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body as T
}

function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<Health>('/health').then(setHealth).catch((e: Error) => setError(e.message))
    api<Message[]>('/messages').then(setMessages).catch((e: Error) => setError(e.message))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      const created = await api<Message>('/messages', {
        method: 'POST',
        body: JSON.stringify({ content: draft }),
      })
      setMessages((prev) => [created, ...prev])
      setDraft('')
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <main>
      <header>
        <h1>ouyang_web</h1>
        {health && (
          <span className={`badge ${health.status === 'ok' ? 'ok' : 'bad'}`}>
            {health.env} · v{health.version} · db {health.db ? 'ok' : 'down'}
          </span>
        )}
      </header>

      <form onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="留言…"
          maxLength={500}
        />
        <button type="submit" disabled={!draft.trim()}>
          送出
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      <ul>
        {messages.map((m) => (
          <li key={m.id}>
            <span>{m.content}</span>
            <time>{new Date(m.created_at).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </main>
  )
}

export default App
