import { api } from '../api'

/** 對應後端 short_links.rs */
export type ShortLink = {
  id: number
  code: string
  /** 目的網址 */
  url: string
  title: string
  /** 要登入才跳轉 */
  require_login: boolean
  created_at: string
  clicks: number
  ips: number
  last_click_at: string | null
}

export type ClickIp = {
  ip: string
  clicks: number
  first_at: string
  last_at: string
  /** 有登入點過的帳號，逗號分隔 */
  users: string
  user_agent: string
}

export type Click = {
  id: number
  ip: string
  username: string | null
  user_agent: string
  referer: string
  created_at: string
}

export type Stats = {
  link: ShortLink
  ips: ClickIp[]
  clicks: Click[]
  /** 最近 30 天有點擊的日子（UTC 的 YYYY-MM-DD） */
  days: { day: string; clicks: number }[]
}

export type LinkInput = { url: string; title: string; require_login: boolean }

export const listLinks = () => api<ShortLink[]>('/links')
export const createLink = (input: LinkInput & { code: string }) =>
  api<ShortLink>('/links', { method: 'POST', body: JSON.stringify(input) })
export const updateLink = (id: number, input: LinkInput) =>
  api<ShortLink>(`/links/${id}`, { method: 'PUT', body: JSON.stringify(input) })
export const deleteLink = (id: number) => api<void>(`/links/${id}`, { method: 'DELETE' })
export const getStats = (id: number) => api<Stats>(`/links/${id}/stats`)

/** 完整的短網址，例如 https://ouyang.app/s/ab3k */
export const shortUrl = (code: string) => `${window.location.origin}/s/${code}`
