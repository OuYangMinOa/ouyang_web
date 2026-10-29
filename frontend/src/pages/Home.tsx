import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../api'

type Message = { id: number; content: string; created_at: string }

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

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
      setDraft('')
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <h1>留言板</h1>
      <form className="inline-form" onSubmit={submit}>
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

      <ul className="messages">
        {messages.map((m) => (
          <li key={m.id}>
            <span>{m.content}</span>
            <time>{new Date(m.created_at).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </>
  )
}
