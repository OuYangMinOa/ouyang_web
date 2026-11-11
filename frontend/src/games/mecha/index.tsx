import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { lobbyPath, useLobby } from '../lobby/useLobby'
import { Countdown } from '../shared/Party'
import { load, save } from '../shared/storage'
import { useParty } from '../shared/useParty'
import { MechGame, type BattleSetup, type DroneMode, type GameEvent, type HudFrame, type Phase } from './game'
import { Hud, type HudSeat } from './Hud'
import type { MapData, Team } from './map'
import { seatName, slotOf, type MechaParty, type MechaView } from './online'
import { MechSwap, OnlineMenu, PauseMenu, Results, Scoreboard, TeamSelect } from './Panels'
import { mechKind, MECHS, teamClass, TEAMS, type MechKind } from './spec'
import { TouchControls } from './Touch'
import './mecha.css'

type Feed = {
  id: number
  killer: string
  victim: string
  killerTeam: Team
  victimTeam: Team
  /**
   * 用什麼打倒的：主武器（機砲、狙擊型的電磁砲、偵察型的脈衝步槍、堡壘型的機槍、砲擊型的卡賓槍）、飛彈、偵察機或迫擊砲彈；
   * downed 是打下偵察機
   */
  w: 'gun' | 'cannon' | 'head' | 'rifle' | 'mg' | 'carbine' | 'missile' | 'drone' | 'shell' | 'downed'
  mine: boolean
}

const FEED_ICON = {
  gun: ' ✦ ',
  cannon: ' 🎯 ',
  head: ' 🎯 ',
  rifle: ' ⁘ ',
  mg: ' ⁂ ',
  carbine: ' ∙ ',
  missile: ' 🚀 ',
  drone: ' 💥 ',
  shell: ' ☄ ',
  downed: ' ⌖ ',
} as const
const FEED_LABEL = {
  gun: '用機砲擊倒',
  cannon: '用電磁砲擊倒',
  head: '一砲打中頭擊倒',
  rifle: '用脈衝步槍擊倒',
  mg: '用機槍擊倒',
  carbine: '用卡賓槍擊倒',
  missile: '用飛彈擊倒',
  drone: '用偵察機炸倒',
  shell: '用迫擊砲炸倒',
  downed: '打下了',
} as const
const GUN_FEED = { speed: 'gun', sniper: 'cannon', recon: 'rifle', fortress: 'mg', mortar: 'carbine' } as const

const isCoarse = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
const canFullscreen = () => typeof document !== 'undefined' && document.fullscreenEnabled === true

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/** 照 view 推出開打的時間（performance.now() 的時間軸）；`viewAt` 是收到這份 view 的時間 */
function goAtOf(view: MechaView, viewAt: number): number {
  return viewAt + (view.startsIn > 0 ? view.startsIn : -view.elapsed)
}

/** 比賽剩下的時間（分:秒），自己每 0.25 秒往下數 */
function MatchClock({ ms, stamp }: { ms: number | null; stamp: number }) {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  if (ms === null) return null
  const left = Math.max(0, ms - Math.max(0, now - stamp))
  const secs = Math.ceil(left / 1000)
  return (
    <span className={`mecha-clock${secs <= 30 ? ' urgent' : ''}`}>
      {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
    </span>
  )
}

export default function Mecha() {
  const navigate = useNavigate()
  const lobby = useLobby()
  const gameRef = useRef<MechGame | null>(null)
  const frames = useRef<((f: HudFrame) => void) | null>(null)
  const [map, setMap] = useState<MapData | null>(null)
  const [phase, setPhase] = useState<Phase>('preview')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  const [feed, setFeed] = useState<Feed[]>([])
  const [deathBy, setDeathBy] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [board, setBoard] = useState(false)
  const [pointer, setPointer] = useState(false)
  const [lockOn, setLockOn] = useState(false)
  const [focusSeat, setFocusSeat] = useState<number | null>(null)
  /** 自己的偵察機：沒放出去、操控中、停在原地 */
  const [droneMode, setDroneMode] = useState<DroneMode>('none')
  /** 自己的機甲變身了沒（觸控按鈕跟著換） */
  const [deployed, setDeployed] = useState(false)
  /** 自己站在自己家的重生點裡；換機甲的面板開著 */
  const [home, setHome] = useState(false)
  const [swap, setSwap] = useState(false)
  const [touch, setTouch] = useState(isCoarse)
  const [sound, setSound] = useState(() => load('mecha:sound', true))
  const [sensitivity, setSensitivity] = useState(() => load('mecha:sensitivity', 1))
  const [fullscreen, setFullscreen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 自己按了「練習」：開房間、加 3 台電腦、開始（不影響畫面，用 ref 記） */
  const practice = useRef(0)
  /** 沒有座位時自己選了要看的那一局 */
  const [watchGame, setWatchGame] = useState<number | null>(null)

  const register = useCallback((draw: ((f: HudFrame) => void) | null) => {
    frames.current = draw
  }, [])
  const nameOf = useRef<(seat: number) => string>((seat) => `駕駛員 ${seat + 1}`)
  const teamOf = useRef<(seat: number) => Team>(() => 0)
  const kindOf = useRef<(seat: number) => MechKind>(() => 'speed')
  const meRef = useRef<number | null>(null)

  const party = useParty<MechaParty>('mecha', {
    onEvent: (e) => {
      const game = gameRef.current
      if (!game || !e) return
      switch (e.type) {
        case 'tick':
          game.onTick(e.m ?? [], e.hp, e.d)
          break
        case 'missile':
          game.onMissile(e.seat, e.id, e.o, e.dir, e.target, e.goal ?? null)
          break
        case 'boom':
          game.onBoom(e.seat, e.o)
          break
        case 'shell':
          game.onShell(e.seat, e.id, e.o, e.v)
          break
        case 'downed':
          game.onDowned(e.seat, e.by, e.n)
          break
        case 'kill':
          game.onKill(e.killer, e.victim, e.w)
          break
        case 'pong':
          game.onPong(e.t, e.clock)
          break
      }
    },
  })
  const view = party.view
  const room = party.room
  nameOf.current = (seat) => seatName(party, seat)
  teamOf.current = (seat) => view?.players[seat]?.team ?? 0
  kindOf.current = (seat) => mechKind(view?.players[seat]?.mech)
  meRef.current = view?.you ?? null

  const playing = room?.phase === 'playing' || room?.phase === 'results'
  const selecting = room?.phase === 'playing' && view !== null && view.select !== null && !view.ended
  const seated = view !== null && view.you !== null
  const battle = playing && view !== null && view.select === null && (seated || watchGame === view.game)
  const screen: 'menu' | 'select' | 'battle' = selecting ? 'select' : battle ? 'battle' : 'menu'
  const ended = battle && view?.ended === true

  // 建立遊戲：整個頁面只有一個 WebGL 畫面
  const mountGame = useCallback((host: HTMLDivElement | null) => {
    if (!host) return
    let toastId = 0
    const showToast = (text: string) => setToast({ text, id: ++toastId })
    const onEvent = (e: GameEvent) => {
      switch (e.type) {
        case 'phase':
          setPhase(e.phase)
          break
        case 'countdown':
          setCountdown(e.n)
          if (e.n === 0) window.setTimeout(() => setCountdown((n) => (n === 0 ? null : n)), 900)
          break
        case 'toast':
          showToast(e.text)
          break
        case 'lock':
          setLockOn(e.locked)
          break
        case 'focus':
          setFocusSeat(e.seat)
          break
        case 'drone':
          setDroneMode(e.mode)
          break
        case 'home':
          setHome(e.inside)
          break
        case 'deploy':
          setDeployed(e.on)
          break
        case 'pad':
          setMenu((m) => !m)
          break
        case 'downed': {
          // 打下偵察機：擊倒訊息裡多一行，打下來的人跳提示
          const me = meRef.current
          const item: Feed = {
            id: ++toastId,
            killer: nameOf.current(e.by),
            victim: `${nameOf.current(e.seat)} 的偵察機`,
            killerTeam: teamOf.current(e.by),
            victimTeam: teamOf.current(e.seat),
            w: 'downed',
            mine: e.by === me || e.seat === me,
          }
          setFeed((f) => [...f.slice(-4), item])
          window.setTimeout(() => setFeed((f) => f.filter((x) => x.id !== item.id)), 6000)
          if (e.by === me) showToast(`打下 ${nameOf.current(e.seat)} 的偵察機！`)
          break
        }
        case 'kill': {
          const { killer, victim, w } = e.kill
          const me = meRef.current
          const item: Feed = {
            id: ++toastId,
            killer: nameOf.current(killer),
            victim: nameOf.current(victim),
            killerTeam: teamOf.current(killer),
            victimTeam: teamOf.current(victim),
            w: w === 'gun' ? GUN_FEED[kindOf.current(killer)] : w,
            mine: killer === me || victim === me,
          }
          setFeed((f) => [...f.slice(-4), item])
          window.setTimeout(() => setFeed((f) => f.filter((x) => x.id !== item.id)), 6000)
          if (victim === me) setDeathBy(item.killer)
          else if (killer === me) showToast(`擊倒 ${item.victim}！`)
          break
        }
      }
    }
    let game: MechGame
    try {
      game = new MechGame(host, onEvent, (f) => frames.current?.(f), load('mecha:sound', true))
    } catch {
      setError('這個瀏覽器沒辦法顯示 3D 畫面（WebGL 沒有開啟或不支援），換個瀏覽器或更新顯示卡驅動程式再試試。')
      return
    }
    game.setSensitivity(load('mecha:sensitivity', 1))
    gameRef.current = game
    setMap(game.mapData)
    return () => {
      game.dispose()
      gameRef.current = null
    }
  }, [])

  // 畫面切換：選單的背景是廣場上的機甲、選隊時是自己選的機甲
  const myTeam: Team = view && view.you !== null ? (view.players[view.you]?.team ?? 0) : 0
  const myKind = mechKind(view && view.you !== null ? view.players[view.you]?.mech : null)
  useEffect(() => {
    const game = gameRef.current
    if (!game) return
    if (screen === 'menu') game.preview()
    else if (screen === 'select') game.showroom(myTeam, myKind)
  }, [screen, myTeam, myKind])

  // 選隊畫面：機甲畫在選單右邊空出來的那一塊（窄螢幕選單蓋滿整個畫面，就不移）
  useEffect(() => {
    const game = gameRef.current
    if (!game) return
    if (screen !== 'select') {
      game.setStage(null)
      return
    }
    const measure = () => {
      const panel = document.querySelector('.mecha-select .mecha-panel')
      const right = panel ? panel.getBoundingClientRect().right : 0
      const w = window.innerWidth
      game.setStage(w - right > 240 ? { x: right, y: 0, w: w - right, h: window.innerHeight } : null)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [screen])

  // 開局：選完隊、收到新的一局（或重新整理後接著打、選了觀戰）
  const startedGame = useRef<number | null>(null)
  useEffect(() => {
    const game = gameRef.current
    if (!game || !view || screen !== 'battle') {
      if (screen !== 'battle') startedGame.current = null
      return
    }
    if (startedGame.current === view.game) return
    startedGame.current = view.game
    const setup: BattleSetup = {
      seats: view.players.map((p, s) => ({ name: seatName(party, s), team: p.team, bot: view.bots.includes(s), kind: mechKind(p.mech) })),
      me: view.you,
      goAt: goAtOf(view, party.viewAt),
      players: view.players,
      slots: view.players.map((_, s) => slotOf(view, s)),
      driving: view.you !== null && view.driver === view.you,
      difficulty: view.difficulty,
      resume: view.resume,
      botStates: view.elapsed > 0 ? view.botStates : [],
    }
    setMenu(false)
    setBoard(false)
    setDeathBy(null)
    setFeed([])
    setCountdown(null)
    setDroneMode('none')
    setDeployed(false)
    setHome(false)
    setSwap(false)
    game.unlockAudio()
    game.start(setup, {
      state: (d, bots) => party.act({ type: 'state', ...(d ? { d } : {}), ...(bots.length ? { bots } : {}) }),
      hits: (hits) => party.act({ type: 'hit', hits }),
      missile: (m) => party.act({ type: 'missile', ...m }),
      boom: (b) => party.act({ type: 'boom', ...b }),
      shell: (s) => party.act({ type: 'shell', ...s }),
      ping: (t) => party.act({ type: 'ping', t }),
    })
    if (view.you !== null && !isCoarse()) game.lockPointer()
  }, [screen, view, party])

  // view 變了：活著沒、第幾條命、血量、飛彈、誰開電腦；結算了就停下來
  useEffect(() => {
    const game = gameRef.current
    if (!game || !view || screen !== 'battle' || startedGame.current !== view.game) return
    game.sync(view.players, view.you !== null && view.driver === view.you, goAtOf(view, party.viewAt))
    if (view.ended) game.end()
  }, [screen, view, party.viewAt])

  // 復活了就不再顯示是誰打倒的
  const meAlive = view && view.you !== null ? view.players[view.you]?.alive !== false : true
  if (meAlive && deathBy !== null) setDeathBy(null)

  // 練習：開房間後自己加電腦（一般 3 台；大混戰一次補到 30 對 30）、按開始
  const asked = useRef(false)
  useEffect(() => {
    const want = practice.current
    if (!want || !party.connected || !room || !party.isHost) return
    if (room.phase !== 'lobby') {
      practice.current = 0
      return
    }
    const bots = room.players.filter((p) => p.bot).length
    if (bots < want) {
      if (!asked.current) {
        asked.current = true
        party.addBot(want - bots)
      }
      return
    }
    asked.current = false
    practice.current = 0
    // 大混戰：擊倒目標拉高，不然一下子就打完了
    if (want > 3) party.setOptions({ ...room.options, killTarget: 100, timeLimit: 15 })
    party.start()
  }, [party, room])

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

  // 第一次摸到螢幕就換成觸控版面
  useEffect(() => {
    const onTouch = () => setTouch(true)
    window.addEventListener('touchstart', onTouch, { once: true, passive: true })
    return () => window.removeEventListener('touchstart', onTouch)
  }, [])

  useEffect(() => {
    const onLock = () => setPointer(document.pointerLockElement !== null)
    const onFull = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('pointerlockchange', onLock)
    document.addEventListener('fullscreenchange', onFull)
    return () => {
      document.removeEventListener('pointerlockchange', onLock)
      document.removeEventListener('fullscreenchange', onFull)
    }
  }, [])

  // 打開選單、換機甲的面板時放開所有按鍵
  useEffect(() => {
    gameRef.current?.setHold(menu || swap)
  }, [menu, swap])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      if (e.code === 'Tab' && screen === 'battle') {
        e.preventDefault()
        setBoard(true)
        return
      }
      if (e.repeat) return
      switch (e.code) {
        case 'KeyB':
          if (canSwap && !menu) {
            e.preventDefault()
            if (swap) closeSwap()
            else openSwap()
          }
          break
        case 'Escape':
        case 'KeyP':
          if (swap) {
            e.preventDefault()
            closeSwap()
          } else if (screen === 'battle' && !ended) {
            e.preventDefault()
            setMenu((m) => !m)
          }
          break
        case 'KeyM':
          toggleSound()
          break
        case 'KeyF':
          toggleFullscreen()
          break
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Tab') setBoard(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  })

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), 2000)
    return () => window.clearTimeout(timer)
  }, [toast])

  function toggleSound() {
    gameRef.current?.unlockAudio()
    setSound((on) => {
      save('mecha:sound', !on)
      gameRef.current?.setSound(!on)
      return !on
    })
  }

  function changeSensitivity(v: number) {
    setSensitivity(v)
    save('mecha:sensitivity', v)
    gameRef.current?.setSensitivity(v)
  }

  function toggleFullscreen() {
    if (!canFullscreen()) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
  }

  function openSwap() {
    setSwap(true)
    gameRef.current?.unlockPointer()
  }

  function closeSwap() {
    setSwap(false)
    gameRef.current?.unlockAudio()
    if (!touch && meAlive) gameRef.current?.lockPointer()
  }

  function pickMech(kind: MechKind) {
    if (kind !== myKind) party.act({ type: 'mech', mech: kind })
    closeSwap()
  }

  function resume() {
    setMenu(false)
    gameRef.current?.unlockAudio()
    if (!touch) gameRef.current?.lockPointer()
  }

  function leaveRoom() {
    setMenu(false)
    setWatchGame(null)
    party.leave()
  }

  /** 離開遊戲：從遊戲室來的回遊戲室 */
  function exit() {
    navigate(lobby.code ? lobbyPath(lobby.code) : '/games')
  }

  function startPractice(bots: number) {
    gameRef.current?.unlockAudio()
    asked.current = false
    practice.current = bots
    void party.create()
  }

  const inBattle = screen === 'battle' && view !== null
  const me = view?.you ?? null
  const viewerSeat = me ?? focusSeat
  const viewerTeam: Team = viewerSeat !== null && view ? (view.players[viewerSeat]?.team ?? 0) : 0
  const viewerKind = mechKind(viewerSeat !== null && view ? view.players[viewerSeat]?.mech : null)
  const hudSeats: HudSeat[] = view ? view.players.map((p, s) => ({ name: seatName(party, s), team: p.team })) : []
  const live = inBattle && !ended && (phase === 'battle' || phase === 'countdown')
  const showClick = live && me !== null && !touch && !pointer && !menu && !swap
  const respawnIn = view && me !== null && !meAlive ? view.players[me]?.respawnIn ?? null : null
  // 換機甲：站在自己家的重生點裡、或倒下等復活時
  const canSwap = live && me !== null && (meAlive ? home : !ended)
  if (swap && !canSwap) setSwap(false)
  const swapLabel = touch ? '換機甲' : '換機甲（B）'
  const exitLabel = lobby.code ? '回到遊戲室' : '回到小遊戲'

  return (
    <div className={`mecha-root${touch ? ' touch' : ''}`}>
      <div
        className="mecha-view"
        ref={mountGame}
        onClick={() => {
          gameRef.current?.unlockAudio()
          if (live && me !== null && !touch && !menu) gameRef.current?.lockPointer()
        }}
      />

      {inBattle && <Hud register={register} map={map} seats={hudSeats} me={viewerTeam} kind={viewerKind} touch={touch} />}

      <div className="mecha-top">
        <div className="mecha-top-start">
          <button
            type="button"
            className="mecha-icon"
            onClick={() => {
              if (screen === 'menu') exit()
              else if (window.confirm('離開這個房間？')) leaveRoom()
            }}
            aria-label={screen === 'menu' ? exitLabel : '離開房間'}
            title={screen === 'menu' ? exitLabel : '離開房間'}
          >
            ←
          </button>
          {inBattle && (
            <div className={`mecha-chip mecha-you ${teamClass(viewerTeam)}`}>
              {me === null ? '觀戰中' : `${TEAMS[viewerTeam].name}・${MECHS[viewerKind].name}`}
            </div>
          )}
        </div>
        {inBattle && view && (
          <div className="mecha-chip mecha-score" aria-live="off">
            <span className="mecha-score-team red">
              <em>{TEAMS[0].short}</em>
              <strong>{view.score[0]}</strong>
            </span>
            <span className="mecha-score-mid">
              <span className="muted">先到 {view.killTarget}</span>
              <MatchClock ms={view.ended ? null : view.endsIn} stamp={party.viewAt} />
            </span>
            <span className="mecha-score-team blue">
              <strong>{view.score[1]}</strong>
              <em>{TEAMS[1].short}</em>
            </span>
          </div>
        )}
        <div className="mecha-top-end">
          {live && (
            <button type="button" className="mecha-icon" onClick={() => setMenu(true)} aria-label="選單" title="選單（Esc）">
              ☰
            </button>
          )}
          {inBattle && (
            <button
              type="button"
              className={`mecha-icon${board ? ' on' : ''}`}
              onClick={() => setBoard((b) => !b)}
              aria-pressed={board}
              aria-label="記分板"
              title="記分板（按住 Tab）"
            >
              📋
            </button>
          )}
          <button
            type="button"
            className="mecha-icon"
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
              className="mecha-icon"
              onClick={toggleFullscreen}
              aria-pressed={fullscreen}
              aria-label={fullscreen ? '離開全螢幕' : '全螢幕'}
              title={fullscreen ? '離開全螢幕（F）' : '全螢幕（F）'}
            >
              {fullscreen ? '🗗' : '⛶'}
            </button>
          )}
        </div>
      </div>

      {inBattle && feed.length > 0 && (
        <ol className="mecha-feed" aria-live="polite">
          {feed.map((f) => (
            <li key={f.id} className={`mecha-chip${f.mine ? ' mine' : ''}`}>
              <span className={teamClass(f.killerTeam)}>{f.killer}</span>
              <span aria-label={FEED_LABEL[f.w]}>{FEED_ICON[f.w]}</span>
              <span className={teamClass(f.victimTeam)}>{f.victim}</span>
            </li>
          ))}
        </ol>
      )}

      {inBattle && me === null && focusSeat !== null && !ended && (
        <div className="mecha-chip mecha-watch">
          <span>
            觀戰：<strong>{seatName(party, focusSeat)}</strong>
          </span>
          <button type="button" className="secondary" onClick={() => setFocusSeat(gameRef.current?.cycleFocus() ?? focusSeat)}>
            換人
          </button>
        </div>
      )}

      {inBattle && countdown !== null && (
        <div className="mecha-countdown" key={countdown} role="status">
          {countdown === 0 ? '開打！' : countdown}
        </div>
      )}
      {inBattle && lockOn && <div className="mecha-lock-note">鎖定完成：按 {touch ? '「飛彈」' : 'Q'} 發射</div>}
      {inBattle && toast && (
        <div className="mecha-toast mecha-chip" key={toast.id} role="status">
          {toast.text}
        </div>
      )}
      {inBattle && !ended && me !== null && !meAlive && (
        <div className="mecha-dead" role="status">
          <strong>{deathBy ? `被 ${deathBy} 擊倒` : '機體損毀'}</strong>
          <span>
            <Countdown ms={respawnIn} stamp={view} /> 後開{MECHS[myKind].name}在機庫重新出擊
          </span>
          {!swap && (
            <button type="button" className="secondary" onClick={openSwap}>
              {swapLabel}
            </button>
          )}
        </div>
      )}
      {canSwap && meAlive && !swap && !menu && (
        <button type="button" className="mecha-chip mecha-swap" onClick={openSwap}>
          {swapLabel}
        </button>
      )}
      {swap && view && (
        <MechSwap current={myKind} alive={meAlive} connected={party.connected} onPick={pickMech} onClose={closeSwap} />
      )}
      {inBattle && phase === 'countdown' && me !== null && (
        <div className="mecha-chip mecha-ready-note">先熟悉一下操作：開打前可以轉動視角，還不能移動</div>
      )}

      {showClick && (
        <button type="button" className="mecha-click" onClick={() => gameRef.current?.lockPointer()}>
          <strong>點一下開始操作</strong>
          <span>滑鼠瞄準、左鍵開火；按 Esc 叫出選單</span>
        </button>
      )}

      {live && touch && !menu && !swap && me !== null && meAlive && <TouchControls game={gameRef.current} kind={myKind} drone={droneMode} deployed={deployed} />}

      {inBattle && board && view && !ended && (
        <div className="mecha-layer mecha-center mecha-board-layer" onClick={() => setBoard(false)}>
          <div className="mecha-panel mecha-board-panel">
            <h2>記分板</h2>
            <Scoreboard party={party} view={view} />
          </div>
        </div>
      )}

      {screen === 'menu' && (
        <div className="mecha-layer mecha-menu">
          <div className="mecha-panel" onClick={() => gameRef.current?.unlockAudio()}>
            <h1 className="mecha-title">
              <span aria-hidden="true">🤖</span> 機甲對戰
            </h1>
            {error ? (
              <p className="error">{error}</p>
            ) : (
              <OnlineMenu
                party={party}
                touch={touch}
                onPractice={startPractice}
                onWatch={() => {
                  gameRef.current?.unlockAudio()
                  if (view) setWatchGame(view.game)
                }}
              />
            )}
          </div>
        </div>
      )}

      {screen === 'select' && view && <TeamSelect party={party} view={view} touch={touch} onLeave={leaveRoom} />}

      {menu && live && (
        <PauseMenu party={party} sensitivity={sensitivity} onSensitivity={changeSensitivity} onResume={resume} onLeave={leaveRoom} />
      )}

      {ended && view && <Results party={party} view={view} onLeave={leaveRoom} />}

      {inBattle && (party.error || !party.connected) && (
        <div className="mecha-chip mecha-offline" role="alert">
          {party.error ?? '連線中斷，重新連線中…'}
        </div>
      )}
    </div>
  )
}
