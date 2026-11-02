import { useEffect, useState } from 'react'
import BigTime, { Progress } from './BigTime'
import {
  formatCountdown,
  isFresh,
  isRun,
  load,
  newRun,
  now,
  pauseRun,
  remaining,
  save,
  startRun,
  useAlarm,
  useNow,
  type Run,
} from './clock'
import type { TimerProps } from './types'

const PRESETS = [1, 3, 5, 10]
const MAX_MINUTES = 24 * 60

function durationText(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s} 秒`
  return s ? `${m} 分 ${s} 秒` : `${m} 分鐘`
}

export default function Countdown({ prepare, alarm, onTitle }: TimerProps) {
  const [run, setRunState] = useState<Run>(() => load('countdown', newRun(5 * 60_000), isRun))
  const [minText, setMinText] = useState(() => String(Math.floor(run.duration / 60_000)))
  const [secText, setSecText] = useState(() => String(Math.round((run.duration % 60_000) / 1000)))
  const [done, setDone] = useState(false)
  const running = run.endAt !== null
  const t = useNow(running)
  const left = remaining(run, t)

  function setRun(r: Run) {
    setRunState(r)
    save('countdown', r)
  }

  useAlarm(run.endAt, () => {
    setRun({ ...run, endAt: null, left: 0 })
    setDone(true)
    alarm('end', '⏰ 倒數結束', `${durationText(run.duration)}到了`)
  })

  useEffect(() => {
    onTitle(running ? `⏳ ${formatCountdown(left)}` : done ? '⏰ 時間到' : null)
  }, [running, left, done, onTitle])

  function begin(duration: number) {
    prepare()
    setDone(false)
    setMinText(String(Math.floor(duration / 60_000)))
    setSecText(String(Math.round((duration % 60_000) / 1000)))
    setRun(startRun(newRun(duration), now()))
  }

  /** 從輸入框算出的長度；不合理就是 0 */
  function typedDuration(m = minText, s = secText): number {
    const min = Math.min(MAX_MINUTES, Math.max(0, Math.floor(Number(m) || 0)))
    const sec = Math.min(59, Math.max(0, Math.floor(Number(s) || 0)))
    return (min * 60 + sec) * 1000
  }

  function editTime(m: string, s: string) {
    setMinText(m)
    setSecText(s)
    setDone(false)
    // 還沒開始的話直接換成新的長度
    if (!running) setRun(newRun(typedDuration(m, s)))
  }

  function toggle() {
    if (running) {
      setRun(pauseRun(run, now()))
      return
    }
    prepare()
    setDone(false)
    // 倒數完了再按開始：用原本的長度重來
    if (run.left <= 0) setRun(startRun(newRun(run.duration), now()))
    else setRun(startRun(run, now()))
  }

  function reset() {
    setDone(false)
    setRun(newRun(run.duration))
  }

  function addMinute() {
    setDone(false)
    const extra = 60_000
    if (running) setRun({ ...run, duration: run.duration + extra, endAt: run.endAt! + extra })
    else setRun({ ...run, duration: run.duration + (run.left <= 0 ? 0 : extra), left: run.left + extra })
  }

  const fresh = isFresh(run)

  return (
    <div className="tm-panel">
      <div className="tm-presets" role="group" aria-label="快速倒數">
        {PRESETS.map((m) => (
          <button key={m} type="button" className="secondary" onClick={() => begin(m * 60_000)}>
            {m} 分
          </button>
        ))}
      </div>

      <BigTime
        text={formatCountdown(left)}
        sub={done ? '⏰ 時間到！' : running ? '倒數中' : fresh ? '按開始倒數' : left > 0 ? '已暫停' : ''}
        className={done ? 'ringing' : ''}
      />
      <Progress value={run.duration ? left / run.duration : 0} />

      <div className="tm-actions">
        <button type="button" onClick={toggle} disabled={!running && run.duration <= 0}>
          {running ? '暫停' : fresh || left <= 0 ? '開始' : '繼續'}
        </button>
        {(!fresh || done) && (
          <button type="button" className="secondary" onClick={reset}>
            重設
          </button>
        )}
        {!fresh && (
          <button type="button" className="secondary" onClick={addMinute}>
            +1 分
          </button>
        )}
      </div>

      <fieldset className="tm-fields" disabled={running}>
        <legend>自訂時間</legend>
        <label>
          分
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_MINUTES}
            value={minText}
            onChange={(e) => editTime(e.target.value, secText)}
          />
        </label>
        <label>
          秒
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            value={secText}
            onChange={(e) => editTime(minText, e.target.value)}
          />
        </label>
      </fieldset>
    </div>
  )
}
