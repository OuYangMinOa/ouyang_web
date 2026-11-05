import { useAiStatus } from './api'
import './ai.css'

function formatSince(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const sameDay = date.toDateString() === new Date().toDateString()
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 放在每個 AI 功能頁面的最上面：AI 不能用時馬上告訴使用者，能用時什麼都不顯示。
 * 每 15 秒確認一次，AI 呼叫失敗時也會立刻更新；恢復後自己消失，不用重新整理。
 */
export default function AiStatusNotice() {
  const status = useAiStatus()
  if (!status || (status.configured && status.available)) return null

  const since = formatSince(status.since)
  return (
    <div className="ai-notice" role="status">
      <span className="ai-notice-icon" aria-hidden="true">
        ⚠
      </span>
      <div>
        <strong>{status.configured ? 'AI 服務暫時無法使用' : 'AI 功能尚未開放'}</strong>
        <p>
          {status.configured
            ? `${since ? `從${since}起` : '目前'}連不上 AI 服務，AI 相關的功能暫停。恢復後這則訊息會自動消失，不用重新整理。`
            : '管理員還沒設定 AI 服務，AI 相關的功能暫時不能用。'}
        </p>
      </div>
    </div>
  )
}
