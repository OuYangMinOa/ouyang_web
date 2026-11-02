import { useEffect, useState } from 'react'
import BigTime from './BigTime'
import { formatCountdown, formatStopwatch, load, now, save, useNow } from './clock'
import type { TimerProps } from './types'

type Watch = {
  /** 正在跑：這一段從什麼時候開始；暫停：null */
  startAt: number | null
  /** 之前幾段累積的毫秒 */
  acc: number
  /** 每次按分圈時的總時間 */
  laps: number[]
}

const EMPTY: Watch = { startAt: null, acc: 0, laps: [] }
const MAX_LAPS = 999

const isWatch = (v: unknown) => {
  const w = v as Watch
  return !!w && typeof w.acc === 'number' && (w.startAt === null || typeof w.startAt === 'number') && Array.isArray(w.laps)
}

export default function Stopwatch({ onTitle }: Pick<TimerProps, 'onTitle'>) {
  const [watch, setWatchState] = useState<Watch>(() => load('stopwatch', EMPTY, isWatch))
  const running = watch.startAt !== null
  // 百分之一秒在跳，畫面更新快一點
  const t = useNow(running, 33)
  const elapsed = watch.acc + (watch.startAt === null ? 0 : Math.max(0, t - watch.startAt))
  const seconds = Math.floor(elapsed / 1000)

  function setWatch(w: Watch) {
    setWatchState(w)
    save('stopwatch', w)
  }

  useEffect(() => {
    // 標題只到秒，不要每 33ms 改一次
    onTitle(running ? `⏱ ${formatCountdown(seconds * 1000)}` : null)
  }, [running, seconds, onTitle])

  function toggle() {
    const at = now()
    if (watch.startAt === null) setWatch({ ...watch, startAt: at })
    else setWatch({ ...watch, startAt: null, acc: watch.acc + (at - watch.startAt) })
  }

  function lap() {
    if (watch.startAt === null || watch.laps.length >= MAX_LAPS) return
    setWatch({ ...watch, laps: [...watch.laps, watch.acc + (now() - watch.startAt)] })
  }

  const lapTimes = watch.laps.map((total, i) => total - (i > 0 ? watch.laps[i - 1] : 0))
  // 兩圈以上才標最快、最慢
  const fastest = lapTimes.length >= 2 ? Math.min(...lapTimes) : -1
  const slowest = lapTimes.length >= 2 ? Math.max(...lapTimes) : -1
  const lastLap = watch.laps.at(-1) ?? 0
  const started = running || elapsed > 0

  return (
    <div className="tm-panel">
      <BigTime text={formatStopwatch(elapsed)} sub={running ? '計時中' : started ? '已暫停' : '按開始計時'} />

      <div className="tm-actions">
        <button type="button" onClick={toggle}>
          {running ? '暫停' : started ? '繼續' : '開始'}
        </button>
        {running ? (
          <button type="button" className="secondary" onClick={lap}>
            分圈
          </button>
        ) : (
          started && (
            <button type="button" className="secondary" onClick={() => setWatch(EMPTY)}>
              重設
            </button>
          )
        )}
      </div>

      {watch.laps.length > 0 && (
        <ol className="tm-laps">
          {started && (
            <li className="current">
              <span className="tm-lap-no">第 {watch.laps.length + 1} 圈</span>
              <span className="tm-lap-time">{formatStopwatch(elapsed - lastLap)}</span>
              <span className="tm-lap-total">{formatStopwatch(elapsed)}</span>
            </li>
          )}
          {lapTimes
            .map((ms, i) => (
              <li key={i} className={ms === fastest ? 'fast' : ms === slowest ? 'slow' : ''}>
                <span className="tm-lap-no">
                  第 {i + 1} 圈{ms === fastest ? '・最快' : ms === slowest ? '・最慢' : ''}
                </span>
                <span className="tm-lap-time">{formatStopwatch(ms)}</span>
                <span className="tm-lap-total">{formatStopwatch(watch.laps[i])}</span>
              </li>
            ))
            .reverse()}
        </ol>
      )}
    </div>
  )
}
