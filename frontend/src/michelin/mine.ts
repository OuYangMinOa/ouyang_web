// 自己的米其林：想吃／吃過和訂位提醒（後端 backend/src/michelin.rs），登入才有。
// 地圖頁和「我的足跡」頁各自載入一次；改動先畫上去，伺服器回錯誤再改回來。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../api'
import { useAuth } from '../auth'

export type MarkStatus = 'want' | 'been'
export type Mark = { restaurant: string; status: MarkStatus; visited_on: string | null; updated_at: string }
export type Reminder = { id: number; restaurant: string; remind_at: string; note: string; sent_at: string | null }

/** 某個帳號載入的資料；換帳號或登出時直接不用，不必清掉 */
type Loaded = { user: number; marks: Map<string, Mark>; reminders: Reminder[]; error: string | null }

const NO_MARKS: ReadonlyMap<string, Mark> = new Map()
const NO_REMINDERS: Reminder[] = []
const markUrl = (id: string) => `/michelin/marks/${encodeURIComponent(id)}`

export function useMine() {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [data, setData] = useState<Loaded | null>(null)
  const current = userId !== null && data?.user === userId ? data : null
  const marks: ReadonlyMap<string, Mark> = current?.marks ?? NO_MARKS
  // 改動失敗時要改回去的「改之前」，從這裡拿最新的
  const marksRef = useRef(marks)
  useEffect(() => {
    marksRef.current = marks
  }, [marks])

  useEffect(() => {
    if (userId === null) return
    let alive = true
    Promise.all([api<{ marks: Mark[] }>('/michelin/marks'), api<{ reminders: Reminder[] }>('/michelin/reminders')])
      .then(([m, r]) => {
        if (!alive) return
        setData({ user: userId, marks: new Map(m.marks.map((mark) => [mark.restaurant, mark])), reminders: r.reminders, error: null })
      })
      .catch((e) => {
        if (alive) setData({ user: userId, marks: new Map(), reminders: [], error: errorMessage(e) })
      })
    return () => {
      alive = false
    }
  }, [userId])

  /** 只改目前帳號那份 */
  const update = useCallback(
    (change: (prev: Loaded) => Loaded) => setData((prev) => (prev && prev.user === userId ? change(prev) : prev)),
    [userId],
  )

  /** 設成想吃／吃過；status 是 null 就取消。visitedOn 只有吃過才有 */
  const setMark = useCallback(
    async (id: string, status: MarkStatus | null, visitedOn: string | null = null) => {
      const before = marksRef.current.get(id)
      const put = (mark: Mark | undefined) =>
        update((prev) => {
          const next = new Map(prev.marks)
          if (mark) next.set(id, mark)
          else next.delete(id)
          return { ...prev, marks: next }
        })
      const date = status === 'been' ? visitedOn : null
      put(status ? { restaurant: id, status, visited_on: date, updated_at: new Date().toISOString() } : undefined)
      try {
        if (status) {
          await api(markUrl(id), { method: 'PUT', body: JSON.stringify({ status, visited_on: date }) })
        } else {
          await api(markUrl(id), { method: 'DELETE' })
        }
      } catch (e) {
        put(before)
        throw e
      }
    },
    [update],
  )

  const addReminder = useCallback(
    async (restaurant: string, remindAt: Date, note: string) => {
      const created = await api<Reminder>('/michelin/reminders', {
        method: 'POST',
        body: JSON.stringify({ restaurant, remind_at: remindAt.toISOString(), note }),
      })
      update((prev) => ({
        ...prev,
        reminders: [...prev.reminders, created].sort((a, b) => a.remind_at.localeCompare(b.remind_at) || a.id - b.id),
      }))
      return created
    },
    [update],
  )

  const removeReminder = useCallback(
    async (id: number) => {
      await api(`/michelin/reminders/${id}`, { method: 'DELETE' })
      update((prev) => ({ ...prev, reminders: prev.reminders.filter((r) => r.id !== id) }))
    },
    [update],
  )

  return {
    loggedIn: userId !== null,
    /** 登入了、資料還沒回來時是 false */
    loaded: userId === null || current !== null,
    error: current?.error ?? null,
    marks,
    setMark,
    reminders: current?.reminders ?? NO_REMINDERS,
    addReminder,
    removeReminder,
  }
}

export type Mine = ReturnType<typeof useMine>

/** 12/1（一）12:00；不是今年的加上年份 */
export function formatWhen(iso: string) {
  const d = new Date(iso)
  const week = '日一二三四五六'[d.getDay()]
  const time = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}/`
  return `${year}${d.getMonth() + 1}/${d.getDate()}（${week}）${time}`
}
