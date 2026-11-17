import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { errorMessage } from '../../api'
import { lobbyPath, useLobby } from '../lobby/useLobby'
import { PartyNotice } from '../shared/Party'
import { load, save } from '../shared/storage'
import { useParty } from '../shared/useParty'
import { Glyph, TowerArt } from './Art'
import { TdGame, type GameEvent, type TowerInfo } from './game'
import { BuildInfo, Players, Resources, SendPanel, Shop, TowerPanel, WaveBanner, WaveBar } from './Hud'
import { IconsContext, type Icons } from './icons'
import { loadSpec, seatName, type AimMode, type Spec, type TdAction, type TdParty, type TdView, type TowerId } from './online'
import { Menu, PauseMenu, Results } from './Panels'
import { createStats, goldOf } from './stats'
import './towerdefense.css'

type Note = { id: number; text: string; tone: 'ok' | 'danger' | 'accent' | '' }

const isCoarse = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
const canFullscreen = () => typeof document !== 'undefined' && document.fullscreenEnabled === true

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/**
 * 迷宮塔防：整個畫面都是遊戲（`registry.ts` 設了 `fullscreen`）。
 * 3D 畫面在 `game.ts`，這裡負責連線（派對房間）、把伺服器的事件交給它，以及浮在上面的介面。
 */
export default function TowerDefense() {
  const navigate = useNavigate()
  const lobby = useLobby()
  const gameRef = useRef<TdGame | null>(null)
  const [spec, setSpec] = useState<Spec | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 3D 畫面做好了沒（底下用到遊戲的 effect 等它好了再跑一次） */
  const [ready, setReady] = useState(false)
  /** 塔和怪物的小圖：3D 畫面做好之後拍一次，拍不了就是 null（介面退回用表情符號） */
  const [icons, setIcons] = useState<Icons | null>(null)
  const [stats] = useState(createStats)
  const [build, setBuild] = useState<TowerId | null>(null)
  /** 滑鼠停在商店的哪一種塔上（先看說明，還沒選） */
  const [peek, setPeek] = useState<TowerId | null>(null)
  /** 選到的那座塔，或選到的空格（兩個不會同時有） */
  const [tower, setTower] = useState<TowerInfo | null>(null)
  const [cell, setCell] = useState<number | null>(null)
  /** 蓋在正在預覽的那一格，路線會多幾格 */
  const [gain, setGain] = useState<number | null>(null)
  const [look, setLook] = useState(0)
  const [flags, setFlags] = useState<boolean[]>([])
  const [target, setTarget] = useState<number | null>(null)
  const [aim, setAim] = useState<number | null>(null)
  const [income, setIncome] = useState(0)
  const [toast, setToast] = useState<Note | null>(null)
  const [feed, setFeed] = useState<Note[]>([])
  const [leak, setLeak] = useState(0)
  const [menu, setMenu] = useState(false)
  const [board, setBoard] = useState(false)
  const [sending, setSending] = useState(false)
  const [hideResults, setHideResults] = useState(false)
  const [touch, setTouch] = useState(isCoarse)
  const [sound, setSound] = useState(() => load('towerdefense:sound', true))
  const [fullscreen, setFullscreen] = useState(false)
  /** 自己按了「練習」：開房間後自己按開始 */
  const practice = useRef(false)
  const noteId = useRef(0)

  const say = useCallback((text: string, tone: Note['tone'] = '') => setToast({ id: ++noteId.current, text, tone }), [])
  const log = useCallback((text: string, tone: Note['tone'] = '') => {
    const item = { id: ++noteId.current, text, tone }
    setFeed((f) => [...f.slice(-3), item])
    window.setTimeout(() => setFeed((f) => f.filter((x) => x.id !== item.id)), 7000)
  }, [])

  // 事件處理要用到最新的名字、座位、下一波的內容，但不想每次都換掉處理函式
  const latest = useRef({
    name: (seat: number) => `玩家 ${seat + 1}`,
    me: null as number | null,
    next: [] as [number, number][],
    build: null as TowerId | null,
    act: (() => {}) as (action: TdAction) => void,
    afford: (() => true) as (kind: TowerId) => boolean,
  })

  const party = useParty<TdParty>('towerdefense', {
    onEvent: (e) => {
      const game = gameRef.current
      if (!e) return
      const { name, me, next } = latest.current
      switch (e.type) {
        case 'tick':
          game?.onTick(e)
          break
        case 'tower':
          game?.onTower(e)
          break
        case 'wave':
          // 畫面中間的「第幾波」跟著 view 出來（見下面的 banner），這裡只管聲音
          game?.play(next.some(([kind]) => (spec?.monsters[kind]?.lives ?? 1) > 1) ? 'boss' : 'wave')
          break
        case 'ready':
          setFlags(e.ready)
          break
        case 'send': {
          const unit = spec?.units[e.unit]
          const monster = spec?.monsters.find((m) => m.id === unit?.kind)
          const what = unit && monster ? `${monster.name}×${unit.count}` : '怪物'
          if (e.to === me) {
            say(`${name(e.from)} 派了${what}來打你！`, 'danger')
            game?.play('incoming')
          } else if (e.from === me) {
            setIncome(e.income)
            game?.play('send')
          }
          log(`${name(e.from)} 派${what}打 ${name(e.to)}`, e.to === me ? 'danger' : '')
          break
        }
        case 'give':
          if (e.to === me) {
            say(`${name(e.from)} 給你 ${e.amount} 元`, 'ok')
            game?.play('coin')
          }
          log(`${name(e.from)} 給 ${name(e.to)} ${e.amount} 元`)
          break
        case 'out':
          log(`${name(e.seat)} 守不住了（第 ${e.place} 名）`, 'danger')
          break
        case 'aim':
          setAim(e.seat)
          setTarget(e.target)
          break
      }
    },
  })
  const { room, view } = party
  const me = view?.you ?? null
  const my = view && me !== null ? view.players[me] : null

  /** 錢夠不夠蓋這種塔；不夠就說一聲（不用等伺服器回來才知道） */
  function afford(kind: TowerId): boolean {
    const t = spec?.towers.find((x) => x.id === kind)
    if (!t || !view || me === null) return true
    const cost = t.levels[0].cost
    if (goldOf(view, stats.get(), me) >= cost) return true
    say(`錢不夠：${t.name}要 ${cost}`, 'danger')
    gameRef.current?.play('deny')
    return false
  }
  useEffect(() => {
    latest.current = { name: (seat) => seatName(party, seat), me, next: view?.next ?? [], build, act: party.act, afford }
  })

  const battle = (room?.phase === 'playing' || room?.phase === 'results') && view !== null
  const ended = battle && view.ended
  /** 還在場上、可以操作 */
  const active = battle && !ended && room?.phase === 'playing' && my !== null && !my.out
  /** 正在看自己的場地：可以蓋塔 */
  const home = active && my !== null && look === my.field
  const versus = view?.mode === 'versus'

  useEffect(() => {
    let alive = true
    loadSpec()
      .then((s) => alive && setSpec(s))
      .catch((e: unknown) => alive && setError(`載入失敗：${errorMessage(e)}`))
    return () => {
      alive = false
    }
  }, [])

  // 建立遊戲：整個頁面只有一個 WebGL 畫面
  const mountGame = useCallback(
    (host: HTMLDivElement | null) => {
      if (!host || !spec) return
      const onEvent = (e: GameEvent): void => {
        switch (e.type) {
          case 'stats':
            stats.set(e)
            break
          case 'pick':
            setTower(game.picked())
            setCell(e.cell)
            break
          case 'build': {
            const kind = latest.current.build
            if (kind && latest.current.afford(kind)) latest.current.act({ type: 'build', cell: e.cell, kind })
            break
          }
          case 'cancel':
            setBuild(null)
            gameRef.current?.select(null, null)
            break
          case 'deny':
            say(e.reason, 'danger')
            break
          case 'towers':
            // 選到的那座可能升級了、被拆了
            setTower(game.picked())
            break
          case 'leak':
            setLeak((n) => n + 1)
            break
          case 'preview':
            setGain(e.cell === null ? null : e.gain)
            break
        }
      }
      let game: TdGame
      try {
        game = new TdGame(host, spec, (e) => onEvent(e), load('towerdefense:sound', true))
      } catch {
        setError('這個瀏覽器沒辦法顯示 3D 畫面（WebGL 沒有開啟或不支援），換個瀏覽器或更新顯示卡驅動程式再試試。')
        return
      }
      gameRef.current = game
      setReady(true)
      return () => {
        game.dispose()
        gameRef.current = null
        setReady(false)
      }
    },
    [spec, stats, say],
  )

  // 塔和怪物的小圖：等第一個畫面出來之後再拍（要另外開一個小的 WebGL 畫面，會卡幾十毫秒）
  useEffect(() => {
    if (!ready) return
    const timer = window.setTimeout(() => setIcons(gameRef.current?.icons() ?? null), 80)
    return () => window.clearTimeout(timer)
  }, [ready])

  // 選單的背景是房主選的那張地圖，慢慢轉
  const menuMap = room?.options.map ?? 'plains'
  useEffect(() => {
    const game = ready ? gameRef.current : null
    if (!game) return
    game.setPreview(!battle)
    if (!battle) game.setMap(menuMap)
  }, [ready, battle, menuMap])

  // 新的一局：把介面的狀態清掉（在 render 裡依 view 推導，和 Party.tsx 的 Countdown 一樣）
  const [gameNo, setGameNo] = useState<number | null>(null)
  const currentGame = battle ? view.game : null
  if (currentGame !== gameNo) {
    setGameNo(currentGame)
    setBuild(null)
    setPeek(null)
    setTower(null)
    setCell(null)
    setGain(null)
    setFeed([])
    setLeak(0)
    setMenu(false)
    setSending(false)
    setHideResults(false)
    if (view) {
      setLook(view.look ?? 0)
      setAim(view.aim)
    }
  }
  // 每次收到 view：準備好了沒、收入、派兵的目標以伺服器的為準
  const [seen, setSeen] = useState<TdView | null>(null)
  /** 剛打完哪一波（場上清空、開始休息）：說一聲、響一聲 */
  const [cleared, setCleared] = useState<{ game: number; wave: number } | null>(null)
  if (view !== seen) {
    setSeen(view)
    if (seen && view && seen.game === view.game && seen.nextIn === null && view.nextIn !== null && view.wave > 0 && !view.ended) {
      setCleared({ game: view.game, wave: view.wave })
    }
    if (view) {
      setFlags(view.players.map((p) => p.ready))
      setTarget(view.target)
      if (view.you !== null) setIncome(view.players[view.you]?.income ?? 0)
    }
  }
  // 新的一波：畫面中間跳出「第幾波」和這一波的怪。同一局裡波數往上加才跳（剛連上、重新整理時不跳）
  const waveKey = battle && !ended ? `${view.game}:${view.wave}` : null
  const [waveSeen, setWaveSeen] = useState<{ key: string | null; game: number; wave: number }>({ key: null, game: -1, wave: 0 })
  const [banner, setBanner] = useState<{ key: string; wave: number; groups: [number, number][] } | null>(null)
  if (waveKey !== waveSeen.key) {
    if (view && waveKey && waveSeen.key && waveSeen.game === view.game && view.wave > waveSeen.wave && view.now.length) {
      setBanner({ key: waveKey, wave: view.wave, groups: view.now })
    } else if (!waveKey) setBanner(null)
    setWaveSeen({ key: waveKey, game: view?.game ?? -1, wave: view?.wave ?? 0 })
  }
  useEffect(() => {
    if (!banner) return
    const timer = window.setTimeout(() => setBanner((b) => (b?.key === banner.key ? null : b)), 2700)
    return () => window.clearTimeout(timer)
  }, [banner])
  useEffect(() => {
    if (!cleared) return
    say(`第 ${cleared.wave} 波守住了`, 'ok')
    gameRef.current?.play('clear')
  }, [cleared, say])

  // view 變了：塔、路線、誰是誰交給 3D 畫面
  useEffect(() => {
    const game = ready ? gameRef.current : null
    if (game && view && battle) game.sync(view)
  }, [ready, battle, view])

  useEffect(() => {
    if (ready) gameRef.current?.setLook(look)
  }, [ready, look, gameNo])

  useEffect(() => {
    if (ready) gameRef.current?.setBuild(home ? build : null)
  }, [ready, build, home])

  // 場地要放在上面的資源列和下面的商店中間：量它們實際多高（窄螢幕會換成兩行）
  const topBar = useRef<HTMLDivElement>(null)
  const shopRow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ready || !battle) return
    const measure = () => {
      const top = topBar.current?.getBoundingClientRect().bottom ?? 0
      const shop = shopRow.current?.getBoundingClientRect().top
      gameRef.current?.setInsets(top + 10, shop === undefined ? 16 : window.innerHeight - shop + 10)
    }
    const observer = new ResizeObserver(measure)
    if (topBar.current) observer.observe(topBar.current)
    if (shopRow.current) observer.observe(shopRow.current)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [ready, battle, active])

  // 這一波或下一波有飛行的怪：把牠們直飛的路線也畫出來
  const air = view !== null && [...view.now, ...view.next].some(([kind]) => spec?.monsters[kind]?.air)
  useEffect(() => {
    if (ready) gameRef.current?.setAirHint(air)
  }, [ready, air])

  // 結束：響一聲
  const endedGame = useRef<number | null>(null)
  useEffect(() => {
    if (!view || !ended || endedGame.current === view.game) return
    endedGame.current = view.game
    const won = view.mode === 'coop' ? view.won === true : view.you !== null && view.winner === view.you
    gameRef.current?.play(won ? 'win' : 'lose')
  }, [ended, view])

  // 練習：開好房間就自己按開始
  useEffect(() => {
    if (!practice.current || !party.connected || !room || !party.isHost) return
    practice.current = false
    if (room.phase === 'lobby') party.start()
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

  useEffect(() => {
    const onTouch = () => setTouch(true)
    const onFull = () => setFullscreen(!!document.fullscreenElement)
    window.addEventListener('touchstart', onTouch, { once: true, passive: true })
    document.addEventListener('fullscreenchange', onFull)
    return () => {
      window.removeEventListener('touchstart', onTouch)
      document.removeEventListener('fullscreenchange', onFull)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const towerSpec = tower && spec ? spec.towers[tower.kind] : null

  function toggleSound() {
    setSound((on) => {
      save('towerdefense:sound', !on)
      gameRef.current?.setSound(!on)
      if (!on) gameRef.current?.unlockAudio()
      return !on
    })
  }

  function toggleFullscreen() {
    if (!canFullscreen()) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
  }

  function cancel() {
    setBuild(null)
    gameRef.current?.select(null, null)
  }

  /** 按了下面的塔：選了空格就直接蓋在那一格，不然進入（或離開）蓋塔模式 */
  function pickKind(kind: TowerId) {
    if (!home) return
    if (cell !== null) {
      if (!afford(kind)) return
      party.act({ type: 'build', cell, kind })
      gameRef.current?.select(null, null)
      return
    }
    gameRef.current?.select(null, null)
    setBuild((b) => (b === kind ? null : kind))
  }

  function changeLook(field: number) {
    setLook(field)
    setBuild(null)
    if (me !== null) party.act({ type: 'look', field })
  }

  function setReadyFlag(on: boolean) {
    if (me === null) return
    party.act({ type: 'ready', ready: on })
    setFlags((f) => f.map((v, i) => (i === me ? on : v)))
  }

  function cycleSpeed() {
    if (!my) return
    party.act({ type: 'speed', speed: (my.speed % 3) + 1 })
  }

  /** 可以拆、改瞄準：自己的，或主人是電腦、不在線上 */
  const canManage =
    home && tower !== null && view !== null && (tower.owner === me || view.bots.includes(tower.owner) || view.players[tower.owner]?.online === false)

  function leaveRoom() {
    setMenu(false)
    party.leave()
  }

  /** 離開遊戲：從遊戲室來的回遊戲室 */
  function exit() {
    navigate(lobby.code ? lobbyPath(lobby.code) : '/games')
  }

  function startPractice() {
    gameRef.current?.unlockAudio()
    practice.current = true
    void party.create()
  }

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const g = gameRef.current
      if (!battle || !g || !spec) {
        if (e.code === 'KeyM') toggleSound()
        return
      }
      if (e.code === 'Tab') {
        e.preventDefault()
        if (!e.repeat) setBoard((b) => !b)
        return
      }
      const step = e.shiftKey ? 3 : 1.2
      switch (e.code) {
        case 'ArrowLeft':
        case 'KeyA':
          return g.nudge(-step, 0)
        case 'ArrowRight':
        case 'KeyD':
          return g.nudge(step, 0)
        case 'ArrowUp':
        case 'KeyW':
          return g.nudge(0, step)
        case 'ArrowDown':
        case 'KeyS':
          return g.nudge(0, -step)
        case 'KeyQ':
          return g.turn(-0.12)
        case 'KeyE':
          return g.turn(0.12)
        case 'Equal':
        case 'NumpadAdd':
          return g.zoom(0.9)
        case 'Minus':
        case 'NumpadSubtract':
          return g.zoom(1.1)
      }
      if (e.repeat) return
      if (/^Digit[1-9]$/.test(e.code)) {
        const t = spec.towers[Number(e.code.slice(5)) - 1]
        if (t) pickKind(t.id)
        return
      }
      switch (e.code) {
        case 'Escape':
          e.preventDefault()
          if (build || tower !== null || cell !== null) cancel()
          else if (board) setBoard(false)
          else if (sending) setSending(false)
          else if (!ended) setMenu((m) => !m)
          break
        case 'KeyU':
          if (tower && home) party.act({ type: 'upgrade', id: tower.id })
          break
        case 'KeyX':
        case 'Delete':
          if (tower && canManage) party.act({ type: 'sell', id: tower.id })
          break
        case 'Space':
          e.preventDefault()
          if (active && me !== null) setReadyFlag(!flags[me])
          break
        case 'Home':
        case 'Digit0':
          g.resetView()
          break
        case 'KeyM':
          toggleSound()
          break
        case 'KeyF':
          toggleFullscreen()
          break
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  })

  const exitLabel = lobby.code ? '回到遊戲室' : '回到小遊戲'
  const present = view ? view.players.map((p, s) => ({ p, s })).filter(({ p, s }) => !view.bots.includes(s) && p.online && !p.out) : []
  const lookOwner = view && versus ? view.players.findIndex((p) => p.field === look) : -1
  const buildSpec = spec?.towers.find((t) => t.id === build) ?? null
  const peekSpec = spec?.towers.find((t) => t.id === peek) ?? null

  return (
    <IconsContext value={icons}>
      <div className={`td-root${touch ? ' touch' : ''}`} onPointerDown={() => gameRef.current?.unlockAudio()}>
        {spec && <div className="td-view" ref={mountGame} />}

        {battle && spec && (
          <>
            <div className="td-top" ref={topBar}>
              <div className="td-top-start">
                <button
                  type="button"
                  className="td-icon"
                  onClick={() => window.confirm('離開這個房間？') && leaveRoom()}
                  aria-label="離開房間"
                  title="離開房間"
                >
                  <Glyph name="back" />
                </button>
                <Resources view={view} stats={stats} seat={me} look={look} income={income} leak={leak} />
              </div>
              <WaveBar
                view={view}
                spec={spec}
                stats={stats}
                look={look}
                ready={me !== null && flags[me] === true}
                readyCount={present.filter(({ s }) => flags[s]).length}
                readyTotal={present.length}
                canAct={active}
                onReady={setReadyFlag}
              />
              <div className="td-top-end">
                {my && !ended && (
                  <button
                    type="button"
                    className={`td-icon td-speed${view.speed > 1 ? ' on' : ''}`}
                    onClick={cycleSpeed}
                    title="遊戲速度：照所有人裡最慢的那個（大家都調快才會變快）"
                    aria-label={`遊戲速度：你選 ${my.speed} 倍，現在 ${view.speed} 倍`}
                  >
                    <Glyph name="speed" size={16} />
                    <small>{my.speed === view.speed ? `${view.speed}×` : `${my.speed}→${view.speed}×`}</small>
                  </button>
                )}
                <button
                  type="button"
                  className={`td-icon${board ? ' on' : ''}`}
                  onClick={() => setBoard((b) => !b)}
                  aria-pressed={board}
                  aria-label="玩家"
                  title="玩家（Tab）"
                >
                  <Glyph name="players" />
                </button>
                {!ended && (
                  <button type="button" className="td-icon" onClick={() => setMenu(true)} aria-label="選單" title="選單（Esc）">
                    <Glyph name="menu" />
                  </button>
                )}
                {canFullscreen() && (
                  <button
                    type="button"
                    className="td-icon td-wide-only"
                    onClick={toggleFullscreen}
                    aria-pressed={fullscreen}
                    aria-label={fullscreen ? '離開全螢幕' : '全螢幕'}
                    title={fullscreen ? '離開全螢幕（F）' : '全螢幕（F）'}
                  >
                    <Glyph name={fullscreen ? 'shrink' : 'expand'} />
                  </button>
                )}
              </div>
            </div>

            {leak > 0 && <div className="td-leak" key={leak} aria-hidden="true" />}
            {banner && <WaveBanner key={banner.key} wave={banner.wave} groups={banner.groups} spec={spec} />}

            {feed.length > 0 && (
              <ol className="td-feed" aria-live="polite">
                {feed.map((f) => (
                  <li key={f.id} className={`td-chip ${f.tone}`}>
                    {f.text}
                  </li>
                ))}
              </ol>
            )}
            {toast && (
              <div className={`td-toast td-chip ${toast.tone}`} key={toast.id} role="status">
                {toast.text}
              </div>
            )}

            {board && (
              <div className="td-side td-chip">
                <div className="td-info-head">
                  <strong>玩家</strong>
                  <button type="button" className="td-x" onClick={() => setBoard(false)} aria-label="關閉">
                    <Glyph name="close" size={18} />
                  </button>
                </div>
                <Players
                  party={party}
                  view={view}
                  stats={stats}
                  look={look}
                  target={target}
                  aim={aim}
                  onLook={changeLook}
                  onGive={(seat, amount) => party.act({ type: 'give', seat, amount })}
                  onAim={(seat) => party.act({ type: 'aim', seat })}
                />
              </div>
            )}

            {!ended && (
              <div className="td-dock">
                <PartyNotice party={party} />
                {(me === null || my?.out || (versus && my && look !== my.field)) && (
                  <div className="td-chip td-watch">
                    <span>
                      {me === null ? '觀戰中' : my?.out ? `你出局了（第 ${my.place} 名）` : '觀看中'}
                      {versus && lookOwner >= 0 && (
                        <>
                          ：<strong>{seatName(party, lookOwner)}</strong> 的場地
                        </>
                      )}
                    </span>
                    {my && !my.out && look !== my.field && (
                      <button type="button" onClick={() => changeLook(my.field)}>
                        回到我的場地
                      </button>
                    )}
                    {versus && (me === null || my?.out) && (
                      <button type="button" className="secondary" onClick={() => changeLook((look + 1) % view.fields.length)}>
                        換一個
                      </button>
                    )}
                  </div>
                )}
                {tower && towerSpec ? (
                  <TowerPanel
                    tower={tower}
                    spec={spec}
                    view={view}
                    stats={stats}
                    seat={me}
                    ownerName={tower.owner === me ? '你蓋的' : `${seatName(party, tower.owner)} 蓋的`}
                    canManage={canManage}
                    canUpgrade={home}
                    onUpgrade={() => party.act({ type: 'upgrade', id: tower.id })}
                    onSell={() => party.act({ type: 'sell', id: tower.id })}
                    onMode={(mode: AimMode) => party.act({ type: 'mode', id: tower.id, mode })}
                    onClose={cancel}
                    onPeekUpgrade={(on) => gameRef.current?.setPeekUpgrade(on)}
                  />
                ) : home && (build || cell !== null) ? (
                  <BuildInfo
                    tower={buildSpec}
                    gain={gain}
                    view={view}
                    stats={stats}
                    seat={me}
                    hint={
                      cell !== null
                        ? '選好格子了：按下面的塔就蓋在這一格'
                        : touch
                          ? '點格子看範圍，再點一次同一格就蓋'
                          : '點格子就蓋；右鍵或 Esc 取消'
                    }
                    onCancel={cancel}
                  />
                ) : home && peekSpec ? (
                  <BuildInfo tower={peekSpec} gain={null} view={view} stats={stats} seat={me} hint="按一下選這種塔，再點格子蓋" />
                ) : null}
                {sending && active && me !== null && versus && (
                  <SendPanel
                    spec={spec}
                    view={view}
                    stats={stats}
                    seat={me}
                    targetName={target !== null ? seatName(party, target) : null}
                    onSend={(unit) => party.act({ type: 'send', unit })}
                  />
                )}
                {active && (
                  <div className="td-dock-row" ref={shopRow}>
                    {versus && (
                      <button
                        type="button"
                        className={`td-send-toggle${sending ? ' on' : ''}`}
                        aria-pressed={sending}
                        onClick={() => setSending((s) => !s)}
                        title="花錢派怪去打別人"
                      >
                        <Glyph name="sword" size={22} />
                        派兵
                      </button>
                    )}
                    <Shop spec={spec} view={view} stats={stats} seat={me} kind={home ? build : null} onPick={pickKind} onPeek={setPeek} disabled={!home} />
                  </div>
                )}
              </div>
            )}

            {menu && !ended && (
              <PauseMenu party={party} touch={touch} sound={sound} onSound={toggleSound} onResume={() => setMenu(false)} onLeave={leaveRoom} />
            )}
            {ended && !hideResults && (
              <Results party={party} view={view} spec={spec} onLeave={leaveRoom} onHide={() => setHideResults(true)} />
            )}
            {ended && hideResults && (
              <button type="button" className="td-chip td-show-results" onClick={() => setHideResults(false)}>
                看結算
              </button>
            )}
            {(party.error || !party.connected) && (
              <div className="td-chip td-offline" role="alert">
                {party.error ?? '連線中斷，重新連線中…'}
              </div>
            )}
          </>
        )}

        {!battle && (
          <>
            <div className="td-top">
              <div className="td-top-start">
                <button type="button" className="td-icon" onClick={exit} aria-label={exitLabel} title={exitLabel}>
                  <Glyph name="back" />
                </button>
              </div>
              <div className="td-top-end">
                <button
                  type="button"
                  className="td-icon"
                  onClick={toggleSound}
                  aria-pressed={sound}
                  aria-label={sound ? '關掉音效' : '打開音效'}
                  title={sound ? '關掉音效（M）' : '打開音效（M）'}
                >
                  <Glyph name={sound ? 'sound' : 'mute'} />
                </button>
              </div>
            </div>
            <div className="td-layer td-menu">
              <div className="td-panel">
                <h1 className="td-title">
                  <TowerArt id="bolt" level={4} size={44} />
                  迷宮塔防
                </h1>
                {error ? (
                  <p className="error">{error}</p>
                ) : spec ? (
                  <Menu party={party} spec={spec} touch={touch} onPractice={startPractice} />
                ) : (
                  <p className="muted">載入中…</p>
                )}
                {!party.code && (
                  <button type="button" className="secondary" onClick={exit}>
                    {exitLabel}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </IconsContext>
  )
}
