import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { useAuth } from '../../auth'
import { load, save } from '../shared/storage'
import { GameLayout, Overlay, Segmented, StatusLine, Toolbar } from '../shared/ui'
import type { MiniInfo } from './draw'
import { badgeCount, describe, Tetris } from './engine'
import { MiniBoards } from './MiniBoards'
import { Playfield, type PlayfieldHooks } from './Playfield'
import {
  MAX_NAME,
  loadName,
  saveName,
  useArena,
  type Arena,
  type ArenaPlayer,
  type ArenaState,
  type Strategy,
} from './useArena'
import './tetris.css'

const MAX_PLAYERS = 99
/** 盤面送給伺服器的最短間隔 */
const BOARD_EVERY_MS = 150
/** 內容區比這寬時，小盤面放在主盤面兩側 */
const WIDE_PX = 760

const STRATEGIES: { value: Strategy; label: string; hint: string }[] = [
  { value: 'random', label: '隨機', hint: '每隔幾秒隨機換一個目標' },
  { value: 'ko', label: '快輸的', hint: '瞄準盤面最高、快被頂到的人，搶 KO' },
  { value: 'badges', label: '徽章', hint: '瞄準徽章最多的人，KO 他可以拿走他的徽章' },
  { value: 'attackers', label: '反擊', hint: '同時反擊所有正在打你的人' },
]

const BOT_OPTIONS = [0, 10, 30, 60, 98]

function stars(points: number): string {
  const n = badgeCount(points)
  return '★'.repeat(n) + '☆'.repeat(4 - n)
}

/** 盤面上方閃一下的字 */
function useFlash(): [ReactNode, (text: string | null, sent: number) => void] {
  const [flash, setFlash] = useState<{ id: number; text: string | null; sent: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  function show(text: string | null, sent: number) {
    clearTimeout(timer.current)
    setFlash({ id: Date.now(), text, sent })
    timer.current = setTimeout(() => setFlash(null), 1200)
  }
  const node = flash && (
    <span key={flash.id} className="tetris-flash-text">
      {flash.text && <strong>{flash.text}</strong>}
      {flash.sent > 0 && <span className="tetris-flash-sent">+{flash.sent} 行攻擊</span>}
    </span>
  )
  return [node, show]
}

/** 從收到的毫秒數往下倒數；`stamp` 換了（收到新的狀態）就從現在重新起算 */
function Countdown({ ms, stamp, children }: { ms: number; stamp: unknown; children: (left: number) => ReactNode }) {
  const [left, setLeft] = useState(ms)
  useEffect(() => {
    const end = performance.now() + ms
    const id = setInterval(() => setLeft(Math.max(0, end - performance.now())), 100)
    return () => clearInterval(id)
  }, [ms, stamp])
  return <>{children(left)}</>
}

export default function TetrisGame() {
  const [params] = useSearchParams()
  const [practice, setPractice] = useState(false)
  if (params.get('room')) return <Online />
  if (practice) return <Practice onExit={() => setPractice(false)} />
  return <Menu onPractice={() => setPractice(true)} />
}

function Help() {
  return (
    <>
      <div className="tetris-help">
        <strong>操作</strong>
        <ul>
          <li>← →：左右移動（按住連續移動）</li>
          <li>↓：加速下落；空白鍵：直接落下</li>
          <li>↑ / X：順時針轉；Z / Ctrl：逆時針轉</li>
          <li>C / Shift：保留（Hold）</li>
          <li>1～4：切換攻擊目標</li>
        </ul>
        <p className="muted">手機用盤面下方的按鈕，左右和下可以按住不放。</p>
      </div>
      <div className="tetris-help">
        <strong>規則</strong>
        <ul>
          <li>一次消 2 / 3 / 4 行送出 1 / 2 / 4 行垃圾；T-Spin、連擊、連續高難度消行（B2B）和全消都有加成。</li>
          <li>收到的垃圾行先在左邊量表等 2 秒（黃→紅），這段時間消行可以抵銷；之後放下沒消行的方塊就會升上來。</li>
          <li>把對手頂到出局就是 KO，拿到徽章點數；徽章越多攻擊越強，最多 +100%。</li>
          <li>剩下的人越少，方塊掉得越快。活到最後的人獲勝。</li>
        </ul>
      </div>
    </>
  )
}

function Menu({ onPractice }: { onPractice: () => void }) {
  const arena = useArena({})
  const { user, loading } = useAuth()
  const location = useLocation()
  const [name, setName] = useState(loadName)
  const [draft, setDraft] = useState('')

  function changeName(value: string) {
    const next = [...value].slice(0, MAX_NAME).join('')
    setName(next)
    saveName(next.trim())
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (draft.trim()) arena.join(draft)
  }

  return (
    <GameLayout side={<Help />}>
      <div className="tetris-menu">
        <p className="tetris-intro">
          最多 {MAX_PLAYERS} 人同場的俄羅斯方塊大逃殺。消行會變成垃圾行送給你瞄準的對手，把別人頂到出局就能拿徽章、讓攻擊更強，
          活到最後的人獲勝。人不夠時由電腦補位，一個人也能玩。
        </p>
        {user ? (
          <p className="muted">
            以 <strong>{user.username}</strong> 的名義參加。
          </p>
        ) : (
          !loading && (
            <>
              <label className="tetris-name">
                <span>暱稱</span>
                <input
                  value={name}
                  onChange={(e) => changeName(e.target.value)}
                  placeholder="訪客"
                  maxLength={MAX_NAME * 2}
                  autoComplete="nickname"
                />
              </label>
              <p className="muted">
                <Link to="/login" state={{ from: location.pathname + location.search }}>
                  登入
                </Link>
                後會用帳號名稱，換分頁或裝置也回得到同一局。
              </p>
            </>
          )
        )}
        <div className="tetris-menu-actions">
          <button type="button" onClick={() => arena.create(true)} disabled={arena.busy || loading}>
            快速配對
          </button>
          <button type="button" className="secondary" onClick={() => arena.create(false)} disabled={arena.busy || loading}>
            建立私人房間
          </button>
          <button type="button" className="secondary" onClick={onPractice}>
            單人練習
          </button>
        </div>
        <form className="inline-form" onSubmit={submit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            placeholder="房間代碼"
            maxLength={8}
            autoCapitalize="characters"
            autoComplete="off"
            aria-label="房間代碼"
          />
          <button type="submit" className="secondary" disabled={!draft.trim()}>
            加入
          </button>
        </form>
        {arena.error && <p className="error">{arena.error}</p>}
        <p className="muted">
          快速配對會加入正在等人的公開房間，兩個人以上就開始 20 秒倒數；私人房間把代碼或邀請連結給朋友，由房主決定電腦人數和開始時間。
        </p>
      </div>
    </GameLayout>
  )
}

type PracticePhase = 'running' | 'paused' | 'over'

function Practice({ onExit }: { onExit: () => void }) {
  const [initial] = useState(() => new Tetris())
  const game = useRef<Tetris | null>(initial)
  const [phase, setPhase] = useState<PracticePhase>('running')
  const [hud, setHud] = useState({ lines: 0, level: 1 })
  const [best, setBest] = useState(() => load<number>('tetris:best', 0))
  const [flash, showFlash] = useFlash()

  function restart() {
    game.current = new Tetris()
    setHud({ lines: 0, level: 1 })
    setPhase('running')
  }

  function frame() {
    const g = game.current
    if (!g) return
    for (const r of g.events.splice(0)) {
      const label = describe(r)
      if (label) showFlash(label, 0)
    }
    // 每消 10 行升一級
    g.level = Math.min(15, 1 + Math.floor(g.lines / 10))
    if (g.lines !== hud.lines || g.level !== hud.level) setHud({ lines: g.lines, level: g.level })
    if (g.over && phase === 'running') {
      setPhase('over')
      if (g.lines > best) {
        setBest(g.lines)
        save('tetris:best', g.lines)
      }
    }
  }

  function onKey(code: string): boolean {
    if (code === 'Escape' || code === 'KeyP') {
      if (phase === 'running') setPhase('paused')
      else if (phase === 'paused') setPhase('running')
      return phase !== 'over'
    }
    return false
  }

  const hooks = useRef<PlayfieldHooks>({})
  useEffect(() => {
    hooks.current = { onFrame: frame, onKey }
  })

  useEffect(() => {
    const hide = () => {
      if (document.hidden) setPhase((p) => (p === 'running' ? 'paused' : p))
    }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [])

  const record = phase === 'over' && hud.lines > 0 && hud.lines >= best
  const overlay =
    phase === 'paused' ? (
      <Overlay>
        <strong className="tetris-overlay-title">⏸ 已暫停</strong>
        <button type="button" onClick={() => setPhase('running')}>
          繼續
        </button>
      </Overlay>
    ) : phase === 'over' ? (
      <Overlay>
        <strong className="tetris-overlay-title">遊戲結束</strong>
        <span>
          消了 {hud.lines} 行{record ? '，新紀錄！' : `（最高 ${best} 行）`}
        </span>
        <button type="button" onClick={restart}>
          再玩一次
        </button>
      </Overlay>
    ) : null

  return (
    <GameLayout side={<Help />}>
      <StatusLine tone={phase === 'over' ? 'danger' : undefined}>
        {hud.lines} 行 · 等級 {hud.level}
        <span className="tetris-muted"> · 最高 {Math.max(best, hud.lines)} 行</span>
      </StatusLine>
      <Playfield
        game={game}
        running={phase === 'running'}
        hooks={hooks}
        overlay={overlay}
        flash={flash}
      />
      <Toolbar>
        <button
          type="button"
          className="secondary"
          onClick={() => setPhase(phase === 'paused' ? 'running' : 'paused')}
          disabled={phase === 'over'}
        >
          {phase === 'paused' ? '▶ 繼續' : '⏸ 暫停'}
        </button>
        <button type="button" className="secondary" onClick={restart}>
          重新開始
        </button>
        <button type="button" className="secondary" onClick={onExit}>
          回到選單
        </button>
      </Toolbar>
    </GameLayout>
  )
}

type Feed = { id: number; text: string; mine: boolean }

function Online() {
  const game = useRef<Tetris | null>(null)
  /** 手上這局是伺服器的第幾局 */
  const round = useRef(0)
  const topoutSent = useRef(0)
  const board = useRef({ last: 0, dirty: false })
  const stateRef = useRef<ArenaState | null>(null)
  const youRef = useRef<number | null>(null)
  const [flash, showFlash] = useFlash()
  const [feed, setFeed] = useState<Feed[]>([])
  /** 畫面用：手上這局的局數和送出的行數 */
  const [local, setLocal] = useState({ round: 0, sent: 0 })

  const arena = useArena({
    onGarbage: (lines) => {
      const g = game.current
      if (g && !g.over && round.current === stateRef.current?.round) {
        g.receive(lines)
        board.current.dirty = true
      }
    },
    onKo: ({ victim, killer, place }) => {
      const players = stateRef.current?.players ?? []
      const name = (pid: number | null) => players.find((p) => p.pid === pid)?.name ?? '?'
      const you = youRef.current
      const text =
        killer === null
          ? `${name(victim)} 出局（第 ${place} 名）`
          : `${killer === you ? '你' : name(killer)} KO 了 ${victim === you ? '你' : name(victim)}`
      const mine = killer === you || victim === you
      if (killer === you) showFlash('K.O.', 0)
      setFeed((prev) => [{ id: Date.now() + Math.random(), text, mine }, ...prev].slice(0, 6))
    },
  })
  const { state, you } = arena
  const me = state?.players.find((p) => p.pid === you) ?? null
  useEffect(() => {
    stateRef.current = state
    youRef.current = you
  })

  const send = arena.send
  const roundNo = state?.round ?? 0
  const phase = state?.phase
  const playing = !!me?.inRound && !!me.alive
  const mine = local.round === roundNo
  const running = phase === 'playing' && playing && mine

  function sendBoard() {
    const g = game.current
    if (!g) return
    board.current = { last: performance.now(), dirty: false }
    send({ type: 'board', rows: g.snapshot(), pending: g.pending() })
  }

  function frame() {
    if (!state || !me) return
    // 新的一局開始倒數時開新盤面；重連回來發現手上沒有這局的盤面（重新整理過），就只能認輸
    if (playing && round.current !== roundNo) {
      if (phase === 'countdown') {
        game.current = new Tetris()
        round.current = roundNo
        topoutSent.current = 0
        setLocal({ round: roundNo, sent: 0 })
      } else if (phase === 'playing' && topoutSent.current !== roundNo) {
        topoutSent.current = roundNo
        send({ type: 'topout' })
      }
      return
    }
    const g = game.current
    if (!g || !mine) return
    if (g.sent !== local.sent) setLocal({ round: roundNo, sent: g.sent })
    g.level = state.level
    g.badges = me.badges
    for (const r of g.events.splice(0)) {
      if (r.sent > 0) send({ type: 'attack', lines: r.sent })
      const label = describe(r)
      if (label || r.sent > 0) showFlash(label, r.sent)
      board.current.dirty = true
    }
    if (g.over && running && topoutSent.current !== roundNo) {
      sendBoard()
      topoutSent.current = roundNo
      send({ type: 'topout' })
      return
    }
    if (running && board.current.dirty && performance.now() - board.current.last >= BOARD_EVERY_MS) sendBoard()
  }

  function strategy(value: Strategy) {
    send({ type: 'strategy', strategy: value })
  }

  function onKey(code: string): boolean {
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(code)
    if (n < 0 || !running) return false
    strategy(STRATEGIES[n].value)
    return true
  }

  const hooks = useRef<PlayfieldHooks>({})
  useEffect(() => {
    hooks.current = { onFrame: frame, onKey }
  })

  const wrap = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= WIDE_PX))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const header = <RoomHeader arena={arena} />

  if (!state || !me) {
    return (
      <div ref={wrap} className="tetris-online">
        {header}
        {!arena.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const opponents = state.players.filter((p) => p.pid !== you)
  const attackers = opponents.filter((p) => p.alive && p.target === you)
  const minis: MiniInfo[] = opponents.map((p) => ({
    pid: p.pid,
    alive: p.alive,
    place: p.place,
    targeted: me.alive && me.target === p.pid,
    attacker: me.alive && p.alive && p.target === you,
    waiting: !p.inRound,
  }))
  const pick = (pid: number) => {
    if (running && opponents.some((p) => p.pid === pid && p.alive)) send({ type: 'target', pid })
  }
  const half = Math.ceil(minis.length / 2)
  const inRound = state.players.filter((p) => p.inRound)
  const alive = inRound.filter((p) => p.alive).length

  if (phase === 'lobby') {
    return (
      <div ref={wrap} className="tetris-online">
        {header}
        <Lobby arena={arena} state={state} me={me} />
      </div>
    )
  }

  let overlay: ReactNode = null
  if (!me.inRound) {
    overlay = (
      <Overlay>
        <strong className="tetris-overlay-title">對局進行中</strong>
        <span>下一局開始時就會加入，先看看大家打得怎樣。</span>
      </Overlay>
    )
  } else if (phase === 'countdown') {
    overlay = (
      <Overlay>
        <Countdown ms={state.endsIn ?? 0} stamp={state}>
          {(left) => <strong className="tetris-countdown">{Math.max(1, Math.ceil(left / 1000))}</strong>}
        </Countdown>
        <span>{inRound.length} 人參戰</span>
      </Overlay>
    )
  } else if (!me.alive && me.place !== null) {
    overlay = (
      <Overlay>
        <strong className="tetris-overlay-title">{me.place === 1 ? '🏆 第 1 名！' : `第 ${me.place} 名`}</strong>
        <span>
          共 {inRound.length} 人 · KO {me.kos} 人 · 送出 {mine ? local.sent : 0} 行
        </span>
        {phase === 'playing' && <span className="muted">還剩 {alive} 人，可以繼續觀戰</span>}
      </Overlay>
    )
  }

  const current = me.manual ? null : me.strategy
  const hint = STRATEGIES.find((s) => s.value === current)?.hint ?? '手動指定的目標'

  return (
    <div ref={wrap} className="tetris-online">
      {header}
      <StatusLine tone={me.place === 1 ? 'ok' : undefined}>
        {phase === 'results' ? '這局結束' : `剩 ${alive} / ${inRound.length} 人`} · 速度 {state.level}
        {me.inRound && (
          <span className="tetris-muted">
            {' '}
            · KO {me.kos} · <span className="tetris-stars">{stars(me.badges)}</span>
          </span>
        )}
      </StatusLine>

      <div className={`tetris-arena${wide ? ' wide' : ''}`}>
        {wide && (
          <MiniBoards
            minis={minis.slice(0, half)}
            boards={arena.boards}
            version={arena.boardsVersion}
            fill
            onPick={pick}
            label="其他玩家（左半）"
          />
        )}
        <Playfield
          game={game}
          running={running}
          hooks={hooks}
          overlay={overlay}
          flash={flash}
          info={
            me.inRound && (
              <div className="tetris-info">
                <span className="tetris-stars">{stars(me.badges)}</span>
                <span>+{badgeCount(me.badges) * 25}%</span>
                {attackers.length > 0 && me.alive && <span className="tetris-danger">⚠ {attackers.length} 人瞄準你</span>}
              </div>
            )
          }
        />
        {wide && (
          <MiniBoards
            minis={minis.slice(half)}
            boards={arena.boards}
            version={arena.boardsVersion}
            fill
            onPick={pick}
            label="其他玩家（右半）"
          />
        )}
      </div>

      {running && (
        <div className="tetris-strategy">
          <Segmented
            label="攻擊目標（1～4，或點小盤面指定）"
            value={(current ?? 'manual') as Strategy}
            options={STRATEGIES.map((s) => ({ value: s.value, label: s.label }))}
            onChange={strategy}
          />
          <span className="muted">{hint}</span>
        </div>
      )}

      {!wide && (
        <MiniBoards
          minis={minis}
          boards={arena.boards}
          version={arena.boardsVersion}
          fill={false}
          onPick={pick}
          label="其他玩家"
        />
      )}

      {feed.length > 0 && (
        <ul className="tetris-feed" aria-live="polite">
          {feed.map((f) => (
            <li key={f.id} className={f.mine ? 'mine' : ''}>
              {f.text}
            </li>
          ))}
        </ul>
      )}

      {phase === 'results' && <Lobby arena={arena} state={state} me={me} />}
    </div>
  )
}

/** 房間代碼、邀請與離開，以及連線錯誤 */
function RoomHeader({ arena }: { arena: Arena }) {
  const [copied, setCopied] = useState(false)

  async function share() {
    if (!arena.inviteUrl) return
    if (navigator.share) {
      try {
        await navigator.share({ title: '一起來玩俄羅斯方塊', url: arena.inviteUrl })
        return
      } catch {
        // 使用者取消分享，改成複製
      }
    }
    try {
      await navigator.clipboard.writeText(arena.inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('複製這個連結給朋友：', arena.inviteUrl)
    }
  }

  return (
    <div className="tetris-room">
      <div className="room-code">
        <span className="muted">房間</span>
        <strong>{arena.code}</strong>
        {arena.state?.public && <span className="chip subtle">公開配對</span>}
        {arena.code && !arena.connected && !arena.error && <span className="muted">連線中…</span>}
      </div>
      <div className="game-toolbar">
        {arena.errorCode === 'replaced' && (
          <button type="button" onClick={arena.reconnect}>
            在這裡繼續
          </button>
        )}
        <button type="button" className="secondary" onClick={share}>
          {copied ? '已複製連結' : '邀請朋友'}
        </button>
        <button type="button" className="secondary" onClick={arena.leave}>
          離開房間
        </button>
      </div>
      {arena.error && <p className="error">{arena.error}</p>}
    </div>
  )
}

function Lobby({ arena, state, me }: { arena: Arena; state: ArenaState; me: ArenaPlayer }) {
  const humans = state.players.filter((p) => !p.bot)
  const host = state.host === me.pid
  const room = MAX_PLAYERS - humans.length
  const bots = Math.min(state.bots, room)
  const canStart = humans.length + bots >= 2

  return (
    <section className="tetris-lobby">
      <h2>{state.phase === 'results' ? '下一局' : '等待開始'}</h2>
      <p>
        {humans.length} 位玩家 + {bots} 位電腦，共 <strong>{humans.length + bots}</strong> 人
      </p>
      <ul className="tetris-roster">
        {humans.map((p) => (
          <li key={p.pid} className={p.pid === me.pid ? 'me' : ''}>
            {p.name}
            {p.pid === state.host && <span className="chip subtle">房主</span>}
            {p.pid === me.pid && <span className="chip subtle">你</span>}
          </li>
        ))}
      </ul>
      {host ? (
        <Segmented
          label="電腦玩家"
          value={BOT_OPTIONS.includes(state.bots) ? state.bots : -1}
          options={BOT_OPTIONS.map((n) => ({ value: n, label: n === 98 ? '補滿 99 人' : `${n} 位`, disabled: n > room }))}
          onChange={(count) => arena.send({ type: 'bots', count })}
        />
      ) : (
        <p className="muted">電腦玩家由房主決定。</p>
      )}
      {state.public && state.endsIn !== null && (
        <Countdown ms={state.endsIn} stamp={state}>
          {(left) => <p className="tetris-auto">{Math.ceil(left / 1000)} 秒後自動開始</p>}
        </Countdown>
      )}
      {state.public && state.endsIn === null && humans.length < 2 && (
        <p className="muted">再一個人加入就開始 20 秒倒數；不想等可以直接開始，和電腦對戰。</p>
      )}
      {host ? (
        <button type="button" onClick={() => arena.send({ type: 'start' })} disabled={!canStart || !arena.connected}>
          {state.phase === 'results' ? '再來一局' : '開始'}
        </button>
      ) : (
        <p className="muted">等房主開始…</p>
      )}
      {host && !canStart && <p className="muted">至少要兩個人，或加上電腦玩家。</p>}
    </section>
  )
}
