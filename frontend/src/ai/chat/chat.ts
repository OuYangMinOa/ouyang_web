import { api } from '../../api'
import type { AiUsage } from '../api'

/**
 * AI 助手的對話（後端 backend/src/ai_chat.rs）。
 * 資料庫裡一則一則存：使用者的訊息、AI 的回答（可能帶著要呼叫的工具）、工具的結果；
 * 畫面上把同一個問題底下的 AI 回答和工具合成一段（Turn）。
 */

export type ChatSummary = {
  id: number
  title: string
  created_at: string
  updated_at: string
  /** 有動作在等使用者確認 */
  pending: boolean
}

export type ToolCall = { id: string; name: string; arguments: string }

export type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'denied'

export type StoredMessage = {
  id: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  reasoning: string
  tool_calls: ToolCall[]
  tool_call_id: string | null
  tool_name: string | null
  tool_title: string | null
  arguments: string | null
  summary: string | null
  /** assistant：done／stopped／error；tool：ToolStatus */
  status: string
  usage: AiUsage | null
  created_at: string
}

export type ChatView = ChatSummary & { messages: StoredMessage[] }

/** 串流的每一段，對應後端的 `ai_chat::ChatEvent` */
export type ChatEvent =
  | { type: 'step' }
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      title: string
      arguments: string
      summary: string | null
      approval: boolean
    }
  | { type: 'tool_result'; id: string; status: ToolStatus; content: string }
  | { type: 'approval'; ids: string[] }
  | { type: 'title'; title: string }
  | { type: 'done'; usage: AiUsage }
  | { type: 'error'; message: string }

export type TextBlock = { type: 'text'; content: string; reasoning: string; status?: string }
export type ToolBlock = {
  type: 'tool'
  id: string
  name: string
  title: string
  arguments: string
  summary: string | null
  status: ToolStatus
  result: string
}
export type Block = TextBlock | ToolBlock

export type Turn =
  | { role: 'user'; key: string; text: string }
  | { role: 'assistant'; key: string; blocks: Block[]; usage: AiUsage | null; error?: string; streaming?: boolean }

export type AssistantTurn = Extract<Turn, { role: 'assistant' }>

function addUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!b) return a
  if (!a) return b
  return { prompt_tokens: a.prompt_tokens + b.prompt_tokens, completion_tokens: a.completion_tokens + b.completion_tokens }
}

/** 資料庫的訊息合成畫面上的一段一段 */
export function toTurns(messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      turns.push({ role: 'user', key: `m${m.id}`, text: m.content })
      continue
    }
    let last = turns[turns.length - 1]
    if (!last || last.role !== 'assistant') {
      last = { role: 'assistant', key: `m${m.id}`, blocks: [], usage: null }
      turns.push(last)
    }
    if (m.role === 'assistant') {
      if (m.content || m.reasoning) {
        last.blocks.push({ type: 'text', content: m.content, reasoning: m.reasoning, status: m.status })
      }
      last.usage = addUsage(last.usage, m.usage)
    } else {
      last.blocks.push({
        type: 'tool',
        id: m.tool_call_id ?? String(m.id),
        name: m.tool_name ?? '',
        title: m.tool_title ?? m.tool_name ?? '工具',
        arguments: m.arguments ?? '',
        summary: m.summary,
        status: m.status as ToolStatus,
        result: m.content,
      })
    }
  }
  return turns
}

/** 把一段串流事件套到正在回答的那一段上 */
export function applyEvent(turn: AssistantTurn, event: ChatEvent): AssistantTurn {
  const blocks = [...turn.blocks]
  const last = blocks[blocks.length - 1]
  switch (event.type) {
    case 'reasoning':
    case 'content': {
      const text: TextBlock =
        last?.type === 'text' ? { ...last } : { type: 'text', content: '', reasoning: '' }
      if (event.type === 'content') text.content += event.text
      else text.reasoning += event.text
      if (last?.type === 'text') blocks[blocks.length - 1] = text
      else blocks.push(text)
      return { ...turn, blocks }
    }
    case 'tool_call':
      blocks.push({
        type: 'tool',
        id: event.id,
        name: event.name,
        title: event.title,
        arguments: event.arguments,
        summary: event.summary,
        status: event.approval ? 'pending' : 'running',
        result: '',
      })
      return { ...turn, blocks }
    case 'tool_result':
      return {
        ...turn,
        blocks: blocks.map((b) =>
          b.type === 'tool' && b.id === event.id ? { ...b, status: event.status, result: event.content } : b,
        ),
      }
    case 'done':
      return { ...turn, usage: addUsage(turn.usage, event.usage) }
    case 'error':
      return { ...turn, error: event.message }
    default:
      return turn
  }
}

export type Quota = {
  today: { requests: number; tokens: number }
  /** null 是不限 */
  daily_requests: number | null
  daily_tokens: number | null
  unlimited: boolean
  blocked: boolean
}

export type ToolInfo = { name: string; title: string; description: string; source: string; approval: boolean }
export type MyTools = { supported: boolean; tools: ToolInfo[] }

export const chatApi = {
  list: () => api<ChatSummary[]>('/ai/chats'),
  create: () => api<ChatSummary>('/ai/chats', { method: 'POST' }),
  get: (id: number) => api<ChatView>(`/ai/chats/${id}`),
  rename: (id: number, title: string) =>
    api<ChatSummary>(`/ai/chats/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  remove: (id: number) => api<void>(`/ai/chats/${id}`, { method: 'DELETE' }),
  quota: () => api<Quota>('/ai/usage'),
  tools: () => api<MyTools>('/ai/tools'),
}

/** 「今天 3 / 50 次」這類的額度說明；不限就是 null */
export function quotaLabel(quota: Quota): string | null {
  if (quota.blocked) return '你的 AI 功能被管理員停用了'
  if (quota.unlimited) return null
  const parts: string[] = []
  if (quota.daily_requests !== null) parts.push(`${quota.today.requests} / ${quota.daily_requests} 次`)
  if (quota.daily_tokens !== null)
    parts.push(`${quota.today.tokens.toLocaleString()} / ${quota.daily_tokens.toLocaleString()} tokens`)
  return parts.length ? `今天已用 ${parts.join('、')}` : null
}

/** 工具的參數排版成好讀的 JSON；不是 JSON 就照原樣 */
export function prettyArguments(text: string): string {
  try {
    const value = JSON.parse(text)
    if (value && typeof value === 'object' && Object.keys(value).length === 0) return ''
    return JSON.stringify(value, null, 2)
  } catch {
    return text
  }
}
