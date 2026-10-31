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

/** 全站的 IP 訪問紀錄，見後端 access_log.rs */
export type AccessIp = {
  ip: string
  requests: number
  errors: number
  first_at: string
  last_at: string
  users: string[]
  last_method: string
  last_path: string
  user_agent: string
}

export type AccessPath = { path: string; requests: number; ips: number; errors: number }

export type AccessReport = {
  summary: { requests: number; ips: number; users: number; errors: number }
  ips: AccessIp[]
  paths: AccessPath[]
}

export type AccessRequest = {
  id: number
  ip: string
  method: string
  path: string
  query: string
  status: number
  duration_ms: number
  username: string | null
  user_agent: string
  created_at: string
}

/** 自行註冊的申請，見後端 registration.rs */
export type Registration = {
  id: number
  username: string
  note: string
  ip: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
  reviewed_at: string | null
  reviewer: string | null
}

export type RegistrationReport = {
  open: boolean
  pending: Registration[]
  reviewed: Registration[]
}
