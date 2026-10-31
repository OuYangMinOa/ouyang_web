import { useEffect, useRef, useState } from 'react'
import type { Match, Stage, Team } from './api'

/**
 * 每隔 interval 執行一次 load；分頁在背景時暫停，回到前景馬上補一次。
 * key 變了就取消進行中的請求、重新開始；interval 是 null 時只執行一次。
 */
export function usePolling(load: (signal: AbortSignal) => Promise<void>, interval: number | null, key: string) {
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    let controller = new AbortController()
    let timer: number | undefined
    let stopped = false

    async function tick() {
      window.clearTimeout(timer)
      controller.abort()
      controller = new AbortController()
      try {
        await loadRef.current(controller.signal)
      } catch {
        // 錯誤由 load 自己處理；這裡只會收到取消
      }
      if (!stopped && interval !== null && document.visibilityState === 'visible') {
        timer = window.setTimeout(tick, interval)
      }
    }

    function onVisible() {
      if (document.visibilityState === 'visible') tick()
    }

    tick()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      controller.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [interval, key])
}

/** 每秒更新一次的現在時間，倒數用 */
export function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(timer)
  }, [interval])
  return now
}

export function isAbort(e: unknown) {
  return e instanceof DOMException && e.name === 'AbortError'
}

/* ---- 時間：一律用瀏覽器的時區 ---- */

const WEEKDAYS = '日一二三四五六'

/** 本地日期的 YYYY-MM-DD，分組用 */
export function dayKey(iso: string | number) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 10/31（六） */
export function formatDay(iso: string | number) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`
}

/** 05:00 */
export function formatClock(iso: string | number) {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 今天、明天、昨天；其他日子是 null */
export function dayWord(iso: string | number) {
  const key = dayKey(iso)
  const now = Date.now()
  if (key === dayKey(now)) return '今天'
  if (key === dayKey(now + 86_400_000)) return '明天'
  if (key === dayKey(now - 86_400_000)) return '昨天'
  return null
}

/** 今天、明天、昨天，其他日子照常顯示日期 */
export function relativeDay(iso: string | number) {
  return dayWord(iso) ?? formatDay(iso)
}

/** 倒數：「2 天 3 小時」「3:05:09」 */
export function formatCountdown(ms: number) {
  if (ms <= 0) return '即將開始'
  const s = Math.floor(ms / 1000)
  const days = Math.floor(s / 86_400)
  const hours = Math.floor((s % 86_400) / 3600)
  if (days > 0) return `${days} 天 ${hours} 小時`
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** 比賽時間 mm:ss */
export function formatGameTime(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatGold(gold: number) {
  return `${(gold / 1000).toFixed(1)}k`
}

/* ---- 比賽 ---- */

export const isTbd = (team: Team) => team.code === 'TBD' || team.name === 'TBD'

export function winner(match: Match): Team | undefined {
  return match.teams.find((t) => t.result?.outcome === 'win')
}

/** 這場在哪個階段（standings 的 slug），找不到就用 blockName */
export function stageOf(match: Match, stages: Stage[]) {
  return stages.find((s) => s.matchIds.includes(match.id))?.slug ?? match.blockName
}

/* ---- 瑞士輪戰績 ---- */

/** 瑞士輪三勝晉級、三敗淘汰 */
export const SWISS_TARGET = 3

export type SwissRow = {
  team: Team
  wins: number
  losses: number
  /** 依時間排的每一場：對手、勝負、比賽 id */
  history: { opponent: Team; won: boolean; matchId: string }[]
  status: 'qualified' | 'eliminated' | 'playing'
}

/** 從已結束的瑞士輪比賽算出每隊戰績；已排定對手但還沒打的隊伍也列進來（0-0） */
export function swissTable(matches: Match[]): SwissRow[] {
  const rows = new Map<string, SwissRow>()
  const row = (team: Team) => {
    let r = rows.get(team.code)
    if (!r) {
      r = { team, wins: 0, losses: 0, history: [], status: 'playing' }
      rows.set(team.code, r)
    }
    return r
  }

  for (const m of matches) {
    if (m.teams.length !== 2 || m.teams.some(isTbd)) continue
    const [a, b] = m.teams
    row(a)
    row(b)
    const win = winner(m)
    if (m.state !== 'completed' || !win) continue
    for (const [team, opponent] of [
      [a, b],
      [b, a],
    ]) {
      const r = row(team)
      const won = team.code === win.code
      if (won) r.wins++
      else r.losses++
      r.history.push({ opponent, won, matchId: m.id })
    }
  }

  for (const r of rows.values()) {
    if (r.wins >= SWISS_TARGET) r.status = 'qualified'
    else if (r.losses >= SWISS_TARGET) r.status = 'eliminated'
  }
  return [...rows.values()].sort(
    (x, y) => y.wins - x.wins || x.losses - y.losses || x.team.code.localeCompare(y.team.code),
  )
}
