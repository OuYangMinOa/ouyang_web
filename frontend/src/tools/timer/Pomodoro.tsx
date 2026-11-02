import { useEffect, useState } from 'react'
import BigTime, { Progress } from './BigTime'
import { formatCountdown, isFresh, isRun, load, newRun, now, pauseRun, remaining, save, startRun, useAlarm, useNow, type Run } from './clock'
import type { TimerProps } from './types'

type Phase = 'work' | 'short' | 'long'

type Settings = {
  /** 分鐘 */
  work: number
  short: number
  long: number
  /** 幾輪工作之後長休息，長休息結束就完成一組 */
  rounds: number
  /** 一段結束後自動開始下一段 */
  auto: boolean
}

type State = { phase: Phase; round: number; run: Run }

const DEFAULTS: Settings = { work: 25, short: 5, long: 15, rounds: 4, auto: true }

const PHASES: Record<Phase, { label: string; icon: string }> = {
  work: { label: '專注', icon: '🍅' },
  short: { label: '短休息', icon: '☕' },
  long: { label: '長休息', icon: '🛋️' },
}

const LIMITS: Record<keyof Omit<Settings, 'auto'>, [number, number]> = {
  work: [1, 180],
  short: [1, 60],
  long: [1, 120],
  rounds: [1, 12],
}

const isSettings = (v: unknown) => {
  const s = v as Settings
  return (
    !!s &&
    typeof s.auto === 'boolean' &&
    (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).every(
      (k) => Number.isInteger(s[k]) && s[k] >= LIMITS[k][0] && s[k] <= LIMITS[k][1],
    )
  )
}
const isState = (v: unknown) => {
  const s = v as State
  return !!s && s.phase in PHASES && Number.isInteger(s.round) && s.round >= 1 && isRun(s.run)
}

const minutes = (settings: Settings, phase: Phase) => settings[phase] * 60_000

function initial(settings: Settings): State {
  return { phase: 'work', round: 1, run: newRun(minutes(settings, 'work')) }
}

/** 下一段：工作 → 短休息（最後一輪是長休息）→ 工作…；長休息之後是 null（完成一組） */
function nextPhase(phase: Phase, round: number, rounds: number): { phase: Phase; round: number } | null {
  if (phase === 'work') return { phase: round >= rounds ? 'long' : 'short', round }
  if (phase === 'short') return { phase: 'work', round: round + 1 }
  return null
}

export default function Pomodoro({ prepare, alarm, onTitle }: TimerProps) {
  const [settings, setSettingsState] = useState<Settings>(() => load('pomodoro:settings', DEFAULTS, isSettings))
  const [state, setStateRaw] = useState<State>(() => load('pomodoro:state', initial(settings), isState))
  const [texts, setTexts] = useState(() => ({
    work: String(settings.work),
    short: String(settings.short),
    long: String(settings.long),
    rounds: String(settings.rounds),
  }))
  const [finished, setFinished] = useState(false)
  const { phase, round, run } = state
  const running = run.endAt !== null
  const t = useNow(running)
  const left = remaining(run, t)

  function setState(s: State) {
    setStateRaw(s)
    save('pomodoro:state', s)
  }

  function setSettings(s: Settings) {
    setSettingsState(s)
    save('pomodoro:settings', s)
    // 這一段還沒開始的話，套用新的長度
    if (isFresh(run)) setState({ ...state, round: Math.min(round, s.rounds), run: newRun(minutes(s, phase)) })
  }

  /** 進到下一段；auto 時接著上一段的結束時間開始，不會因為晚處理而少算 */
  function advance(from: State, startAt: number | null): State | null {
    const next = nextPhase(from.phase, from.round, settings.rounds)
    if (!next) return null
    const run = newRun(minutes(settings, next.phase))
    return { ...next, run: startAt === null ? run : startRun(run, startAt) }
  }

  useAlarm(run.endAt, (endAt) => {
    let current = state
    let at = endAt
    let ended = current.phase
    let next = advance(current, settings.auto ? at : null)
    // 電腦睡著等原因錯過好幾段：一路往後推到現在這一段
    while (next && settings.auto && next.run.endAt !== null && next.run.endAt <= now()) {
      current = next
      ended = current.phase
      at = next.run.endAt
      next = advance(current, at)
    }
    if (!next) {
      setState(initial(settings))
      setFinished(true)
      alarm('break', '🎉 完成一組番茄鐘', `${settings.rounds} 輪專注都完成了，辛苦了！`)
      return
    }
    setFinished(false)
    setState(next)
    if (ended === 'work') {
      alarm('end', `${PHASES[next.phase].icon} 專注時間結束`, `休息 ${settings[next.phase]} 分鐘吧`)
    } else {
      alarm('break', '🍅 休息結束', `第 ${next.round} 輪專注，${settings.work} 分鐘`)
    }
  })

  useEffect(() => {
    onTitle(running ? `${PHASES[phase].icon} ${formatCountdown(left)} ${PHASES[phase].label}` : null)
  }, [running, left, phase, onTitle])

  function toggle() {
    if (running) {
      setState({ ...state, run: pauseRun(run, now()) })
      return
    }
    prepare()
    setFinished(false)
    setState({ ...state, run: startRun(run, now()) })
  }

  function skip() {
    const next = advance(state, running ? now() : null)
    if (next) setState(next)
    else setState(initial(settings))
  }

  function reset() {
    setFinished(false)
    setState(initial(settings))
  }

  function editNumber(key: keyof typeof LIMITS, value: string) {
    setTexts((x) => ({ ...x, [key]: value }))
    const n = Number(value)
    const [lo, hi] = LIMITS[key]
    if (Number.isInteger(n) && n >= lo && n <= hi) setSettings({ ...settings, [key]: n })
  }

  const fresh = isFresh(run)
  const isBreak = phase !== 'work'

  return (
    <div className={`tm-panel tm-pomo ${isBreak ? 'break' : 'work'}`}>
      <div className="tm-phase">
        <span className="tm-phase-name">
          <span aria-hidden="true">{PHASES[phase].icon}</span> {PHASES[phase].label}
        </span>
        <span className="tm-rounds" aria-label={`第 ${round} 輪，共 ${settings.rounds} 輪`}>
          {Array.from({ length: settings.rounds }, (_, i) => (
            <span
              key={i}
              className={i + 1 < round || (i + 1 === round && isBreak) ? 'done' : i + 1 === round ? 'now' : ''}
            />
          ))}
          <span className="tm-round-text">
            第 {Math.min(round, settings.rounds)}/{settings.rounds} 輪
          </span>
        </span>
      </div>

      <BigTime
        text={formatCountdown(left)}
        sub={finished ? '🎉 完成一組！' : running ? (isBreak ? '休息中' : '專注中') : fresh ? '按開始' : '已暫停'}
      />
      <Progress value={run.duration ? 1 - left / run.duration : 0} />

      <div className="tm-actions">
        <button type="button" onClick={toggle}>
          {running ? '暫停' : fresh ? '開始' : '繼續'}
        </button>
        <button type="button" className="secondary" onClick={skip}>
          跳過
        </button>
        {(!fresh || round > 1 || phase !== 'work') && (
          <button type="button" className="secondary" onClick={reset}>
            重設
          </button>
        )}
      </div>

      <fieldset className="tm-fields tm-settings">
        <legend>設定</legend>
        {(
          [
            ['work', '專注（分）'],
            ['short', '短休息（分）'],
            ['long', '長休息（分）'],
            ['rounds', '輪數'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              inputMode="numeric"
              min={LIMITS[key][0]}
              max={LIMITS[key][1]}
              value={texts[key]}
              onChange={(e) => editNumber(key, e.target.value)}
              onBlur={() => setTexts((x) => ({ ...x, [key]: String(settings[key]) }))}
            />
          </label>
        ))}
        <label className="tm-check">
          <input type="checkbox" checked={settings.auto} onChange={(e) => setSettings({ ...settings, auto: e.target.checked })} />
          <span>
            自動開始下一段
            <span className="muted">關掉的話，每段結束後要自己按開始</span>
          </span>
        </label>
      </fieldset>
      <p className="muted">
        {settings.rounds} 輪專注之間是短休息，最後一輪後長休息，長休息結束就完成一組。改設定會從下一段開始套用。
      </p>
    </div>
  )
}
