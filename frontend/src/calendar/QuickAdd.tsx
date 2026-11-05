import { useState, type FormEvent } from 'react'
import { api, errorMessage } from '../api'
import { useAiStatus } from '../ai/api'
import { useAuth } from '../auth'
import type { EventDraft } from './EventDialog'

/**
 * 「用一句話新增」：AI 把「下週三晚上七點跟阿明吃飯」整理成事項的欄位，打開新增事項的視窗讓使用者確認。
 * 只有登入的人看得到；管理員沒開放 AI 時整個不顯示。
 */
export default function QuickAdd({ onDraft }: { onDraft: (draft: EventDraft) => void }) {
  const { user } = useAuth()
  if (!user) return null
  return <QuickAddForm onDraft={onDraft} />
}

function QuickAddForm({ onDraft }: { onDraft: (draft: EventDraft) => void }) {
  const status = useAiStatus()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!status?.configured) return null
  const down = !status.available

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const draft = await api<EventDraft>('/ai/calendar/parse', { method: 'POST', body: JSON.stringify({ text }) })
      setText('')
      onDraft(draft)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="cal-quick" onSubmit={submit}>
      <label className="cal-quick-field">
        <span className="cal-quick-label">✨ 用一句話新增</span>
        <span className="inline-form">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={down ? 'AI 暫時無法使用' : '例如：下週三晚上七點跟阿明吃飯、農曆八月十五媽媽生日'}
            maxLength={500}
            disabled={down || busy}
            enterKeyHint="go"
          />
          <button type="submit" disabled={down || busy || !text.trim()}>
            {busy ? 'AI 整理中…' : '填表'}
          </button>
        </span>
      </label>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
