import { useState, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { load, save } from '../shared/storage'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  cardLabel,
  cardText,
  isRed,
  KIND_NAMES,
  RANKS,
  sameCards,
  sortHand,
  suitOf,
  SUITS,
  rankOf,
  type B2Options,
  type B2View,
  type BigTwoParty,
  type Card,
  type Combo,
  type SortMode,
} from './types'
import './bigtwo.css'

type B2Party = Party<BigTwoParty>

/** 大老二：規則都在伺服器（backend/src/bigtwo.rs），這裡只畫自己的 view、送動作 */
export default function BigTwo() {
  const party = useParty<BigTwoParty>('bigtwo')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>台灣玩法的大老二：4 個人輪流出牌，先出完的人贏，其他人照剩下的張數扣分。人不夠可以加電腦。</p>
        </PartyEntry>
      </GameLayout>
    )
  }
  return <InRoom party={party} />
}

function Rules({ options }: { options?: B2Options }) {
  const o = options
  return (
    <div className="game-help">
      <strong>怎麼玩</strong>
      <ul>
        <li>牌的大小：3 最小，接著 4、5…K、A，2 最大；同點數比花色，♠ &gt; ♥ &gt; ♦ &gt; ♣。</li>
        <li>
          牌型：單張、對子{o?.triples ? '、三條' : ''}，以及五張牌型：順子 &lt; {o?.flush === false ? '' : '同花 < '}葫蘆
          &lt; 鐵支 &lt; 同花順。鐵支和葫蘆要帶一張或一對湊滿五張。
        </li>
        <li>
          順子：
          {o?.straights === 'natural'
            ? 'A 當 1，A2345 最小，接著 23456、34567…10JQKA 最大'
            : '2 最大，34567 最小…10JQKA，再來 A2345，23456 最大'}
          ；JQKA2 這種繞過 2 的不算。點數一樣時比最大那張的花色。
        </li>
        <li>
          要出同樣張數的牌型才能壓，五張牌型之間照等級比。
          {o?.bombs ? '鐵支和同花順是炸彈，可以壓單張和對子。' : ''}
        </li>
        <li>第一局拿到 ♣3 的人先出，第一手要包含 ♣3；之後每局由上一局的贏家先出。</li>
        <li>可以 pass，pass 之後這一圈還能再出。其他三家都 pass，最後出牌的人重新自由出牌。</li>
        <li>
          有人出完就結束：其他人照剩下的張數扣分，剩 10 張以上加倍、一張都沒出（13 張）三倍
          {o?.twosDouble ? '，手上每剩一張 2 再加倍' : ''}；贏的人拿走全部扣分，分數在同一個房間累計。
        </li>
        <li>
          {o && o.thinkSecs > 0 ? `每手有 ${o.thinkSecs} 秒，` : ''}時間到或斷線會自動處理：能 pass 就 pass，自由出牌就出最小的單張。
        </li>
        <li>點牌把它抬起來，再按「出牌」；「提示」會在所有能出的組合之間輪流切換。</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: B2Party }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來打大老二"
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
      <div className="b2">
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
      hint={<p className="muted">大老二要剛好 4 個人，人不夠可以加電腦玩家補位。</p>}
    />
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="b2">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>{lobby}</GameLayout>
      </div>
    )
  }

  return (
    <div className="b2">
      {header}
      <GameLayout side={side}>
        <Board party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && lobby}
      </GameLayout>
    </div>
  )
}

function OptionsForm({ party }: { party: B2Party }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<B2Options>) => party.setOptions({ ...o, ...patch })
  const flag = (value: boolean) => (value ? 1 : 0)

  return (
    <div className="b2-options">
      <Segmented
        label="思考時間（每手）"
        value={o.thinkSecs}
        options={[
          { value: 0, label: '不限' },
          ...[15, 30, 60].map((s) => ({ value: s, label: `${s} 秒` })),
        ]}
        onChange={(thinkSecs) => set({ thinkSecs })}
        disabled={!editable}
      />
      <Segmented
        label="同花"
        value={flag(o.flush)}
        options={[
          { value: 1, label: '算牌型' },
          { value: 0, label: '不算' },
        ]}
        onChange={(v) => set({ flush: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="鐵支、同花順"
        value={flag(o.bombs)}
        options={[
          { value: 0, label: '只壓五張牌型' },
          { value: 1, label: '也能壓單張、對子' },
        ]}
        onChange={(v) => set({ bombs: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="三條"
        value={flag(o.triples)}
        options={[
          { value: 0, label: '不能出' },
          { value: 1, label: '可以出' },
        ]}
        onChange={(v) => set({ triples: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="順子大小"
        value={o.straights}
        options={[
          { value: 'twoHigh', label: '2 最大（23456 最大）' },
          { value: 'natural', label: 'A 當 1（A2345 最小）' },
        ]}
        onChange={(straights) => set({ straights })}
        disabled={!editable}
      />
      <Segmented
        label="結算時手上的 2"
        value={flag(o.twosDouble)}
        options={[
          { value: 0, label: '不另外算' },
          { value: 1, label: '每張再加倍' },
        ]}
        onChange={(v) => set({ twosDouble: v === 1 })}
        disabled={!editable}
      />
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

/** 一張牌的牌面；`small` 是桌上、結算用的小牌 */
function CardFace({ card, small }: { card: Card; small?: boolean }) {
  return (
    <span className={`b2-card${small ? ' small' : ''}${isRed(card) ? ' red' : ''}`} aria-label={cardLabel(card)}>
      <CardInk card={card} />
    </span>
  )
}

function CardInk({ card }: { card: Card }) {
  return (
    <>
      <span className="b2-card-corner" aria-hidden>
        <span>{RANKS[rankOf(card)]}</span>
        <span>{SUITS[suitOf(card)]}</span>
      </span>
      <span className="b2-card-pip" aria-hidden>
        {SUITS[suitOf(card)]}
      </span>
    </>
  )
}

/** 一行文字版的牌：♠5 ♥5 */
function MiniCards({ cards }: { cards: Card[] }) {
  return (
    <span className="b2-mini-cards">
      {cards.map((c) => (
        <span key={c} className={`b2-mini${isRed(c) ? ' red' : ''}`}>
          {cardText(c)}
        </span>
      ))}
    </span>
  )
}

function Board({ party, view }: { party: B2Party; view: B2View }) {
  const me = view.you
  const name = (seat: number) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const ended = view.stage === 'end'
  const myTurn = me !== null && view.turn === me

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  if (ended && view.result) {
    const won = view.result.winner === me
    status = won ? '你出完了，這局你贏！' : `${name(view.result.winner)} 出完了`
    tone = me === null ? 'ok' : won ? 'ok' : 'danger'
  } else if (myTurn) {
    if (view.table) status = `輪到你：壓過 ${name(view.table.seat)} 的${KIND_NAMES[view.table.kind]}，或 pass`
    else if (view.first) status = '輪到你先出，第一手要包含 ♣3'
    else status = '輪到你自由出牌'
    tone = 'accent'
  } else if (view.turn !== null) {
    status = `${name(view.turn)} 思考中…`
  }

  // 自己在下面，其他三家照出牌順序：上家（左）、對家（中）、下家（右）；觀戰時四家都列出來
  const base = me ?? 0
  const around =
    me === null
      ? [0, 1, 2, 3].map((seat) => ({ seat, pos: null as string | null }))
      : [
          { seat: (base + 3) % 4, pos: '上家' },
          { seat: (base + 2) % 4, pos: '對家' },
          { seat: (base + 1) % 4, pos: '下家' },
        ]

  return (
    <div className="b2-board">
      <StatusLine tone={tone}>
        {status} {!ended && <Countdown ms={view.endsIn} stamp={view} />}
      </StatusLine>
      <ul className={`b2-seats${me === null ? ' four' : ''}`} aria-label="其他玩家">
        {around.map(({ seat, pos }) => (
          <SeatTile key={seat} party={party} view={view} seat={seat} pos={pos} name={name(seat)} />
        ))}
      </ul>
      <Felt view={view} name={name} />
      {me !== null && view.hand && !ended && (
        <Hand key={view.game} party={party} view={view} me={me} hand={view.hand} myTurn={myTurn} />
      )}
      {ended && view.result && <Result party={party} view={view} name={name} />}
      <p className="muted b2-game-no">第 {view.game} 局</p>
    </div>
  )
}

function SeatTile({
  party,
  view,
  seat,
  pos,
  name,
}: {
  party: B2Party
  view: B2View
  seat: number
  pos: string | null
  name: string
}) {
  const s = view.seats[seat]
  const player = party.playerAt(seat)
  const turn = view.turn === seat
  const won = view.result?.winner === seat
  const last = s.last
  return (
    <li className={`b2-seat${turn ? ' turn' : ''}${won ? ' won' : ''}`}>
      <div className="b2-seat-head">
        <span className="b2-seat-name">{name}</span>
        {pos && <span className="b2-seat-pos">{pos}</span>}
      </div>
      <div className="b2-seat-count">
        <span className="b2-back" aria-hidden />
        <span className={s.count <= 2 && s.count > 0 ? 'b2-low' : ''}>
          {s.count === 0 ? '出完了' : s.count <= 2 ? `剩 ${s.count} 張！` : `${s.count} 張`}
        </span>
      </div>
      <div className="b2-seat-chips">
        {player?.bot && <span className="chip subtle">電腦</span>}
        {!s.online && <span className="chip subtle">離線</span>}
        <span className="b2-total">{s.total} 分</span>
      </div>
      <div className="b2-seat-last">
        {last && 'pass' in last ? (
          <span className="b2-pass">pass</span>
        ) : last ? (
          <MiniCards cards={last.cards} />
        ) : turn ? (
          <span className="muted">思考中…</span>
        ) : null}
      </div>
    </li>
  )
}

/** 桌子中間：這一圈最大的那手 */
function Felt({ view, name }: { view: B2View; name: (seat: number) => string }) {
  const table = view.table
  let caption: string
  if (table) caption = `${name(table.seat)} · ${KIND_NAMES[table.kind]}`
  else if (view.turn === null) caption = ''
  else if (view.first) caption = `${name(view.turn)} 先出，第一手要包含 ♣3`
  else caption = `${name(view.turn)} 自由出牌`
  return (
    <div className="b2-felt" aria-live="polite">
      {table ? (
        <div className="b2-felt-cards">
          {table.cards.map((c) => (
            <CardFace key={c} card={c} small />
          ))}
        </div>
      ) : (
        <div className="b2-felt-empty" aria-hidden>
          ♠ ♥ ♦ ♣
        </div>
      )}
      {caption && <p>{caption}</p>}
    </div>
  )
}

const SORT_KEY = 'bigtwo:sort'

function Hand({
  party,
  view,
  me,
  hand,
  myTurn,
}: {
  party: B2Party
  view: B2View
  me: number
  hand: Card[]
  myTurn: boolean
}) {
  const [sort, setSort] = useState<SortMode>(() => (load<string>(SORT_KEY, 'rank') === 'suit' ? 'suit' : 'rank'))
  const [picked, setPicked] = useState<Card[]>([])
  const [hint, setHint] = useState<{ plays: Combo[]; i: number } | null>(null)
  // 送出後到收到新的 view 之前不能再按，避免連點送兩次
  const [sent, setSent] = useState<B2View | null>(null)
  const waiting = sent === view

  // 打出去的牌不在手上了，自然就不算選取
  const selected = picked.filter((c) => hand.includes(c))
  const match = view.plays.find((p) => sameCards(p.cards, selected)) ?? null
  const canPass = myTurn && view.table !== null
  const mySeat = view.seats[me]

  function toggle(card: Card) {
    setPicked(selected.includes(card) ? selected.filter((c) => c !== card) : [...selected, card])
  }

  function changeSort(next: SortMode) {
    setSort(next)
    save(SORT_KEY, next)
  }

  function nextHint() {
    if (view.plays.length === 0) return
    const i = hint && hint.plays === view.plays ? (hint.i + 1) % view.plays.length : 0
    setHint({ plays: view.plays, i })
    setPicked(view.plays[i].cards)
  }

  function play() {
    if (!match) return
    setSent(view)
    party.act({ type: 'play', cards: match.cards })
    setPicked([])
  }

  function pass() {
    setSent(view)
    party.act({ type: 'pass' })
    setPicked([])
  }

  let note: string | null = null
  if (myTurn && view.plays.length === 0) note = '沒有壓得過的牌，只能 pass'
  else if (selected.length > 0 && myTurn && !match) note = '這組牌不能出（牌型不對或壓不過）'
  else if (selected.length > 0 && !myTurn) note = '可以先選好，輪到你再出'

  return (
    <section className={`b2-hand-area${myTurn ? ' my-turn' : ''}`} aria-label="你的手牌">
      <div className="b2-me">
        <strong>你</strong>
        <span>{hand.length} 張</span>
        <span>{mySeat.total} 分</span>
        {mySeat.last && 'pass' in mySeat.last && <span className="b2-pass">pass</span>}
        {mySeat.last && !('pass' in mySeat.last) && <MiniCards cards={mySeat.last.cards} />}
      </div>
      <div className="b2-hand">
        {sortHand(hand, sort).map((card) => {
          const on = selected.includes(card)
          return (
            <button
              key={card}
              type="button"
              className={`b2-card${isRed(card) ? ' red' : ''}${on ? ' picked' : ''}`}
              onClick={() => toggle(card)}
              aria-pressed={on}
              aria-label={cardLabel(card)}
            >
              <CardInk card={card} />
            </button>
          )
        })}
      </div>
      <div className="b2-controls">
        <button type="button" onClick={play} disabled={!myTurn || !match || waiting}>
          {match ? `出${KIND_NAMES[match.kind]}` : '出牌'}
        </button>
        <button type="button" className="secondary" onClick={pass} disabled={!canPass || waiting}>
          pass
        </button>
        <button type="button" className="secondary" onClick={nextHint} disabled={!myTurn || view.plays.length === 0}>
          提示{hint && hint.plays === view.plays ? ` ${hint.i + 1}/${view.plays.length}` : ''}
        </button>
        <button type="button" className="secondary" onClick={() => setPicked([])} disabled={selected.length === 0}>
          取消選取
        </button>
      </div>
      {note && <p className="muted b2-note">{note}</p>}
      <Segmented
        label="手牌排序"
        value={sort}
        options={[
          { value: 'rank', label: '照點數' },
          { value: 'suit', label: '照花色' },
        ]}
        onChange={changeSort}
      />
    </section>
  )
}

function Result({ party, view, name }: { party: B2Party; view: B2View; name: (seat: number) => string }) {
  const result = view.result!
  const order = [0, 1, 2, 3].sort((a, b) => result.deltas[b] - result.deltas[a])
  return (
    <section className="b2-result">
      <h3>第 {view.game} 局結算</h3>
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
            <tr key={seat} className={seat === view.you ? 'b2-result-me' : undefined}>
              <td className="primary" data-label="玩家">
                {name(seat)}
                {party.playerAt(seat)?.bot && <span className="chip subtle">電腦</span>}
              </td>
              <td data-label="剩下的牌">
                {seat === result.winner ? (
                  <span className="b2-won">出完了！</span>
                ) : (
                  <>
                    <span className="b2-left-count">{result.hands[seat].length} 張</span>
                    <MiniCards cards={result.hands[seat]} />
                  </>
                )}
              </td>
              <td data-label="這局" className={result.deltas[seat] > 0 ? 'b2-plus' : result.deltas[seat] < 0 ? 'b2-minus' : ''}>
                {result.deltas[seat] > 0 ? `+${result.deltas[seat]}` : result.deltas[seat]}
              </td>
              <td data-label="總分">{view.seats[seat].total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
