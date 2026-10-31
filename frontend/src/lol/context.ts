import { createContext, useContext } from 'react'
import type { LiveEvent, Match, Stage, Tournament } from './api'

export type LolData = {
  tournament: Tournament | null
  /** 這屆的所有比賽，照時間排；還在載入是 null */
  matches: Match[] | null
  stages: Stage[]
  /** 正在進行的比賽 */
  live: LiveEvent[]
  error: string
  /** 上次成功更新的時間 */
  updatedAt: number | null
}

export const LolContext = createContext<LolData | null>(null)

/** 賽程在 LolApp 裡抓一次、定時更新，切換頁面不用重抓 */
export function useLol(): LolData {
  const data = useContext(LolContext)
  if (!data) throw new Error('useLol 要在 <LolApp> 裡面用')
  return data
}
