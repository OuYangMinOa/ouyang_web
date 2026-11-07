import type { CSSProperties, ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { Segmented } from '../shared/ui'
import type { Party } from '../shared/useParty'
import { formatMs, hexColor } from './format'
import { seatColor } from './game'
import { seatName, type OnlineTrack, type RacingParty, type RacingView } from './online'
import { TRACKS } from './tracks'

/** 線上比賽的面板：還沒進房間、大廳、比賽中的選單、成績（連線和開局在 index.tsx） */

type RacingRoom = Party<RacingParty>

const ONLINE_LAPS = [1, 3, 5]

/** 房主選賽道和圈數；其他人看得到但不能改 */
function OnlineOptions({ party }: { party: RacingRoom }) {
  const room = party.room
  if (!room) return null
  const options = room.options
  const locked = !party.isHost || room.phase === 'playing'
  return (
    <>
      <div className="segmented-field">
        <span className="segmented-label">賽道</span>
        <div className="race-tracks">
          {TRACKS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`race-track${t.id === options.track ? ' active' : ''}`}
              aria-pressed={t.id === options.track}
              disabled={locked && t.id !== options.track}
              onClick={() => !locked && party.setOptions({ ...options, track: t.id as OnlineTrack })}
            >
              <strong>{t.name}</strong>
              <span>{t.blurb}</span>
            </button>
          ))}
        </div>
      </div>
      <Segmented
        label="圈數"
        value={options.laps}
        options={ONLINE_LAPS.map((n) => ({ value: n, label: `${n} 圈` }))}
        onChange={(laps) => party.setOptions({ ...options, laps })}
        disabled={locked}
      />
      {!party.isHost && <p className="muted race-help">賽道和圈數由房主決定。</p>}
    </>
  )
}

/** 選單畫面的線上部分：還沒進房間時建立／加入，進了房間是大廳和聊天 */
export function OnlineMenu({ party, modeSwitch }: { party: RacingRoom; modeSwitch: ReactNode }) {
  if (!party.code) {
    return (
      <>
        {modeSwitch}
        <PartyEntry party={party}>
          <p className="race-help">
            開一個房間，把連結傳給朋友，2～8 人在同一條賽道上比。每個人開自己的車，車子會互相碰撞；起跑位置每局重新抽。
          </p>
        </PartyEntry>
      </>
    )
  }
  return (
    <>
      {modeSwitch}
      <PartyHeader party={party} shareTitle="一起來玩 3D 賽車" />
      <PartyNotice party={party} />
      {party.room ? (
        <>
          <PartyLobby
            party={party}
            options={<OnlineOptions party={party} />}
            hint={
              <p className="race-help">
                車色照座位分配。比賽中不能暫停，按暫停只會打開選單、放開油門；第一個人跑完後，其他人還有 30 秒可以過線。
              </p>
            }
          />
          <ChatBox party={party} />
        </>
      ) : (
        !party.error && <p className="muted">連線中…</p>
      )}
    </>
  )
}

type Row = {
  seat: number
  name: string
  color: number
  /** 結算後的名次；比賽中只有跑完的人有 */
  place: number | null
  finish: number | null
  lapsDone: number
  bestLap: number | null
  points: number
  me: boolean
}

/** 名次表：結算後照名次；比賽中跑完的照完賽時間排在前面，其他人照跑完的圈數 */
function standings(party: RacingRoom, view: RacingView): Row[] {
  const rows: Row[] = view.players.map((p, seat) => ({
    seat,
    name: seatName(party, seat),
    color: seatColor(seat),
    place: p.place,
    finish: p.finish,
    lapsDone: p.lapTimes.length,
    bestLap: p.lapTimes.length ? Math.min(...p.lapTimes) : null,
    points: p.points,
    me: seat === view.you,
  }))
  rows.sort((a, b) => {
    if (a.place !== null && b.place !== null) return a.place - b.place
    if (a.finish !== null || b.finish !== null) {
      if (a.finish === null) return 1
      if (b.finish === null) return -1
      return a.finish - b.finish
    }
    return b.lapsDone - a.lapsDone || a.seat - b.seat
  })
  if (!view.ended) rows.forEach((r, i) => (r.place = r.finish !== null ? i + 1 : null))
  return rows
}

/** 自己跑完（等別人）和結算時的成績；結算後下面接著「再來一局」的大廳 */
export function OnlineResult({
  party,
  view,
  onLeave,
  onExit,
}: {
  party: RacingRoom
  view: RacingView
  onLeave: () => void
  onExit: () => void
}) {
  const rows = standings(party, view)
  const me = rows.find((r) => r.me) ?? null
  const ended = view.ended
  let title: string
  if (!ended) title = me ? '跑完了！' : '觀戰中'
  else if (!me) title = '比賽結束'
  else if (me.finish === null) title = `第 ${me.place} 名（沒跑完）`
  else title = me.place === 1 ? '冠軍！' : `第 ${me.place} 名`

  return (
    <div className="race-panel race-result">
      <h2>{title}</h2>
      {!ended && view.endsIn !== null && (
        <p className="race-grace-line">
          還在跑的人 <Countdown ms={view.endsIn} stamp={view} /> 內要過線
        </p>
      )}
      {me && me.finish !== null && (
        <dl className="race-summary">
          <div>
            <dt>總時間</dt>
            <dd>{formatMs(me.finish)}</dd>
          </div>
          <div>
            <dt>最快圈</dt>
            <dd>{formatMs(me.bestLap)}</dd>
          </div>
        </dl>
      )}
      <table className="responsive race-table online">
        <thead>
          <tr>
            <th>名次</th>
            <th>車手</th>
            <th>總時間</th>
            <th>最快圈</th>
            <th>積分</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.seat} className={r.me ? 'me' : undefined}>
              <td data-label="名次">{r.place ?? '–'}</td>
              <td data-label="車手" className="primary">
                <span className="race-swatch" style={{ '--car': hexColor(r.color) } as CSSProperties} />
                {r.name}
              </td>
              <td data-label="總時間">
                {r.finish !== null ? formatMs(r.finish) : ended ? '沒跑完' : '比賽中'}
              </td>
              <td data-label="最快圈">{formatMs(r.bestLap)}</td>
              <td data-label="積分">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ended && <PartyLobby party={party} options={<OnlineOptions party={party} />} />}
      <PartyNotice party={party} />
      <details className="race-chat">
        <summary>聊天</summary>
        <ChatBox party={party} />
      </details>
      <div className="race-actions">
        <button type="button" className="secondary" onClick={onLeave}>
          離開房間
        </button>
        <button type="button" className="secondary" onClick={onExit}>
          離開遊戲
        </button>
      </div>
    </div>
  )
}

/** 線上比賽中按暫停：比賽不會停，只是打開選單（聊天、離開） */
export function OnlinePause({
  party,
  onResume,
  onLeave,
  onExit,
}: {
  party: RacingRoom
  onResume: () => void
  onLeave: () => void
  onExit: () => void
}) {
  return (
    <div className="race-panel race-pause race-online-pause">
      <h2>選單</h2>
      <p className="race-help">線上比賽不會暫停，別人還在跑！</p>
      <button type="button" onClick={onResume}>
        回到比賽
      </button>
      <ChatBox party={party} />
      {party.isHost && (
        <button
          type="button"
          className="secondary"
          onClick={() => window.confirm('中止這一局，大家回到大廳？') && party.abort()}
        >
          中止這局
        </button>
      )}
      <button type="button" className="secondary" onClick={onLeave}>
        離開房間
      </button>
      <button type="button" className="secondary" onClick={onExit}>
        離開遊戲
      </button>
    </div>
  )
}
