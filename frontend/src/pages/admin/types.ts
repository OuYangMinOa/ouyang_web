export type AdminUser = {
  id: number
  username: string
  disabled: boolean
  created_at: string
  last_login_at: string | null
  roles: string[]
}

export type Role = {
  id: number
  name: string
  description: string
  permissions: { name: string; description: string }[]
}

/** 隱藏頁面的一次瀏覽（一個分頁），見後端 visits.rs */
export type VisitSession = {
  session: string
  first_at: string
  last_at: string
  ips: string[]
  users: string[]
  user_agent: string
  opens: number
  clicks: number
  scans: number
  errors: number
}

export type VisitReport = {
  summary: { sessions: number; ips: number; users: number; last_day: number }
  sessions: VisitSession[]
}

export type VisitEvent = {
  id: number
  action: 'open' | 'click' | 'scan' | 'error'
  detail: string
  ip: string
  username: string | null
  created_at: string
}
