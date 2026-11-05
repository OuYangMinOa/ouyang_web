import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '../../api'
import AiStatusNotice from '../AiStatusNotice'
import { chatApi, type MyTools, type Quota, type ToolInfo } from './chat'
import '../ai.css'
import './chat.css'

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const ratio = limit ? Math.min(1, used / limit) : 0
  return (
    <div className="ai-meter">
      <div className="ai-meter-head">
        <span>{label}</span>
        <strong>
          {used.toLocaleString()}
          {limit !== null ? ` / ${limit.toLocaleString()}` : ''}
        </strong>
      </div>
      {limit !== null && (
        <div
          className={`ai-meter-bar ${ratio >= 1 ? 'is-full' : ratio >= 0.8 ? 'is-high' : ''}`}
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used}
        >
          <span style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
    </div>
  )
}

function QuotaCard({ quota }: { quota: Quota }) {
  return (
    <section className="card ai-quota">
      <h2>今天的額度</h2>
      {quota.blocked ? (
        <p className="error">管理員停用了你的 AI 功能，有問題請到「回報 / 許願」詢問。</p>
      ) : quota.unlimited ? (
        <p className="muted">你是管理員，不受額度限制。今天用了 {quota.today.requests} 次、{quota.today.tokens.toLocaleString()} tokens。</p>
      ) : (
        <>
          <Meter label="對話次數" used={quota.today.requests} limit={quota.daily_requests} />
          <Meter label="Tokens（輸入＋輸出）" used={quota.today.tokens} limit={quota.daily_tokens} />
          <p className="muted">
            每送出一則訊息、每次用一句話新增日曆事項算一次；按「允許」後 AI 接著做不另外算次數，但 tokens 照算。
            額度在台灣時間每天 0 點重新計算。
          </p>
        </>
      )}
    </section>
  )
}

export default function ToolsPage() {
  const [quota, setQuota] = useState<Quota | null>(null)
  const [tools, setTools] = useState<MyTools | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([chatApi.quota(), chatApi.tools()])
      .then(([q, t]) => {
        setQuota(q)
        setTools(t)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [])

  const groups = new Map<string, ToolInfo[]>()
  for (const tool of tools?.tools ?? []) {
    groups.set(tool.source, [...(groups.get(tool.source) ?? []), tool])
  }

  return (
    <div className="ai-tools-page">
      <h1>工具與額度</h1>
      <AiStatusNotice />
      {error && <p className="error">{error}</p>}
      {quota && <QuotaCard quota={quota} />}

      <section className="card">
        <h2>AI 能用的工具</h2>
        <p className="muted ai-intro">
          在<Link to="/ai">對話</Link>裡直接用平常的話說就好，AI 會自己決定要不要用工具。標著「要你確認」的會改到你的資料，
          AI 想用的時候畫面上會出現「允許／拒絕」，按了允許才會做。
        </p>
        {tools && !tools.supported && (
          <p className="error">目前的 AI 模型不支援呼叫工具，只能一般聊天。</p>
        )}
        {tools === null && !error && <p className="muted">載入中…</p>}
        {tools?.tools.length === 0 && <p className="muted">管理員目前沒有開放任何工具。</p>}
        {[...groups].map(([source, list]) => (
          <div key={source} className="ai-tool-group">
            <h3>{source === '本站' ? '本站功能' : source}</h3>
            <ul className="ai-tool-list">
              {list.map((tool) => (
                <li key={tool.name}>
                  <div className="ai-tool-list-head">
                    <strong>{tool.title}</strong>
                    {tool.approval && <span className="chip subtle">要你確認</span>}
                  </div>
                  <p className="muted">{tool.description}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  )
}
