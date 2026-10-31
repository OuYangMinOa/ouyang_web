export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status)
  return body as T
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export type User = {
  id: number
  username: string
  roles: string[]
  permissions: string[]
}

/** 跟後端 auth.rs 的 Permission 對應 */
export const PERMISSIONS = {
  adminUsers: 'admin.users',
} as const

/** 註冊入口有沒有開（管理員在系統管理裡切換） */
export async function registrationOpen(): Promise<boolean> {
  return (await api<{ open: boolean }>('/auth/register')).open
}
