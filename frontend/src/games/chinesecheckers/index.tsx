import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  CELLS,
  PIECES,
  cornerTriangle,
  destinations,
  distance,
  layout,
  polygon,
  roundedOutline,
  starOutline,
  target,
  turnsFor,
  type Point,
} from './board'
import {
  COLOR_NAMES,
  THINK_CHOICES,
  type CcOptions,
  type CcView,
  type ChineseCheckersParty,
} from './types'
import './chinesecheckers.css'

type CcParty = Party<ChineseCheckersParty>
type NameOf = (seat: number) => string

/** 跳棋：規則都在伺服器（backend/src/chinesecheckers.rs），這裡畫 view、算出能走的格子和路徑、送動作 */
export default function ChineseCheckers() {
  const party = useParty<ChineseCheckersParty>('chinesecheckers')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>六角星棋盤上的跳棋：走一步，或連續跳過別人的棋，先把 10 顆棋全部走進對面角落的人贏。2～6 人，人不夠可以加電腦。</p>
        </PartyEntry>
      </GameLayout>
    )
  }
  return <InRoom party={party} />
}

function Rules({ options, limit = 150, spoil = 30 }: { options?: CcOptions; limit?: number; spoil?: number }) {
  const o = options
  return (
    <div className="game-help">
      <strong>怎麼玩</strong>
      <ul>
        <li>每人 10 顆棋，從星形的一個角出發，先把棋全部走進正對面那個角的人贏。棋盤會轉成你的角在最下面。</li>
        <li>
          輪到你時動一顆棋：走到相鄰的空格；或跳過相鄰的一顆棋（誰的都可以）落到正後方的空格。跳完可以接著跳、想停就停，但走一步就不能再跳。
        </li>
        {o?.longJumps && (
          <li>長跳：同一直線上隔著空格的棋也能跳，棋前後的空格要一樣多，例如隔兩個空格的棋，跳過去落在它後面第三格。</li>
        )}
        <li>
          防堵：目標的 10 格都有棋、而且至少一顆是你的，就算走完。別人的棋要等它的主人走滿 {spoil} 手（或已經走完）才算你的，
          賴在你目標裡不走的棋等於幫你填格子。
        </li>
        <li>
          {o?.fullRanking
            ? '排出所有名次：走完的人之後跳過、棋拿下棋盤（免得擋住別人），剩最後一個人時結束。'
            : '第一個人走完就結束，其他人照進度排名。'}
          每局第一名 +1，在同一個房間累計。
        </li>
        <li>每人最多走 {limit} 手，大家都走滿還沒分出勝負就照進度（棋離目標多遠）排名。</li>
        <li>{o && o.thinkSecs > 0 ? `每手有 ${o.thinkSecs} 秒，` : ''}時間到或斷線，由電腦代走這一手。</li>
        <li>用到的角：2 人對角、3 人隔一個角、4 人兩組對角、5 人空一個角、6 人全部。</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: CcParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來下跳棋"
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
      <div className="cc">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const side = (
    <>
      <ChatBox party={party} />
      <Rules options={view?.options ?? room.options} limit={view?.moveLimit} spoil={view?.spoilAfter} />
    </>
  )
  const lobby = (
    <PartyLobby
      party={party}
      options={<OptionsForm party={party} />}
      hint={<p className="muted">2～6 人，人不夠可以加電腦玩家。</p>}
    />
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="cc">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>{lobby}</GameLayout>
      </div>
    )
  }

  return (
    <div className="cc">
      {header}
      <GameLayout side={side}>
        <Game key={view.game} party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && lobby}
      </GameLayout>
    </div>
  )
}

function OptionsForm({ party }: { party: CcParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<CcOptions>) => party.setOptions({ ...o, ...patch })

  return (
    <div className="cc-options">
      <Segmented
        label="思考時間（每手）"
        value={o.thinkSecs}
        options={THINK_CHOICES.map((s) => ({ value: s, label: s === 0 ? '不限' : `${s} 秒` }))}
        onChange={(thinkSecs) => set({ thinkSecs })}
        disabled={!editable}
      />
      <Segmented
        label="跳法"
        value={o.longJumps ? 1 : 0}
        options={[
          { value: 0, label: '一般' },
          { value: 1, label: '長跳（對稱跳）' },
        ]}
        onChange={(v) => set({ longJumps: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="結束"
        value={o.fullRanking ? 1 : 0}
        options={[
          { value: 0, label: '有人走完就結束' },
          { value: 1, label: '排出所有名次' },
        ]}
        onChange={(v) => set({ fullRanking: v === 1 })}
        disabled={!editable}
      />
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

/** 一個座位的顏色名，例如「紅」 */
const colorName = (seat: number) => COLOR_NAMES[seat] ?? ''

function Game({ party, view }: { party: CcParty; view: CcView }) {
  const me = view.you
  const name: NameOf = (seat) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const ended = view.stage === 'end'
  const myRank = me !== null ? view.seats[me].rank : null
  const myTurn = me !== null && view.turn === me && !ended
  const [picked, setPicked] = useState<number | null>(null)
  // 送出後到收到新的 view（或被拒絕）之前不能再送，避免連點送兩次
  const [sent, setSent] = useState<{ view: CcView; notice: number | undefined } | null>(null)
  const waiting = sent !== null && sent.view === view && sent.notice === party.notice?.id
  const mine = me === null ? null : String(me)
  const selected = picked !== null && mine !== null && !ended && myRank === null && view.board[picked] === mine ? picked : null
  const dests = useMemo(
    () => (selected === null ? new Map<number, number[]>() : destinations(view.board, selected, view.options.longJumps)),
    [view.board, selected, view.options.longJumps],
  )

  function tap(cell: number | null) {
    if (cell !== null && mine !== null && view.board[cell] === mine && !ended && myRank === null) {
      setPicked(cell === selected ? null : cell)
      return
    }
    const path = cell === null ? undefined : dests.get(cell)
    if (path && myTurn && !waiting) {
      party.act({ type: 'move', path })
      setSent({ view, notice: party.notice?.id })
      setPicked(null)
      return
    }
    // 還沒輪到你時點能到的格子：留著選取，只是不能走
    if (path) return
    setPicked(null)
  }

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  if (ended && view.result) {
    const winner = view.result.ranking[0]
    const won = winner === me
    if (view.result.reason === 'limit') {
      status = won ? '步數用完了，照進度排名：你贏了！' : `步數用完了，照進度排名：${name(winner)} 贏了`
    } else {
      status = won ? '你走完了，這局你贏！' : `${name(winner)} 走完了！`
    }
    tone = me === null || won ? 'ok' : 'danger'
  } else if (myRank !== null) {
    status = `你走完了，第 ${myRank} 名！等其他人排出名次…`
    tone = 'ok'
  } else if (myTurn) {
    status = selected === null ? '輪到你：點一顆自己的棋' : dests.size > 0 ? '輪到你：點亮起來的格子' : '這顆棋動不了，換一顆'
    tone = 'accent'
  } else if (view.turn !== null) {
    status = `${name(view.turn)}（${colorName(view.turn)}）思考中…`
  }

  const last = view.last
  const lastText =
    last === null
      ? null
      : last.path.length === 2 && distance(last.path[0], last.path[1]) === 1
        ? `${name(last.seat)} 走了一步`
        : `${name(last.seat)} 跳了 ${last.path.length - 1} 次`

  return (
    <div className="cc-game">
      <StatusLine tone={tone}>
        {status} {!ended && myRank === null && <Countdown ms={view.endsIn} stamp={view} />}
      </StatusLine>
      <div className="board-box cc-box">
        <Board view={view} me={me} selected={selected} dests={dests} active={myTurn && !waiting} onTap={tap} />
      </div>
      <div className="cc-under">
        <p className="muted cc-hint">
          {me !== null && (
            <>
              你是<span className={`cc-dot cc-seat-${me}`} aria-hidden />
              {colorName(me)}色。
            </>
          )}
          {lastText && `上一手：${lastText}。`}
        </p>
        {selected !== null && (
          <button type="button" className="secondary" onClick={() => setPicked(null)}>
            取消選取
          </button>
        )}
      </div>
      <SeatList party={party} view={view} name={name} />
      {ended && view.result && <Result party={party} view={view} name={name} />}
      <p className="muted cc-game-no">第 {view.game} 局</p>
    </div>
  )
}

/** 相鄰兩格的距離（SVG 單位）。棋盤最外圈的洞左右到 ±6、上下到 ±6.93，四周留一點邊（css 的寬高比要跟著改） */
const U = 10
const VIEW_W = 13.8 * U
const VIEW_H = 15.8 * U

function Board({
  view,
  me,
  selected,
  dests,
  active,
  onTap,
}: {
  view: CcView
  me: number | null
  selected: number | null
  dests: Map<number, number[]>
  /** 輪到自己、可以送出 */
  active: boolean
  onTap: (cell: number | null) => void
}) {
  // 自己的角轉到最下面；觀戰的人看座位 0 的方向
  const turns = turnsFor(view.corners[me ?? 0])
  const points = useMemo(() => layout(turns, U), [turns])
  const star = useMemo(() => polygon(starOutline(points)), [points])
  const homes = useMemo(
    () => view.corners.map((corner) => polygon(cornerTriangle(points, corner))),
    [points, view.corners],
  )
  const goal = me !== null ? roundedOutline(cornerTriangle(points, target(view.corners[me])), 0.5 * U) : null
  const [hover, setHover] = useState<number | null>(null)

  // 新的一手：播一下移動的動畫（重連、剛進來時不播）
  const [anim, setAnim] = useState({ moveNo: view.moveNo, playing: false })
  if (anim.moveNo !== view.moveNo) {
    setAnim({ moveNo: view.moveNo, playing: view.last !== null && view.moveNo > anim.moveNo && !reducedMotion() })
  }
  const last = view.last
  const hidden = anim.playing && last ? last.path[last.path.length - 1] : null

  function cellAt(e: MouseEvent<SVGSVGElement>): number | null {
    const ctm = e.currentTarget.getScreenCTM()
    if (!ctm) return null
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    // 點在兩格之間也算最近的那一格，手機上比較點得準
    let best: number | null = null
    let bestD = (0.75 * U) ** 2
    points.forEach((q, i) => {
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  const preview = hover !== null ? dests.get(hover) : undefined
  const line = (path: number[]) => path.map((c) => `${points[c].x.toFixed(2)},${points[c].y.toFixed(2)}`).join(' ')

  return (
    <svg
      className={`cc-board${active ? ' active' : ''}`}
      viewBox={`${-VIEW_W / 2} ${-VIEW_H / 2} ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label="跳棋棋盤"
      onClick={(e) => onTap(cellAt(e))}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse') setHover(cellAt(e))
      }}
      onPointerLeave={() => setHover(null)}
    >
      <polygon className="cc-star" points={star} />
      {homes.map((pts, seat) => (
        <polygon key={seat} className={`cc-home cc-seat-${seat}`} points={pts} />
      ))}
      {goal && me !== null && <path className={`cc-goal cc-seat-${me}`} d={goal} />}
      {points.map((p, i) => (
        <circle key={i} className="cc-hole" cx={p.x} cy={p.y} r={0.17 * U} />
      ))}

      {last && (
        <g className={`cc-trail cc-seat-${last.seat}`} aria-hidden>
          <polyline className="cc-trail-shadow" points={line(last.path)} />
          <polyline className="cc-trail-line" points={line(last.path)} />
          <circle className="cc-trail-from" cx={points[last.path[0]].x} cy={points[last.path[0]].y} r={0.4 * U} />
          {last.path.slice(1, -1).map((c) => (
            <circle key={c} className="cc-trail-stop" cx={points[c].x} cy={points[c].y} r={0.12 * U} />
          ))}
        </g>
      )}

      {Array.from({ length: CELLS }, (_, i) => {
        const ch = view.board[i]
        if (ch === '.' || i === hidden) return null
        const seat = Number(ch)
        return <Piece key={i} seat={seat} at={points[i]} />
      })}

      {preview && <polyline className="cc-preview" points={line(preview)} />}
      {selected !== null && <circle className="cc-selected" cx={points[selected].x} cy={points[selected].y} r={0.5 * U} />}
      {[...dests.keys()].map((c) => (
        <circle
          key={c}
          className={`cc-dest${active ? '' : ' idle'}${c === hover ? ' hover' : ''}`}
          cx={points[c].x}
          cy={points[c].y}
          r={0.3 * U}
        />
      ))}

      {anim.playing && last && (
        <MovingPiece
          key={view.moveNo}
          seat={last.seat}
          path={last.path.map((c) => points[c])}
          onDone={() => setAnim((a) => ({ ...a, playing: false }))}
        />
      )}
    </svg>
  )
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function Piece({ seat, at }: { seat: number; at: Point }) {
  return (
    <g className={`cc-piece cc-seat-${seat}`} transform={`translate(${at.x} ${at.y})`}>
      <PieceInk />
    </g>
  )
}

function PieceInk() {
  return (
    <>
      <circle className="cc-piece-body" r={0.4 * U} />
      <circle className="cc-piece-shine" cx={-0.12 * U} cy={-0.13 * U} r={0.13 * U} />
    </>
  )
}

/** 上一手的棋沿著路徑移動；跳的時候放大一點，像跳起來 */
function MovingPiece({ seat, path, onDone }: { seat: number; path: Point[]; onDone: () => void }) {
  const ref = useRef<SVGGElement>(null)
  // 只用掛上去那一刻的路徑和 callback，重繪不會重播
  const [frames] = useState(path)
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  })
  useEffect(() => {
    const segs = frames.length - 1
    // 走一步的兩格距離剛好是 1 格，跳的話至少 2 格
    const hop = segs > 1 || Math.hypot(frames[1].x - frames[0].x, frames[1].y - frames[0].y) > 1.5 * U
    const per = hop ? 190 : 230
    const total = per * segs
    const start = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / total)
      const pos = t * segs
      const i = Math.min(segs - 1, Math.floor(pos))
      const f = pos - i
      const e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2
      const a = frames[i]
      const b = frames[i + 1]
      const x = a.x + (b.x - a.x) * e
      const y = a.y + (b.y - a.y) * e
      const s = hop ? 1 + 0.28 * Math.sin(Math.PI * f) : 1
      ref.current?.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(3)})`)
      if (t < 1) raf = requestAnimationFrame(frame)
      else done.current()
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [frames])
  return (
    <g ref={ref} className={`cc-piece cc-moving cc-seat-${seat}`} transform={`translate(${frames[0].x} ${frames[0].y})`}>
      <PieceInk />
    </g>
  )
}

function SeatList({ party, view, name }: { party: CcParty; view: CcView; name: NameOf }) {
  return (
    <ul className="cc-seats" aria-label="玩家">
      {view.seats.map((s, seat) => {
        const player = party.playerAt(seat)
        const turn = view.turn === seat
        return (
          <li key={seat} className={`cc-seat cc-seat-${seat}${turn ? ' turn' : ''}${seat === view.you ? ' me' : ''}`}>
            <div className="cc-seat-head">
              <span className="cc-dot" aria-hidden />
              <span className="cc-seat-name">{name(seat)}</span>
              <span className="muted">{colorName(seat)}</span>
              {s.rank !== null && <span className="cc-rank">第 {s.rank} 名</span>}
            </div>
            <div className="cc-progress" role="progressbar" aria-valuenow={s.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${name(seat)} 的進度`}>
              <span style={{ width: `${s.progress}%` }} />
            </div>
            <div className="cc-seat-meta">
              <span>
                目標 {s.home}/{PIECES}
              </span>
              <span>
                {s.moves}/{view.moveLimit} 手
              </span>
              <span>贏 {s.wins} 局</span>
              {player?.bot && <span className="chip subtle">電腦</span>}
              {!s.online && <span className="chip subtle">離線</span>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function Result({ party, view, name }: { party: CcParty; view: CcView; name: NameOf }) {
  const result = view.result!
  return (
    <section className="cc-result">
      <h3>
        第 {view.game} 局結算{result.reason === 'limit' && `（大家都走滿 ${view.moveLimit} 手，照進度排名）`}
      </h3>
      <table className="responsive">
        <thead>
          <tr>
            <th>名次</th>
            <th>玩家</th>
            <th>目標裡</th>
            <th>進度</th>
            <th>手數</th>
            <th>累計</th>
          </tr>
        </thead>
        <tbody>
          {result.ranking.map((seat, i) => {
            const s = view.seats[seat]
            return (
              <tr key={seat} className={seat === view.you ? 'cc-result-me' : undefined}>
                <td data-label="名次">{i + 1}</td>
                <td className="primary" data-label="玩家">
                  <span className={`cc-dot cc-seat-${seat}`} aria-hidden />
                  {name(seat)}
                  {party.playerAt(seat)?.bot && <span className="chip subtle">電腦</span>}
                </td>
                <td data-label="目標裡">
                  {s.home}/{PIECES}
                </td>
                <td data-label="進度">{s.rank !== null ? '走完了' : `${s.progress}%`}</td>
                <td data-label="手數">{s.moves}</td>
                <td data-label="累計">贏 {s.wins} 局</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
