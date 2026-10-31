import { useState } from 'react'
import { Outlet } from 'react-router'
import { errorMessage } from '../api'
import { getCurrentTournament, getLive, getSchedule, getStages, type LiveEvent, type Match, type Stage, type Tournament } from './api'
import { LolContext, type LolData } from './context'
import { isAbort, usePolling } from './util'
import './lol.css'

// API 前面有一分鐘的 CDN 快取，抓更勤也拿不到更新的資料
const SCHEDULE_INTERVAL = 60_000
const LIVE_INTERVAL = 30_000

/** LoL 世界賽 APP 的外框：抓這屆的賽程、階段和直播狀態，各頁面用 useLol() 讀 */
export default function LolApp() {
  const [tournament, setTournament] = useState<Tournament | null>(null)
  const [matches, setMatches] = useState<Match[] | null>(null)
  const [stages, setStages] = useState<Stage[]>([])
  const [live, setLive] = useState<LiveEvent[]>([])
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  usePolling(
    async (signal) => {
      try {
        const current = tournament ?? (await getCurrentTournament(signal))
        if (!current) {
          setMatches([])
          setError('找不到世界賽的資料')
          return
        }
        setTournament(current)
        const [schedule, stageList] = await Promise.all([
          getSchedule(current, signal),
          // 階段只用來分類，抓不到也不影響賽程
          getStages(current.id, signal).catch((e: unknown) => {
            if (isAbort(e)) throw e
            return null
          }),
        ])
        if (stageList) setStages(stageList)
        // 有階段資料時用它篩出這屆的比賽，比日期範圍準
        const ids = new Set(stageList?.flatMap((s) => s.matchIds))
        setMatches(ids.size > 0 ? schedule.filter((m) => ids.has(m.id)) : schedule)
        setError('')
        setUpdatedAt(Date.now())
      } catch (e) {
        if (!isAbort(e)) setError(errorMessage(e))
      }
    },
    SCHEDULE_INTERVAL,
    'schedule',
  )

  usePolling(
    async (signal) => {
      try {
        setLive(await getLive(signal))
      } catch (e) {
        // 直播狀態抓不到就維持上一次的，賽程那邊會顯示錯誤
        if (isAbort(e)) throw e
      }
    },
    LIVE_INTERVAL,
    'live',
  )

  // 賽程有一分鐘快取，比分和狀態以直播資料為準
  const liveById = new Map(live.map((e) => [e.match.id, e.match]))
  const merged = matches?.map((m) => {
    const now = liveById.get(m.id)
    if (!now) return m
    return { ...m, state: now.state, teams: now.teams.every((t) => t.result) ? now.teams : m.teams }
  })
  const data: LolData = { tournament, matches: merged ?? null, stages, live, error, updatedAt }

  return (
    <LolContext.Provider value={data}>
      <div className="lol">
        <Outlet />
      </div>
    </LolContext.Provider>
  )
}
