import { memo, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { formatTime } from '../shared/format'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party, type PartyRoom } from '../shared/useParty'
import { MineBoard, type CellLook, type Press } from './Board'
import {
  bitAt,
  newerMe,
  seconds,
  type BotLevel,
  type OnMine,
  type RaceLevel,
  type RaceMe,
  type RaceOptions,
  type RaceParty,
  type RacePlayer,
  type RaceView,
} from './raceTypes'
import { TOOL_OPTIONS, type Tool } from './tools'

type RaceRoom = Party<RaceParty>

const LEVELS: { value: RaceLevel; label: string }[] = [
  { value: 'beginner', label: '初級 9×9' },
  { value: 'intermediate', label: '中級 16×16' },
  { value: 'expert', label: '高級 30×16' },
]
const ON_MINE: { value: OnMine; label: string }[] = [
  { value: 'freeze', label: '凍結 5 秒' },
  { value: 'out', label: '直接出局' },
]
const BOTS: { value: BotLevel; label: string }[] = [
  { value: 'easy', label: '簡單' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困難' },
]

/** 線上競速：地雷在伺服器上（backend/src/minesrace.rs），這裡只畫自己的盤面、送動作 */
export function Race({ modeSwitch }: { modeSwitch: ReactNode }) {
  const party = useParty<RaceParty>('minesrace')
  if (!party.code) {
    return (
      <GameLayout side={<Help />}>
        {modeSwitch}
        <PartyEntry party={party}>
          <p>大家同一個盤面、同一個起點，比誰先把地雷區解開。1～8 人，人不夠可以加電腦。</p>
        </PartyEntry>
      </GameLayout>
    )
  }
  // 換房間時把上一個房間收到的盤面丟掉
  return <InRoom key={party.code} party={party} modeSwitch={modeSwitch} />
}

function Help() {
  return (
    <div className="game-help">
      <strong>怎麼玩</strong>
      <ul>
        <li>所有人同一個盤面，起點已經替每個人打開同一塊，比誰先把所有安全格打開。</li>
        <li>地雷只在伺服器上，瀏覽器裡查不到。踩到雷：預設凍結 5 秒（那顆雷會標出來），也可以設成直接出局。</li>
        <li>名次照完成的時間；時間到還沒完成的照完成度排。真人都結束後，電腦最多再等 30 秒。</li>
        <li>對局中只看得到別人大概開到哪裡（每 3×3 一塊的熱度），不會洩漏哪幾格安全；自己結束後才看得到完整的縮圖。</li>
        <li>計分：第 1 名得「人數」分，每差一名少 1 分，沒完成的再少 1 分，同一個房間累計。</li>
        <li>操作和單人一樣：長按或右鍵插旗，點數字快速打開周圍；手機可以切換插旗模式。</li>
        <li>時間上限：初級 5 分鐘、中級 10 分鐘、高級 20 分鐘。</li>
      </ul>
    </div>
  )
}

function InRoom({ party, modeSwitch }: { party: RaceRoom; modeSwitch: ReactNode }) {
  const { room, view, subscribe } = party
  // 自己動作的結果走即時事件（比 view 快），和 view 裡的那份比新舊
  const [eventMe, setEventMe] = useState<RaceMe | null>(null)
  const [chatOpen, setChatOpen] = useState(true)
  useEffect(
    () =>
      subscribe((event) => {
        if (event?.type === 'me') setEventMe(event.me)
      }),
    [subscribe],
  )
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩踩地雷競速"
      extra={
        party.isHost &&
        playing && (
          <button
            type="button"
            className="secondary"
            onClick={() => window.confirm('中止這一局，回到大廳？') && party.abort()}
          >
            中止這局
          </button>
        )
      }
    />
  )
  if (!room) {
    return (
      <div className="ms-race">
        {modeSwitch}
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const side = (
    <>
      {view && room.phase !== 'lobby' && <Standings view={view} room={room} you={party.you} />}
      <details className="ms-race-chat" open={chatOpen} onToggle={(e) => setChatOpen(e.currentTarget.open)}>
        <summary>聊天</summary>
        <ChatBox party={party} />
      </details>
      <Help />
    </>
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="ms-race">
        {modeSwitch}
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>
          <PartyLobby party={party} options={<OptionsForm party={party} />} />
        </GameLayout>
      </div>
    )
  }

  return (
    <div className="ms-race">
      {modeSwitch}
      {header}
      <GameLayout side={side}>
        <RaceBoard party={party} view={view} me={newerMe(view.me, eventMe)} />
        <PartyNotice party={party} />
        {room.phase === 'results' && <PartyLobby party={party} options={<OptionsForm party={party} />} />}
      </GameLayout>
    </div>
  )
}

function OptionsForm({ party }: { party: RaceRoom }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<RaceOptions>) => party.setOptions({ ...o, ...patch })
  const hasBots = room.players.some((p) => p.bot)
  return (
    <div className="ms-race-options">
      <Segmented label="難度" value={o.level} options={LEVELS} onChange={(level) => set({ level })} disabled={!editable} />
      <Segmented
        label="踩到地雷"
        value={o.onMine}
        options={ON_MINE}
        onChange={(onMine) => set({ onMine })}
        disabled={!editable}
      />
      {hasBots && (
        <Segmented label="電腦強度" value={o.bots} options={BOTS} onChange={(bots) => set({ bots })} disabled={!editable} />
      )}
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

/**
 * `stamp` 換了就重新計時：`ms` 毫秒內是 true，時間到變 false。只在開始和結束時 render，不會每一格都重畫。
 * 伺服器送的是「送出當下還剩幾毫秒」，所以收到新的就從現在重新算。
 */
function useActiveFor(ms: number, stamp: unknown): boolean {
  const [state, setState] = useState({ stamp, active: ms > 0 })
  if (state.stamp !== stamp) setState({ stamp, active: ms > 0 })
  useEffect(() => {
    if (ms <= 0) return
    const id = setTimeout(() => setState((s) => (s.stamp === stamp ? { ...s, active: false } : s)), ms)
    return () => clearTimeout(id)
  }, [ms, stamp])
  return state.stamp === stamp ? state.active : ms > 0
}

/** 碼表：從 view 的 elapsed 接著往上數（結束、倒數中不動）；收到新的 view 就重新對時 */
function Stopwatch({ view }: { view: RaceView }) {
  const [version, setVersion] = useState({ view, n: 0 })
  // 在 render 裡依 props 更新 state（和 Party.tsx 的 Countdown 一樣），換了就重掛 Running 重新起算
  if (version.view !== view) setVersion({ view, n: version.n + 1 })
  const running = !view.ended && view.startsIn === 0
  if (!running) return <>{formatTime(Math.floor(view.elapsed / 1000))}</>
  return <Running key={version.n} from={view.elapsed} />
}

function Running({ from }: { from: number }) {
  const [start] = useState(() => performance.now() - from)
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 250)
    return () => clearInterval(id)
  }, [])
  return <>{formatTime(Math.floor(Math.max(from, now - start) / 1000))}</>
}

function cellLook(ch: string, i: number, reveal: string | null): CellLook {
  const mine = reveal !== null && bitAt(reveal, i)
  switch (ch) {
    case '.':
      return mine
        ? { text: '💣', className: 'ms-cell mine', label: '地雷' }
        : { text: '', className: 'ms-cell', label: '未開' }
    case 'F':
      return reveal !== null && !mine
        ? { text: '❌', className: 'ms-cell wrong', label: '插錯的旗' }
        : { text: '🚩', className: 'ms-cell', label: '旗子' }
    case 'X':
      return { text: '💣', className: 'ms-cell open boom', label: '踩到的地雷' }
    case '0':
      return { text: '', className: 'ms-cell open', label: '空白' }
    default:
      return { text: ch, className: `ms-cell open n${ch}`, label: ch }
  }
}

function RaceBoard({ party, view, me }: { party: RaceRoom; view: RaceView; me: RaceMe | null }) {
  const [tool, setTool] = useState<Tool>('dig')
  const counting = useActiveFor(view.startsIn, view)
  const frozen = useActiveFor(me?.frozen ?? 0, me)
  const done = me === null || me.finished !== null || me.out || view.ended
  const canPlay = party.room?.phase === 'playing' && !counting && !frozen && !done

  function onPress(i: number, press: Press) {
    if (!me || !canPlay) return
    const ch = me.board[i]
    // 鍵盤的 F 一律插旗；其他照目前的工具，右鍵或長按做相反的動作
    const flagging = press === 'flag' || (tool === 'flag') !== (press === 'alt')
    if (flagging && (ch === '.' || ch === 'F')) party.act({ type: 'flag', i })
    else if (press === 'flag') return
    else if (ch === '.') party.act({ type: 'open', i })
    // 數字格：周圍的旗數對了就打開其餘的鄰格（伺服器會檢查）
    else if (ch >= '1' && ch <= '8') party.act({ type: 'chord', i })
  }

  const board = me?.board ?? ''
  let marked = 0
  for (const ch of board) if (ch === 'F' || ch === 'X') marked++
  const progress = me ? Math.floor((me.opened * 100) / view.safe) : 0

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  if (counting) {
    status = (
      <>
        準備！ <Countdown ms={view.startsIn} stamp={view} /> 後開始
      </>
    )
    tone = 'accent'
  } else if (me === null) {
    status = view.ended ? '這局結束了' : '觀戰中：下一局才能參加'
  } else if (me.finished !== null) {
    status = view.ended
      ? `🏁 第 ${me.place} 名，${seconds(me.finished)}`
      : `🏁 完成！第 ${me.place} 名，${seconds(me.finished)}`
    tone = 'ok'
  } else if (me.out) {
    status = view.ended ? `💥 出局，第 ${me.place} 名` : '💥 踩到地雷出局了，看看別人吧'
    tone = 'danger'
  } else if (view.ended) {
    status = `時間到，第 ${me.place} 名（完成 ${progress}%）`
  } else if (frozen) {
    status = (
      <>
        💥 踩到地雷！凍結 <Countdown ms={me.frozen} stamp={me} />
      </>
    )
    tone = 'danger'
  } else {
    status = tool === 'flag' ? '插旗模式：點格子插旗／拔旗' : '長按或右鍵插旗；點數字可快速打開周圍'
  }

  return (
    <div className="ms-race-main">
      {me !== null && !view.ended && (
        <Segmented value={tool} options={TOOL_OPTIONS} onChange={setTool} />
      )}
      <div className="ms-bar">
        <span className="ms-counter" aria-label="剩餘雷數">
          💣 {view.mines - marked}
        </span>
        <span className="ms-race-progress" aria-label="完成度">
          {me ? `${progress}%` : '觀戰'}
        </span>
        <span className="ms-counter" aria-label="經過時間">
          ⏱ <Stopwatch view={view} />
        </span>
      </div>
      <StatusLine tone={tone}>{status}</StatusLine>
      {!view.ended && view.endsIn !== null && view.endsIn < 60_000 && !counting && (
        <p className="muted ms-race-left">
          離結算還有 <Countdown ms={view.endsIn} stamp={view} />
        </p>
      )}
      {me ? (
        <MineBoard
          cols={view.cols}
          rows={view.rows}
          look={(i) => cellLook(board[i], i, view.reveal)}
          onPress={onPress}
          done={done}
          className={frozen ? 'frozen' : counting ? 'waiting' : undefined}
        />
      ) : (
        <p className="muted">觀戰中，右邊（手機在下面）看得到每個人的進度。</p>
      )}
    </div>
  )
}

/** 名次和進度；只有 view 或名單換了才重畫（碼表跳動不會連帶重畫這裡） */
const Standings = memo(function Standings({
  view,
  room,
  you,
}: {
  view: RaceView
  room: PartyRoom<RaceOptions>
  you: number | null
}) {
  const name = (seat: number) => room.players.find((p) => p.seat === seat)?.name ?? `座位 ${seat + 1}`
  const player = (seat: number) => room.players.find((p) => p.seat === seat)
  const order = view.players
    .map((p, seat) => ({ p, seat }))
    .sort((a, b) =>
      view.ended
        ? (a.p.place ?? 99) - (b.p.place ?? 99)
        : rank(a.p) - rank(b.p) || b.p.opened - a.p.opened || a.seat - b.seat,
    )
  const mySeat = room.players.find((p) => p.pid === you)?.seat ?? null

  return (
    <section className="ms-race-standings" aria-label="名次">
      <h3>{view.ended ? '結算' : '進度'}</h3>
      <ol>
        {order.map(({ p, seat }) => {
          const info = player(seat)
          const pct = Math.floor((p.opened * 100) / view.safe)
          return (
            <li key={seat} className={seat === mySeat ? 'me' : undefined}>
              <MiniMap view={view} player={p} />
              <div className="ms-race-who">
                <div className="ms-race-name">
                  {p.place !== null && (p.finished !== null || view.ended) && (
                    <span className="ms-race-place">#{p.place}</span>
                  )}
                  <strong>{name(seat)}</strong>
                  {seat === mySeat && <span className="chip subtle">你</span>}
                  {info?.bot && <span className="chip subtle">電腦</span>}
                  {info && !info.bot && !info.online && <span className="chip subtle">離線</span>}
                </div>
                <div className="ms-race-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${pct}%` }} className={p.out ? 'out' : p.finished !== null ? 'done' : ''} />
                </div>
                <div className="ms-race-meta muted">
                  {p.finished !== null ? (
                    <span className="ok">🏁 {seconds(p.finished)}</span>
                  ) : p.out ? (
                    <span className="danger">💥 出局</span>
                  ) : p.frozen ? (
                    <span className="danger">凍結中</span>
                  ) : (
                    <span>{pct}%</span>
                  )}
                  {p.hits > 0 && <span>踩雷 {p.hits}</span>}
                  <span>{p.points} 分</span>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
})

/** 對局中的排序：完成的照名次排最前面，還在玩的其次，出局的最後（同一組再照開了多少比） */
function rank(p: RacePlayer): number {
  if (p.finished !== null) return p.place ?? 0
  return p.out ? 1000 : 100
}

/**
 * 小盤面：有完整縮圖（自己結束了或整局結束）就畫每一格開了沒，不然畫每 3×3 一塊的熱度。
 * 用 CSS grid 畫，顏色跟著主題。
 */
function MiniMap({ view, player }: { view: RaceView; player: RacePlayer }) {
  if (player.mini !== null) {
    const cells = []
    for (let i = 0; i < view.cols * view.rows; i++) {
      cells.push(<span key={i} className={bitAt(player.mini, i) ? 'o' : undefined} />)
    }
    return (
      <div
        className="ms-mini"
        style={{ '--mc': view.cols, '--mr': view.rows, aspectRatio: `${view.cols} / ${view.rows}` } as CSSProperties}
        aria-hidden="true"
      >
        {cells}
      </div>
    )
  }
  const bc = Math.ceil(view.cols / view.block)
  const br = Math.ceil(view.rows / view.block)
  return (
    <div
      className="ms-mini heat"
      style={{ '--mc': bc, '--mr': br, aspectRatio: `${view.cols} / ${view.rows}` } as CSSProperties}
      aria-hidden="true"
    >
      {Array.from(player.heat.slice(0, bc * br), (h, k) => (
        <span key={k} className={`h${h}`} />
      ))}
    </div>
  )
}
