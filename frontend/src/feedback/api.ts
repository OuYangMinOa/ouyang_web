import { api, ApiError } from '../api'

/** 回報與許願，見後端 feedback.rs */
export type FeedbackKind = 'bug' | 'wish'
export type FeedbackStatus = 'open' | 'closed'

export const KIND_LABELS: Record<FeedbackKind, string> = { bug: '回報', wish: '許願' }
export const KIND_ICONS: Record<FeedbackKind, string> = { bug: '🐞', wish: '🌠' }
export const STATUS_LABELS: Record<FeedbackStatus, string> = { open: '處理中', closed: '已結案' }

export type Thread = {
  id: number
  kind: FeedbackKind
  title: string
  status: FeedbackStatus
  created_at: string
  updated_at: string
  messages: number
  /** 對方有新的留言 */
  unread: boolean
}

export type AdminThread = Thread & {
  /** 發問的帳號；訪客是 null */
  reporter: string | null
  ip: string
}

export type Message = {
  id: number
  from_admin: boolean
  author: string | null
  body: string
  created_at: string
  images: number[]
}

export type Conversation<T extends Thread = Thread> = { thread: T; messages: Message[] }

export type Unread = { mine: number; admin?: number }

export type Draft = { body: string; images: number[] }

export function imageUrl(id: number) {
  return `/api/feedback/images/${id}`
}

/** body 直接是圖片檔，回傳圖片 id，送出留言時一起帶上 */
export async function uploadImage(image: Blob): Promise<number> {
  const res = await fetch('/api/feedback/images', {
    method: 'POST',
    headers: { 'Content-Type': image.type || 'application/octet-stream' },
    body: image,
  })
  const body = await res.json().catch(() => ({}))
  if (res.status === 413) throw new ApiError('圖片太大（上限 5 MB）', 413)
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status)
  return body.id
}

export const fetchUnread = () => api<Unread>('/feedback/unread')

export const listMine = () => api<Thread[]>('/feedback')

export const getMine = (id: number) => api<Conversation>(`/feedback/${id}`)

export function createThread(kind: FeedbackKind, title: string, draft: Draft) {
  return api<Conversation>('/feedback', { method: 'POST', body: JSON.stringify({ kind, title, ...draft }) })
}

export function replyMine(id: number, draft: Draft) {
  return api<Conversation>(`/feedback/${id}/messages`, { method: 'POST', body: JSON.stringify(draft) })
}

export const adminList = (status: FeedbackStatus | '') =>
  api<AdminThread[]>(`/admin/feedback${status ? `?status=${status}` : ''}`)

export const adminGet = (id: number) => api<Conversation<AdminThread>>(`/admin/feedback/${id}`)

export function adminReply(id: number, draft: Draft) {
  return api<Conversation<AdminThread>>(`/admin/feedback/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify(draft),
  })
}

export function adminSetStatus(id: number, status: FeedbackStatus) {
  return api<Conversation<AdminThread>>(`/admin/feedback/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  })
}

export const adminDelete = (id: number) => api<void>(`/admin/feedback/${id}`, { method: 'DELETE' })

/** 讀過或送出之後通知頁首的紅點重新整理 */
const CHANGED = 'feedback:changed'

export function notifyChanged() {
  window.dispatchEvent(new Event(CHANGED))
}

export function onChanged(listener: () => void) {
  window.addEventListener(CHANGED, listener)
  return () => window.removeEventListener(CHANGED, listener)
}
