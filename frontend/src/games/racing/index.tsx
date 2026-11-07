import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { useNavigate } from 'react-router'
import { load, save } from '../shared/storage'
import { Segmented } from '../shared/ui'
import type { Difficulty } from './ai'
import {
  CAMERA_NAMES,
  CAR_COLORS,
  RaceGame,
  type FinishResult,
  type Hint,
  type HudFrame,
  type MiniMap,
  type Phase,
  type RaceEvent,
  type RacerInfo,
  type Standing,
} from './game'
import type { TouchState } from './input'
import { findTrack, TRACKS } from './tracks'
import './racing.css'

type Settings = {
  track: string
  laps: number
  opponents: number
  difficulty: Difficulty
  color: number
  autoGas: boolean
  fullscreen: boolean
  camera: number
}

/** 每條賽道自己的最快圈，以及各圈數的最快完賽時間（毫秒） */
type Records = Record<string, { lap?: number; race?: Record<string, number> }>

type Result = FinishResult & { newLap: boolean; newRace: boolean }

const LAPS = [1, 3, 5]
const OPPONENTS = [
  { value: 0, label: '計時賽' },
  { value: 3, label: '3 台' },
  { value: 5, label: '5 台' },
  { value: 7, label: '7 台' },
]
const DIFFICULTIES: { value: Difficulty; label: string }[] = [
  { value: 'easy', label: '簡單' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困難' },
]

const isCoarse = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
const canFullscreen = () => typeof document !== 'undefined' && document.fullscreenEnabled === true

function loadSettings(): Settings {
  const raw = load<Partial<Settings>>('racing:settings', {})
  return {
    track: TRACKS.some((t) => t.id === raw.track) ? raw.track! : TRACKS[0].id,
    laps: LAPS.includes(raw.laps as number) ? raw.laps! : 3,
    opponents: OPPONENTS.some((o) => o.value === raw.opponents) ? raw.opponents! : 5,
    difficulty: DIFFICULTIES.some((d) => d.value === raw.difficulty) ? raw.difficulty! : 'normal',
    color: CAR_COLORS.some((c) => c.hex === raw.color) ? raw.color! : CAR_COLORS[0].hex,
    autoGas: typeof raw.autoGas === 'boolean' ? raw.autoGas : isCoarse(),
    fullscreen: typeof raw.fullscreen === 'boolean' ? raw.fullscreen : true,
    camera: typeof raw.camera === 'number' ? raw.camera : 0,
  }
}

/** 1:23.45 */
function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–:––.––'
  const cs = Math.floor(ms / 10)
  const m = Math.floor(cs / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

const hexColor = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

export default function Racing() {
  const navigate = useNavigate()
  const rootRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<RaceGame | null>(null)
  const [settings, setSettings] = useState(loadSettings)
  const [screen, setScreen] = useState<'menu' | 'race'>('menu')
  const [phase, setPhase] = useState<Phase>('preview')
  const [paused, setPaused] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [status, setStatus] = useState({ position: 1, total: 1, lap: 1, laps: 1 })
  const [bestLap, setBestLap] = useState<number | null>(null)
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  const [hint, setHint] = useState<Hint>(null)
  const [map, setMap] = useState<MiniMap | null>(null)
  const [racers, setRacers] = useState<RacerInfo[]>([])
  const [result, setResult] = useState<Result | null>(null)
  const [standings, setStandings] = useState<Standing[] | null>(null)
  const [records, setRecords] = useState<Records>(() => load('racing:records', {}))
  const [sound, setSound] = useState(() => load('racing:sound', true))
  const [touch, setTouch] = useState(isCoarse)
  const [fullscreen, setFullscreen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 每個畫面更新的東西直接改 DOM，不經過 React
  const speedRef = useRef<HTMLSpanElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const lapTimeRef = useRef<HTMLSpanElement>(null)
  const driftRef = useRef<HTMLDivElement>(null)
  const dotRefs = useRef<(SVGCircleElement | null)[]>([])
  const statusRef = useRef(status)
  const live = useRef({ screen, phase, paused })
  live.current = { screen, phase, paused }
  const recordsRef = useRef(records)
  recordsRef.current = records
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const sendTouch = useCallback((patch: Partial<TouchState>) => gameRef.current?.setTouch(patch), [])

  function update(patch: Partial<Settings>) {
    setSettings((s) => {
      const next = { ...s, ...patch }
      save('racing:settings', next)
      return next
    })
  }

  // 建立遊戲：整個頁面只有一個 WebGL 畫面，換賽道、重新開始都沿用；之後的設定變化各自呼叫 game 的方法。
  // 用 ref callback（React 19 可以回傳清除函式）而不是 effect：放畫面的 div 一掛上就建立，比其他 effect 早
  const mountGame = useCallback((host: HTMLDivElement | null) => {
    if (!host) return
    let toastId = 0
    const showToast = (text: string) => setToast({ text, id: ++toastId })

    const onEvent = (e: RaceEvent) => {
      switch (e.type) {
        case 'map':
          setMap(e.map)
          break
        case 'racers':
          setRacers(e.racers)
          break
        case 'phase':
          setPhase(e.phase)
          break
        case 'countdown':
          setCountdown(e.n)
          if (e.n === 0) window.setTimeout(() => setCountdown((n) => (n === 0 ? null : n)), 900)
          break
        case 'lap':
          setBestLap((b) => (b === null || e.ms < b ? e.ms : b))
          showToast(
            e.final
              ? `最後一圈！${e.best ? '　最快圈 ' : '　'}${formatMs(e.ms)}`
              : `第 ${e.lap} 圈 ${formatMs(e.ms)}${e.best ? '　最快圈！' : ''}`,
          )
          break
        case 'hint':
          setHint(e.hint)
          break
        case 'finish': {
          const r = e.result
          const prev = recordsRef.current[r.track] ?? {}
          const prevRace = prev.race?.[String(r.laps)]
          const newLap = prev.lap === undefined || r.bestLap < prev.lap
          const newRace = prevRace === undefined || r.time < prevRace
          if (newLap || newRace) {
            const next: Records = {
              ...recordsRef.current,
              [r.track]: {
                lap: newLap ? r.bestLap : prev.lap,
                race: { ...prev.race, [String(r.laps)]: newRace ? r.time : prevRace! },
              },
            }
            save('racing:records', next)
            setRecords(next)
          }
          setBestLap(r.bestLap)
          setResult({ ...r, newLap, newRace })
          setStandings(r.standings)
          setHint(null)
          break
        }
        case 'standings':
          setStandings(e.standings)
          break
        case 'pad':
          if (e.action === 'pause') setPause(true)
          else if (e.action === 'camera') cycleCamera()
          break
      }
    }

    const onFrame = (f: HudFrame) => {
      if (speedRef.current) speedRef.current.textContent = String(Math.round(f.speedKmh))
      if (timeRef.current) timeRef.current.textContent = formatMs(f.raceMs)
      if (lapTimeRef.current) lapTimeRef.current.textContent = formatMs(f.lapMs)
      if (driftRef.current) {
        driftRef.current.dataset.level = String(f.drift)
        driftRef.current.dataset.boost = String(f.boost)
      }
      const s = statusRef.current
      if (s.position !== f.position || s.total !== f.total || s.lap !== f.lap || s.laps !== f.laps) {
        const next = { position: f.position, total: f.total, lap: f.lap, laps: f.laps }
        statusRef.current = next
        setStatus(next)
      }
      for (let i = 0; i < dotRefs.current.length; i++) {
        const dot = dotRefs.current[i]
        if (!dot) continue
        dot.setAttribute('cx', f.cars[i * 2].toFixed(1))
        dot.setAttribute('cy', f.cars[i * 2 + 1].toFixed(1))
      }
    }

    let game: RaceGame
    try {
      game = new RaceGame(host, onEvent, onFrame, load('racing:sound', true))
    } catch {
      setError('這個瀏覽器沒辦法顯示 3D 畫面（WebGL 沒有開啟或不支援），換個瀏覽器或更新顯示卡驅動程式再試試。')
      return
    }
    gameRef.current = game
    const s = settingsRef.current
    game.setAutoGas(s.autoGas)
    game.setCamera(s.camera)
    return () => {
      game.dispose()
      gameRef.current = null
    }
  }, [])

  // 選單的背景是電腦在跑選好的賽道；換賽道、回到選單時跟著換（進頁面時也從這裡開始）
  useEffect(() => {
    if (screen === 'menu') gameRef.current?.preview(findTrack(settings.track))
  }, [screen, settings.track])

  useEffect(() => {
    gameRef.current?.setAutoGas(settings.autoGas)
  }, [settings.autoGas])

  // 遊戲蓋住整個畫面：後面的網頁不要捲動
  useEffect(() => {
    const html = document.documentElement
    const prev = html.style.overflow
    html.style.overflow = 'hidden'
    return () => {
      html.style.overflow = prev
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [])

  // 第一次摸到螢幕就換成觸控版面（筆電觸控螢幕也適用）
  useEffect(() => {
    const onTouch = () => setTouch(true)
    window.addEventListener('touchstart', onTouch, { once: true, passive: true })
    return () => window.removeEventListener('touchstart', onTouch)
  }, [])

  useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement
      setFullscreen(on)
      // 按 Esc 離開全螢幕時，鍵盤事件不會傳進來，直接當成暫停
      if (!on) pauseIfRacing()
    }
    const onHidden = () => {
      if (document.hidden) pauseIfRacing()
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.repeat) return
      const { screen } = live.current
      switch (e.code) {
        case 'KeyP':
        case 'Escape':
          if (screen === 'race') {
            e.preventDefault()
            setPause(!live.current.paused)
          }
          break
        case 'KeyC':
          if (screen === 'race') cycleCamera()
          break
        case 'KeyR':
          gameRef.current?.respawn()
          break
        case 'KeyM':
          toggleSound()
          break
        case 'KeyF':
          toggleFullscreen()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), 2200)
    return () => window.clearTimeout(timer)
  }, [toast])

  function pauseIfRacing() {
    const { screen, phase } = live.current
    if (screen === 'race' && (phase === 'countdown' || phase === 'racing')) setPause(true)
  }

  function setPause(on: boolean) {
    const { screen, phase } = live.current
    if (on && (screen !== 'race' || (phase !== 'countdown' && phase !== 'racing'))) return
    gameRef.current?.setPaused(on)
    setPaused(on)
  }

  function cycleCamera() {
    const mode = gameRef.current?.cycleCamera()
    if (mode === undefined) return
    update({ camera: mode })
    setToast({ text: `視角：${CAMERA_NAMES[mode]}`, id: Date.now() })
  }

  function toggleSound() {
    setSound((on) => {
      save('racing:sound', !on)
      gameRef.current?.setSound(!on)
      return !on
    })
  }

  function enterFullscreen() {
    const el = rootRef.current
    if (!el || !canFullscreen() || document.fullscreenElement) return
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => {
        // 手機全螢幕時順便轉成橫向（Android 才支援，其他的會失敗，沒關係）
        if (!isCoarse()) return
        const orientation = window.screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
        void orientation.lock?.('landscape').catch(() => {})
      })
      .catch(() => {})
  }

  function toggleFullscreen() {
    if (!canFullscreen()) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else enterFullscreen()
  }

  function start() {
    const game = gameRef.current
    if (!game) return
    game.unlockAudio()
    if (settings.fullscreen) enterFullscreen()
    setResult(null)
    setStandings(null)
    setPaused(false)
    setHint(null)
    setBestLap(null)
    setCountdown(null)
    setToast(null)
    setScreen('race')
    game.startRace({
      track: findTrack(settings.track),
      laps: settings.laps,
      opponents: settings.opponents,
      difficulty: settings.difficulty,
      color: settings.color,
    })
  }

  function backToMenu() {
    gameRef.current?.setPaused(false)
    setPaused(false)
    setResult(null)
    setStandings(null)
    setHint(null)
    setCountdown(null)
    setScreen('menu')
  }

  function exit() {
    navigate('/games')
  }

  const inRace = screen === 'race'
  const racing = inRace && (phase === 'countdown' || phase === 'racing')
  const track = findTrack(settings.track)
  const record = records[track.id]

  return (
    <div className={`race-root${touch ? ' touch' : ''}`} ref={rootRef}>
      <div className="race-view" ref={mountGame} />

      <div className="race-top">
        <div className="race-top-start">
          {inRace ? (
            <div className="race-chip race-status" aria-live="off">
              {status.total > 1 && (
                <div className="race-pos">
                  <strong>{status.position}</strong>
                  <span>/ {status.total}</span>
                </div>
              )}
              <div className="race-lines">
                <div className="race-lap">
                  第 <strong>{status.lap}</strong> / {status.laps} 圈
                </div>
                <div className="race-time">
                  <span ref={timeRef}>0:00.00</span>
                </div>
                <div className="race-sub">
                  本圈 <span ref={lapTimeRef}>0:00.00</span>
                </div>
                <div className="race-sub">最快 {formatMs(bestLap)}</div>
              </div>
            </div>
          ) : (
            <button type="button" className="race-icon" onClick={exit} aria-label="回到小遊戲" title="回到小遊戲">
              ←
            </button>
          )}
        </div>
        <div className="race-top-end">
          <div className="race-buttons">
            {racing && (
              <button
                type="button"
                className="race-icon"
                onClick={() => setPause(true)}
                aria-label="暫停"
                title="暫停（P）"
              >
                ❚❚
              </button>
            )}
            {inRace && (
              <button
                type="button"
                className="race-icon"
                onClick={cycleCamera}
                aria-label={`切換視角，現在是${CAMERA_NAMES[settings.camera]}`}
                title="切換視角（C）"
              >
                🎥
              </button>
            )}
            <button
              type="button"
              className="race-icon"
              onClick={toggleSound}
              aria-pressed={sound}
              aria-label={sound ? '關掉聲音' : '打開聲音'}
              title={sound ? '關掉聲音（M）' : '打開聲音（M）'}
            >
              {sound ? '🔊' : '🔇'}
            </button>
            {canFullscreen() && (
              <button
                type="button"
                className="race-icon"
                onClick={toggleFullscreen}
                aria-pressed={fullscreen}
                aria-label={fullscreen ? '離開全螢幕' : '全螢幕'}
                title={fullscreen ? '離開全螢幕（F）' : '全螢幕（F）'}
              >
                {fullscreen ? '🗗' : '⛶'}
              </button>
            )}
          </div>
          {inRace && map && (
            <svg className="race-chip race-map" viewBox={map.viewBox} aria-hidden="true">
              <path d={map.d} className="race-map-road" />
              {racers.map((r, i) => (
                <circle
                  key={i}
                  ref={(el) => {
                    dotRefs.current[i] = el
                  }}
                  r={map.size * (r.player ? 0.032 : 0.022)}
                  className={r.player ? 'race-map-me' : 'race-map-car'}
                  style={{ '--car': hexColor(r.color) } as CSSProperties}
                />
              ))}
            </svg>
          )}
        </div>
      </div>

      {inRace && (
        <div className="race-chip race-speed">
          <span className="race-speed-value" ref={speedRef}>
            0
          </span>
          <span className="race-speed-unit">km/h</span>
          <div className="race-drift" ref={driftRef} data-level="-1" data-boost="false" aria-hidden="true">
            <span />
            <span />
          </div>
        </div>
      )}

      {inRace && countdown !== null && (
        <div className="race-countdown" key={countdown} role="status">
          {countdown === 0 ? 'GO!' : countdown}
        </div>
      )}
      {inRace && toast && (
        <div className="race-toast race-chip" key={toast.id} role="status">
          {toast.text}
        </div>
      )}
      {racing && hint && (
        <div className={`race-hint ${hint}`} role="alert">
          <strong>{hint === 'wrongWay' ? '逆向行駛！' : '卡住了？'}</strong>
          <button type="button" onClick={() => gameRef.current?.respawn()}>
            {touch ? '回到賽道' : '回到賽道（R）'}
          </button>
        </div>
      )}

      {racing && touch && !paused && <TouchControls onChange={sendTouch} />}

      {screen === 'menu' && (
        <div className="race-layer race-menu">
          <div className="race-panel">
            <h1 className="race-title">
              <span aria-hidden="true">🏎️</span> 3D 賽車
            </h1>
            {error ? (
              <p className="error">{error}</p>
            ) : (
              <>
                <div className="segmented-field">
                  <span className="segmented-label">賽道</span>
                  <div className="race-tracks">
                    {TRACKS.map((t) => {
                      const best = records[t.id]?.lap
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className={`race-track${t.id === track.id ? ' active' : ''}`}
                          aria-pressed={t.id === track.id}
                          onClick={() => update({ track: t.id })}
                        >
                          <strong>{t.name}</strong>
                          <span>{t.blurb}</span>
                          {best !== undefined && <span className="race-record">最快圈 {formatMs(best)}</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <Segmented
                  label="圈數"
                  value={settings.laps}
                  options={LAPS.map((n) => ({
                    value: n,
                    label: `${n} 圈`,
                  }))}
                  onChange={(laps) => update({ laps })}
                />
                <Segmented
                  label="電腦對手"
                  value={settings.opponents}
                  options={OPPONENTS}
                  onChange={(opponents) => update({ opponents })}
                />
                <Segmented
                  label="難度"
                  value={settings.difficulty}
                  options={DIFFICULTIES}
                  onChange={(difficulty) => update({ difficulty })}
                  disabled={settings.opponents === 0}
                />
                <div className="segmented-field">
                  <span className="segmented-label">車色</span>
                  <div className="race-colors" role="radiogroup" aria-label="車色">
                    {CAR_COLORS.map((c) => (
                      <button
                        key={c.hex}
                        type="button"
                        role="radio"
                        aria-checked={settings.color === c.hex}
                        aria-label={c.name}
                        title={c.name}
                        className="race-color"
                        style={{ '--car': hexColor(c.hex) } as CSSProperties}
                        onClick={() => update({ color: c.hex })}
                      />
                    ))}
                  </div>
                </div>
                <div className="race-checks">
                  {touch && (
                    <label className="race-check">
                      <input
                        type="checkbox"
                        checked={settings.autoGas}
                        onChange={(e) => update({ autoGas: e.target.checked })}
                      />
                      自動踩油門（只要管方向和煞車）
                    </label>
                  )}
                  {canFullscreen() && (
                    <label className="race-check">
                      <input
                        type="checkbox"
                        checked={settings.fullscreen}
                        onChange={(e) => update({ fullscreen: e.target.checked })}
                      />
                      開始時切換成全螢幕
                    </label>
                  )}
                </div>
                {record?.race?.[String(settings.laps)] !== undefined && (
                  <p className="race-best">
                    {settings.laps} 圈最佳紀錄 <strong>{formatMs(record.race[String(settings.laps)])}</strong>
                  </p>
                )}
                <p className="race-help">
                  {touch
                    ? '左下角左右拖曳轉彎，右下角油門、煞車。轉彎時按住「甩尾」，按越久車尾甩越開、彎轉越急，放開時會加速；甩越久加速越久。'
                    : '方向鍵或 WASD 開車，轉彎時按住空白鍵或 Shift 甩尾：按越久車尾甩越開、彎轉越急，放開時加速（甩越久越久）。C 換視角、R 回到賽道、P 暫停、F 全螢幕、M 聲音。也可以接遊戲手把。'}
                </p>
                {/* 選單很長時開始鈕黏在面板底部，不用捲到最下面 */}
                <div className="race-start-bar">
                  <button type="button" className="race-start" onClick={start}>
                    開始比賽
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {paused && (
        <div className="race-layer race-center">
          <div className="race-panel race-pause">
            <h2>暫停</h2>
            <button type="button" onClick={() => setPause(false)}>
              繼續
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setPaused(false)
                start()
              }}
            >
              重新開始
            </button>
            <button type="button" className="secondary" onClick={backToMenu}>
              回到選單
            </button>
            <button type="button" className="secondary" onClick={exit}>
              離開遊戲
            </button>
          </div>
        </div>
      )}

      {inRace && phase === 'finished' && result && (
        <div className="race-layer race-center">
          <ResultPanel
            result={result}
            standings={standings ?? result.standings}
            solo={racers.length === 1}
            onAgain={start}
            onMenu={backToMenu}
            onExit={exit}
          />
        </div>
      )}
    </div>
  )
}

function ResultPanel({
  result,
  standings,
  solo,
  onAgain,
  onMenu,
  onExit,
}: {
  result: Result
  standings: Standing[]
  solo: boolean
  onAgain: () => void
  onMenu: () => void
  onExit: () => void
}) {
  const me = standings.find((s) => s.player)
  const title = solo ? '完成！' : me?.position === 1 ? '冠軍！' : `第 ${me?.position ?? '–'} 名`
  return (
    <div className="race-panel race-result">
      <h2>{title}</h2>
      <dl className="race-summary">
        <div>
          <dt>總時間</dt>
          <dd>
            {formatMs(result.time)}
            {result.newRace && <span className="chip">新紀錄</span>}
          </dd>
        </div>
        <div>
          <dt>最快圈</dt>
          <dd>
            {formatMs(result.bestLap)}
            {result.newLap && <span className="chip">新紀錄</span>}
          </dd>
        </div>
      </dl>
      {result.lapTimes.length > 1 && (
        <p className="race-laps-list">
          各圈：
          {result.lapTimes.map((ms, i) => (
            <span key={i} className={ms === result.bestLap ? 'best' : undefined}>
              {formatMs(ms)}
            </span>
          ))}
        </p>
      )}
      {!solo && (
        <table className="responsive race-table">
          <thead>
            <tr>
              <th>名次</th>
              <th>車手</th>
              <th>總時間</th>
              <th>最快圈</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((s) => (
              <tr key={s.name} className={s.player ? 'me' : undefined}>
                <td data-label="名次">{s.position}</td>
                <td data-label="車手" className="primary">
                  <span className="race-swatch" style={{ '--car': hexColor(s.color) } as CSSProperties} />
                  {s.name}
                </td>
                <td data-label="總時間">{s.time !== null ? formatMs(s.time) : '比賽中'}</td>
                <td data-label="最快圈">{formatMs(s.bestLap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="race-actions">
        <button type="button" onClick={onAgain}>
          再跑一次
        </button>
        <button type="button" className="secondary" onClick={onMenu}>
          換賽道
        </button>
        <button type="button" className="secondary" onClick={onExit}>
          離開
        </button>
      </div>
    </div>
  )
}

/** 手機的觸控操作：左邊是方向（按住左右拖），右邊是油門、煞車、甩尾 */
function TouchControls({ onChange }: { onChange: (patch: Partial<TouchState>) => void }) {
  const steerPointers = useRef(new Map<number, number>())
  const knobRef = useRef<HTMLSpanElement>(null)
  const [pressed, setPressed] = useState({ gas: false, brake: false, drift: false })
  // 收起來（暫停、跑完）時全部放開，不然車子會一直踩著油門
  useEffect(() => () => onChange({ steer: 0, gas: false, brake: false, drift: false }), [onChange])

  function applySteer() {
    const values = [...steerPointers.current.values()]
    const steer = values.length ? values[values.length - 1] : 0
    onChange({ steer })
    if (knobRef.current) knobRef.current.style.transform = `translateX(${steer * 100}%)`
  }

  function steerAt(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const steer = Math.abs(x) < 0.1 ? 0 : Math.max(-1, Math.min(1, x * 1.4))
    steerPointers.current.set(e.pointerId, steer)
    applySteer()
  }

  function release(e: PointerEvent<HTMLDivElement>) {
    steerPointers.current.delete(e.pointerId)
    applySteer()
  }

  function pedal(key: 'gas' | 'brake' | 'drift') {
    const set = (on: boolean) => {
      onChange({ [key]: on })
      setPressed((p) => (p[key] === on ? p : { ...p, [key]: on }))
    }
    return {
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        set(true)
      },
      onPointerUp: () => set(false),
      onPointerCancel: () => set(false),
      onLostPointerCapture: () => set(false),
      onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    }
  }

  return (
    <div className="race-touch">
      <div
        className="race-steer"
        role="presentation"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          steerAt(e)
        }}
        onPointerMove={(e) => {
          if (steerPointers.current.has(e.pointerId)) steerAt(e)
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <span className="race-steer-arrow" aria-hidden="true">
          ◀
        </span>
        <span className="race-steer-track" aria-hidden="true">
          <span className="race-steer-knob" ref={knobRef} />
        </span>
        <span className="race-steer-arrow" aria-hidden="true">
          ▶
        </span>
      </div>
      <div className="race-pedals">
        <button type="button" className={`race-pedal drift${pressed.drift ? ' on' : ''}`} {...pedal('drift')}>
          甩尾
        </button>
        <button type="button" className={`race-pedal gas${pressed.gas ? ' on' : ''}`} {...pedal('gas')}>
          油門
        </button>
        <button type="button" className={`race-pedal brake${pressed.brake ? ' on' : ''}`} {...pedal('brake')}>
          煞車
        </button>
      </div>
    </div>
  )
}
