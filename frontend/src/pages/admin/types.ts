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
