import { useState, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { Segmented } from '../shared/ui'
import type { Party } from '../shared/useParty'
import type { Team } from './map'
import { DIFFICULTIES, seatName, type MechaParty, type MechaView } from './online'
import { DRONE, MECH, MECH_KINDS, mechKind, MECHS, SHELL, teamClass, TEAMS, type MechKind } from './spec'

/** 選單、說明（操作和機體介紹）、選隊、記分板、結算、比賽中的選單（連線和開局在 index.tsx） */

type MechaRoom = Party<MechaParty>

const KILL_TARGETS = [10, 20, 30, 50, 100]
const TIME_LIMITS = [5, 10, 15, 20, 30]

/** 房主選擊倒目標、時間和電腦難度；其他人看得到但不能改 */
function Options({ party }: { party: MechaRoom }) {
  const room = party.room
  if (!room) return null
  const options = room.options
  const locked = !party.isHost || room.phase === 'playing'
  return (
    <>
      <Segmented
        label="先擊倒幾次"
        value={options.killTarget}
        options={KILL_TARGETS.map((n) => ({ value: n, label: `${n} 次` }))}
        onChange={(killTarget) => party.setOptions({ ...options, killTarget })}
        disabled={locked}
      />
      <Segmented
        label="時間上限"
        value={options.timeLimit}
        options={TIME_LIMITS.map((n) => ({ value: n, label: `${n} 分` }))}
        onChange={(timeLimit) => party.setOptions({ ...options, timeLimit })}
        disabled={locked}
      />
      {room.players.some((p) => p.bot) && (
        <Segmented
          label="電腦難度"
          value={options.difficulty}
          options={DIFFICULTIES}
          onChange={(difficulty) => party.setOptions({ ...options, difficulty })}
          disabled={locked}
        />
      )}
    </>
  )
}

const KIND_OPTIONS = MECH_KINDS.map((kind) => ({ value: kind, label: `${MECHS[kind].name}・${MECHS[kind].short}` }))

const deg = (rad: number) => Math.round((rad * 180) / Math.PI)

/** 射速：一秒好幾發的寫「幾發/秒」，慢的寫「幾秒一發」 */
function rateText(rate: number) {
  return rate >= 1 ? `${rate} 發/秒` : `${(1 / rate).toFixed(1)} 秒一發`
}

/** 每台機甲要知道的幾件事（說明面板裡才看得到；選機體的卡片只有一句定位） */
const MECH_TIPS: Record<MechKind, string[]> = {
  speed: ['衝刺和飛行共用能量，用完要等回復。'],
  sniper: ['放大瞄準、站穩不動最準。', '沒有推進器，靠距離活下來。'],
  recon: [
    '框裡看得到的敵人會標記給全隊。',
    '引爆炸到的一擊擊倒；偵察機也會被打下來。',
    '操控時機甲不能動，可以讓它停在原地繼續偵測。',
    `離機甲超過 ${DRONE.clear} m 訊號開始變差。`,
  ],
  fortress: ['變身後只能轉向，不能走。', '盾牌只擋正面，側面、背後和高處打得到。'],
  mortar: [
    `沒有落點標示：左右轉向、上下調仰角（${deg(SHELL.elevMin)}～${deg(SHELL.elevMax)}°）。`,
    `45° 最遠（約 ${SHELL.range} m），再高再低都變近。`,
    '高角度能越過大樓，低角度快但會被擋。',
    '架砲時不能走，也不能發射飛彈。',
  ],
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** 一台機甲的卡片：名字、定位和四個主要數值；`full`（說明面板）多了其餘的數值和要知道的幾件事 */
export function MechCard({ kind, full }: { kind: MechKind; full?: boolean }) {
  const m = MECHS[kind]
  const d = m.deploy
  return (
    <div className="mecha-card">
      <div className="mecha-card-head">
        <strong>{m.name}</strong>
        <span className="chip subtle">{m.role}</span>
      </div>
      <p>{m.blurb}</p>
      <dl className="mecha-stats">
        <Stat label="耐久">{m.hp}</Stat>
        <Stat label="極速">{Math.round(m.boost * 3.6)} km/h</Stat>
        <Stat label={m.weapon}>
          {rateText(m.fireRate)}・{m.magazine} 發
        </Stat>
        <Stat label="射程">{m.gunRange} m</Stat>
        {full && (
          <>
            <Stat label="一發傷害">{m.gunDamage}</Stat>
            <Stat label="飛彈">{MECH.missiles} 發</Stat>
            {m.drones > 0 && (
              <Stat label="偵察機">
                {m.drones} 架・爆炸半徑 {DRONE.blast} m
              </Stat>
            )}
            {d && (
              <Stat label={d.arms.weapon}>
                {rateText(d.arms.fireRate)}・{d.arms.magazine} 發
              </Stat>
            )}
            {d?.shield && (
              <Stat label="盾牌">
                寬 {d.shield.width} m・高 {d.shield.height} m
              </Stat>
            )}
            {d?.mortar && (
              <>
                <Stat label="砲擊距離">
                  {SHELL.min}～{SHELL.range} m
                </Stat>
                <Stat label="爆炸半徑">{SHELL.blast} m</Stat>
              </>
            )}
          </>
        )}
      </dl>
      {full && (
        <ul className="mecha-tips">
          {MECH_TIPS[kind].map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 操作：按鍵（觸控是畫面上的按鈕）對照表 */
const KEYS: [string, string][] = [
  ['WASD', '移動'],
  ['滑鼠', '瞄準'],
  ['左鍵', '開火'],
  ['右鍵', '放大瞄準'],
  ['Shift', '衝刺'],
  ['空白鍵', '跳躍（疾風按住飛行）'],
  ['Q', '飛彈（自動鎖定）'],
  ['E', '偵察機・變身・架砲'],
  ['R', '換彈'],
  ['B', '換機甲（在機庫裡）'],
  ['Tab', '記分板'],
  ['Esc', '選單'],
]
const GESTURES: [string, string][] = [
  ['左下拖曳', '移動'],
  ['右半邊拖曳', '瞄準'],
  ['開火', '按住射擊，可邊拖邊瞄'],
  ['瞄準', '放大'],
  ['衝刺・跳躍', '疾風可噴射、飛行'],
  ['飛彈', '自動鎖定準星附近的敵人'],
  ['換機甲', '在機庫裡或等復活時'],
]

type InfoTab = 'keys' | 'mechs'
const INFO_TABS: { value: InfoTab; label: string }[] = [
  { value: 'keys', label: '操作' },
  { value: 'mechs', label: '機體' },
]

/** 說明：操作表和五台機體的介紹。選單、選隊和對戰中的選單都從「說明」按鈕打開 */
export function InfoPanel({ touch, kind: first = 'speed', onClose }: { touch: boolean; kind?: MechKind; onClose: () => void }) {
  const [tab, setTab] = useState<InfoTab>('keys')
  const [kind, setKind] = useState<MechKind>(first)
  return (
    <div className="mecha-layer mecha-center mecha-info-layer" onClick={onClose}>
      <div className="mecha-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="說明">
        <div className="mecha-head">
          <h2>說明</h2>
          <button type="button" className="mecha-icon" onClick={onClose} aria-label="關閉" title="關閉（Esc）">
            ×
          </button>
        </div>
        <Segmented value={tab} options={INFO_TABS} onChange={setTab} />
        {tab === 'keys' ? (
          <>
            <dl className="mecha-keys">
              {(touch ? GESTURES : KEYS).map(([key, what]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
            <p className="mecha-help muted">先擊倒對方指定次數的隊伍贏。{!touch && '也支援遊戲手把。'}</p>
          </>
        ) : (
          <>
            <Segmented value={kind} options={KIND_OPTIONS} onChange={setKind} />
            <MechCard kind={kind} full />
          </>
        )}
      </div>
    </div>
  )
}

/** 房間裡有一局正在打、自己不在場上：可以觀戰，房主可以中止 */
function InProgress({ party, onWatch }: { party: MechaRoom; onWatch: () => void }) {
  return (
    <section className="party-lobby">
      <h2>對戰進行中</h2>
      <p>這局結束後就可以開下一局。</p>
      <div className="mecha-actions">
        <button type="button" onClick={onWatch}>
          觀戰
        </button>
        {party.isHost && (
          <button type="button" className="secondary" onClick={() => window.confirm('中止這一局，大家回到大廳？') && party.abort()}>
            中止這局
          </button>
        )}
      </div>
    </section>
  )
}

/** 選單畫面：還沒進房間時建立／加入（也可以一鍵開練習房），進了房間是大廳和聊天。操作和機體介紹在「說明」按鈕裡 */
export function OnlineMenu({
  party,
  onWatch,
  onPractice,
}: {
  party: MechaRoom
  onWatch: () => void
  /** 開練習房：加幾台電腦 */
  onPractice: (bots: number) => void
}) {
  if (!party.code) {
    return (
      <PartyEntry party={party}>
        <p className="mecha-help">紅藍兩隊機甲對戰，最多 30 對 30，人不夠加電腦。</p>
        <div className="mecha-actions">
          <button type="button" className="secondary" onClick={() => onPractice(3)} disabled={party.busy}>
            練習（3 台電腦）
          </button>
          <button type="button" className="secondary" onClick={() => onPractice(59)} disabled={party.busy}>
            大混戰 30 對 30
          </button>
        </div>
      </PartyEntry>
    )
  }
  return (
    <>
      <PartyHeader party={party} shareTitle="一起來玩機甲對戰" />
      <PartyNotice party={party} />
      {party.room?.phase === 'playing' ? (
        <>
          <InProgress party={party} onWatch={onWatch} />
          <ChatBox party={party} />
        </>
      ) : party.room ? (
        <>
          <PartyLobby
            party={party}
            options={<Options party={party} />}
            hint={<p className="mecha-help muted">開始後有 20 秒選隊伍和機體。</p>}
          />
          <ChatBox party={party} />
        </>
      ) : (
        !party.error && <p className="muted">連線中…</p>
      )}
    </>
  )
}

/** 選隊：每個人選紅隊或藍隊和機體，按「準備好了」就不能換 */
export function TeamSelect({
  party,
  view,
  onInfo,
  onLeave,
}: {
  party: MechaRoom
  view: MechaView
  /** 打開說明（操作、機體介紹） */
  onInfo: () => void
  onLeave: () => void
}) {
  const me = view.you
  const ready = view.select?.ready ?? []
  const done = me !== null && ready[me] === true
  const bots = new Set(view.bots)
  const mine = me !== null ? view.players[me]?.team : null
  const myKind = mechKind(me !== null ? view.players[me]?.mech : null)
  const humans = view.players.map((_, s) => s).filter((s) => !bots.has(s))
  const readyCount = humans.filter((s) => ready[s]).length
  return (
    <div className="mecha-layer mecha-select">
      <div className="mecha-panel">
        <div className="mecha-select-head">
          <h2>{me === null ? '大家在選隊伍' : '選隊伍和機體'}</h2>
          <span className="mecha-select-tools">
            {view.select && (
              <span className="mecha-chip mecha-select-timer" role="timer">
                <Countdown ms={view.select.endsIn} stamp={view} />
              </span>
            )}
            <button type="button" className="secondary" onClick={onInfo}>
              ℹ️ 說明
            </button>
          </span>
        </div>
        <p className="mecha-help muted">
          先到 {view.killTarget} 擊倒・限時 {view.timeLimit} 分鐘
        </p>
        <div className="mecha-teams">
          {([0, 1] as Team[]).map((team) => {
            const seats = view.players.map((p, s) => ({ p, s })).filter(({ p }) => p.team === team)
            return (
              <section key={team} className={`mecha-team ${teamClass(team)}`}>
                <h3>
                  {TEAMS[team].name}
                  <span className="muted">{seats.length} 人</span>
                </h3>
                <ul>
                  {seats.map(({ p, s }) => (
                    <li key={s} className={s === me ? 'me' : undefined}>
                      <span className="mecha-name">
                        {seatName(party, s)}
                        <small className="mecha-kind">{MECHS[mechKind(p.mech)].short}</small>
                      </span>
                      {bots.has(s) ? <span className="chip subtle">電腦</span> : ready[s] ? <span className="mecha-ok">✓ 好了</span> : <span className="muted">選隊中</span>}
                    </li>
                  ))}
                </ul>
                {me !== null && (
                  <button
                    type="button"
                    className={mine === team ? undefined : 'secondary'}
                    disabled={done || mine === team || !party.connected}
                    onClick={() => party.act({ type: 'team', team })}
                  >
                    {mine === team ? '你在這隊' : `加入${TEAMS[team].name}`}
                  </button>
                )}
              </section>
            )
          })}
        </div>
        {me === null ? (
          <p className="mecha-help">觀戰中，大家選好就開打。</p>
        ) : (
          <section className="mecha-guide">
            <Segmented
              label="你的機體"
              value={myKind}
              options={KIND_OPTIONS}
              onChange={(mech) => party.act({ type: 'mech', mech })}
              disabled={done || !party.connected}
            />
            <MechCard kind={myKind} />
          </section>
        )}
        {!party.connected && <p className="error">連線中斷，重新連線中…</p>}
        <PartyNotice party={party} />
        <div className="mecha-actions mecha-sticky">
          <button type="button" className="secondary" onClick={() => window.confirm('離開這個房間？') && onLeave()}>
            離開
          </button>
          {me !== null && (
            <button type="button" className="mecha-start" disabled={done || !party.connected} onClick={() => party.act({ type: 'ready' })}>
              {done ? `等其他人（${readyCount}/${humans.length}）` : '準備好了'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 記分板：兩隊各一張表，照擊倒數排 */
export function Scoreboard({ party, view }: { party: MechaRoom; view: MechaView }) {
  const bots = new Set(view.bots)
  return (
    <div className="mecha-board">
      {([0, 1] as Team[]).map((team) => {
        const rows = view.players
          .map((p, s) => ({ ...p, seat: s }))
          .filter((p) => p.team === team)
          .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.damage - a.damage)
        return (
          <section key={team} className={`mecha-board-team ${teamClass(team)}`}>
            <h3>
              {TEAMS[team].name} <strong>{view.score[team]}</strong>
            </h3>
            <table className="responsive mecha-table">
              <thead>
                <tr>
                  <th>駕駛員</th>
                  <th>擊倒</th>
                  <th>倒下</th>
                  <th>傷害</th>
                  <th>勝場</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.seat} className={r.seat === view.you ? 'me' : undefined}>
                    <td data-label="駕駛員" className="primary">
                      {seatName(party, r.seat)}
                      <small className="mecha-kind">{MECHS[mechKind(r.mech)].short}</small>
                      {bots.has(r.seat) && <span className="chip subtle">電腦</span>}
                      {!r.alive && !view.ended && <span className="muted">（倒下）</span>}
                    </td>
                    <td data-label="擊倒">{r.kills}</td>
                    <td data-label="倒下">{r.deaths}</td>
                    <td data-label="傷害">{r.damage}</td>
                    <td data-label="勝場">{r.wins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )
      })}
    </div>
  )
}

/** 結算：哪一隊贏、記分板，下面接著「再來一局」的大廳 */
export function Results({ party, view, onLeave }: { party: MechaRoom; view: MechaView; onLeave: () => void }) {
  const me = view.you
  const myTeam = me !== null ? view.players[me]?.team : null
  let title: string
  if (view.winner === null) title = '平手！'
  else if (myTeam === undefined || myTeam === null) title = `${TEAMS[view.winner].name}獲勝！`
  else title = view.winner === myTeam ? '勝利！' : '落敗…'
  const best = view.players
    .map((p, s) => ({ ...p, seat: s }))
    .sort((a, b) => b.kills - a.kills || b.damage - a.damage)[0]
  return (
    <div className="mecha-layer mecha-center">
      <div className="mecha-panel mecha-result">
        <h2 className={view.winner !== null ? teamClass(view.winner) : undefined}>{title}</h2>
        <p className="mecha-final">
          <span className="red">{TEAMS[0].name} {view.score[0]}</span>
          <span className="muted">：</span>
          <span className="blue">
            {view.score[1]} {TEAMS[1].name}
          </span>
        </p>
        {best && best.kills > 0 && (
          <p className="mecha-mvp">
            MVP：<strong>{seatName(party, best.seat)}</strong>（擊倒 {best.kills}、傷害 {best.damage}）
          </p>
        )}
        <Scoreboard party={party} view={view} />
        <PartyLobby party={party} options={<Options party={party} />} />
        <PartyNotice party={party} />
        <details className="mecha-chat">
          <summary>聊天</summary>
          <ChatBox party={party} />
        </details>
        <div className="mecha-actions mecha-sticky">
          <button type="button" className="secondary" onClick={onLeave}>
            離開房間
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 對戰中換機甲：站在自己家的機庫（重生點）裡馬上換（耐久、飛彈、偵察機補滿，留在原地），
 * 倒下等復活時選的是下一次出擊的那台
 */
export function MechSwap({
  current,
  alive,
  connected,
  onPick,
  onClose,
}: {
  current: MechKind
  alive: boolean
  connected: boolean
  onPick: (kind: MechKind) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<MechKind>(current)
  const name = MECHS[kind].name
  return (
    <div className="mecha-layer mecha-center" onClick={onClose}>
      <div className="mecha-panel mecha-swap-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="換機甲">
        <h2>
          換機甲 <small className="muted">{alive ? '馬上換好，耐久和彈藥補滿' : '復活時開這一台'}</small>
        </h2>
        <Segmented label="機體" value={kind} options={KIND_OPTIONS} onChange={setKind} />
        <MechCard kind={kind} />
        <div className="mecha-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" disabled={!connected} onClick={() => onPick(kind)}>
            {kind === current ? `繼續開${name}` : alive ? `換成${name}` : `下次出擊開${name}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 對戰中按 Esc：比賽不會停，只是打開選單 */
export function PauseMenu({
  party,
  sensitivity,
  onSensitivity,
  onInfo,
  onResume,
  onLeave,
  extra,
}: {
  party: MechaRoom
  sensitivity: number
  onSensitivity: (v: number) => void
  /** 打開說明（操作、機體介紹） */
  onInfo: () => void
  onResume: () => void
  onLeave: () => void
  extra?: ReactNode
}) {
  return (
    <div className="mecha-layer mecha-center">
      <div className="mecha-panel mecha-pause">
        <h2>
          選單 <small className="muted">對戰不會暫停</small>
        </h2>
        <button type="button" onClick={onResume}>
          回到對戰
        </button>
        <button type="button" className="secondary" onClick={onInfo}>
          ℹ️ 說明
        </button>
        <label className="mecha-range">
          <span>瞄準靈敏度 {sensitivity.toFixed(1)}</span>
          <input type="range" min={0.3} max={2.5} step={0.1} value={sensitivity} onChange={(e) => onSensitivity(Number(e.target.value))} />
        </label>
        {extra}
        <ChatBox party={party} />
        {party.isHost && (
          <button type="button" className="secondary" onClick={() => window.confirm('中止這一局，大家回到大廳？') && party.abort()}>
            中止這局
          </button>
        )}
        <button type="button" className="secondary" onClick={() => window.confirm('離開這個房間？') && onLeave()}>
          離開房間
        </button>
      </div>
    </div>
  )
}
