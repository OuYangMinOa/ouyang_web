import { useState, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  ROLE_INFO,
  ROLE_NAMES,
  ROUNDS,
  WIN_SCORE,
  ZODIAC_EMOJI,
  goalText,
  headName,
  isGood,
  type AntiqueParty,
  type AqOptions,
  type AqRecord,
  type AqView,
  type Head,
  type Role,
  type SkillUse,
} from './types'
import './antique.css'

type AqParty = Party<AntiqueParty>
type NameOf = (seat: number) => string

/** 依人數取前幾個，和後端 ROLES 一樣 */
const LINEUP: Role[] = ['xuYuan', 'fangZhen', 'huangYanyan', 'kidoKana', 'laoChaofeng', 'yaoBuran', 'zhengGuoqu', 'jiYunfu']

/** 古董局中局：規則都在伺服器（backend/src/antique.rs），這裡只畫自己的 view、送動作 */
export default function Antique() {
  const party = useParty<AntiqueParty>('antique')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>
            十二生肖獸首有真有假。許愿陣營要找出真品，老朝奉陣營混在裡面搗亂。三個回合輪流鑑寶、投票，最後再互相指認身分。
            6～8 人，人不夠可以加電腦。
          </p>
        </PartyEntry>
      </GameLayout>
    )
  }
  return <InRoom party={party} />
}

function Rules() {
  return (
    <div className="game-help">
      <strong>怎麼玩</strong>
      <ul>
        <li>許愿陣營要找出真品，老朝奉陣營要混淆視聽。老朝奉和藥不然互相認識，鄭國渠不和隊友相認。</li>
        <li>共三回合，每回合 4 件獸首（2 真 2 假）。輪到你時先鑑定（方震是查驗一個人的陣營），有技能就用技能，再指定下一位還沒行動的人。</li>
        <li>大家都行動完就討論，說說你看到什麼（壞人會說謊，好人也可能被老朝奉騙了）。</li>
        <li>投票：每人每回合 2 枚籌碼，可以留到之後再用，最後一回合要全部投出。得票第一的獸首入選但不公開真假，第二名入選並公開真假。</li>
        <li>三回合後鑑人：許愿陣營找老朝奉，老朝奉找許愿，藥不然找方震。</li>
        <li>
          計分：入選的真品每件 +1；許愿陣營過半數投中老朝奉 +1；許愿沒被老朝奉找到 +2；方震沒被藥不然找到 +1。
          {WIN_SCORE} 分以上許愿陣營贏，六件入選的全是真品就直接贏。
        </li>
        <li>6 人局沒有鄭國渠和姬雲浮，7 人局沒有姬雲浮。分數在同一個房間累計：贏的陣營每人 1 分。</li>
      </ul>
      <strong>角色</strong>
      <ul>
        {LINEUP.map((role) => (
          <li key={role}>
            <strong>{ROLE_NAMES[role]}</strong>（{isGood(role) ? '許愿陣營' : '老朝奉陣營'}）：{ROLE_INFO[role]}
          </li>
        ))}
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: AqParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩古董局中局"
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
      <div className="aq">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const side = (
    <>
      <ChatBox party={party} placeholder={chatHint(view)} />
      <Rules />
    </>
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="aq">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>
          <PartyLobby party={party} options={<OptionsForm party={party} />} />
        </GameLayout>
      </div>
    )
  }

  return (
    <div className="aq">
      {header}
      <GameLayout side={side}>
        <Board party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && <PartyLobby party={party} options={<OptionsForm party={party} />} />}
      </GameLayout>
    </div>
  )
}

function chatHint(view: AqView | null): string {
  if (!view || view.stage === 'end') return '說點什麼…'
  if (view.you === null) return '觀戰中：只有觀戰的人看得到'
  return '例如：鼠首是真的、牛首是假的'
}

function OptionsForm({ party }: { party: AqParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<AqOptions>) => party.setOptions({ ...o, ...patch })
  const players = Math.min(room.players.filter((p) => p.bot || p.online).length, room.max)

  return (
    <div className="aq-options">
      <Segmented
        label="玩法"
        value={o.offline ? 1 : 0}
        options={[
          { value: 0, label: '線上聊天' },
          { value: 1, label: '線下當面' },
        ]}
        onChange={(v) => set({ offline: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="每人行動時間"
        value={o.turnSecs}
        options={[
          ...[30, 60, 90].map((s) => ({ value: s, label: `${s} 秒` })),
          { value: 0, label: '不限' },
        ]}
        onChange={(turnSecs) => set({ turnSecs })}
        disabled={!editable}
      />
      {!o.offline && (
        <Segmented
          label="討論時間"
          value={o.discussSecs}
          options={[60, 120, 180, 300].map((s) => ({ value: s, label: s < 120 ? `${s} 秒` : `${s / 60} 分` }))}
          onChange={(discussSecs) => set({ discussSecs })}
          disabled={!editable}
        />
      )}
      <p className={players >= 6 ? 'muted' : 'error'}>
        {players < 6
          ? `至少要 6 人（現在 ${players} 人），可以加電腦補位`
          : `${Math.min(players, 8)} 人：${LINEUP.slice(0, Math.min(players, 8))
              .map((r) => ROLE_NAMES[r])
              .join('、')}`}
      </p>
      {o.offline && <p className="muted">線下模式：大家當面討論，討論沒有倒數，所有人都按「可以投票了」才開始投票。</p>}
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

/** 點座位要做什麼（查驗、偷襲、交棒、鑑人） */
type SeatPick = { can: (seat: number) => boolean; act: (seat: number) => void; chosen?: number | null }

function Board({ party, view }: { party: AqParty; view: AqView }) {
  const me = view.you
  const name: NameOf = (seat) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const myTurn = view.turn !== null && view.turn.seat === me
  const step = myTurn ? view.turn!.step : null
  const role = view.me?.role ?? null
  const remaining = view.seats.map((_, i) => i).filter((i) => !view.order.includes(i))
  const current = view.heads.filter((h) => h.round === view.round)

  let seatPick: SeatPick | null = null
  if (myTurn && step === 'identify' && role === 'fangZhen') {
    seatPick = {
      can: (i) => i !== me && !view.me!.checked.includes(i),
      act: (seat) => party.act({ type: 'check', seat }),
    }
  } else if (myTurn && step === 'skill' && role === 'yaoBuran') {
    seatPick = { can: (i) => i !== me, act: (seat) => party.act({ type: 'ambush', seat }) }
  } else if (myTurn && step === 'pass' && remaining.length > 0) {
    seatPick = { can: (i) => remaining.includes(i), act: (seat) => party.act({ type: 'pass', seat }) }
  } else if (view.stage === 'ident' && view.me?.goal) {
    seatPick = {
      can: (i) => !view.me!.forbidden.includes(i),
      act: (seat) => party.act({ type: 'accuse', seat }),
      chosen: view.me.accused,
    }
  }

  return (
    <div className="aq-board">
      <RoleCard view={view} name={name} />
      <StatusLine tone={statusTone(view, myTurn)}>
        {statusText(view, myTurn, name)} <Countdown ms={view.endsIn} stamp={view} />
      </StatusLine>
      <p className="muted aq-lineup">
        {view.stage !== 'end' && `第 ${view.round + 1} / ${ROUNDS} 回合 · `}
        {view.lineup.map((r) => ROLE_NAMES[r]).join('、')}
        {view.options.offline && ' · 線下當面'}
      </p>

      <ActionPanel party={party} view={view} remaining={remaining} name={name} />
      {view.stage !== 'end' && <Heads party={party} view={view} heads={current} />}
      <Seats party={party} view={view} name={name} pick={seatPick} />
      {view.end && <Result view={view} name={name} />}
      {view.me && <Notes view={view} name={name} />}
      <History view={view} name={name} />
    </div>
  )
}

function statusTone(view: AqView, myTurn: boolean): 'ok' | 'danger' | 'accent' | undefined {
  if (view.stage === 'end') {
    const role = view.me?.role
    if (!role) return 'ok'
    return isGood(role) === (view.end?.result.winner === 'good') ? 'ok' : 'danger'
  }
  if (myTurn || view.stage === 'vote' || view.stage === 'ident') return 'accent'
  return undefined
}

function statusText(view: AqView, myTurn: boolean, name: NameOf): ReactNode {
  switch (view.stage) {
    case 'peek':
      return '看看你的身分'
    case 'act':
      if (!view.turn) return ''
      return myTurn ? '輪到你行動了' : `${name(view.turn.seat)} 行動中…`
    case 'discuss':
      return view.options.offline ? '當面討論：大家看到了什麼？' : '討論：在聊天室說說你看到了什麼'
    case 'vote':
      return '投票：把籌碼投給你覺得是真品的獸首'
    case 'reveal': {
      const r = view.results.at(-1)
      if (!r) return ''
      const heads = view.heads.filter((h) => h.round === r.round)
      return `${headName(heads[r.first].zodiac)}、${headName(heads[r.second].zodiac)} 入選`
    }
    case 'ident':
      return view.me?.goal ? `鑑人：${goalText(view.me.goal)}` : '鑑人：等其他人指認'
    case 'end': {
      const winner = view.end?.result.winner === 'good' ? '許愿陣營獲勝！' : '老朝奉陣營獲勝！'
      const role = view.me?.role
      if (!role) return winner
      return `${winner}${isGood(role) === (view.end?.result.winner === 'good') ? '（你贏了）' : '（你輸了）'}`
    }
  }
}

/** 自己的身分：點一下遮住（防偷看） */
function RoleCard({ view, name }: { view: AqView; name: NameOf }) {
  const [hidden, setHidden] = useState(false)
  if (view.you === null || !view.me) {
    return <p className="aq-role spectator">觀戰中：看不到大家的身分，下一局開始時就能參加。</p>
  }
  const role = view.me.role
  const mates = view.seats
    .map((s, i) => ({ role: s.role, seat: i }))
    .filter((s) => s.seat !== view.you && s.role !== null && view.stage !== 'end')
  return (
    <button
      type="button"
      className={`aq-role ${isGood(role) ? 'good' : 'bad'}${hidden ? ' hidden' : ''}`}
      onClick={() => setHidden((h) => !h)}
      aria-pressed={hidden}
    >
      <span className="aq-role-label">{hidden ? '你的身分' : isGood(role) ? '許愿陣營' : '老朝奉陣營'}</span>
      <strong>{hidden ? '● ● ●' : ROLE_NAMES[role]}</strong>
      {!hidden && <span className="aq-role-info">{ROLE_INFO[role]}</span>}
      {!hidden && mates.length > 0 && (
        <span className="aq-role-mates">
          你的隊友：{mates.map((m) => `${name(m.seat)}（${ROLE_NAMES[m.role!]}）`).join('、')}
        </span>
      )}
      <span className="aq-role-hint">{hidden ? '點一下顯示' : '點一下遮住'}</span>
    </button>
  )
}

function ActionPanel({
  party,
  view,
  remaining,
  name,
}: {
  party: AqParty
  view: AqView
  remaining: number[]
  name: NameOf
}) {
  const me = view.you
  if (me === null || !view.me) return null
  const seat = view.seats[me]
  const waiting = view.seats.filter((s, i) => s.online && !s.ready && i !== me).length
  const readyButton = (label: string) => (
    <button type="button" onClick={() => party.act({ type: 'ready' })} disabled={seat.ready}>
      {seat.ready ? `等其他 ${waiting} 人…` : label}
    </button>
  )

  switch (view.stage) {
    case 'peek':
      return <div className="aq-actions">{readyButton('記住了')}</div>
    case 'act': {
      if (view.turn?.seat !== me) return null
      return <TurnPanel party={party} view={view} remaining={remaining} name={name} />
    }
    case 'discuss':
      return (
        <div className="aq-actions">
          <p>
            {view.options.offline
              ? '當面說說你看到了什麼，大家都按了就開始投票。'
              : '在聊天室說說你看到了什麼（可以說謊），大家都按了就提早投票。'}
          </p>
          {readyButton('可以投票了')}
        </div>
      )
    case 'vote':
      return null
    case 'reveal':
      return <div className="aq-actions">{readyButton(view.round + 1 < ROUNDS ? '下一回合' : '開始鑑人')}</div>
    case 'ident':
      return (
        <p className="aq-actions aq-hint">
          {view.me.goal
            ? view.me.accused === null
              ? `點下面的名字，${goalText(view.me.goal)}（投完還能改）`
              : `你指認了 ${name(view.me.accused)}，大家投完前還能改`
            : '鄭國渠不用鑑人，等其他人指認。'}
        </p>
      )
    default:
      return null
  }
}

function TurnPanel({
  party,
  view,
  remaining,
  name,
}: {
  party: AqParty
  view: AqView
  remaining: number[]
  name: NameOf
}) {
  const turn = view.turn!
  const role = view.me!.role
  if (turn.step === 'identify') {
    return (
      <div className="aq-actions">
        <p>
          {role === 'fangZhen'
            ? '點下面一位玩家，查驗他是哪個陣營'
            : `點一件獸首鑑定${turn.left && turn.left > 1 ? `（還能看 ${turn.left} 件）` : ''}`}
        </p>
      </div>
    )
  }
  if (turn.step === 'skill') {
    if (role === 'laoChaofeng') {
      return (
        <div className="aq-actions">
          <p>要讓之後鑑定的許愿、黃煙煙、木戶加奈看到相反的結果嗎？</p>
          <div className="aq-buttons">
            <button type="button" onClick={() => party.act({ type: 'swap', on: true })}>
              發動調換
            </button>
            <button type="button" className="secondary" onClick={() => party.act({ type: 'swap', on: false })}>
              不發動
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="aq-actions">
        <p>{role === 'yaoBuran' ? '點下面一位玩家偷襲：他下一次行動不能鑑定' : '點一件獸首封鎖：之後鑑定它的人看不出真假'}</p>
        <div className="aq-buttons">
          <button type="button" className="secondary" onClick={() => party.act({ type: 'skip' })}>
            {role === 'yaoBuran' ? '不偷襲' : '不封鎖'}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="aq-actions">
      {turn.ambushed && <p className="aq-warn">{ambushText(view)}</p>}
      {remaining.length > 0 ? (
        <p>點下面一位還沒行動的人，換他行動</p>
      ) : (
        <>
          <p>你是這回合最後一個，結束後開始討論。</p>
          <button type="button" onClick={() => party.act({ type: 'pass', seat: null })}>
            結束行動
          </button>
        </>
      )}
      {remaining.length === 1 && (
        <button type="button" onClick={() => party.act({ type: 'pass', seat: remaining[0] })}>
          交給 {name(remaining[0])}
        </button>
      )}
    </div>
  )
}

function ambushText(view: AqView): string {
  const last = view.me!.records.at(-1)
  return last?.outcome === 'crippled' ? '你被偷襲過，再也不能鑑定了。' : '你被偷襲了，這次不能鑑定，也不能用技能。'
}

/** 本回合的四件獸首：輪到自己時可以點來鑑定或封鎖；投票時在上面放籌碼 */
function Heads({ party, view, heads }: { party: AqParty; view: AqView; heads: Head[] }) {
  const me = view.me
  const turn = view.turn
  const myTurn = turn !== null && turn.seat === view.you
  const seen = (slot: number) => me?.records.filter((r) => r.round === view.round && r.slot === slot) ?? []
  const canIdentify = myTurn && turn.step === 'identify' && me?.role !== 'fangZhen'
  const canBlock = myTurn && turn.step === 'skill' && me?.role === 'zhengGuoqu'
  const voting = view.stage === 'vote' && me !== null

  return (
    <section className="aq-heads-wrap" aria-label="本回合的獸首">
      {voting && <ChipVote key={view.round} party={party} view={view} heads={heads} />}
      {!voting && (
        <ul className="aq-heads">
          {heads.map((h) => {
            const mine = seen(h.slot)
            const click = canIdentify && mine.length === 0 ? 'identify' : canBlock ? 'block' : null
            const body = <HeadBody head={h} records={mine} skills={me?.skills ?? []} />
            return (
              <li key={h.slot} className={headClass(h)}>
                {click ? (
                  <button
                    type="button"
                    className="aq-head-body"
                    onClick={() => party.act({ type: click, slot: h.slot })}
                  >
                    {body}
                    <span className="aq-head-cta">{click === 'identify' ? '鑑定' : '封鎖'}</span>
                  </button>
                ) : (
                  <div className="aq-head-body">{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function headClass(h: Head): string {
  return ['aq-head', h.pick ? `pick-${h.pick}` : '', h.genuine === true ? 'genuine' : h.genuine === false ? 'fake' : '']
    .filter(Boolean)
    .join(' ')
}

function HeadBody({ head, records, skills }: { head: Head; records: AqRecord[]; skills: SkillUse[] }) {
  const blocked = skills.some((s) => s.kind === 'block' && s.round === head.round && s.slot === head.slot)
  return (
    <>
      <span className="aq-head-emoji" aria-hidden="true">
        {ZODIAC_EMOJI[head.zodiac]}
      </span>
      <strong>{headName(head.zodiac)}</strong>
      <span className="aq-head-chips">
        {records.map((r, k) => (
          <span key={k} className={`chip aq-seen ${r.outcome}`}>
            你看到：{outcomeShort(r)}
          </span>
        ))}
        {blocked && <span className="chip subtle">你封鎖了</span>}
        {head.pick === 'first' && <span className="chip">入選第一</span>}
        {head.pick === 'second' && <span className="chip">入選第二</span>}
        {head.genuine !== null && (
          <span className={`chip aq-truth ${head.genuine ? 'genuine' : 'fake'}`}>{head.genuine ? '真品' : '贗品'}</span>
        )}
        {head.votes !== null && <span className="chip subtle">{head.votes} 票</span>}
      </span>
    </>
  )
}

function outcomeShort(r: AqRecord): string {
  switch (r.outcome) {
    case 'genuine':
      return '真品'
    case 'fake':
      return '贗品'
    case 'sealed':
      return '看不出來'
    case 'blocked':
      return '被封鎖'
    case 'good':
      return '許愿陣營'
    case 'bad':
      return '老朝奉陣營'
    case 'ambushed':
      return '被偷襲'
    case 'crippled':
      return '不能鑑定'
  }
}

/** 投籌碼：每件獸首一個加減器，送出後還能改 */
function ChipVote({ party, view, heads }: { party: AqParty; view: AqView; heads: Head[] }) {
  const me = view.me!
  const [alloc, setAlloc] = useState<number[]>(() => me.alloc ?? [0, 0, 0, 0])
  const used = alloc.reduce((a, b) => a + b, 0)
  const left = me.chips - used
  const last = view.round + 1 === ROUNDS
  const sent = me.alloc !== null && me.alloc.every((v, i) => v === alloc[i])
  const change = (slot: number, delta: number) =>
    setAlloc((a) => a.map((v, i) => (i === slot ? Math.max(0, v + delta) : v)))

  return (
    <div className="aq-vote">
      <p className="aq-hint">
        你有 {me.chips} 枚籌碼，還剩 {left} 枚
        {last ? '（最後一回合要全部投出）' : '（沒用完的留到下一回合）'}
      </p>
      <ul className="aq-heads">
        {heads.map((h) => {
          const mine = me.records.filter((r) => r.round === view.round && r.slot === h.slot)
          return (
            <li key={h.slot} className={headClass(h)}>
              <div className="aq-head-body">
                <HeadBody head={h} records={mine} skills={me.skills} />
                <span className="aq-stepper">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => change(h.slot, -1)}
                    disabled={alloc[h.slot] === 0}
                    aria-label={`${headName(h.zodiac)} 少投一枚`}
                  >
                    −
                  </button>
                  <span className="aq-stepper-count">{alloc[h.slot]}</span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => change(h.slot, 1)}
                    disabled={left <= 0}
                    aria-label={`${headName(h.zodiac)} 多投一枚`}
                  >
                    +
                  </button>
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="aq-buttons">
        <button
          type="button"
          onClick={() => party.act({ type: 'chips', alloc })}
          disabled={sent || left < 0 || (last && left !== 0)}
        >
          {sent ? '已投出（還能改）' : me.alloc ? '改投' : '投出'}
        </button>
      </div>
    </div>
  )
}

function Seats({
  party,
  view,
  name,
  pick,
}: {
  party: AqParty
  view: AqView
  name: NameOf
  pick: SeatPick | null
}) {
  const me = view.you
  const checks = new Map<number, AqRecord>()
  for (const r of view.me?.records ?? []) if (r.seat !== null) checks.set(r.seat, r)

  return (
    <ul className="aq-seats" aria-label="玩家">
      {view.seats.map((s, i) => {
        const player = party.playerAt(i)
        const acting = view.turn?.seat === i
        const clickable = pick?.can(i) ?? false
        const chosen = pick?.chosen === i
        const check = checks.get(i)
        const chips: ReactNode[] = []
        if (i === me) chips.push(<span key="me" className="chip subtle">你</span>)
        if (s.role && (i !== me || view.stage === 'end'))
          chips.push(
            <span key="role" className={`chip aq-role-chip ${isGood(s.role) ? 'good' : 'bad'}`}>
              {ROLE_NAMES[s.role]}
            </span>,
          )
        if (acting) chips.push(<span key="act" className="chip">行動中</span>)
        else if (view.stage === 'act' && s.acted) chips.push(<span key="acted" className="chip subtle">已行動</span>)
        if (check)
          chips.push(
            <span key="check" className={`chip aq-seen ${check.outcome}`}>
              查驗：{check.outcome === 'good' ? '好人' : '壞人'}
            </span>,
          )
        if (player?.bot) chips.push(<span key="bot" className="chip subtle">電腦</span>)
        if (!s.online) chips.push(<span key="off" className="chip subtle">離線</span>)
        if ((view.stage === 'peek' || view.stage === 'discuss' || view.stage === 'reveal') && s.ready)
          chips.push(<span key="ready" className="chip subtle">✓ 好了</span>)
        if (s.voted) chips.push(<span key="voted" className="chip subtle">✓ 已投</span>)

        const body = (
          <>
            <span className="aq-seat-name">{name(i)}</span>
            <span className="aq-seat-chips">{chips}</span>
            {s.points > 0 && <span className="aq-seat-points">{s.points} 分</span>}
          </>
        )
        const cls = ['aq-seat', acting ? 'acting' : '', chosen ? 'chosen' : '', i === me ? 'me' : '']
          .filter(Boolean)
          .join(' ')
        return (
          <li key={i} className={cls}>
            {clickable ? (
              <button type="button" className="aq-seat-body" onClick={() => pick!.act(i)} aria-pressed={chosen}>
                {body}
              </button>
            ) : (
              <div className="aq-seat-body">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function recordText(r: AqRecord, view: AqView, name: NameOf): string {
  if (r.outcome === 'ambushed') return '被偷襲，這次不能鑑定'
  if (r.outcome === 'crippled') return '被偷襲過，再也不能鑑定'
  if (r.seat !== null) return `查驗 ${name(r.seat)}：${r.outcome === 'good' ? '許愿陣營' : '老朝奉陣營'}`
  const head = view.heads[r.round * 4 + (r.slot ?? 0)]
  const what =
    r.outcome === 'sealed'
      ? '看不出來（這回合失去能力）'
      : r.outcome === 'blocked'
        ? '看不出來（被鄭國渠封鎖）'
        : outcomeShort(r)
  return `${head ? headName(head.zodiac) : '獸首'}：${what}${r.swapped ? '（其實被老朝奉調換過）' : ''}`
}

function skillText(s: SkillUse, view: AqView, name: NameOf, mine: boolean): string {
  const who = mine ? '你' : `${name(s.seat)} `
  switch (s.kind) {
    case 'swap':
      return s.on ? `${who}發動了調換` : `${who}沒有調換`
    case 'ambush':
      return `${who}偷襲了 ${name(s.target ?? 0)}`
    case 'block': {
      const head = view.heads[s.round * 4 + (s.slot ?? 0)]
      return `${who}封鎖了 ${head ? headName(head.zodiac) : '一件獸首'}`
    }
  }
}

/** 自己的鑑定紀錄，最新的回合在上面 */
function Notes({ view, name }: { view: AqView; name: NameOf }) {
  const me = view.me!
  const rounds = Array.from({ length: view.round + 1 }, (_, i) => view.round - i)
  if (me.records.length === 0 && me.skills.length === 0) return null
  return (
    <section className="aq-log">
      <h3>你的紀錄（只有你看得到）</h3>
      {rounds.map((round) => {
        const records = me.records.filter((r) => r.round === round)
        const skills = me.skills.filter((s) => s.round === round)
        if (records.length === 0 && skills.length === 0) return null
        return (
          <div key={round} className="aq-log-round">
            <h4>第 {round + 1} 回合</h4>
            <ul>
              {records.map((r, k) => (
                <li key={`r${k}`}>{recordText(r, view, name)}</li>
              ))}
              {skills.map((s, k) => (
                <li key={`s${k}`} className="muted">
                  {skillText(s, view, name, true)}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

/** 每回合公開的東西：行動順序、票數、誰投了哪裡 */
function History({ view, name }: { view: AqView; name: NameOf }) {
  if (view.results.length === 0) return null
  const rounds = [...view.results].reverse()
  return (
    <section className="aq-log">
      <h3>投票紀錄</h3>
      {rounds.map((r) => {
        const heads = view.heads.filter((h) => h.round === r.round)
        return (
          <div key={r.round} className="aq-log-round">
            <h4>第 {r.round + 1} 回合</h4>
            <p>
              入選：{headName(heads[r.first].zodiac)}（第一，不公開）、{headName(heads[r.second].zodiac)}（第二，
              {r.secondGenuine ? '真品' : '贗品'}）
            </p>
            <p className="muted">
              票數：{heads.map((h) => `${headName(h.zodiac)} ${r.votes[h.slot]}`).join('、')}
            </p>
            <ul className="aq-allocs">
              {r.allocs.map((a, seat) => (
                <li key={seat}>
                  <strong>{name(seat)}</strong>
                  <span className={a && a.some((v) => v > 0) ? '' : 'muted'}>
                    {a && a.some((v) => v > 0)
                      ? heads
                          .filter((h) => a[h.slot] > 0)
                          .map((h) => `${ZODIAC_EMOJI[h.zodiac]}×${a[h.slot]}`)
                          .join(' ')
                      : '沒投'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}

function Result({ view, name }: { view: AqView; name: NameOf }) {
  const end = view.end!
  const r = end.result
  const seatOf = (role: Role) => end.roles.indexOf(role)
  const lao = seatOf('laoChaofeng')
  const yao = seatOf('yaoBuran')
  const accused = (seat: number) => {
    const t = seat >= 0 ? end.accusations[seat] : null
    return t === null || t === undefined ? '沒有指認' : `指認了 ${name(t)}`
  }
  const lines: [string, number][] = [[`入選的真品 ${r.genuine} 件`, r.genuine]]
  if (!r.direct) {
    lines.push([
      r.bossFound
        ? `找出老朝奉（${r.bossVotes[r.bossTarget!]} 票，要 ${r.bossRequired} 票）`
        : `沒找出老朝奉（${r.bossTarget === null ? `沒有人拿到 ${r.bossRequired} 票以上` : `多數投給了 ${name(r.bossTarget)}`}）`,
      r.bossFound ? 1 : 0,
    ])
    lines.push([`許愿${r.xuFound ? '被' : '沒被'}老朝奉找到（老朝奉${accused(lao)}）`, r.xuFound ? 0 : 2])
    lines.push([`方震${r.fangFound ? '被' : '沒被'}藥不然找到（藥不然${accused(yao)}）`, r.fangFound ? 0 : 1])
  }
  const rounds = Array.from({ length: ROUNDS }, (_, i) => i)
  const fails: string[] = []
  if (end.roles.includes('huangYanyan')) fails.push(`黃煙煙在第 ${end.fails.huangYanyan + 1} 回合`)
  if (end.roles.includes('kidoKana')) fails.push(`木戶加奈在第 ${end.fails.kidoKana + 1} 回合`)

  return (
    <section className={`aq-result ${r.winner}`}>
      <h3>{r.winner === 'good' ? '許愿陣營獲勝' : '老朝奉陣營獲勝'}</h3>
      {r.direct ? (
        <p>六件入選的全是真品，直接獲勝！</p>
      ) : (
        <table className="aq-score">
          <tbody>
            {lines.map(([text, points], k) => (
              <tr key={k}>
                <td>{text}</td>
                <td className="aq-score-points">+{points}</td>
              </tr>
            ))}
            <tr className="aq-score-total">
              <td>許愿陣營合計（要 {WIN_SCORE} 分）</td>
              <td className="aq-score-points">{r.score}</td>
            </tr>
          </tbody>
        </table>
      )}

      <h4>身分</h4>
      <ul className="aq-roles">
        {end.roles.map((role, seat) => (
          <li key={seat}>
            <span>{name(seat)}</span>
            <span className={`chip aq-role-chip ${isGood(role) ? 'good' : 'bad'}`}>{ROLE_NAMES[role]}</span>
            <span className="muted">累計 {view.seats[seat].points} 分</span>
          </li>
        ))}
      </ul>

      <h4>所有獸首</h4>
      {rounds.map((round) => (
        <div key={round} className="aq-truths">
          <span className="muted">第 {round + 1} 回合</span>
          {view.heads
            .filter((h) => h.round === round)
            .map((h) => (
              <span key={h.slot} className={`chip aq-truth ${h.genuine ? 'genuine' : 'fake'}`}>
                {ZODIAC_EMOJI[h.zodiac]} {headName(h.zodiac)} {h.genuine ? '真' : '假'}
                {h.pick === 'first' ? ' ①' : h.pick === 'second' ? ' ②' : ''}
              </span>
            ))}
        </div>
      ))}

      {end.skills.length > 0 && (
        <>
          <h4>技能</h4>
          <ul className="aq-skills">
            {end.skills.map((s, k) => (
              <li key={k}>
                第 {s.round + 1} 回合：{ROLE_NAMES[end.roles[s.seat]]} {skillText(s, view, name, false)}
              </li>
            ))}
          </ul>
        </>
      )}
      {fails.length > 0 && <p className="muted">{fails.join('、')}看不出真假。</p>}
    </section>
  )
}
