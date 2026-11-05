import { useState, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  COLOR_KEYS,
  COLOR_NAMES,
  cardLabel,
  colorOf,
  faceText,
  isWild,
  points,
  type Card,
  type Color,
  type LogEntry,
  type UnoOptions,
  type UnoParty,
  type UnoView,
} from './types'
import { useMotion, type Motion } from './motion'
import './uno.css'

type UParty = Party<UnoParty>
type NameOf = (seat: number) => string

/** UNO：規則都在伺服器（backend/src/uno.rs），這裡只畫自己的 view、送動作 */
export default function Uno() {
  const party = useParty<UnoParty>('uno')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>經典的 UNO：出同顏色或同數字的牌，先出完的人贏。剩一張時記得喊 UNO！2～10 人，人不夠可以加電腦。</p>
        </PartyEntry>
      </GameLayout>
    )
  }
  return <InRoom party={party} />
}

function Rules({ options }: { options?: UnoOptions }) {
  const o = options
  return (
    <div className="game-help">
      <strong>怎麼玩</strong>
      <ul>
        <li>每人 7 張。輪到你時出一張和桌上「同顏色」或「同數字／同符號」的牌；萬用牌隨時能出，出的人指定顏色。</li>
        <li>
          {o?.drawUntil
            ? '沒得出（或不想出）就一直抽到能出為止，抽到的那張可以馬上出，也可以不出。'
            : '沒得出（或不想出）就抽一張，抽到能出的可以馬上出，否則換下一位。'}
        </li>
        <li>跳過：下一位跳過。迴轉：換方向，兩個人玩時等於跳過。+2、萬用+4：下一位抽牌而且跳過。</li>
        {o?.stacking && <li>疊加：被 +2 時可以再出 +2 或 +4 把罰抽丟給下一位；+4 上面只能疊 +4。不疊就把累積的張數全抽走。</li>}
        <li>
          出到剩一張時要喊 UNO：出牌前先按「UNO!」，或出完馬上按。沒喊的話，下一位出手前其他人都可以按「抓」，被抓到罰抽 2 張。
        </li>
        <li>
          {o?.scoring === 'points'
            ? `計分：贏的人拿其他人手上牌的點數（數字照面額、功能牌 20、萬用牌 50），先到 ${o.target} 分的人拿下整場。`
            : '計分：每局先出完的人 +1 分，在同一個房間累計。'}
        </li>
        <li>{o && o.thinkSecs > 0 ? `每手有 ${o.thinkSecs} 秒，` : ''}時間到會自動抽牌、不出；斷線的人由電腦代打。</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: UParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩 UNO"
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
      <div className="uno">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const side = (
    <>
      <ChatBox party={party} />
      <Rules options={view?.options ?? room.options} />
    </>
  )
  const lobby = (
    <PartyLobby
      party={party}
      options={<OptionsForm party={party} />}
      hint={<p className="muted">2～10 人，人不夠可以加電腦玩家。</p>}
    />
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="uno">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>{lobby}</GameLayout>
      </div>
    )
  }

  return (
    <div className="uno">
      {header}
      <GameLayout side={side}>
        <Board party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && lobby}
      </GameLayout>
    </div>
  )
}

function OptionsForm({ party }: { party: UParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<UnoOptions>) => party.setOptions({ ...o, ...patch })
  const flag = (value: boolean) => (value ? 1 : 0)

  return (
    <div className="uno-options">
      <Segmented
        label="思考時間（每手）"
        value={o.thinkSecs}
        options={[
          { value: 0, label: '不限' },
          ...[10, 20, 30, 60].map((s) => ({ value: s, label: `${s} 秒` })),
        ]}
        onChange={(thinkSecs) => set({ thinkSecs })}
        disabled={!editable}
      />
      <Segmented
        label="+2、+4 疊加"
        value={flag(o.stacking)}
        options={[
          { value: 0, label: '不能疊' },
          { value: 1, label: '可以疊' },
        ]}
        onChange={(v) => set({ stacking: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="沒得出時"
        value={flag(o.drawUntil)}
        options={[
          { value: 0, label: '抽一張' },
          { value: 1, label: '抽到能出為止' },
        ]}
        onChange={(v) => set({ drawUntil: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="計分"
        value={o.scoring}
        options={[
          { value: 'single', label: '單局（贏的人 +1）' },
          { value: 'points', label: '累計點數' },
        ]}
        onChange={(scoring) => set({ scoring })}
        disabled={!editable}
      />
      {o.scoring === 'points' && (
        <Segmented
          label="目標分數"
          value={o.target}
          options={[200, 300, 500].map((t) => ({ value: t, label: `${t} 分` }))}
          onChange={(target) => set({ target })}
          disabled={!editable}
        />
      )}
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

function colorClass(card: Card): string {
  const c = colorOf(card)
  return c === null ? 'wild' : COLOR_KEYS[c]
}

/** 一張牌的牌面：四角是數字，中間一個白色橢圓 */
function CardInk({ card }: { card: Card }) {
  const text = faceText(card)
  return (
    <>
      <span className="uno-card-corner" aria-hidden>
        {text}
      </span>
      <span className="uno-card-oval" aria-hidden>
        <span>{text}</span>
      </span>
    </>
  )
}

function CardFace({ card, big }: { card: Card; big?: boolean }) {
  return (
    <span className={`uno-card ${colorClass(card)}${big ? ' big' : ''}`} role="img" aria-label={cardLabel(card)}>
      <CardInk card={card} />
    </span>
  )
}

/** 一行文字版的小牌 */
function MiniCard({ card, color }: { card: Card; color?: Color }) {
  // 萬用牌標上指定的顏色
  const tint = isWild(card) && color !== undefined ? ` tint-${COLOR_KEYS[color]}` : ''
  return (
    <span className={`uno-mini ${colorClass(card)}${tint}`}>
      {cardLabel(card)}
      {isWild(card) && color !== undefined && `→${COLOR_NAMES[color]}`}
    </span>
  )
}

function Board({ party, view }: { party: UParty; view: UnoView }) {
  const me = view.you
  const name: NameOf = (seat) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const ended = view.stage === 'end'
  const myTurn = me !== null && view.turn === me
  const n = view.seats.length
  const motion = useMotion(view)

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  if (ended && view.result) {
    const won = view.result.winner === me
    const whole = view.result.champion ? '，拿下整場！' : ''
    status = won ? `你出完了，這局你贏${whole || '！'}` : `${name(view.result.winner)} 出完了${whole}`
    tone = me === null || won ? 'ok' : 'danger'
  } else if (myTurn) {
    if (view.drawn !== null) status = '抽到能出的牌：要出嗎？'
    else if (view.pending > 0) status = `輪到你：疊上去，或抽 ${view.pending} 張`
    else status = view.playable.length > 0 ? '輪到你出牌' : '輪到你：沒有能出的牌，抽一張'
    tone = 'accent'
  } else if (view.turn !== null) {
    status = `${name(view.turn)} 思考中…`
  }

  // 從自己的下一位開始照出牌順序排；觀戰從座位 0 開始
  const base = me ?? -1
  const order = Array.from({ length: n }, (_, i) => (base + 1 + i + n) % n).filter((s) => s !== me)

  return (
    <div className="uno-board">
      <StatusLine tone={tone}>
        {status} {!ended && <Countdown ms={view.endsIn} stamp={view} />}
      </StatusLine>
      <ul className="uno-seats" aria-label="其他玩家">
        {order.map((seat) => (
          <SeatTile key={seat} party={party} view={view} seat={seat} name={name(seat)} motion={motion} />
        ))}
      </ul>
      <CatchBar party={party} view={view} name={name} />
      <Table party={party} view={view} name={name} motion={motion} />
      {me !== null && view.hand && !ended && (
        <Hand
          key={view.game}
          party={party}
          view={view}
          me={me}
          hand={view.hand}
          myTurn={myTurn}
          motion={motion}
        />
      )}
      {ended && view.result && <Result party={party} view={view} name={name} />}
      <Log view={view} name={name} />
      <p className="muted uno-game-no">第 {view.game} 局</p>
    </div>
  )
}

function SeatTile({
  party,
  view,
  seat,
  name,
  motion,
}: {
  party: UParty
  view: UnoView
  seat: number
  name: string
  motion: Motion
}) {
  const s = view.seats[seat]
  // 還在飛過來的牌先不算
  const count = Math.max(0, s.count - (motion.lag[seat] ?? 0))
  const player = party.playerAt(seat)
  const turn = view.turn === seat
  const won = view.result?.winner === seat
  return (
    <li
      className={`uno-seat${turn ? ' turn' : ''}${won ? ' won' : ''}`}
      ref={(el) => motion.attach.seat(seat, el)}
    >
      <span className="uno-seat-name">{name}</span>
      <div className="uno-seat-count">
        <span className="uno-back" aria-hidden />
        <span className={count === 1 ? 'uno-low' : ''}>{s.count === 0 ? '出完了' : `${count} 張`}</span>
        {s.uno && s.count === 1 && <span className="uno-said">UNO!</span>}
      </div>
      <div className="uno-seat-chips">
        {player?.bot && <span className="chip subtle">電腦</span>}
        {!s.online && <span className="chip subtle">離線</span>}
        <span className="uno-total">{s.total} 分</span>
      </div>
    </li>
  )
}

/** 有人剩一張沒喊 UNO：其他人可以抓，他自己可以補喊 */
function CatchBar({ party, view, name }: { party: UParty; view: UnoView; name: NameOf }) {
  const target = view.exposed
  if (target === null || view.stage === 'end') return null
  if (view.you === target) {
    return (
      <div className="uno-catch self">
        <span>你剩一張還沒喊！</span>
        <button type="button" className="uno-shout" onClick={() => party.act({ type: 'uno' })}>
          UNO!
        </button>
      </div>
    )
  }
  if (view.you === null) {
    return <div className="uno-catch">{name(target)} 剩一張還沒喊 UNO…</div>
  }
  return (
    <div className="uno-catch">
      <span>{name(target)} 剩一張沒喊 UNO！</span>
      <button type="button" className="uno-shout" onClick={() => party.act({ type: 'catch', seat: target })}>
        抓！
      </button>
    </div>
  )
}

/** 桌子中間：抽牌堆、桌上的牌、現在的顏色和方向 */
function Table({ party, view, name, motion }: { party: UParty; view: UnoView; name: NameOf; motion: Motion }) {
  const myTurn = view.you !== null && view.turn === view.you && view.stage === 'play'
  const canDraw = myTurn && view.drawn === null
  const last = [...view.log].reverse().find((e) => e.type === 'play')
  // 牌堆的張數也等牌飛出去才減
  const { attach, under, lag, hidden, landing } = motion
  const inFlight = lag.reduce((a, b) => a + b, 0) + hidden.length + landing.length
  return (
    <div className={`uno-felt tint-${COLOR_KEYS[view.color]}`} aria-live="polite">
      <div className="uno-felt-cards">
        <button
          type="button"
          className="uno-pile"
          onClick={() => party.act({ type: 'draw' })}
          disabled={!canDraw}
          aria-label={view.pending > 0 ? `抽 ${view.pending} 張` : '抽一張'}
        >
          <span
            className="uno-pile-back"
            aria-hidden
            ref={(el) => attach.pile(el)}
          >
            UNO
          </span>
          <span className="uno-pile-count">剩 {view.pile + inFlight} 張</span>
        </button>
        <span className="uno-discard">
          {under !== null && (
            <span key="under" className="uno-discard-under" aria-hidden>
              <CardFace card={under} big />
            </span>
          )}
          <span
            key="top"
            className="uno-discard-top"
            ref={(el) => attach.top(el)}
          >
            <CardFace card={view.top} big />
          </span>
        </span>
      </div>
      <div className="uno-felt-info">
        <span className={`uno-color-dot ${COLOR_KEYS[view.color]}`} aria-hidden />
        <span>現在是{COLOR_NAMES[view.color]}色</span>
        {/* key 換了就重播一次動畫 */}
        <span key={`dir-${view.clockwise}`} className="uno-dir">
          {view.clockwise ? '↻ 順時針' : '↺ 逆時針'}
        </span>
        {view.pending > 0 && (
          <span key={`pending-${view.pending}`} className="uno-pending">
            累積 +{view.pending}
          </span>
        )}
      </div>
      {last && <p>{name(last.seat)} 出的</p>}
    </div>
  )
}

function Hand({
  party,
  view,
  me,
  hand,
  myTurn,
  motion,
}: {
  party: UParty
  view: UnoView
  me: number
  hand: Card[]
  myTurn: boolean
  motion: Motion
}) {
  // 剩兩張時先按「UNO!」，出牌時一起送
  const [armed, setArmed] = useState(false)
  // 選了萬用牌，等著選顏色
  const [picking, setPicking] = useState<Card | null>(null)
  // 送出後到收到新的 view 之前不能再按，避免連點送兩次
  const [sent, setSent] = useState<UnoView | null>(null)
  const waiting = sent === view
  const uno = armed && hand.length === 2
  const choosing = picking !== null && myTurn && view.playable.includes(picking) ? picking : null

  function play(card: Card, color?: Color) {
    setSent(view)
    setPicking(null)
    setArmed(false)
    party.act({ type: 'play', card, color, uno })
  }

  function tap(card: Card, el: HTMLElement) {
    if (!myTurn || waiting || !view.playable.includes(card)) return
    // 記下這張的位置，出牌動畫從這裡飛到桌上
    attach.playFrom(el.getBoundingClientRect())
    if (isWild(card)) setPicking(card)
    else play(card)
  }

  function draw() {
    setSent(view)
    setPicking(null)
    party.act({ type: 'draw' })
  }

  function pass() {
    setSent(view)
    party.act({ type: 'pass' })
  }

  const mySeat = view.seats[me]
  // 還沒發到的新牌先不畫；正在飛過來的先佔位置、看不見
  const { attach, hidden, landing } = motion
  const shown = hand.filter((c) => !hidden.includes(c))
  return (
    <section
      className={`uno-hand-area${myTurn ? ' my-turn' : ''}`}
      aria-label="你的手牌"
      ref={(el) => attach.handArea(el)}
    >
      <div className="uno-me">
        <strong>你</strong>
        <span>{shown.length} 張</span>
        <span>{mySeat.total} 分</span>
        {mySeat.uno && hand.length === 1 && <span className="uno-said">UNO!</span>}
      </div>
      <div className="uno-hand" ref={(el) => attach.hand(el)}>
        {shown.map((card) => {
          const ok = myTurn && view.playable.includes(card)
          return (
            <button
              key={card}
              type="button"
              data-card={card}
              className={`uno-card ${colorClass(card)}${ok ? ' ok' : myTurn ? ' dim' : ''}${card === view.drawn ? ' drawn' : ''}${card === choosing ? ' picked' : ''}${landing.includes(card) ? ' incoming' : ''}`}
              onClick={(e) => tap(card, e.currentTarget)}
              aria-disabled={!ok}
              aria-label={`${cardLabel(card)}${ok ? '（可以出）' : ''}`}
            >
              <CardInk card={card} />
            </button>
          )
        })}
      </div>
      {choosing !== null && (
        <div className="uno-pick" role="group" aria-label="選一個顏色">
          <span>選顏色：</span>
          {COLOR_KEYS.map((key, c) => (
            <button key={key} type="button" className={`uno-pick-color ${key}`} onClick={() => play(choosing, c as Color)}>
              {COLOR_NAMES[c]}
            </button>
          ))}
          <button type="button" className="secondary" onClick={() => setPicking(null)}>
            取消
          </button>
        </div>
      )}
      <div className="uno-controls">
        {view.drawn === null ? (
          <button type="button" onClick={draw} disabled={!myTurn || waiting}>
            {view.pending > 0 ? `抽 ${view.pending} 張` : '抽牌'}
          </button>
        ) : (
          <button type="button" className="secondary" onClick={pass} disabled={!myTurn || waiting}>
            不出
          </button>
        )}
        <button
          type="button"
          className={`uno-shout${uno ? ' armed' : ''}`}
          onClick={() => setArmed(!uno)}
          disabled={hand.length !== 2}
          aria-pressed={uno}
        >
          {uno ? 'UNO! ✓' : 'UNO!'}
        </button>
      </div>
      <p className="muted uno-note">
        {hand.length === 2
          ? uno
            ? '出牌時會一起喊 UNO'
            : '剩兩張：出牌前先按「UNO!」'
          : myTurn
            ? '點亮起來的牌直接出；萬用牌出之前要選顏色'
            : '等其他人出牌…'}
      </p>
    </section>
  )
}

function Log({ view, name }: { view: UnoView; name: NameOf }) {
  if (view.log.length === 0) return null
  const line = (e: LogEntry): ReactNode => {
    switch (e.type) {
      case 'play':
        return (
          <>
            {name(e.seat)} 出了 <MiniCard card={e.card} color={e.color} />
          </>
        )
      case 'draw':
        return `${name(e.seat)} 抽了 ${e.count} 張`
      case 'pass':
        return `${name(e.seat)} 不出`
      case 'caught':
        return `${name(e.by)} 抓到 ${name(e.seat)} 沒喊 UNO`
    }
  }
  return (
    <section className="uno-log" aria-label="最近的動作">
      <ol>
        {[...view.log].reverse().map((e, i) => (
          <li key={view.log.length - i}>{line(e)}</li>
        ))}
      </ol>
    </section>
  )
}

function Result({ party, view, name }: { party: UParty; view: UnoView; name: NameOf }) {
  const result = view.result!
  const seats = view.seats.map((_, i) => i)
  const left = (seat: number) => result.hands[seat].reduce((sum, c) => sum + points(c), 0)
  const order = seats.sort((a, b) => view.seats[b].total - view.seats[a].total || left(a) - left(b))
  const byPoints = view.options.scoring === 'points'
  return (
    <section className="uno-result">
      <h3>
        第 {view.game} 局結算
        {byPoints && (result.champion ? `：${name(result.winner)} 拿下整場` : `（目標 ${view.options.target} 分）`)}
      </h3>
      <table className="responsive">
        <thead>
          <tr>
            <th>玩家</th>
            <th>剩下的牌</th>
            <th>這局</th>
            <th>總分</th>
          </tr>
        </thead>
        <tbody>
          {order.map((seat) => (
            <tr key={seat} className={seat === view.you ? 'uno-result-me' : undefined}>
              <td className="primary" data-label="玩家">
                {name(seat)}
                {party.playerAt(seat)?.bot && <span className="chip subtle">電腦</span>}
              </td>
              <td data-label="剩下的牌">
                {seat === result.winner ? (
                  <span className="uno-won">出完了！</span>
                ) : (
                  <span className="uno-left">
                    <span className="uno-left-count">
                      {result.hands[seat].length} 張{byPoints && `・${left(seat)} 點`}
                    </span>
                    {result.hands[seat].map((c) => (
                      <MiniCard key={c} card={c} />
                    ))}
                  </span>
                )}
              </td>
              <td data-label="這局" className={seat === result.winner ? 'uno-plus' : ''}>
                {seat === result.winner ? `+${result.gained}` : 0}
              </td>
              <td data-label="總分">{view.seats[seat].total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
