import { useEffect, useRef, useState } from 'react'
import { MatchRow } from './components'
import { useLol } from './context'
import { dayKey, dayWord, formatDay, stageOf } from './util'
import type { Match } from './api'

const ALL = 'all'

/** 賽程：依日期分組，可以只看某個階段；第一次載入時捲到今天（或下一個比賽日） */
export default function Schedule() {
  const { matches, stages, error } = useLol()
  const [stage, setStage] = useState(ALL)
  const [today] = useState(() => dayKey(Date.now()))
  const todayRef = useRef<HTMLElement>(null)
  const scrolled = useRef(false)

  const shown = (matches ?? []).filter((m) => stage === ALL || stageOf(m, stages) === stage)
  const days = new Map<string, Match[]>()
  for (const m of shown) {
    const key = dayKey(m.startTime)
    days.set(key, [...(days.get(key) ?? []), m])
  }
  const focusDay = [...days.keys()].find((k) => k >= today)

  useEffect(() => {
    if (scrolled.current || !todayRef.current) return
    scrolled.current = true
    todayRef.current.scrollIntoView({ block: 'start' })
  }, [focusDay])

  // 篩選只列有比賽的階段
  const stageOptions = stages.filter((s) => (matches ?? []).some((m) => s.matchIds.includes(m.id)))

  return (
    <>
      <div className="lol-head">
        <h1>賽程</h1>
        {matches && <span className="muted">{matches.length} 場 · 時間為你裝置的時區</span>}
      </div>

      {stageOptions.length > 1 && (
        <div className="lol-filter" role="group" aria-label="階段">
          {[{ slug: ALL, name: '全部' }, ...stageOptions].map((s) => (
            <button
              key={s.slug}
              type="button"
              className={stage === s.slug ? '' : 'secondary'}
              aria-pressed={stage === s.slug}
              onClick={() => setStage(s.slug)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {error && <p className="error">{matches ? `更新失敗：${error}` : `載入失敗：${error}`}</p>}
      {!matches && !error && <p className="muted lol-empty">載入中…</p>}
      {matches && shown.length === 0 && <p className="muted lol-empty">沒有比賽。</p>}

      {[...days].map(([key, list]) => (
        <section
          key={key}
          className={`lol-day ${key === today ? 'today' : ''}`}
          ref={key === focusDay ? todayRef : undefined}
        >
          <h2>
            {formatDay(list[0].startTime)}
            {dayWord(list[0].startTime) && <span className="chip subtle">{dayWord(list[0].startTime)}</span>}
            <span className="lol-day-stage muted">{[...new Set(list.map((m) => m.blockName))].join('、')}</span>
          </h2>
          <div className="lol-list">
            {list.map((m) => (
              <MatchRow key={m.id} match={m} />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
