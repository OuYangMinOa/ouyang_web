import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { lobbyPath, useLobby } from '../lobby/useLobby'
import { Countdown } from '../shared/Party'
import { load, save } from '../shared/storage'
import { Segmented } from '../shared/ui'
import { useParty } from '../shared/useParty'
import { DIFFICULTIES, type Difficulty } from './ai'
import { CarSelect } from './CarSelect'
import { formatMs, hexColor } from './format'
import {
  CAMERA_NAMES,
  RaceGame,
  type FinishResult,
  type Hint,
  type HudFrame,
  type MiniMap,
  type Phase,
  type RaceEvent,
  type RacerInfo,
  type Rect,
  type Standing,
} from './game'
import type { TouchState } from './input'
import { seatCar, seatName, seatPick, type RacingParty, type RacingPick, type RacingView } from './online'
import { OnlineMenu, OnlinePause, OnlineResult, OnlineSelect } from './OnlinePanels'
import { CAR_COLORS, CARS, carSpec, type CarKind } from './spec'
import { findTrack, TRACKS } from './tracks'
import './racing.css'

type Settings = {
  track: string
  laps: number
  opponents: number
  difficulty: Difficulty
  color: number
  car: CarKind
  autoGas: boolean
  fullscreen: boolean
  camera: number
}

/** 每條賽道自己的最快圈，以及各圈數的最快完賽時間（毫秒） */
type Records = Record<string, { lap?: number; race?: Record<string, number> }>
/** 最快紀錄存在哪裡：賽道改過（加了起伏、夜城改成 8 字形）以後舊紀錄不能比，換一個名字重新記 */
const RECORDS_KEY = 'racing:records:v2'

type Result = FinishResult & { newLap: boolean; newRace: boolean }

/** 單人（和電腦比）或多人連線 */
type Mode = 'solo' | 'online'

const MODES: { value: Mode; label: string }[] = [
  { value: 'solo', label: '單人' },
  { value: 'online', label: '多人連線' },
]

const LAPS = [1, 3, 5]
const OPPONENTS = [
  { value: 0, label: '計時賽' },
  { value: 3, label: '3 台' },
  { value: 5, label: '5 台' },
  { value: 7, label: '7 台' },
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
    car: CARS.some((c) => c.kind === raw.car) ? raw.car! : 'all',
    autoGas: typeof raw.autoGas === 'boolean' ? raw.autoGas : isCoarse(),
    fullscreen: typeof raw.fullscreen === 'boolean' ? raw.fullscreen : true,
    camera: typeof raw.camera === 'number' ? raw.camera : 0,
  }
}

/** 照 view 推出起跑的時間（performance.now() 的時間軸）；`viewAt` 是收到這份 view 的時間 */
function goAtOf(view: RacingView, viewAt: number): number {
  return viewAt + (view.startsIn > 0 ? view.startsIn : -view.elapsed)
}

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

export default function Racing() {
  const navigate = useNavigate()
  const rootRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<RaceGame | null>(null)
  const [settings, setSettings] = useState(loadSettings)
  /** 選單（單人選賽道、線上的大廳）→ 選車 → 比賽 */
  const [screen, setScreen] = useState<'menu' | 'select' | 'race'>('menu')
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
  const [records, setRecords] = useState<Records>(() => load(RECORDS_KEY, {}))
  const [sound, setSound] = useState(() => load('racing:sound', true))
  const [music, setMusic] = useState(() => load('racing:music', true))
  const [touch, setTouch] = useState(isCoarse)
  const [fullscreen, setFullscreen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 多人連線：網址帶 ?room=（邀請連結、遊戲室）就直接進多人
  const [params, setParams] = useSearchParams()
  const lobby = useLobby()
  const [mode, setMode] = useState<Mode>(() =>
    params.has('room') ? 'online' : load<Mode>('racing:mode', 'solo') === 'online' ? 'online' : 'solo',
  )
  /** 現在這場比賽（和選車畫面）是單人還是線上的 */
  const [raceKind, setRaceKind] = useState<Mode>('solo')
  /** 線上觀戰（沒有座位、重新整理前已經跑完、跑完後在看別人）時鏡頭跟著的座位；自己在跑是 null */
  const [watchSeat, setWatchSeat] = useState<number | null>(null)
  /** 線上自己跑完後在看別人跑（成績表收起來） */
  const [spectating, setSpectating] = useState(false)
  /**
   * 自己對某一局的選擇：回到房間（`watch` false，不再自動進去）或在房間裡按了觀看比賽（true）。
   * 沒選過的局照預設：有座位就上場、沒座位就觀戰；回到房間過的局（伺服器記著）重新整理後也不會自動進去
   */
  const [stance, setStance] = useState<{ game: number; watch: boolean } | null>(null)
  const party = useParty<RacingParty>('racing', {
    enabled: mode === 'online',
    onEvent: (e) => {
      if (e?.type === 'cars') gameRef.current?.onlineCars(e.cars)
      else if (e?.type === 'pong') gameRef.current?.onlinePong(e.t, e.clock)
      else if (e?.type === 'bump') gameRef.current?.onlineBump(e.from, e.to, e.v)
    },
  })
  const online = mode === 'online'
  const view = online ? party.view : null
  const roomPhase = online ? (party.room?.phase ?? null) : null
  /** 已經開過的那一局（view.game），同一局不重開 */
  const startedGame = useRef<number | null>(null)
  /** 線上比賽時把過線回報給伺服器 */
  const reportLap = useRef<((lap: number, time: number) => void) | null>(null)
  reportLap.current =
    raceKind === 'online' ? (lap, time) => party.act({ type: 'lap', lap, time: Math.max(0, Math.round(time)) }) : null

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
  /** 選車畫面：車子畫在預覽那一塊 */
  const sendStage = useCallback((rect: Rect | null) => gameRef.current?.setStage(rect), [])

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
          reportLap.current?.(e.lap, e.at)
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
          reportLap.current?.(r.laps, r.time)
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
            save(RECORDS_KEY, next)
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
        case 'focus':
          setWatchSeat(e.seat)
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
      game = new RaceGame(host, onEvent, onFrame, load('racing:sound', true), load('racing:music', true))
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

  // 選單的背景是電腦在跑選好的賽道（線上是房主選的）；換賽道、回到選單時跟著換（進頁面時也從這裡開始）
  const menuTrack = online && party.room ? party.room.options.track : settings.track
  useEffect(() => {
    if (screen === 'menu') gameRef.current?.preview(findTrack(menuTrack))
  }, [screen, menuTrack])

  // 線上：房主按了開始，先選車（每個人有時限，選好了才開始倒數）。一局只切過去一次（在 render 裡依 view 調整 state）
  const [selectedGame, setSelectedGame] = useState<number | null>(null)
  if (online && roomPhase === 'playing' && view && view.select !== null && !view.ended && selectedGame !== view.game) {
    setSelectedGame(view.game)
    setRaceKind('online')
    setWatchSeat(null)
    setSpectating(false)
    setResult(null)
    setStandings(null)
    setPaused(false)
    setHint(null)
    setCountdown(null)
    setToast(null)
    setScreen('select')
  }

  // 選車畫面的背景：選到的車停在這局的賽道上（線上是自己選的；觀戰的人看第一個座位的）
  const selectTrack = screen !== 'select' ? null : raceKind === 'online' ? (view?.track ?? null) : settings.track
  const shownPick =
    screen !== 'select'
      ? null
      : raceKind === 'online'
        ? view && seatPick(view, view.you ?? 0)
        : { car: settings.car, color: Math.max(0, CAR_COLORS.findIndex((c) => c.hex === settings.color)) }
  const shownCar = shownPick?.car
  const shownColor = shownPick?.color
  useEffect(() => {
    if (selectTrack === null || shownCar === undefined || shownColor === undefined) return
    gameRef.current?.showroom(findTrack(selectTrack), shownCar, CAR_COLORS[shownColor].hex)
  }, [selectTrack, shownCar, shownColor])

  // 回到房間過的局不自動進去，在房間裡按了觀看比賽才進去看
  const mineNow = view && view.you !== null ? view.players[view.you] : undefined
  const joinGame = view && (stance?.game === view.game ? stance.watch : !mineNow?.retired)

  // 線上開局：選完車（view.select 變成 null）、收到新的一局（view.game 換了）就排起跑格。觀戰、重新整理後接著跑也從這裡進來
  useEffect(() => {
    const game = gameRef.current
    const room = party.room
    if (!online || !game || !view || room?.phase !== 'playing' || view.ended || view.select !== null) return
    if (startedGame.current === view.game || !joinGame) return
    const mine = view.you !== null ? view.players[view.you] : undefined
    startedGame.current = view.game
    const me = mine && mine.finish === null && !mine.retired ? view.you : null
    const resume = me !== null && view.resume && view.elapsed > 0 ? view.resume : null
    const myLaps = me !== null ? view.players[me].lapTimes : []
    setResult(null)
    setStandings(null)
    setPaused(false)
    setHint(null)
    setBestLap(resume && myLaps.length ? Math.min(...myLaps) : null)
    setCountdown(null)
    setToast(null)
    setRaceKind('online')
    setSpectating(false)
    setScreen('race')
    game.startOnline(
      {
        track: findTrack(view.track),
        laps: view.laps,
        seats: view.players.map((_, seat) => ({ name: seatName(party, seat), ...seatCar(view, seat) })),
        grid: view.grid,
        me,
        goAt: goAtOf(view, party.viewAt),
        resume,
        results: view.players,
        bots: view.bots,
        driving: view.you !== null && view.driver === view.you,
        difficulty: view.difficulty,
        botStates: view.elapsed > 0 ? view.botStates : [],
      },
      {
        state: (d, bots) => party.act({ type: 'state', ...(d ? { d } : {}), ...(bots.length ? { bots } : {}) }),
        botLap: (bot, lap, time) => party.act({ type: 'lap', lap, time: Math.max(0, time), bot }),
        ping: (t) => party.act({ type: 'ping', t }),
        bump: (hits) => party.act({ type: 'bump', hits }),
      },
    )
    setWatchSeat(me === null ? game.focusSeat() : null)
  }, [online, view, party, joinGame])

  // 線上：別人過線、跑完時更新名次；結算了就停下來看成績
  useEffect(() => {
    const game = gameRef.current
    if (raceKind !== 'online' || !game || !view || startedGame.current !== view.game) return
    game.onlineResults(view.players)
    game.setDriving(view.you !== null && view.driver === view.you)
    if (view.ended) game.endOnline()
    else game.syncClock(goAtOf(view, party.viewAt))
  }, [raceKind, view, party.viewAt])

  // 結算了就不看別人跑了，回到自己的成績（遊戲那邊在 endOnline 已經換回自己的車）
  if (spectating && (raceKind !== 'online' || !view || view.ended)) {
    setSpectating(false)
    setWatchSeat(null)
  }

  // 線上：離開房間、房主中止這局（回到大廳）時回選單
  useEffect(() => {
    if (raceKind !== 'online' || screen === 'menu') return
    if (!online || !party.code || roomPhase === 'lobby') backToMenu()
  })

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
        case 'KeyB':
          toggleMusic()
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

  function toggleMusic() {
    // 在按鈕、按鍵的事件裡：順便讓瀏覽器開始出聲（還沒開始比賽時，選單就聽得到音樂）
    gameRef.current?.unlockAudio()
    setMusic((on) => {
      save('racing:music', !on)
      gameRef.current?.setMusic(!on)
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

  /** 單人：選好賽道後去選車 */
  function openSelect() {
    gameRef.current?.unlockAudio()
    setRaceKind('solo')
    setWatchSeat(null)
    setScreen('select')
  }

  function start() {
    const game = gameRef.current
    if (!game) return
    game.unlockAudio()
    if (settings.fullscreen) enterFullscreen()
    setRaceKind('solo')
    setWatchSeat(null)
    setSpectating(false)
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
      car: settings.car,
    })
  }

  function backToMenu() {
    gameRef.current?.setPaused(false)
    // 離開房間後再回來（同一局還在跑）要重新開局，從伺服器記的位置接著跑；還在選車的話回到選車畫面
    startedGame.current = null
    setSelectedGame(null)
    setRaceKind('solo')
    setWatchSeat(null)
    setSpectating(false)
    setPaused(false)
    setResult(null)
    setStandings(null)
    setHint(null)
    setCountdown(null)
    setScreen('menu')
  }

  /** 離開遊戲：從遊戲室來的回遊戲室 */
  function exit() {
    navigate(lobby.code ? lobbyPath(lobby.code) : '/games')
  }

  function changeMode(next: Mode) {
    setMode(next)
    save('racing:mode', next)
    // 回到單人就離開房間，免得重新整理又被帶回去
    if (next === 'solo' && params.has('room')) {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          p.delete('room')
          return p
        },
        { replace: true },
      )
    }
  }

  function leaveRoom() {
    party.leave()
    backToMenu()
  }

  /**
   * 回到房間：人留在房間裡，回到大廳等下一局（不用離開房間再進來）。
   * 比賽還沒結算的話告訴伺服器這局不跑了（還沒跑完算沒跑完），之後這局不會再自動進去
   */
  function backToRoom() {
    if (view && !view.ended) {
      const mine = view.you !== null ? view.players[view.you] : undefined
      const running = mine !== undefined && mine.finish === null && !mine.retired
      if (running && !window.confirm('離開這局回到房間？這局會算沒跑完。')) return
      if (mine && !mine.retired) party.act({ type: 'retire' })
      setStance({ game: view.game, watch: false })
    }
    backToMenu()
  }

  /** 在房間裡看正在跑的這局 */
  function watchRace() {
    gameRef.current?.unlockAudio()
    if (view) setStance({ game: view.game, watch: true })
  }

  /** 線上跑完後看還在跑的人（成績表收起來） */
  function watchOthers() {
    const seat = gameRef.current?.spectate(true)
    if (seat === undefined || seat === null) return
    setSpectating(true)
    setWatchSeat(seat)
  }

  /** 不看了，回到自己的成績 */
  function showResults() {
    gameRef.current?.spectate(false)
    setSpectating(false)
    setWatchSeat(null)
  }

  function watchNext() {
    const seat = gameRef.current?.cycleFocus()
    if (seat !== undefined && seat !== null) setWatchSeat(seat)
  }

  const inRace = screen === 'race'
  const selectView = screen === 'select' && raceKind === 'online' && view?.select ? view : null
  const racing = inRace && (phase === 'countdown' || phase === 'racing')
  const onlineRace = inRace && raceKind === 'online'
  const watching = onlineRace && watchSeat !== null
  const track = findTrack(settings.track)
  const record = records[track.id]
  const modeSwitch = <Segmented label="模式" value={mode} options={MODES} onChange={changeMode} />
  const colorIndex = Math.max(
    0,
    CAR_COLORS.findIndex((c) => c.hex === settings.color),
  )
  /** 自己平常開的車（單人和線上共用，線上換車時也記下來，下次進房間先換成這台） */
  const prefs: RacingPick = { car: settings.car, color: colorIndex }
  const setPrefs = (p: RacingPick) => update({ car: p.car, color: CAR_COLORS[p.color].hex })
  const exitLabel = lobby.code ? '回到遊戲室' : '回到小遊戲'

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
                {/* 觀戰時上面是看的那台車，最快圈只有自己的，不顯示 */}
                {!watching && <div className="race-sub">最快 {formatMs(bestLap)}</div>}
              </div>
            </div>
          ) : selectView?.select ? (
            <div className="race-chip race-select-timer" role="timer">
              選車倒數 <Countdown ms={selectView.select.endsIn} stamp={selectView} />
            </div>
          ) : screen === 'select' ? (
            <button type="button" className="race-icon" onClick={backToMenu} aria-label="回到選單" title="回到選單">
              ←
            </button>
          ) : (
            <button type="button" className="race-icon" onClick={exit} aria-label={exitLabel} title={exitLabel}>
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
              className={`race-icon${music ? '' : ' off'}`}
              onClick={toggleMusic}
              aria-pressed={music}
              aria-label={music ? '關掉音樂' : '打開音樂'}
              title={music ? '關掉音樂（B）' : '打開音樂（B）'}
            >
              🎵
            </button>
            <button
              type="button"
              className="race-icon"
              onClick={toggleSound}
              aria-pressed={sound}
              aria-label={sound ? '關掉音效' : '打開音效'}
              title={sound ? '關掉音效（M）' : '打開音效（M）'}
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

      {onlineRace && (
        <div className="race-online-chips">
          {watching && (
            <div className="race-chip race-watch">
              <span>
                觀戰：<strong>{seatName(party, watchSeat)}</strong>
              </span>
              <button type="button" className="secondary" onClick={watchNext}>
                換人
              </button>
              {spectating && (
                <button type="button" className="secondary" onClick={showResults}>
                  成績
                </button>
              )}
            </div>
          )}
          {view && !view.ended && view.endsIn !== null && (
            <div className="race-chip race-grace" role="status">
              結算倒數 <Countdown ms={view.endsIn} stamp={view} />
            </div>
          )}
          {(party.error || !party.connected) && (
            <div className="race-chip race-offline" role="alert">
              {party.error ?? '連線中斷，重新連線中…'}
            </div>
          )}
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

      {racing && touch && !paused && !watching && <TouchControls onChange={sendTouch} />}

      {screen === 'menu' && (
        <div className="race-layer race-menu">
          {/* 線上不是自己按開始（房主按），在選單上點任何東西時先把聲音打開 */}
          <div className="race-panel" onClick={() => gameRef.current?.unlockAudio()}>
            <h1 className="race-title">
              <span aria-hidden="true">🏎️</span> 3D 賽車
            </h1>
            {error ? (
              <p className="error">{error}</p>
            ) : online ? (
              <OnlineMenu party={party} modeSwitch={modeSwitch} onWatch={watchRace} />
            ) : (
              <>
                {modeSwitch}
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
                          {t.credit && <span className="race-credit">{t.credit}</span>}
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
                    : '方向鍵或 WASD 開車，轉彎時按住空白鍵或 Shift 甩尾：按越久車尾甩越開、彎轉越急，放開時加速（甩越久越久）。C 換視角、R 回到賽道、P 暫停、F 全螢幕、M 音效、B 音樂。也可以接遊戲手把。'}
                </p>
                {/* 選單很長時開始鈕黏在面板底部，不用捲到最下面 */}
                <div className="race-start-bar">
                  <button type="button" className="race-start" onClick={openSelect}>
                    下一步：選車
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {screen === 'select' && raceKind === 'solo' && (
        <CarSelect
          title="選你的車"
          subtitle={`${track.name}・${settings.laps} 圈・${settings.opponents ? `電腦 ${settings.opponents} 台` : '計時賽'}`}
          car={settings.car}
          color={colorIndex}
          onCar={(car) => update({ car })}
          onColor={(i) => update({ color: CAR_COLORS[i].hex })}
          onStage={sendStage}
          actions={
            <>
              <button type="button" className="secondary" onClick={backToMenu}>
                返回
              </button>
              <button type="button" className="race-start" onClick={start}>
                開始比賽
              </button>
            </>
          }
        />
      )}

      {selectView && (
        <OnlineSelect
          party={party}
          view={selectView}
          prefs={prefs}
          onPrefs={setPrefs}
          onStage={sendStage}
          onLeave={leaveRoom}
        />
      )}

      {/* 結算後選單收起來，換成績表 */}
      {paused && onlineRace && !view?.ended && (
        <div className="race-layer race-center">
          <OnlinePause party={party} onResume={() => setPause(false)} onRoom={backToRoom} onLeave={leaveRoom} />
        </div>
      )}

      {paused && !onlineRace && (
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

      {onlineRace && view && (phase === 'finished' || view.ended) && !spectating && (
        <div className="race-layer race-center">
          <OnlineResult party={party} view={view} onWatch={watchOthers} onRoom={backToRoom} onLeave={leaveRoom} />
        </div>
      )}

      {inRace && !onlineRace && phase === 'finished' && result && (
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
                  <span className="race-car-tag">{carSpec(s.car).name}</span>
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
