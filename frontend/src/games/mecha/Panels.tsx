import { useState, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { Segmented } from '../shared/ui'
import type { Party } from '../shared/useParty'
import type { Team } from './map'
import { DIFFICULTIES, seatName, type MechaParty, type MechaView } from './online'
import { DRONE, MECH, MECH_KINDS, mechKind, MECHS, SHELL, teamClass, TEAMS, type MechKind } from './spec'

/** 選單、選隊、記分板、結算、比賽中的選單（連線和開局在 index.tsx） */

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
      {!party.isHost && <p className="muted mecha-help">這些設定由房主決定。</p>}
    </>
  )
}

const KIND_OPTIONS = MECH_KINDS.map((kind) => ({ value: kind, label: `${MECHS[kind].name}・${MECHS[kind].short}` }))

/** 射速：一秒好幾發的寫「幾發/秒」，慢的寫「幾秒一發」 */
function rateText(rate: number) {
  return rate >= 1 ? `${rate} 發/秒` : `${(1 / rate).toFixed(1)} 秒一發`
}

/** 一台機甲的介紹：名字、定位、數值 */
export function MechCard({ kind }: { kind: MechKind }) {
  const m = MECHS[kind]
  return (
    <div className="mecha-card">
      <div className="mecha-card-head">
        <strong>{m.name}</strong>
        <span className="chip subtle">{m.role}</span>
      </div>
      <p>{m.blurb}</p>
      <dl className="mecha-stats">
        <div>
          <dt>耐久</dt>
          <dd>{m.hp}</dd>
        </div>
        <div>
          <dt>極速</dt>
          <dd>{Math.round(m.boost * 3.6)} km/h</dd>
        </div>
        <div>
          <dt>{m.weapon}</dt>
          <dd>
            {rateText(m.fireRate)}・{m.magazine} 發
          </dd>
        </div>
        <div>
          <dt>射程</dt>
          <dd>{m.gunRange} 公尺</dd>
        </div>
        <div>
          <dt>一發傷害</dt>
          <dd>{kind === 'sniper' ? `${m.gunDamage}・打中頭一發擊倒` : m.gunDamage}</dd>
        </div>
        <div>
          <dt>飛彈</dt>
          <dd>每條命 {MECH.missiles} 發</dd>
        </div>
        {m.drones > 0 && (
          <div>
            <dt>偵察機</dt>
            <dd>
              每條命 {m.drones} 架・爆炸一發擊倒（半徑 {DRONE.blast} 公尺）・機身 {DRONE.hp}
            </dd>
          </div>
        )}
        {m.deploy && !m.deploy.mortar && (
          <div>
            <dt>變身後</dt>
            <dd>
              {m.deploy.arms.weapon} {rateText(m.deploy.arms.fireRate)}・{m.deploy.arms.magazine} 發・射程 {m.deploy.arms.gunRange} 公尺
            </dd>
          </div>
        )}
        {m.deploy?.shield && (
          <div>
            <dt>盾牌</dt>
            <dd>
              寬 {m.deploy.shield.width} 公尺・高 {m.deploy.shield.height} 公尺，擋正面
            </dd>
          </div>
        )}
        {m.deploy?.mortar && (
          <div>
            <dt>架砲後</dt>
            <dd>
              {m.deploy.arms.weapon} {rateText(m.deploy.arms.fireRate)}・射程大約 {SHELL.min}～{SHELL.range} 公尺（沒有落點的標示，調仰角和左右）
            </dd>
          </div>
        )}
        {m.deploy?.mortar && (
          <div>
            <dt>砲彈傷害</dt>
            <dd>炸到一發擊倒（半徑 {SHELL.blast} 公尺）</dd>
          </div>
        )}
      </dl>
    </div>
  )
}

/** 操作說明 */
function ControlsHelp({ touch }: { touch: boolean }) {
  return (
    <p className="mecha-help">
      {touch
        ? '左下拖曳移動，右半邊拖曳瞄準。按住「開火」射擊（按著也能拖曳瞄準），「瞄準」放大（狙擊型是狙擊鏡，打中頭一發擊倒），「衝刺」噴火加速，「跳躍」按住往上飛（只有速度型有推進器，其他的「快跑」跑快一點、只能跳一下），「飛彈」發射（把敵人放在準星附近一下子就會鎖定）。偵察型按「偵察機」放出偵察機：搖桿和拖曳操控它、「上升」「下降」調高度，畫面中間框裡看得到的敵人會被掃到、隊友都看得到（飛太遠訊號會變差，畫面越來越糊），按「引爆」炸掉它；操控時機甲站著不能動，按「回到機甲」讓偵察機停在原地繼續偵測，之後按「操控偵察機」回去。堡壘型按「變身」、砲擊型按「架砲」：變身時不能走、只能轉向，再按「收回」恢復；砲擊型架了砲沒有落點的標示：左右拖曳轉方向、上下拖曳調砲管的仰角（20～85 度，45 度最遠，往上往下都變近；低角度飛得快但會被大樓擋住），照畫面上的仰角和「平地約幾公尺」估距離，炸到就一發擊倒。在自己家的機庫裡（或倒下等復活時）按「換機甲」換一台。'
        : 'WASD 移動、滑鼠瞄準、左鍵開火、右鍵放大瞄準（狙擊型是狙擊鏡，站穩了打得最準，打中頭一發擊倒）。Shift 噴火衝刺，空白鍵跳躍、按住往上飛（和衝刺共用能量；只有速度型有推進器，其他的 Shift 是快跑、只能跳一下）。Q 發射飛彈：準星對著敵人一下子就會鎖定、自動追蹤，每條命只有兩發。偵察型按 E 放出偵察機：WASD 和滑鼠操控、空白鍵上升、Shift 下降，畫面中間框裡看得到的敵人會被掃到、隊友的畫面和小地圖都看得到（飛太遠訊號會變差，畫面越來越糊），左鍵引爆；操控時機甲站著不能動，再按 E 回到機甲（偵察機停在原地繼續偵測），之後再按 E 回去操控。堡壘型、砲擊型按 E 變身（架砲）：變身時不能走、只能轉向，再按 E 收回；砲擊型架了砲沒有落點的標示：滑鼠左右轉方向、上下調砲管的仰角（20～85 度，45 度最遠，往上往下都變近；低角度飛得快但會被大樓擋住；右鍵放大轉得慢、方便微調），照畫面上的仰角和「平地約幾公尺」估距離，炸到就一發擊倒。R 換彈、Tab 看記分板、Esc 叫出選單；在自己家的機庫裡（或倒下等復活時）按 B 換機甲。也可以接遊戲手把。'}
    </p>
  )
}

/** 選單上的機體介紹：五台切換著看，加上操作說明 */
function MechGuide({ touch }: { touch: boolean }) {
  const [kind, setKind] = useState<MechKind>('speed')
  return (
    <section className="mecha-guide">
      <Segmented label="機體介紹" value={kind} options={KIND_OPTIONS} onChange={setKind} />
      <MechCard kind={kind} />
      <ControlsHelp touch={touch} />
    </section>
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

/** 選單畫面：還沒進房間時建立／加入（也可以一鍵開練習房），進了房間是大廳和聊天 */
export function OnlineMenu({
  party,
  touch,
  onWatch,
  onPractice,
}: {
  party: MechaRoom
  touch: boolean
  onWatch: () => void
  /** 開練習房：加幾台電腦 */
  onPractice: (bots: number) => void
}) {
  if (!party.code) {
    return (
      <>
        <MechGuide touch={touch} />
        <PartyEntry party={party}>
          <p className="mecha-help">
            紅藍兩隊在一大片城區裡對戰，先擊倒對方指定次數的隊伍贏。兩邊各有一座機庫當重生點，敵人進不去。
            開一個房間把連結傳給朋友，2～60 人（最多 30 對 30），人不夠可以加電腦。
          </p>
          <button type="button" className="secondary" onClick={() => onPractice(3)} disabled={party.busy}>
            練習：和 3 台電腦打
          </button>
          <button type="button" className="secondary" onClick={() => onPractice(59)} disabled={party.busy}>
            大混戰：30 對 30（59 台電腦）
          </button>
        </PartyEntry>
      </>
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
            hint={
              <p className="mecha-help">
                按開始後有 20 秒選紅隊或藍隊和機體（兩隊人數最多差一個），大家都準備好就開打。對戰中不能暫停。
              </p>
            }
          />
          <MechGuide touch={touch} />
          <ChatBox party={party} />
        </>
      ) : (
        !party.error && <p className="muted">連線中…</p>
      )}
    </>
  )
}

/** 選隊：每個人選紅隊或藍隊和機體，按「準備好了」就不能換 */
export function TeamSelect({ party, view, touch, onLeave }: { party: MechaRoom; view: MechaView; touch: boolean; onLeave: () => void }) {
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
          {view.select && (
            <span className="mecha-chip mecha-select-timer" role="timer">
              <Countdown ms={view.select.endsIn} stamp={view} />
            </span>
          )}
        </div>
        <p className="mecha-help">
          先擊倒對方 {view.killTarget} 次的隊伍贏，時間上限 {view.timeLimit} 分鐘。兩隊人數最多差一個，想去的那隊有電腦就和電腦交換。
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
          <>
            <MechGuide touch={touch} />
            <p className="mecha-help">你在觀戰，大家選好就開打。</p>
          </>
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
            <ControlsHelp touch={touch} />
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
        <h2>換機甲</h2>
        <p className="mecha-help">
          {alive
            ? '在自己家的機庫裡才能換：換了馬上就是新的一台，耐久、飛彈、偵察機都是滿的（放出去的偵察機會收回來）。'
            : '倒下等復活時先選好，復活就開這一台出擊。'}
        </p>
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
  onResume,
  onLeave,
  extra,
}: {
  party: MechaRoom
  sensitivity: number
  onSensitivity: (v: number) => void
  onResume: () => void
  onLeave: () => void
  extra?: ReactNode
}) {
  return (
    <div className="mecha-layer mecha-center">
      <div className="mecha-panel mecha-pause">
        <h2>選單</h2>
        <p className="mecha-help">線上對戰不會暫停，你的機甲還站在原地！</p>
        <button type="button" onClick={onResume}>
          回到對戰
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
