import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '../../auth'
import { badgeCount, stars } from './badges'
import { MiniBoards } from './MiniBoards'
import type { MiniInfo } from './minis'
import { Overlay, Segmented, StatusLine } from './ui'
import { MAX_NAME, loadName, saveName, type Arena, type ArenaPlayer, type ArenaState, type Strategy } from './useArena'
import { STRATEGIES, type ArenaMatch } from './useArenaMatch'

/**
 * 大逃殺的畫面（俄羅斯方塊、魔法氣泡共用）：`useArenaMatch`（useArenaMatch.ts）管手上這局和伺服器之間的同步，
 * `ArenaScreen` 排出房間列、狀態列、主盤面和兩側的小盤面、攻擊目標、KO 訊息和大廳。
 * 每個遊戲只要提供 `ArenaEngine`（怎麼開新局、收攻擊、取出要送的攻擊）和自己的主盤面。
 */

export const MAX_PLAYERS = 99
/** 內容區比這寬時，小盤面放在主盤面兩側 */
const WIDE_PX = 760
const BOT_OPTIONS = [0, 10, 30, 60, 98]

/** 從收到的毫秒數往下倒數；`stamp` 換了（收到新的狀態）就從現在重新起算 */
export function Countdown({ ms, stamp, children }: { ms: number; stamp: unknown; children: (left: number) => ReactNode }) {
  const [left, setLeft] = useState(ms)
  useEffect(() => {
    const end = performance.now() + ms
    const id = setInterval(() => setLeft(Math.max(0, end - performance.now())), 100)
    return () => clearInterval(id)
  }, [ms, stamp])
  return <>{children(left)}</>
}

/** 主盤面：`overlay` 蓋在盤面上（倒數、名次），`info` 放在盤面旁邊（徽章、被瞄準） */
export type PlayfieldSlot = (props: { overlay: ReactNode; info: ReactNode; flash: ReactNode }) => ReactNode

export function ArenaScreen<G>({
  match,
  extra,
  playfield,
}: {
  match: ArenaMatch<G>
  /** 房間列多的按鈕（音樂開關） */
  extra?: ReactNode
  playfield: PlayfieldSlot
}) {
  const { engine, arena, state, me, you, running, mine, local } = match
  const wrap = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= WIDE_PX))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const header = <RoomHeader arena={arena} shareTitle={engine.shareTitle} extra={extra} />

  if (!state || !me) {
    return (
      <div ref={wrap} className="arena-online">
        {header}
        {!arena.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const phase = state.phase
  if (phase === 'lobby') {
    return (
      <div ref={wrap} className="arena-online">
        {header}
        <Lobby arena={arena} state={state} me={me} />
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
    if (running && opponents.some((p) => p.pid === pid && p.alive)) arena.send({ type: 'target', pid })
  }
  const half = Math.ceil(minis.length / 2)
  const inRound = state.players.filter((p) => p.inRound)
  const alive = inRound.filter((p) => p.alive).length
  const miniBoards = (list: MiniInfo[], fill: boolean, label: string) => (
    <MiniBoards
      minis={list}
      boards={arena.boards}
      version={arena.boardsVersion}
      fill={fill}
      shape={engine.shape}
      readPalette={engine.readPalette}
      onPick={pick}
      label={label}
    />
  )

  let overlay: ReactNode = null
  if (!me.inRound) {
    overlay = (
      <Overlay>
        <strong className="arena-overlay-title">對局進行中</strong>
        <span>下一局開始時就會加入，先看看大家打得怎樣。</span>
      </Overlay>
    )
  } else if (phase === 'countdown') {
    overlay = (
      <Overlay>
        <Countdown ms={state.endsIn ?? 0} stamp={state}>
          {(left) => <strong className="arena-countdown">{Math.max(1, Math.ceil(left / 1000))}</strong>}
        </Countdown>
        <span>{inRound.length} 人參戰</span>
      </Overlay>
    )
  } else if (!me.alive && me.place !== null) {
    overlay = (
      <Overlay>
        <strong className="arena-overlay-title">{me.place === 1 ? '🏆 第 1 名！' : `第 ${me.place} 名`}</strong>
        <span>
          共 {inRound.length} 人 · KO {me.kos} 人 · 送出 {mine ? local.sent : 0} {engine.unit}
        </span>
        {phase === 'playing' && <span className="muted">還剩 {alive} 人，可以繼續觀戰</span>}
      </Overlay>
    )
  }

  const info = me.inRound && (
    <div className="arena-info">
      <span className="arena-stars">{stars(me.badges)}</span>
      <span>+{badgeCount(me.badges) * 25}%</span>
      {attackers.length > 0 && me.alive && <span className="arena-danger">⚠ {attackers.length} 人瞄準你</span>}
    </div>
  )

  const current = me.manual ? null : me.strategy
  const hint = STRATEGIES.find((s) => s.value === current)?.hint ?? '手動指定的目標'

  return (
    <div ref={wrap} className="arena-online">
      {header}
      <StatusLine tone={me.place === 1 ? 'ok' : undefined}>
        {phase === 'results' ? '這局結束' : `剩 ${alive} / ${inRound.length} 人`} · 速度 {state.level}
        {me.inRound && (
          <span className="arena-muted">
            {' '}
            · KO {me.kos} · <span className="arena-stars">{stars(me.badges)}</span>
          </span>
        )}
      </StatusLine>

      <div className={`arena-field${wide ? ' wide' : ''}`}>
        {wide && miniBoards(minis.slice(0, half), true, '其他玩家（左半）')}
        {playfield({ overlay, info, flash: match.flash })}
        {wide && miniBoards(minis.slice(half), true, '其他玩家（右半）')}
      </div>

      {running && (
        <div className="arena-strategy">
          <Segmented
            label="攻擊目標（1～4，或點小盤面指定）"
            value={(current ?? 'manual') as Strategy}
            options={STRATEGIES.map((s) => ({ value: s.value, label: s.label }))}
            onChange={match.strategy}
          />
          <span className="muted">{hint}</span>
        </div>
      )}

      {!wide && miniBoards(minis, false, '其他玩家')}

      {match.feed.length > 0 && (
        <ul className="arena-feed" aria-live="polite">
          {match.feed.map((f) => (
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

/** 登入的人用帳號名稱；訪客自己取暱稱 */
export function ArenaIdentity({ game }: { game: string }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  const [name, setName] = useState(() => loadName(game))

  function changeName(value: string) {
    const next = [...value].slice(0, MAX_NAME).join('')
    setName(next)
    saveName(game, next.trim())
  }

  if (user) {
    return (
      <p className="muted">
        以 <strong>{user.username}</strong> 的名義參加。
      </p>
    )
  }
  if (loading) return null
  return (
    <>
      <label className="arena-name">
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
}

/** 輸入房間代碼加入 */
export function JoinForm({ arena }: { arena: Arena }) {
  const [draft, setDraft] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    if (draft.trim()) arena.join(draft)
  }

  return (
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
  )
}

/** 房間代碼、邀請與離開，以及連線錯誤 */
function RoomHeader({ arena, shareTitle, extra }: { arena: Arena; shareTitle: string; extra?: ReactNode }) {
  const [copied, setCopied] = useState(false)

  async function share() {
    if (!arena.inviteUrl) return
    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, url: arena.inviteUrl })
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
    <div className="arena-room">
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
        {extra}
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
    <section className="arena-lobby">
      <h2>{state.phase === 'results' ? '下一局' : '等待開始'}</h2>
      <p>
        {humans.length} 位玩家 + {bots} 位電腦，共 <strong>{humans.length + bots}</strong> 人
      </p>
      <ul className="arena-roster">
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
          {(left) => <p className="arena-auto">{Math.ceil(left / 1000)} 秒後自動開始</p>}
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

