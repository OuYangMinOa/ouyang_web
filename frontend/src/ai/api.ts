import { useSyncExternalStore } from 'react'
import { api, ApiError } from '../api'

/**
 * AI 功能共用的前端工具，後端在 backend/src/ai.rs。
 * 之後新增的 AI 功能：頁面上放 <AiStatusNotice />，呼叫自己的後端 API（後端用 `Ai::stream`／`Ai::complete`），
 * 要串流的話用這裡的 streamChat 讀。
 */

export type AiUsage = { prompt_tokens: number; completion_tokens: number }

/** 串流的每一段，對應後端的 `ai::Event` */
export type AiEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'done'; finish_reason: string | null; usage: AiUsage | null }
  | { type: 'error'; message: string }

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * POST 到一個回傳 AI 串流的後端 API（一行一個 JSON，後端的 `ai::ndjson`），每收到一段就呼叫 onEvent。
 * 還沒開始就失敗（AI 掛了、沒設定、輸入有問題）會丟 ApiError；這時順便重新看一次 AI 的狀態，
 * 頁面上的 <AiStatusNotice /> 會馬上出現，不用等下一次定時檢查。
 */
export async function streamChat(
  path: string,
  body: unknown,
  onEvent: (event: AiEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    if (res.status >= 500) refreshAiStatus()
    throw new ApiError(data.error ?? res.statusText, res.status)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const flush = (text: string) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as AiEvent
      if (event.type === 'error') refreshAiStatus()
      onEvent(event)
    }
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const end = buffer.lastIndexOf('\n')
    if (end >= 0) {
      flush(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
    }
  }
  flush(buffer + decoder.decode())
}

// ---- 全站使用中的 AI 能不能用 ----

export type AiStatus = {
  /** 管理員有沒有選一組給全站用；沒有就是不開放 AI 功能 */
  configured: boolean
  available: boolean
  /** 從什麼時候開始是這個狀態 */
  since: string | null
  checked_at: string | null
}

/** 跟後端檢查的間隔一樣 */
const POLL_MS = 15_000

let current: AiStatus | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

/** 馬上向後端重新拿一次狀態（AI 呼叫失敗時用） */
export function refreshAiStatus() {
  api<AiStatus>('/ai/status')
    .then((status) => {
      current = status
      listeners.forEach((listener) => listener())
    })
    .catch(() => {})
}

function refreshIfVisible() {
  if (document.visibilityState === 'visible') refreshAiStatus()
}

// 整個分頁共用一份：有元件在用時才定時去問，分頁在背景時暫停，切回來馬上問一次
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    refreshAiStatus()
    timer = setInterval(refreshIfVisible, POLL_MS)
    document.addEventListener('visibilitychange', refreshIfVisible)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }
}

/** 全站使用中的 AI 現在能不能用；還沒拿到是 null */
export function useAiStatus(): AiStatus | null {
  return useSyncExternalStore(subscribe, () => current)
}
