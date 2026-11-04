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

/** 假的 .env 被拿走的紀錄，見後端 honeypot.rs */
export type HoneypotIp = {
  ip: string
  hits: number
  first_at: string
  last_at: string
  paths: string[]
  users: string[]
  user_agent: string
}

/** 有人拿假 .env 裡的密碼來登入 */
export type HoneypotUse = {
  id: number
  /** 拿來登入的 IP */
  ip: string
  /** 用的是哪一行的密碼（DB_PASSWORD、ADMIN_PASSWORD…） */
  field: string
  /** 當初拿走假檔案的 IP 和時間 */
  issued_ip: string
  issued_at: string
  username: string
  user_agent: string
  created_at: string
}

/** 現在不能登入和註冊的 IP */
export type HoneypotBlock = {
  ip: string
  /** 擋到什麼時候；手動封鎖選「永久」的是 null */
  until: string | null
  /** 管理員手動封鎖的；false 是拿過假檔案或用過假密碼被自動封鎖 */
  manual: boolean
  note: string
}

export type HoneypotReport = {
  summary: { hits: number; ips: number; last_day: number; last_day_ips: number; uses: number; blocked: number }
  ips: HoneypotIp[]
  paths: { path: string; hits: number; ips: number }[]
  uses: HoneypotUse[]
  blocks: HoneypotBlock[]
  auto_block: boolean
}

export type HoneypotHit = {
  id: number
  ip: string
  method: string
  path: string
  query: string
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

/** 系統管理的主機監控，見後端 monitor.rs */
export type MonitorProcess = {
  pid: number
  cmd: string
  /** 佔整台主機的 % */
  cpu: number
  rss: number
  threads: number
  /** Unix 秒 */
  started_at: number
}

export type MonitorGroup = {
  kind: 'service' | 'container' | 'session' | 'self' | 'other'
  name: string
  cgroup: string
  cpu: number
  rss: number
  started_at: number
  processes: MonitorProcess[]
}

export type MonitorSnapshot = {
  sampled_at: number
  kernel: string
  cpu_model: string
  cpus: number
  uptime_secs: number
  load: [number, number, number]
  cpu: { busy: number; iowait: number; steal: number } | null
  memory: { total: number; available: number; swap_total: number; swap_free: number }
  disk: { total: number; used: number; available: number; data_bytes: number } | null
  disk_io: { read_bps: number; write_bps: number } | null
  net: { rx_bps: number; tx_bps: number } | null
  groups: MonitorGroup[]
}

export type MonitorTarget = {
  id: number
  label: string
  pattern: string
  processes: number
  cpu: number
  rss: number
  started_at: number | null
}

export type MonitorStatus = {
  snapshot: MonitorSnapshot | null
  error: string | null
  targets: MonitorTarget[]
}

export type MonitorPoint = {
  t: number
  cpu: number
  mem_used: number
  rx_bps: number
  tx_bps: number
  read_bps: number
  write_bps: number
  targets: { id: number; cpu: number; rss: number; processes: number }[]
}

export type MonitorHistory = { step_secs: number; points: MonitorPoint[] }
