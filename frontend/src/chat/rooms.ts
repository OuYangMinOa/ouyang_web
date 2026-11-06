import { api } from '../api'

/** 私人房間（後端 chat_rooms.rs）：只有成員拿得到，不是成員的一律 404 */
export type Room = {
  id: number
  name: string
  /** 加入用的代碼（8 碼），房主換代碼、移出成員時會變 */
  code: string
  owner_id: number
  /** 依加入的先後 */
  members: { id: number; username: string }[]
  /** 自己還沒看的別人的訊息數 */
  unread: number
  created_at: string
}

/** 哪一間：null 是大家共用的大廳 */
export type RoomId = number | null

export const MAX_ROOM_NAME = 30

/** 未讀數之類以房間為 key 的地方用的字串 */
export function roomKey(room: RoomId): string {
  return room === null ? 'lobby' : String(room)
}

/** 代碼顯示成 ABCD-EFGH，比較好念、好抄 */
export function formatCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

export async function listRooms(): Promise<Room[]> {
  return (await api<{ rooms: Room[] }>('/chat/rooms')).rooms
}

export function createRoom(name: string): Promise<Room> {
  return api<Room>('/chat/rooms', { method: 'POST', body: JSON.stringify({ name }) })
}

export function joinRoom(code: string): Promise<Room> {
  return api<Room>('/chat/rooms/join', { method: 'POST', body: JSON.stringify({ code }) })
}

export function renameRoom(id: number, name: string): Promise<Room> {
  return api<Room>(`/chat/rooms/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
}

export function newRoomCode(id: number): Promise<Room> {
  return api<Room>(`/chat/rooms/${id}/code`, { method: 'POST' })
}

export function deleteRoom(id: number): Promise<void> {
  return api<void>(`/chat/rooms/${id}`, { method: 'DELETE' })
}

/** 房主移出別人；user 是自己就是離開 */
export function removeMember(id: number, user: number): Promise<void> {
  return api<void>(`/chat/rooms/${id}/members/${user}`, { method: 'DELETE' })
}
