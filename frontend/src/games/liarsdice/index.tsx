import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  bidText,
  FACES,
  faceRank,
  matchKind,
  type Bid,
  type LiarsOptions,
  type LiarsParty as LiarsTypes,
  type LiarsView,
  type Reveal,
} from './types'
import './liarsdice.css'

type LParty = Party<LiarsTypes>
type NameOf = (seat: number) => string

/** 吹牛骰子：規則都在伺服器（backend/src/liarsdice.rs），這裡只畫自己的 view、送動作 */
export default function LiarsDice() {
  const party = useParty<LiarsTypes>('liarsdice')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>
            每人一個骰盅、五顆骰子，只看得到自己的。輪流喊「場上有幾個幾點」，一個比一個大，不信就「開」！2～10 人，人不夠可以加電腦。
          </p>
        </PartyEntry>
      </GameLayout>
    )
  }
  return <InRoom party={party} />
}

function Rules({ options }: { options?: LiarsOptions }) {
  const o = options
  const opening =
    o?.opening === 'one' ? '起叫不限個數' : o?.opening === 'players' ? '起叫最少喊「人數」個' : '起叫最少喊「人數 + 1」個'
  return (
    <div className="game-help">
      <strong>怎麼玩</strong>
      <ul>
        <li>每人五顆骰子蓋在骰盅裡，只看得到自己的。大家一起搖，輪流喊「場上至少有 N 個 F 點」。</li>
        <li>下一個人要喊得更大：個數更多，或個數一樣、點數更大；不相信就「開」。</li>
        <li>開了就全部掀開來數：夠 N 個是喊的成立，開的人輸；不夠就是喊的人輸。</li>
        {(!o || o.wildOnes) && (
          <li>
            一點是萬用的，數的時候也算進去（喊的就是一點時只數一點），所以一點最大：2 &lt; 3 &lt; 4 &lt; 5 &lt; 6 &lt; 1。
            {(!o || o.onesLock) && '這輪有人喊過一點之後，一點就不再萬用。'}
          </li>
        )}
        {o && !o.wildOnes && <li>一點不萬用，點數照數字比：1 最小、6 最大。</li>}
        <li>{opening}，但不會超過場上骰子的一半；最多喊到場上的骰子總數。</li>
        {(!o || o.scatter) && <li>五顆點數全不同叫「散骰」，還沒喊之前可以重搖。</li>}
        <li>
          {o?.mode === 'points'
            ? `計分制：打 ${o.rounds} 輪，輸一次喝一杯，最後喝最少的贏。`
            : '淘汰制：輸的人少一顆骰子，骰子輸光就出局，剩最後一個人贏。'}
          下一輪由輸的人先喊。
        </li>
        <li>{o && o.thinkSecs > 0 ? `每手有 ${o.thinkSecs} 秒，` : ''}時間到或斷線由電腦代為出手。</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: LParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩吹牛骰子"
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
      <div className="ld">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const side = (
    <>
      {view && <GameLog view={view} />}
      <ChatBox party={party} />
      <Rules options={view?.options ?? room.options} />
    </>
  )
  const lobby = (
    <PartyLobby
      party={party}
      options={<OptionsForm party={party} />}
      hint={<p className="muted">2～10 人，人不夠可以加電腦玩家（穩健阿伯、唬爛王、算盤阿姨、老實阿弟，個性都不一樣）。</p>}
    />
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="ld">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>{lobby}</GameLayout>
      </div>
    )
  }

  return (
    <div className="ld">
      {header}
      <GameLayout side={side}>
        <Board party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && lobby}
      </GameLayout>
    </div>
  )
}

function OptionsForm({ party }: { party: LParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<LiarsOptions>) => party.setOptions({ ...o, ...patch })
  const flag = (value: boolean) => (value ? 1 : 0)

  return (
    <div className="ld-options">
      <Segmented
        label="勝負"
        value={o.mode}
        options={[
          { value: 'elimination', label: '淘汰制（輸了少一顆）' },
          { value: 'points', label: '計分制（輸了喝一杯）' },
        ]}
        onChange={(mode) => set({ mode })}
        disabled={!editable}
      />
      {o.mode === 'points' && (
        <Segmented
          label="輪數"
          value={o.rounds}
          options={[5, 10, 15, 20].map((r) => ({ value: r, label: `${r} 輪` }))}
          onChange={(rounds) => set({ rounds })}
          disabled={!editable}
        />
      )}
      <Segmented
        label="一點"
        value={flag(o.wildOnes)}
        options={[
          { value: 1, label: '萬用' },
          { value: 0, label: '不萬用' },
        ]}
        onChange={(v) => set({ wildOnes: v === 1 })}
        disabled={!editable}
      />
      {o.wildOnes && (
        <Segmented
          label="有人喊過一點之後"
          value={flag(o.onesLock)}
          options={[
            { value: 1, label: '這輪不再萬用' },
            { value: 0, label: '照樣萬用' },
          ]}
          onChange={(v) => set({ onesLock: v === 1 })}
          disabled={!editable}
        />
      )}
      <Segmented
        label="起叫最少"
        value={o.opening}
        options={[
          { value: 'playersPlusOne', label: '人數 + 1' },
          { value: 'players', label: '人數' },
          { value: 'one', label: '不限' },
        ]}
        onChange={(opening) => set({ opening })}
        disabled={!editable}
      />
      <Segmented
        label="散骰（五顆全不同）"
        value={flag(o.scatter)}
        options={[
          { value: 1, label: '可以重搖' },
          { value: 0, label: '不能重搖' },
        ]}
        onChange={(v) => set({ scatter: v === 1 })}
        disabled={!editable}
      />
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
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

/** 骰子點的位置：3×3 格子的編號 */
const PIPS: Record<number, number[]> = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

/** 一顆骰子；一點和四點是紅點。`tone` 是揭曉時的標記，`i` 是動畫的順序 */
function Die({
  face,
  size,
  tone,
  i,
  label,
}: {
  face: number
  size?: 'sm' | 'lg'
  tone?: 'match' | 'wild' | 'miss' | 'mark'
  i?: number
  label?: string
}) {
  const cls = ['ld-die', `f${face}`, size, tone, (face === 1 || face === 4) && 'red'].filter(Boolean).join(' ')
  const style = i === undefined ? undefined : ({ '--i': i } as CSSProperties)
  // label 是空字串：旁邊已經有文字說明了，螢幕閱讀器跳過
  const a11y = label === '' ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label ?? `${face} 點` }
  return (
    <span className={cls} style={style} {...a11y}>
      {Array.from({ length: 9 }, (_, k) => (
        <span key={k} className={PIPS[face].includes(k) ? 'pip' : undefined} />
      ))}
    </span>
  )
}

/** 喊價：「3 個 ⚄」 */
function BidLabel({ bid, size = 'sm' }: { bid: Bid; size?: 'sm' | 'lg' }) {
  return (
    <span className={`ld-bid${size === 'lg' ? ' big' : ''}`} aria-label={bidText(bid)}>
      <span aria-hidden>{bid.count} 個</span>
      <Die face={bid.face} size={size} label="" />
    </span>
  )
}

/** 骰盅；`rolls` 換了就重掛、播一次搖的動畫 */
function Cup({ size, shake, lifted }: { size?: 'sm' | 'lg'; shake?: boolean; lifted?: boolean }) {
  const cls = ['ld-cup', size, shake && 'shake', lifted && 'lifted'].filter(Boolean).join(' ')
  return <span className={cls} aria-hidden />
}

function Board({ party, view }: { party: LParty; view: LiarsView }) {
  const me = view.you
  const name: NameOf = (seat) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const n = view.seats.length
  const myTurn = me !== null && view.turn === me && view.stage === 'bidding'
  const points = view.options.mode === 'points'

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  if (view.stage === 'end' && view.result) {
    const won = me !== null && view.result.winners.includes(me)
    const who = view.result.winners.map(name).join('、')
    status = won ? (view.result.winners.length > 1 ? `你和 ${who} 一起拿下這局！` : '你拿下這局！') : `${who} 拿下這局`
    tone = won || me === null ? 'ok' : 'danger'
  } else if (view.stage === 'rolling') {
    status = '大家搖骰中…'
  } else if (view.stage === 'reveal' && view.reveal) {
    const r = view.reveal
    status = `${name(r.opener)} 開了！${r.loser === me ? '你輸了這輪' : `${name(r.loser)} 輸了這輪`}`
    tone = r.loser === me ? 'danger' : 'accent'
  } else if (myTurn) {
    status = view.bid ? '輪到你：喊得更大，或者開！' : `輪到你起叫（最少 ${view.minOpen} 個）`
    tone = 'accent'
  } else if (view.turn !== null) {
    status = `${name(view.turn)} 思考中…`
  }

  // 從自己的下一位開始照順序排；觀戰從座位 0 開始
  const base = me ?? -1
  const order = Array.from({ length: n }, (_, k) => (base + 1 + k + n) % n).filter((s) => s !== me)
  const out = me !== null && view.seats[me].dice === 0

  return (
    <div className="ld-board">
      <StatusLine tone={tone}>
        {status} {view.stage === 'bidding' && <Countdown ms={view.endsIn} stamp={view} />}
      </StatusLine>
      <p className="ld-info">
        <span>{points ? `第 ${view.round}／${view.options.rounds} 輪` : `第 ${view.round} 輪`}</span>
        <span>場上 {view.total} 顆骰子</span>
        <span className={view.wild ? 'ld-wild-on' : undefined}>
          {view.options.wildOnes ? (view.wild ? '一點萬用' : '一點被喊過，不萬用') : '一點不萬用'}
        </span>
      </p>
      <Table party={party} view={view} name={name} />
      <ul className="ld-seats" aria-label="其他玩家">
        {order.map((seat) => (
          <SeatTile key={seat} party={party} view={view} seat={seat} name={name(seat)} />
        ))}
      </ul>
      {(view.stage === 'reveal' || view.stage === 'end') && view.reveal && (
        <RevealPanel party={party} view={view} reveal={view.reveal} name={name} />
      )}
      {/* 揭曉時自己的骰子在上面一起攤開，這裡先收起來 */}
      {me !== null && view.mine && !out && (view.stage === 'rolling' || view.stage === 'bidding') && (
        <MyArea party={party} view={view} me={me} mine={view.mine} myTurn={myTurn} />
      )}
      {out && view.stage !== 'end' && <p className="muted ld-note">你的骰子輸光了，在旁邊看到這局結束。</p>}
      {view.stage === 'end' && view.result && <Result party={party} view={view} name={name} />}
      <p className="muted ld-game-no">第 {view.game} 局</p>
    </div>
  )
}

/** 桌子中間：現在的喊價和這輪喊過的 */
function Table({ party, view, name }: { party: LParty; view: LiarsView; name: NameOf }) {
  let main: ReactNode
  if (view.stage === 'rolling') {
    main = <p className="ld-table-hint">搖搖搖…</p>
  } else if (view.bid) {
    main = (
      <div className="ld-current" key={view.history.length}>
        <span className="ld-current-who">{name(view.bid.seat)} 喊</span>
        <BidLabel bid={view.bid} size="lg" />
      </div>
    )
  } else if (view.stage === 'bidding' && view.turn !== null) {
    main = (
      <p className="ld-table-hint">
        等 {view.turn === view.you ? '你' : name(view.turn)} 起叫（最少 {view.minOpen} 個）
      </p>
    )
  } else {
    main = <p className="ld-table-hint">—</p>
  }
  const earlier = view.history.slice(0, -1)
  return (
    <div className="ld-felt" aria-live="polite">
      {main}
      {earlier.length > 0 && (
        <ol className="ld-history" aria-label="這輪喊過的">
          {earlier.map((b, i) => (
            <li key={i}>
              <span className="ld-history-who">{party.playerAt(b.seat)?.name ?? `座位 ${b.seat + 1}`}</span>
              <BidLabel bid={b} />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function SeatTile({ party, view, seat, name }: { party: LParty; view: LiarsView; seat: number; name: string }) {
  const s = view.seats[seat]
  const player = party.playerAt(seat)
  const turn = view.turn === seat && view.stage === 'bidding'
  const out = s.dice === 0
  const won = view.result?.winners.includes(seat)
  const lost = view.stage === 'reveal' && view.reveal?.loser === seat
  const cls = ['ld-seat', turn && 'turn', out && 'out', won && 'won', lost && 'lost'].filter(Boolean).join(' ')
  const startDice = 5
  return (
    <li className={cls}>
      <div className="ld-seat-head">
        <span className="ld-seat-name">{name}</span>
        {player?.bot && <span className="chip subtle">電腦</span>}
        {!s.online && <span className="chip subtle">離線</span>}
      </div>
      <div className="ld-seat-body">
        {!out && <Cup key={s.rolls} size="sm" shake lifted={view.stage === 'reveal' || view.stage === 'end'} />}
        <span className="ld-pips" aria-label={out ? '出局' : `${s.dice} 顆骰子`}>
          {out
            ? '出局'
            : Array.from({ length: Math.max(startDice, s.dice) }, (_, i) => (
                <span key={i} className={i < s.dice ? 'on' : undefined} aria-hidden />
              ))}
        </span>
      </div>
      <div className="ld-seat-foot">
        {s.bid ? (
          <BidLabel bid={s.bid} />
        ) : turn ? (
          <span className="muted">思考中…</span>
        ) : s.rerolled ? (
          <span className="muted">散骰重搖</span>
        ) : null}
        {s.cups > 0 && <span className="ld-cups">喝 {s.cups} 杯</span>}
        {view.stage === 'reveal' && s.ready && <span className="ld-ready">✓</span>}
      </div>
    </li>
  )
}

/** 揭曉：所有人的骰子攤開，標出符合的（萬用的一點另外標），數給大家看 */
function RevealPanel({ party, view, reveal, name }: { party: LParty; view: LiarsView; reveal: Reveal; name: NameOf }) {
  const { bid, wild, hands, matched, loser, bidder, opener } = reveal
  const all = hands.flat()
  const exact = all.filter((d) => d === bid.face).length
  const wilds = wild ? all.filter((d) => d === 1).length : 0
  const holds = matched >= bid.count
  const me = view.you
  const points = view.options.mode === 'points'
  // 動畫的順序：一個人一個人、一顆一顆攤開
  let k = 0
  const consequence = points
    ? `${name(loser)} 喝一杯（這局第 ${view.seats[loser].cups} 杯）`
    : reveal.out
      ? `${name(loser)} 的骰子輸光了，出局！`
      : `${name(loser)} 少一顆骰子，剩 ${view.seats[loser].dice} 顆`
  const canReady = view.stage === 'reveal' && me !== null && !view.seats[me].ready
  const humans = view.seats.filter((s, i) => s.online && !party.playerAt(i)?.bot)
  const readyCount = humans.filter((s) => s.ready).length

  return (
    <section className={`ld-reveal${holds ? ' holds' : ' fails'}`} aria-label="開盅">
      <h3>
        <span className="ld-open-word">開！</span>
        {name(opener)}
        {reveal.auto && '（電腦代開）'} 開 {name(bidder)} 的 <BidLabel bid={bid} />
      </h3>
      <ul className="ld-hands">
        {hands.map((hand, seat) => {
          if (hand.length === 0) return null
          const count = hand.filter((d) => matchKind(d, reveal) !== 'miss').length
          return (
            <li key={seat} className={seat === loser ? 'loser' : undefined}>
              <span className="ld-hand-name">
                {seat === me ? '你' : name(seat)}
                {seat === bidder && <span className="chip subtle">喊</span>}
                {seat === opener && <span className="chip subtle">開</span>}
              </span>
              <span className="ld-dice reveal">
                {hand.map((d, j) => (
                  <Die key={j} face={d} tone={matchKind(d, reveal)} i={k++} />
                ))}
              </span>
              <span className="ld-hand-count" aria-label={`${count} 顆符合`}>
                {count}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="ld-tally" style={{ '--i': k } as CSSProperties}>
        <span>數一數：</span>
        <Die face={bid.face} size="sm" tone="match" /> × {exact}
        {wild && (
          <>
            <span>＋ 萬用</span>
            <Die face={1} size="sm" tone="wild" /> × {wilds}
          </>
        )}
        <span>
          ＝ <strong>{matched}</strong> 個
        </span>
      </p>
      {!wild && bid.face !== 1 && view.options.wildOnes && (
        <p className="muted ld-reveal-note">這輪有人喊過一點，一點不算萬用。</p>
      )}
      {bid.face === 1 && view.options.wildOnes && <p className="muted ld-reveal-note">喊的是一點，只數一點。</p>}
      <p className="ld-verdict" style={{ '--i': k } as CSSProperties}>
        {holds
          ? `喊 ${bid.count} 個，實際有 ${matched} 個，喊的成立 → 開的 ${name(opener)} 輸`
          : `喊 ${bid.count} 個，實際只有 ${matched} 個 → ${name(bidder)} 喊太大了，輸`}
        <br />
        <strong>{consequence}</strong>
      </p>
      {view.stage === 'reveal' && (
        <div className="ld-reveal-next">
          {me !== null && (
            <button type="button" onClick={() => party.act({ type: 'ready' })} disabled={!canReady}>
              {canReady ? (view.final ? '看結果' : '看懂了，下一輪') : '等其他人…'}
            </button>
          )}
          <span className="muted">
            {humans.length > 1 && `${readyCount}/${humans.length} 人看完了・`}
            <Countdown ms={view.nextIn} stamp={view} /> 後{view.final ? '結算' : '下一輪'}
          </span>
        </div>
      )}
    </section>
  )
}

/** 自己的骰盅、散骰重搖、喊價 */
function MyArea({
  party,
  view,
  me,
  mine,
  myTurn,
}: {
  party: LParty
  view: LiarsView
  me: number
  mine: number[]
  myTurn: boolean
}) {
  // 選的點數只在這一手有效：換手（有人喊了）就回到預設
  const turnKey = `${view.round}-${view.history.length}`
  const [pick, setPick] = useState<{ key: string; face: number } | null>(null)
  const legal = (f: number) => view.minCounts[f - 1] !== null
  const face = myTurn ? (pick && pick.key === turnKey && legal(pick.face) ? pick.face : defaultFace(view, mine)) : null
  // 輪到自己時標出選的點數，不然標現在喊的點數
  const mark = face ?? view.bid?.face ?? null
  const rolling = view.stage === 'rolling'
  const seat = view.seats[me]
  const have = mark === null ? 0 : mine.filter((d) => d === mark || (view.wild && mark !== 1 && d === 1)).length

  return (
    <section className={`ld-me${myTurn ? ' my-turn' : ''}`} aria-label="你的骰盅">
      <div className="ld-me-head">
        <strong>你的骰子</strong>
        <span>{seat.dice} 顆</span>
        {seat.cups > 0 && <span>喝了 {seat.cups} 杯</span>}
      </div>
      <div className="ld-mycup">
        {rolling ? (
          <Cup key={seat.rolls} size="lg" shake />
        ) : (
          <span key={seat.rolls} className="ld-dice fresh" aria-label={`你的骰子：${mine.join('、')}`}>
            {mine.map((d, i) => (
              <Die
                key={i}
                face={d}
                size="lg"
                i={i}
                tone={mark !== null && (d === mark || (view.wild && mark !== 1 && d === 1)) ? 'mark' : undefined}
              />
            ))}
          </span>
        )}
      </div>
      {!rolling && mark !== null && view.stage === 'bidding' && (
        <p className="muted ld-have">
          你手上有 {have} 個 {mark}
          {view.wild && mark !== 1 ? '（含萬用的一點）' : ''}；其他 {view.total - mine.length} 顆骰子平均約{' '}
          {(((view.total - mine.length) * (view.wild && mark !== 1 ? 2 : 1)) / 6).toFixed(1)} 個
        </p>
      )}
      {view.canReroll && !rolling && (
        <div className="ld-scatter">
          <span>五顆全不同，是散骰！</span>
          <button type="button" className="secondary" onClick={() => party.act({ type: 'reroll' })}>
            重搖
          </button>
        </div>
      )}
      {myTurn && face !== null && (
        <BidPad key={turnKey} party={party} view={view} face={face} onFace={(f) => setPick({ key: turnKey, face: f })} />
      )}
      {!myTurn && view.stage === 'bidding' && <p className="muted ld-note">等其他人喊…</p>}
    </section>
  )
}

/** 預設選手上最多的點數（萬用的一點也算），同樣多選比較小的 */
function defaultFace(view: LiarsView, mine: number[]): number {
  const onesHigh = view.options.wildOnes
  const score = (f: number) => mine.filter((d) => d === f || (view.wild && f !== 1 && d === 1)).length
  const legal = FACES.filter((f) => view.minCounts[f - 1] !== null)
  const sorted = [...legal].sort((a, b) => score(b) - score(a) || faceRank(a, onesHigh) - faceRank(b, onesHigh))
  return sorted[0] ?? 6
}

/** 最低能喊的：個數最少，同個數點數最小 */
function lowestBid(view: LiarsView): Bid | null {
  let best: Bid | null = null
  for (const f of FACES) {
    const c = view.minCounts[f - 1]
    if (c === null) continue
    const rank = faceRank(f, view.options.wildOnes)
    if (!best || c < best.count || (c === best.count && rank < faceRank(best.face, view.options.wildOnes))) {
      best = { count: c, face: f }
    }
  }
  return best
}

/** 喊價：點數用六個按鈕，個數用加減，顯示最低能喊多少 */
function BidPad({
  party,
  view,
  face,
  onFace,
}: {
  party: LParty
  view: LiarsView
  face: number
  onFace: (face: number) => void
}) {
  const [chosen, setChosen] = useState<{ face: number; count: number } | null>(null)
  // 送出後到收到新的 view 之前不能再按，避免連點送兩次
  const [sent, setSent] = useState<LiarsView | null>(null)
  const waiting = sent === view
  const min = view.minCounts[face - 1]
  const lowest = lowestBid(view)
  const count = min === null ? null : Math.min(view.total, Math.max(min, chosen?.face === face ? chosen.count : min))
  const send = (action: Parameters<LParty['act']>[0]) => {
    setSent(view)
    party.act(action)
  }
  const step = (delta: number) => count !== null && setChosen({ face, count: count + delta })

  return (
    <div className="ld-pad">
      <div className="ld-faces" role="radiogroup" aria-label="點數">
        {FACES.map((f) => {
          const m = view.minCounts[f - 1]
          return (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={f === face}
              className={`ld-face${f === face ? ' active' : ''}`}
              disabled={m === null}
              onClick={() => onFace(f)}
              aria-label={m === null ? `${f} 點（喊不上去了）` : `${f} 點，最少 ${m} 個`}
            >
              <Die face={f} label="" />
              <span className="ld-face-min">{m === null ? '—' : `≥${m}`}</span>
            </button>
          )
        })}
      </div>
      {count !== null && min !== null && (
        <div className="ld-count">
          <button type="button" className="secondary" onClick={() => step(-1)} disabled={count <= min} aria-label="少一個">
            −
          </button>
          <span className="ld-count-value" aria-live="polite">
            <BidLabel bid={{ count, face }} size="lg" />
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => step(1)}
            disabled={count >= view.total}
            aria-label="多一個"
          >
            ＋
          </button>
        </div>
      )}
      <p className="muted ld-lowest">
        {lowest ? (
          <>
            最低能喊 <BidLabel bid={lowest} />
            {min !== null && lowest.face !== face && (
              <>
                ，{face} 點最少 {min} 個
              </>
            )}
          </>
        ) : (
          '已經喊到頂了，只能開'
        )}
      </p>
      <div className="ld-actions">
        {view.bid && (
          <button type="button" className="ld-open" onClick={() => send({ type: 'open' })} disabled={waiting}>
            開！
          </button>
        )}
        {count !== null && (
          <button type="button" onClick={() => send({ type: 'bid', count, face })} disabled={waiting}>
            喊 {bidText({ count, face })}
          </button>
        )}
      </div>
    </div>
  )
}

/** 紀錄：新的在最下面，捲到最下面時才自動跟 */
function GameLog({ view }: { view: LiarsView }) {
  const list = useRef<HTMLOListElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [view.log])
  if (view.log.length === 0) return null
  return (
    <section className="ld-log" aria-label="紀錄">
      <h3>紀錄</h3>
      <ol
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {view.log.map((line, i) => (
          <li key={`${view.log.length}-${i}`} className={line.startsWith('──') ? 'ld-log-round' : undefined}>
            {line}
          </li>
        ))}
      </ol>
    </section>
  )
}

function Result({ party, view, name }: { party: LParty; view: LiarsView; name: NameOf }) {
  const result = view.result!
  const points = view.options.mode === 'points'
  return (
    <section className="ld-result">
      <h3>
        第 {view.game} 局結果（{points ? `${view.round} 輪` : `打了 ${view.round} 輪`}）
      </h3>
      <table className="responsive">
        <thead>
          <tr>
            <th>名次</th>
            <th>玩家</th>
            <th>這局</th>
            <th>累計</th>
          </tr>
        </thead>
        <tbody>
          {result.ranking.map((seat, i) => {
            const s = view.seats[seat]
            const won = result.winners.includes(seat)
            // 計分制同杯數同名次
            const rank = points ? result.ranking.findIndex((x) => view.seats[x].cups === s.cups) + 1 : i + 1
            return (
              <tr key={seat} className={seat === view.you ? 'ld-result-me' : undefined}>
                <td data-label="名次">{won ? '🏆 冠軍' : `第 ${rank} 名`}</td>
                <td className="primary" data-label="玩家">
                  {name(seat)}
                  {party.playerAt(seat)?.bot && <span className="chip subtle">電腦</span>}
                </td>
                <td data-label="這局">
                  {points ? `喝 ${s.cups} 杯` : s.dice > 0 ? `剩 ${s.dice} 顆，喝 ${s.cups} 杯` : `出局，喝 ${s.cups} 杯`}
                </td>
                <td data-label="累計">
                  贏 {s.wins} 局・喝 {s.totalCups} 杯
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
