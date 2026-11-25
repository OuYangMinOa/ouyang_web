import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  REGIONS,
  RESTAURANTS,
  awardRank,
  displayPhone,
  googleMapsUrl,
  telHref,
  type Restaurant,
} from '../../michelin/data'
import { useMine } from '../../michelin/mine'
import { AwardBadge } from '../../michelin/RestaurantCard'
import { ChatBox, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import type { DinnerParty, DinnerView } from './types'
import '../../michelin/michelin.css'
import './dinner.css'

type DinnerRoom = Party<DinnerParty>

const byId = new Map(RESTAURANTS.map((r) => [r.id, r]))
/** 搜尋結果最多列幾家 */
const MAX_RESULTS = 30

function area(r: Restaurant) {
  return `${r.city}${r.district}`
}

/** 吃哪家：規則都在伺服器（backend/src/dinner.rs），這裡只畫自己的 view、送動作 */
export default function Dinner() {
  const party = useParty<DinnerParty>('dinner')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>
            一群人決定不了今天吃哪家？每個人從米其林地圖的星級和必比登裡提名幾家，大家勾「可以接受」的，票最多的那家勝出；同票就轉盤抽籤。
            也可以不投票，直接從提名的店裡抽一家。2～10 人。
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
        <li>提名：每個人挑幾家想吃的米其林（房主決定每人最多幾家），挑好按「好了」。一家都不挑也可以，表示都可以。</li>
        <li>投票：勾所有你「可以接受」的店，要勾幾家都可以。大家投完才開票，之前看不到別人勾了什麼，投完之前都還能改。</li>
        <li>票最多的那家勝出；同票的轉盤抽一家。抽籤模式不投票，直接從所有提名的店裡抽。</li>
        <li>斷線的人不用等。有人一直沒按的話，一半以上的人好了就可以按「不等了」。</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: DinnerRoom }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起決定今天吃哪家"
      extra={
        party.isHost &&
        playing && (
          <button type="button" className="secondary" onClick={() => window.confirm('中止這一局，回到大廳？') && party.abort()}>
            中止這局
          </button>
        )
      }
    />
  )
  if (!room) {
    return (
      <div className="dn">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }
  const side = (
    <>
      <ChatBox party={party} placeholder="今天想吃什麼…" />
      <Rules />
    </>
  )
  if (room.phase === 'lobby' || !view) {
    return (
      <div className="dn">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>
          <PartyLobby party={party} options={<OptionsForm party={party} />} />
        </GameLayout>
      </div>
    )
  }
  return (
    <div className="dn">
      {header}
      <GameLayout side={side}>
        {view.stage === 'nominate' && <Nominate party={party} view={view} />}
        {view.stage === 'vote' && <Vote party={party} view={view} />}
        {view.stage === 'result' && <Result view={view} />}
        <PartyNotice party={party} />
        {room.phase === 'results' && <PartyLobby party={party} options={<OptionsForm party={party} />} />}
      </GameLayout>
    </div>
  )
}

function OptionsForm({ party }: { party: DinnerRoom }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  return (
    <div className="dn-options">
      <Segmented
        label="每人最多提名"
        value={o.perPlayer}
        options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} 家` }))}
        onChange={(perPlayer) => party.setOptions({ ...o, perPlayer })}
        disabled={!editable}
      />
      <Segmented
        label="怎麼決定"
        value={o.mode}
        options={[
          { value: 'vote', label: '投票' },
          { value: 'draw', label: '直接抽籤' },
        ]}
        onChange={(mode) => party.setOptions({ ...o, mode })}
        disabled={!editable}
      />
    </div>
  )
}

/** 誰好了、還在等誰 */
function Waiting({ view, doneLabel }: { view: DinnerView; doneLabel: string }) {
  return (
    <ul className="dn-seats" aria-label="大家的進度">
      {view.seats.map((s, i) => (
        <li key={i} className={`${s.done ? 'is-done' : ''}${s.online ? '' : ' is-offline'}`}>
          {s.name}
          {i === view.you && '（你）'}
          <span className="dn-seat-state">{!s.online ? '離線' : s.done ? doneLabel : '…'}</span>
        </li>
      ))}
    </ul>
  )
}

/** 一半以上的人好了、自己也好了，就可以不等其他人 */
function ProceedButton({ party, view, mineDone, label }: { party: DinnerRoom; view: DinnerView; mineDone: boolean; label: string }) {
  if (!mineDone || view.done === view.online || view.done * 2 < view.online) return null
  return (
    <button type="button" className="secondary" onClick={() => party.act({ type: 'proceed' })}>
      {label}
    </button>
  )
}

function CandidateLine({ r, children, by }: { r: Restaurant; children?: ReactNode; by?: string }) {
  return (
    <li className="dn-line">
      <AwardBadge award={r.award} />
      <span className="dn-line-body">
        <strong>{r.name}</strong>
        <span className="muted">
          {area(r)}・{r.cuisine}・{'$'.repeat(r.price)}
          {by && `・${by}提名`}
        </span>
      </span>
      {children}
    </li>
  )
}

function Nominate({ party, view }: { party: DinnerRoom; view: DinnerView }) {
  const mine = useMine()
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState('all')
  const you = view.you
  const taken = new Set(view.candidates.map((c) => c.id))
  const myCount = view.candidates.filter((c) => c.by === you).length
  const full = myCount >= view.perPlayer
  const ready = you !== null && view.seats[you].done

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const cities = REGIONS.find((r) => r.slug === region)?.cities
    return RESTAURANTS.filter(
      (r) =>
        (!cities || cities.includes(r.city)) &&
        (!q || [r.name, r.cuisine, r.address, r.district].some((f) => f.toLowerCase().includes(q))),
    )
      .sort((a, b) => awardRank(b.award) - awardRank(a.award))
      .slice(0, MAX_RESULTS)
  }, [query, region])
  const wants = [...mine.marks.values()].filter((m) => m.status === 'want' && byId.has(m.restaurant))

  const nominate = (id: string) => party.act({ type: 'nominate', id })

  return (
    <div className="dn-board">
      <StatusLine>
        {you === null
          ? '觀戰中：大家正在提名'
          : ready
            ? `等其他人提名（${view.done} / ${view.online} 人好了）`
            : `挑最多 ${view.perPlayer} 家你想吃的，挑好按「好了」（已提名 ${myCount} 家）`}
      </StatusLine>

      <section aria-labelledby="dn-candidates">
        <h3 id="dn-candidates">
          候選 <span className="muted">{view.candidates.length} 家</span>
        </h3>
        {view.candidates.length === 0 ? (
          <p className="muted">還沒有人提名。</p>
        ) : (
          <ol className="dn-list">
            {view.candidates.map((c) => {
              const r = byId.get(c.id)
              if (!r) return null
              return (
                <CandidateLine key={c.id} r={r} by={c.by === you ? '你' : view.seats[c.by]?.name}>
                  {c.by === you && !ready && (
                    <button type="button" className="secondary" onClick={() => party.act({ type: 'withdraw', id: c.id })}>
                      收回
                    </button>
                  )}
                </CandidateLine>
              )
            })}
          </ol>
        )}
      </section>

      {you !== null && (
        <div className="dn-actions">
          <button type="button" onClick={() => party.act({ type: 'ready', ready: !ready })} className={ready ? 'secondary' : undefined}>
            {ready ? '再挑一下' : myCount === 0 ? '我都可以，好了' : '好了'}
          </button>
          <ProceedButton party={party} view={view} mineDone={ready} label="不等了，往下" />
        </div>
      )}
      <Waiting view={view} doneLabel="好了" />

      {you !== null && !ready && (
        <section className="dn-picker" aria-labelledby="dn-picker">
          <h3 id="dn-picker">挑一家提名</h3>
          {wants.length > 0 && (
            <div className="dn-wants">
              <span className="muted">我的想吃：</span>
              {wants.map((m) => {
                const r = byId.get(m.restaurant)!
                return (
                  <button
                    key={r.id}
                    type="button"
                    className="secondary dn-want"
                    disabled={taken.has(r.id) || full}
                    onClick={() => nominate(r.id)}
                  >
                    ♥ {r.name}
                  </button>
                )
              })}
            </div>
          )}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋店名、料理或地址"
            aria-label="搜尋店名、料理或地址"
          />
          <Segmented
            value={region}
            options={[{ value: 'all', label: '全台' }, ...REGIONS.map((r) => ({ value: r.slug, label: r.name }))]}
            onChange={setRegion}
          />
          <ol className="dn-list">
            {results.map((r) => (
              <CandidateLine key={r.id} r={r}>
                <button type="button" className="secondary" disabled={taken.has(r.id) || full} onClick={() => nominate(r.id)}>
                  {taken.has(r.id) ? '已提名' : '提名'}
                </button>
              </CandidateLine>
            ))}
          </ol>
          {results.length === 0 && <p className="muted">沒有符合的餐廳。</p>}
          {full && <p className="muted">你已經提名 {view.perPlayer} 家了；要換的話先收回一家。</p>}
        </section>
      )}
    </div>
  )
}

function Vote({ party, view }: { party: DinnerRoom; view: DinnerView }) {
  const you = view.you
  const [picks, setPicks] = useState<Set<number>>(() => new Set(view.ballot ?? []))
  const voted = view.ballot !== null
  const changed = !voted || picks.size !== view.ballot!.length || view.ballot!.some((p) => !picks.has(p))

  function toggle(i: number) {
    setPicks((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  return (
    <div className="dn-board">
      <StatusLine>
        {you === null
          ? `觀戰中：大家正在投票（${view.done} / ${view.online} 人投好了）`
          : voted && !changed
            ? `投好了，等其他人（${view.done} / ${view.online} 人投好了）`
            : '勾所有你可以接受的店，要勾幾家都可以'}
      </StatusLine>
      <ol className="dn-list">
        {view.candidates.map((c, i) => {
          const r = byId.get(c.id)
          if (!r) return null
          return (
            <CandidateLine key={c.id} r={r}>
              {you !== null && (
                <label className="dn-pick">
                  <input type="checkbox" checked={picks.has(i)} onChange={() => toggle(i)} />
                  可以
                </label>
              )}
            </CandidateLine>
          )
        })}
      </ol>
      {you !== null && (
        <div className="dn-actions">
          <button type="button" disabled={picks.size === 0 || !changed} onClick={() => party.act({ type: 'vote', picks: [...picks] })}>
            {voted ? '更新投票' : '投票'}
          </button>
          <button type="button" className="secondary" onClick={() => setPicks(new Set(view.candidates.map((_, i) => i)))}>
            都可以（全勾）
          </button>
          <ProceedButton party={party} view={view} mineDone={voted} label="不等了，開票" />
        </div>
      )}
      <Waiting view={view} doneLabel="投好了" />
    </div>
  )
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 同票或抽籤時轉一下：亮的那格一格一格跳，越來越慢，停在抽中的那家 */
function useSpin(spin: number[], winner: number) {
  const key = `${spin.join(',')}>${winner}`
  const [state, setState] = useState<{ key: string; at: number | null; done: boolean }>({ key: '', at: null, done: true })
  useEffect(() => {
    if (spin.length < 2 || reducedMotion()) {
      setState({ key, at: winner, done: true })
      return
    }
    // 跳的次數：至少轉兩圈，最後一格剛好是抽中的那家
    const start = Math.floor(Math.random() * spin.length)
    const finalStep = spin.indexOf(winner)
    const steps = spin.length * 2 + ((finalStep - start + spin.length) % spin.length)
    let step = 0
    let timer = 0
    const tick = () => {
      const at = spin[(start + step) % spin.length]
      const done = step >= steps
      setState({ key, at, done })
      if (done) return
      step += 1
      // 前面快、最後幾格慢下來
      const remaining = steps - step
      timer = window.setTimeout(tick, remaining < 4 ? 260 + (4 - remaining) * 90 : 90)
    }
    tick()
    return () => window.clearTimeout(timer)
    // key 已經包含 spin 和 winner
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state.key === key ? state : { at: null, done: false }
}

function Result({ view }: { view: DinnerView }) {
  const result = view.result!
  const spin = useSpin(result.spin, result.winner)
  const winner = byId.get(view.candidates[result.winner]?.id ?? '')
  const showWinner = spin.done || result.spin.length === 0
  const order = view.candidates
    .map((c, i) => ({ c, i, votes: result.votes[i] ?? [] }))
    .sort((a, b) => b.votes.length - a.votes.length || Number(b.i === result.winner) - Number(a.i === result.winner))

  return (
    <div className="dn-board">
      {result.spin.length > 0 && (
        <ol className="dn-wheel" aria-hidden={!showWinner}>
          {result.spin.map((i) => {
            const r = byId.get(view.candidates[i]?.id ?? '')
            return (
              <li key={i} className={spin.at === i ? (showWinner ? 'is-winner' : 'is-lit') : undefined}>
                {r?.name ?? '?'}
              </li>
            )
          })}
        </ol>
      )}
      {showWinner && winner && (
        <article className="dn-winner" aria-live="polite">
          <p className="dn-winner-label">{result.spin.length > 0 ? '抽中了！今天就吃' : '今天就吃'}</p>
          <h3>
            <AwardBadge award={winner.award} /> {winner.name}
          </h3>
          <p className="muted">
            {area(winner)}・{winner.cuisine}・{'$'.repeat(winner.price)}
          </p>
          <p className="dn-winner-address">{winner.address}</p>
          <div className="dn-actions">
            {winner.phone && (
              <a className="dn-link" href={telHref(winner.phone)}>
                ☎ {displayPhone(winner.phone)}
              </a>
            )}
            <a className="dn-link is-primary" href={googleMapsUrl(winner)} target="_blank" rel="noreferrer">
              Google 地圖
            </a>
            <Link className="dn-link" to={`/michelin?r=${encodeURIComponent(winner.id)}`}>
              在米其林地圖上看
            </Link>
          </div>
        </article>
      )}
      {view.mode === 'vote' && view.candidates.length > 1 && (
        <section aria-labelledby="dn-tally">
          <h3 id="dn-tally">開票結果</h3>
          <ol className="dn-list">
            {order.map(({ c, i, votes }) => {
              const r = byId.get(c.id)
              if (!r) return null
              return (
                <CandidateLine key={c.id} r={r}>
                  <span className={`dn-votes${i === result.winner && showWinner ? ' is-winner' : ''}`}>
                    <strong>{votes.length} 票</strong>
                    {votes.length > 0 && <span className="muted">{votes.map((s) => view.seats[s]?.name).join('、')}</span>}
                  </span>
                </CandidateLine>
              )
            })}
          </ol>
        </section>
      )}
    </div>
  )
}
