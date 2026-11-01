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

/** 系統管理的遊戲狀態，見後端 game_monitor.rs */
export type LivePlayer = {
  /** 認人用：帳號是 u<id>，訪客是雜湊過的 g<…> */
  who: string
  name: string
  username: string | null
  online: boolean
  host: boolean
  /** 例如「座位 1」「觀戰」「第 3 名」，可能是空字串 */
  status: string
  ip: string | null
  online_secs: number | null
}

export type LiveRoom = {
  kind: 'duel' | 'arena' | 'party'
  game: string
  code: string
  phase: 'waiting' | 'playing' | 'idle' | 'lobby' | 'countdown' | 'results'
  round: number
  age_secs: number
  bots: number
  public: boolean
  events: number | null
  alive: number | null
  players: LivePlayer[]
}

export type SoloRun = {
  game: string
  username: string
  score: number
  level: number
  duration_ms: number
  age_secs: number
  idle_secs: number
}

export type GamesReport = { rooms: LiveRoom[]; solo: SoloRun[] }
