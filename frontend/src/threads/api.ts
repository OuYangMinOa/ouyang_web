import { api } from '../api'

/** 對應後端 threads.rs */
export type Setup = {
  key: string
  /** 共用捷徑的 iCloud 連結，管理員還沒設定就是 null */
  shortcut_url: string | null
}

export type Download = {
  id: number
  /** 貼文的網址 */
  url: string
  author: string
  caption: string
  video_count: number
  created_at: string
}

export const getSetup = () => api<Setup>('/threads/setup')
export const resetKey = () => api<Setup>('/threads/setup/key', { method: 'POST' })
export const setShortcut = (url: string) =>
  api<void>('/threads/setup/shortcut', { method: 'PUT', body: JSON.stringify({ url }) })
export const getDownloads = () => api<Download[]>('/threads/downloads')
export const deleteDownload = (id: number) => api<void>(`/threads/downloads/${id}`, { method: 'DELETE' })
