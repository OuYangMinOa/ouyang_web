import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  cardLabel,
  chips,
  isRed,
  RANKS,
  rankOf,
  STREET_NAMES,
  SUITS,
  suitOf,
  type Card,
  type PokerOptions,
  type PokerParty as PokerTypes,
  type PokerSeat,
  type PokerTurn,
  type PokerView,
} from './types'
import './poker.css'

type PokerParty = Party<PokerTypes>

/** 德州撲克：規則都在伺服器（backend/src/poker.rs），這裡只畫自己的 view、送動作 */
export default function Poker() {
  const party = useParty<PokerTypes>('poker')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>無限注德州撲克：2～9 人，每人兩張底牌配五張公牌，一手接一手打到有人贏走所有籌碼。只用遊戲籌碼，人不夠可以加電腦。</p>
        </PartyEntry>
      </GameLayout>
    )
  }
  return <InRoom party={party} />
}

function Rules({ options }: { options?: PokerOptions }) {
  const o = options
  return (
    <div className="game-help">
      <strong>怎麼玩</strong>
      <ul>
        <li>每人兩張底牌，桌上依序發三張翻牌、一張轉牌、一張河牌；最後用 7 張裡最好的 5 張比大小。</li>
        <li>牌型由小到大：高牌、一對、兩對、三條、順子、同花、葫蘆、鐵支、同花順。A2345 是最小的順子。同牌型比點數，花色不分大小。</li>
        <li>
          每手按鈕往左移，按鈕左邊下小盲、再左邊下大盲{o ? `（一開始 ${o.bigBlind / 2}／${o.bigBlind}）` : ''}。
          兩個人單挑時按鈕下小盲，翻牌前先行動。
        </li>
        <li>
          每一輪可以棄牌、過牌、跟注、下注或加注。最少下注一個大盲，加注至少要加到「上一次加注的幅度」；全下不夠一次完整加注時，已經行動過的人只能跟或棄。
        </li>
        <li>有人全下時會分主池和邊池，每個池只有投入夠多的人能贏；沒人跟的下注直接退回。平手平分，除不盡的籌碼從按鈕左邊開始給。</li>
        <li>攤牌只亮必須亮的牌：贏家、河牌被跟注的人，全下時大家都亮。棄牌的牌不會公開；一手結束後可以自己選擇亮牌。</li>
        <li>
          {o && o.thinkSecs > 0 ? `每次行動有 ${o.thinkSecs} 秒，` : ''}時間到或斷線會自動過牌，不能過牌就棄牌。
        </li>
        <li>
          {o && o.blindUp > 0 ? `每 ${o.blindUp} 手盲注升一級。` : ''}
          {o && o.handLimit > 0 ? `打滿 ${o.handLimit} 手時籌碼最多的人贏，` : ''}只剩一個人有籌碼就結束；輸光的人留在旁邊看。
        </li>
        <li>只用遊戲籌碼，不能儲值也不能換錢。</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: PokerParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來打德州撲克"
      extra={
        party.isHost &&
        playing && (
          <button
            type="button"
            className="secondary"
            onClick={() => window.confirm('結束這局牌局，回到大廳？') && party.abort()}
          >
            結束牌局
          </button>
        )
      }
    />
  )
  if (!room) {
    return (
      <div className="pk">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const side = (
    <>
      {view && <HandLog view={view} />}
      <ChatBox party={party} />
      <Rules options={view?.options ?? room.options} />
    </>
  )
  const lobby = (
    <PartyLobby
      party={party}
      options={<OptionsForm party={party} />}
      hint={<p className="muted">2～9 人，人不夠可以加電腦玩家補位。</p>}
    />
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="pk">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>{lobby}</GameLayout>
      </div>
    )
  }

  return (
    <div className="pk">
      {header}
      <GameLayout side={side}>
        <Board party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && lobby}
      </GameLayout>
    </div>
  )
}

function OptionsForm({ party }: { party: PokerParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<PokerOptions>) => party.setOptions({ ...o, ...patch })

  return (
    <div className="pk-options">
      <Segmented
        label="起始籌碼"
        value={o.chips}
        options={[500, 1000, 2000, 5000, 10000].map((c) => ({
          value: c,
          label: chips(c),
          // 至少要 10 個大盲
          disabled: c < o.bigBlind * 10,
        }))}
        onChange={(c) => set({ chips: c })}
        disabled={!editable}
      />
      <Segmented
        label="盲注（小盲／大盲）"
        value={o.bigBlind}
        options={[10, 20, 50, 100, 200].map((b) => ({
          value: b,
          label: `${b / 2}／${b}`,
          disabled: o.chips < b * 10,
        }))}
        onChange={(bigBlind) => set({ bigBlind })}
        disabled={!editable}
      />
      <Segmented
        label="升盲"
        value={o.blindUp}
        options={[
          { value: 0, label: '不升' },
          ...[5, 10, 20].map((n) => ({ value: n, label: `每 ${n} 手` })),
        ]}
        onChange={(blindUp) => set({ blindUp })}
        disabled={!editable}
      />
      <Segmented
        label="手數上限"
        value={o.handLimit}
        options={[
          { value: 0, label: '打到剩一人' },
          ...[30, 50, 100].map((n) => ({ value: n, label: `${n} 手` })),
        ]}
        onChange={(handLimit) => set({ handLimit })}
        disabled={!editable}
      />
      <Segmented
        label="思考時間（每次行動）"
        value={o.thinkSecs}
        options={[
          { value: 0, label: '不限' },
          ...[15, 30, 60].map((s) => ({ value: s, label: `${s} 秒` })),
        ]}
        onChange={(thinkSecs) => set({ thinkSecs })}
        disabled={!editable}
      />
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

/** 一張牌；`back` 是蓋著的牌，`best` 是組成目前最好牌型的那幾張 */
function CardFace({ card, size, best }: { card: Card | null; size?: 'sm' | 'lg'; best?: boolean }) {
  const cls = `pk-card${size ? ` ${size}` : ''}`
  if (card === null) return <span className={`${cls} back`} aria-label="蓋著的牌" />
  return (
    <span className={`${cls}${isRed(card) ? ' red' : ''}${best ? ' best' : ''}`} aria-label={cardLabel(card)}>
      <span className="pk-card-rank" aria-hidden>
        {RANKS[rankOf(card)]}
      </span>
      <span className="pk-card-suit" aria-hidden>
        {SUITS[suitOf(card)]}
      </span>
    </span>
  )
}

function Board({ party, view }: { party: PokerParty; view: PokerView }) {
  const me = view.you
  const name = (seat: number) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const ended = view.stage === 'end'
  const mySeat = me !== null ? view.seats[me] : null
  const myTurn = me !== null && view.turn === me

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  if (ended && view.ranking) {
    const champ = view.ranking[0]
    status = champ === me ? '你贏走了所有籌碼，拿下這局！' : `${name(champ)} 拿下這局`
    tone = champ === me || me === null ? 'ok' : 'danger'
  } else if (myTurn) {
    const t = view.me?.turn
    status = t && t.toCall > 0 ? `輪到你：跟注 ${chips(t.toCall)}、加注或棄牌` : '輪到你：過牌或下注'
    tone = 'accent'
  } else if (view.turn !== null) {
    status = `${name(view.turn)} 思考中…`
  } else if (view.results.length > 0) {
    status = resultText(view, name)
  } else {
    status = '發牌中…'
  }

  // 自己在最下面，其他人照行動順序（往左）繞一圈；觀戰時座位 0 在下面
  const n = view.seats.length
  const base = me ?? 0
  const order = Array.from({ length: n }, (_, k) => (base + k) % n)

  return (
    <div className="pk-board">
      <StatusLine tone={tone}>
        {status} {view.turn !== null && <Countdown ms={view.endsIn} stamp={view} />}
      </StatusLine>
      <p className="pk-info">
        <span>第 {view.hand} 手</span>
        <span>
          盲注 {chips(view.smallBlind)}／{chips(view.bigBlind)}
        </span>
        {view.blindUpIn !== null && <span>{view.blindUpIn === 1 ? '下一手升盲' : `再 ${view.blindUpIn} 手升盲`}</span>}
        {view.nextHandIn !== null && (
          <span>
            下一手 <Countdown ms={view.nextHandIn} stamp={view} />
          </span>
        )}
      </p>
      <div className={`pk-table seats-${n}`}>
        <Felt view={view} name={name} />
        <ul className="pk-seats" aria-label="座位">
          {order.map((seat, k) => {
            // 從正下方（90°）開始順時針排：下一個行動的人在自己的左手邊
            const angle = Math.PI / 2 + (k * 2 * Math.PI) / n
            const style = {
              '--x': `${50 + 47 * Math.cos(angle)}%`,
              '--y': `${50 + 44 * Math.sin(angle)}%`,
            } as CSSProperties
            return <SeatTile key={seat} party={party} view={view} seat={seat} style={style} />
          })}
        </ul>
      </div>
      {mySeat && !mySeat.out && !ended && <MyHand party={party} view={view} seat={mySeat} />}
      {mySeat?.out && !ended && <p className="muted pk-note">你輸光了籌碼，在旁邊看到這局結束。</p>}
      {ended && view.ranking && <Ranking party={party} view={view} name={name} />}
      <p className="muted pk-game-no">第 {view.game} 局</p>
    </div>
  )
}

function resultText(view: PokerView, name: (seat: number) => string): string {
  return view.results
    .map((r) => {
      const who = r.winners.map(name).join('、')
      return r.hand ? `${who} 以${r.hand}贏得 ${chips(r.amount)}` : `${who} 贏得 ${chips(r.amount)}`
    })
    .join('；')
}

/** 桌子中間：公牌、底池 */
function Felt({ view, name }: { view: PokerView; name: (seat: number) => string }) {
  // 贏家最好的 5 張在公牌上標出來
  const best = new Set(view.results.flatMap((r) => r.best ?? []))
  const slots = Array.from({ length: 5 }, (_, i) => view.board[i] ?? null)
  return (
    <div className="pk-felt" aria-live="polite">
      <div className="pk-board-cards" aria-label="公牌">
        {slots.map((c, i) =>
          c === null ? <span key={i} className="pk-card slot" aria-hidden /> : <CardFace key={i} card={c} best={best.has(c)} />,
        )}
      </div>
      <p className="pk-pot">
        {view.pot > 0 ? (
          <>
            底池 <strong>{chips(view.pot)}</strong>
          </>
        ) : view.results.length > 0 ? (
          resultText(view, name)
        ) : (
          STREET_NAMES[view.street]
        )}
      </p>
      {view.pot > 0 && <p className="pk-street">{STREET_NAMES[view.street]}</p>}
    </div>
  )
}

function SeatTile({
  party,
  view,
  seat,
  style,
}: {
  party: PokerParty
  view: PokerView
  seat: number
  style: CSSProperties
}) {
  const s: PokerSeat = view.seats[seat]
  const player = party.playerAt(seat)
  const turn = view.turn === seat
  const me = view.you === seat
  const won = s.won > 0
  const cls = ['pk-seat', turn && 'turn', me && 'me', won && 'won', (s.folded || s.out) && 'dim'].filter(Boolean).join(' ')
  // 有發牌、沒棄牌的人桌上有兩張牌：看得到就翻開，不然蓋著
  const cards = s.dealt && !s.folded ? (s.cards ?? [null, null]) : null
  return (
    <li className={cls} style={style}>
      <div className="pk-seat-head">
        <span className="pk-seat-name">{player?.name ?? `座位 ${seat + 1}`}</span>
        {view.button === seat && (
          <span className="pk-button" title="按鈕（莊家）">
            D
          </span>
        )}
        {view.sb === seat && <span className="chip subtle">小盲</span>}
        {view.bb === seat && <span className="chip subtle">大盲</span>}
        {player?.bot && <span className="chip subtle">電腦</span>}
        {!s.online && <span className="chip subtle">離線</span>}
      </div>
      <div className="pk-seat-body">
        {cards && (
          <span className="pk-seat-cards">
            {cards.map((c, i) => (
              <CardFace key={i} card={c} size="sm" />
            ))}
          </span>
        )}
        <span className="pk-stack">{s.out ? '出局' : chips(s.stack)}</span>
      </div>
      <div className="pk-seat-foot">
        {s.bet > 0 && <span className="pk-bet">{chips(s.bet)}</span>}
        {won ? (
          <span className="pk-won">+{chips(s.won)}</span>
        ) : s.allIn ? (
          <span className="pk-allin">全下</span>
        ) : s.last ? (
          <span className="pk-last">{s.last}</span>
        ) : turn ? (
          <span className="muted">思考中…</span>
        ) : null}
        {s.rank && s.shown && <span className="pk-rank">{s.rank}</span>}
        {s.wins > 0 && <span className="pk-wins">贏 {s.wins} 局</span>}
      </div>
    </li>
  )
}

/** 自己的底牌、目前牌型和操作 */
function MyHand({ party, view, seat }: { party: PokerParty; view: PokerView; seat: PokerSeat }) {
  const me = view.me
  const best = new Set(me?.best ?? [])
  const turn = me?.turn ?? null
  return (
    <section className={`pk-me${turn ? ' my-turn' : ''}`} aria-label="你的手牌">
      <div className="pk-me-row">
        <div className="pk-hole">
          {seat.cards ? (
            seat.cards.map((c) => <CardFace key={c} card={c} size="lg" best={best.has(c)} />)
          ) : (
            <span className="muted">這手沒有牌</span>
          )}
        </div>
        <div className="pk-me-info">
          {me && !seat.folded && (
            <p className="pk-hint">
              目前：<strong>{me.rank}</strong>
            </p>
          )}
          {seat.folded && <p className="muted">你這手棄牌了</p>}
          <p>
            籌碼 <strong>{chips(seat.stack)}</strong>
            {seat.bet > 0 && <span className="muted">（這輪已下 {chips(seat.bet)}）</span>}
          </p>
          {me?.canShow && seat.dealt && (
            <button type="button" className="secondary" onClick={() => party.act({ type: 'show' })}>
              亮牌給大家看
            </button>
          )}
        </div>
      </div>
      {turn && (
        <Actions
          key={`${view.hand}-${view.street}-${turn.currentBet}`}
          party={party}
          view={view}
          turn={turn}
          bet={seat.bet}
        />
      )}
    </section>
  )
}

function Actions({ party, view, turn, bet }: { party: PokerParty; view: PokerView; turn: PokerTurn; bet: number }) {
  const [amount, setAmount] = useState(turn.minRaiseTo)
  // 送出後到收到新的 view 之前不能再按，避免連點送兩次
  const [sent, setSent] = useState<PokerView | null>(null)
  const waiting = sent === view
  const send = (action: Parameters<PokerParty['act']>[0]) => {
    setSent(view)
    party.act(action)
  }

  const { minRaiseTo: min, maxRaiseTo: max } = turn
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v)))
  const target = clamp(amount)
  const opening = turn.currentBet === 0
  // 底池加注：先跟注，再加「跟注之後的底池」那麼多
  const potRaise = (fraction: number) => clamp(turn.currentBet + (view.pot + turn.toCall) * fraction)
  const presets: { label: string; to: number }[] = [
    { label: '最小', to: min },
    { label: '½ 池', to: potRaise(0.5) },
    { label: '¾ 池', to: potRaise(0.75) },
    { label: '1 池', to: potRaise(1) },
  ]
  const allIn = target >= max
  // 跟注就把籌碼推光
  const callAllIn = turn.toCall > 0 && turn.toCall >= max - bet

  return (
    <div className="pk-actions">
      <div className="pk-action-buttons">
        <button type="button" className="danger" onClick={() => send({ type: 'fold' })} disabled={waiting}>
          棄牌
        </button>
        {turn.canCheck ? (
          <button type="button" className="secondary" onClick={() => send({ type: 'check' })} disabled={waiting}>
            過牌
          </button>
        ) : (
          <button type="button" className="secondary" onClick={() => send({ type: 'call' })} disabled={waiting}>
            {callAllIn ? `全下跟注 ${chips(turn.toCall)}` : `跟注 ${chips(turn.toCall)}`}
          </button>
        )}
        {turn.canRaise && (
          <button
            type="button"
            onClick={() => send(allIn ? { type: 'allIn' } : { type: 'raise', to: target })}
            disabled={waiting}
          >
            {allIn ? `全下 ${chips(max)}` : opening ? `下注 ${chips(target)}` : `加注到 ${chips(target)}`}
          </button>
        )}
      </div>
      {turn.canRaise && min < max && (
        <div className="pk-raise">
          <div className="pk-presets">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`secondary${p.to === target ? ' active' : ''}`}
                onClick={() => setAmount(p.to)}
              >
                {p.label}
              </button>
            ))}
            <button type="button" className={`secondary${allIn ? ' active' : ''}`} onClick={() => setAmount(max)}>
              全下
            </button>
          </div>
          <div className="pk-amount">
            <input
              type="range"
              min={min}
              max={max}
              step={Math.max(1, view.smallBlind)}
              value={target}
              onChange={(e) => setAmount(Number(e.target.value))}
              aria-label={opening ? '下注金額' : '加注到'}
            />
            <input
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value) || 0)}
              onBlur={() => setAmount(target)}
              aria-label={opening ? '下注金額' : '加注到'}
            />
          </div>
          <p className="muted pk-range">
            {opening ? '下注' : '加注到'} {chips(min)}～{chips(max)}
          </p>
        </div>
      )}
    </div>
  )
}

/** 行動紀錄：新的在最下面，捲到最下面時才自動跟 */
function HandLog({ view }: { view: PokerView }) {
  const list = useRef<HTMLOListElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [view.log])
  return (
    <section className="pk-log" aria-label="行動紀錄">
      <h3>行動紀錄</h3>
      <ol
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {view.log.map((line, i) => (
          <li key={`${view.log.length}-${i}`} className={line.startsWith('──') ? 'pk-log-hand' : undefined}>
            {line}
          </li>
        ))}
      </ol>
    </section>
  )
}

function Ranking({ party, view, name }: { party: PokerParty; view: PokerView; name: (seat: number) => string }) {
  const ranking = view.ranking!
  return (
    <section className="pk-result">
      <h3>第 {view.game} 局結果（打了 {view.hand} 手）</h3>
      <table className="responsive">
        <thead>
          <tr>
            <th>名次</th>
            <th>玩家</th>
            <th>籌碼</th>
            <th>累計勝場</th>
          </tr>
        </thead>
        <tbody>
          {ranking.map((seat, i) => (
            <tr key={seat} className={seat === view.you ? 'pk-result-me' : undefined}>
              <td data-label="名次">{i === 0 ? '🏆 冠軍' : `第 ${i + 1} 名`}</td>
              <td className="primary" data-label="玩家">
                {name(seat)}
                {party.playerAt(seat)?.bot && <span className="chip subtle">電腦</span>}
              </td>
              <td data-label="籌碼">{view.seats[seat].out ? '出局' : chips(view.seats[seat].stack)}</td>
              <td data-label="累計勝場">{view.seats[seat].wins}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
