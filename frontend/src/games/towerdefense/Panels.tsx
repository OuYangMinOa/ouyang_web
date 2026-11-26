import { useState, type ReactNode } from 'react'
import { ChatBox, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { Segmented } from '../shared/ui'
import { MONSTER_LOOK, TOWER_LOOK } from './models'
import { seatName, type Difficulty, type GameMode, type Spec, type TdRoom, type TdView } from './online'
import { levelText, reachText, seatColor } from './stats'

/** 選單、大廳的選項、說明（玩法和圖鑑）、結算、對戰中的選單（連線和開局在 index.tsx） */

const MODES: { value: GameMode; label: string }[] = [
  { value: 'coop', label: '合作' },
  { value: 'versus', label: '對抗' },
]
const LEVELS: { value: Difficulty; label: string }[] = [
  { value: 'easy', label: '簡單' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困難' },
]
const WAVES = [
  { value: 20, label: '20 波' },
  { value: 30, label: '30 波' },
  { value: 40, label: '40 波' },
  { value: 0, label: '無限' },
]

/** 房主選模式、地圖、難度；其他人看得到但不能改 */
function Options({ party, spec }: { party: TdRoom; spec: Spec }) {
  const room = party.room
  if (!room) return null
  const o = room.options
  const locked = !party.isHost || room.phase === 'playing'
  const set = (patch: Partial<typeof o>) => party.setOptions({ ...o, ...patch })
  const map = spec.maps.find((m) => m.id === o.map)
  return (
    <>
      <Segmented label="模式" value={o.mode} options={MODES} onChange={(mode) => set({ mode })} disabled={locked} />
      <p className="td-help muted">{o.mode === 'coop' ? '一起守同一塊場地，共用生命。' : '各守各的，花錢派怪打別人，撐到最後的贏。'}</p>
      <Segmented
        label="地圖"
        value={o.map}
        options={spec.maps.map((m) => ({ value: m.id, label: m.name }))}
        onChange={(id) => set({ map: id })}
        disabled={locked}
      />
      {map && <p className="td-help muted">{map.blurb}</p>}
      <Segmented label="難度" value={o.difficulty} options={LEVELS} onChange={(difficulty) => set({ difficulty })} disabled={locked} />
      {o.mode === 'coop' && (
        <Segmented label="要撐幾波" value={o.waves} options={WAVES} onChange={(waves) => set({ waves })} disabled={locked} />
      )}
      {room.players.some((p) => p.bot) && (
        <Segmented label="電腦強度" value={o.bots} options={LEVELS} onChange={(bots) => set({ bots })} disabled={locked} />
      )}
    </>
  )
}

/** 操作：按鍵（觸控是手勢）對照表 */
const KEYS: [string, string][] = [
  ['1～7', '選塔'],
  ['點格子', '蓋塔'],
  ['右鍵・Esc', '取消'],
  ['U・X', '升級・拆掉'],
  ['空白鍵', '準備好了'],
  ['拖曳・滾輪', '移動・縮放'],
  ['Q・E', '旋轉'],
  ['Tab', '玩家列表'],
]
const GESTURES: [string, string][] = [
  ['點塔再點格子', '預覽範圍'],
  ['再點同一格', '蓋塔'],
  ['點蓋好的塔', '升級・拆掉'],
  ['一指拖曳', '移動'],
  ['兩指', '縮放・旋轉'],
]

/** 玩法：幾條規則加一張操作表 */
function HowTo({ spec, touch }: { spec: Spec; touch: boolean }) {
  const boss = Math.max(1, ...spec.monsters.map((m) => m.lives))
  const groundOnly = spec.towers.filter((t) => t.ground && !t.air).map((t) => t.name.replace(/塔$/, ''))
  return (
    <>
      <ul className="td-rules">
        <li>
          怪物走到出口扣 1 命{boss > 1 && `（魔王 ${boss} 命）`}。
        </li>
        <li>
          <strong>塔會擋路</strong>：路排得越長越好，但不能堵死。
        </li>
        <li>
          飛行怪直飛出口{groundOnly.length > 0 && `，${groundOnly.join('、')}打不到`}。
        </li>
        <li>
          塔最高 {spec.maxLevel} 級；拆掉退 {Math.round(spec.refund * 10)} 成，第一波前全額退。
        </li>
      </ul>
      <dl className="td-keys">
        {(touch ? GESTURES : KEYS).map(([key, what]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

type InfoTab = 'how' | 'towers' | 'monsters'
const INFO_TABS: { value: InfoTab; label: string }[] = [
  { value: 'how', label: '玩法' },
  { value: 'towers', label: '塔' },
  { value: 'monsters', label: '怪物' },
]

/** 說明：玩法和操作、塔和怪物的圖鑑。選單和對戰中的選單都從「說明」按鈕打開 */
export function InfoPanel({ spec, touch, onClose }: { spec: Spec; touch: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<InfoTab>('how')
  return (
    <div className="td-layer td-center td-info-layer" onClick={onClose}>
      <div className="td-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="說明">
        <div className="td-info-head">
          <h2>說明</h2>
          <button type="button" className="td-x" onClick={onClose} aria-label="關閉" title="關閉（Esc）">
            ×
          </button>
        </div>
        <Segmented value={tab} options={INFO_TABS} onChange={setTab} />
        {tab === 'how' && <HowTo spec={spec} touch={touch} />}
        {tab === 'towers' && (
          <ul className="td-cards">
            {spec.towers.map((t) => (
              <li key={t.id}>
                <span className="td-card-icon" aria-hidden="true">
                  {TOWER_LOOK[t.id].icon}
                </span>
                <div>
                  <strong>{t.name}</strong>
                  <span className="chip subtle">{reachText(t)}</span>
                  <span className="td-cost">{t.levels[0].cost}</span>
                  <p>{t.blurb}</p>
                  <p className="muted">{levelText(t, t.levels[0])}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {tab === 'monsters' && (
          <ul className="td-cards">
            {spec.monsters.map((m) => (
              <li key={m.id}>
                <span className="td-card-icon" aria-hidden="true">
                  {MONSTER_LOOK[m.id].icon}
                </span>
                <div>
                  <strong>{m.name}</strong>
                  {m.air && <span className="chip subtle">飛行</span>}
                  {m.phys < 1 && <span className="chip subtle">物抗 {Math.round((1 - m.phys) * 100)}%</span>}
                  {m.magic < 1 && <span className="chip subtle">魔抗 {Math.round((1 - m.magic) * 100)}%</span>}
                  <p>{m.blurb}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** 選單畫面：還沒進房間時建立／加入（也可以一鍵自己練習），進了房間是大廳和聊天。玩法在「說明」按鈕裡 */
export function Menu({ party, spec, onPractice }: { party: TdRoom; spec: Spec; onPractice: () => void }) {
  if (!party.code) {
    return (
      <PartyEntry party={party}>
        <p className="td-help">蓋塔排迷宮，擋住一波波怪物。1～8 人，合作或對抗。</p>
        <button type="button" className="secondary" onClick={onPractice} disabled={party.busy}>
          單人練習
        </button>
      </PartyEntry>
    )
  }
  return (
    <>
      <PartyHeader party={party} shareTitle="一起來玩迷宮塔防" />
      <PartyNotice party={party} />
      {party.room ? (
        <>
          <PartyLobby party={party} options={<Options party={party} spec={spec} />} />
          <ChatBox party={party} />
        </>
      ) : (
        !party.error && <p className="muted">連線中…</p>
      )}
    </>
  )
}

/** 每個人的戰績 */
export function Scoreboard({ party, view }: { party: TdRoom; view: TdView }) {
  const versus = view.mode === 'versus'
  const bots = new Set(view.bots)
  const rows = view.players
    .map((p, seat) => ({ ...p, seat }))
    .sort((a, b) => (versus ? (a.place ?? 0) - (b.place ?? 0) : 0) || b.kills - a.kills || b.damage - a.damage)
  return (
    <table className="responsive td-table">
      <thead>
        <tr>
          <th>玩家</th>
          {versus && <th>名次</th>}
          <th>擊倒</th>
          <th>傷害</th>
          <th>蓋塔</th>
          {versus && <th>派兵</th>}
          <th>勝場</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.seat} className={r.seat === view.you ? 'me' : undefined} style={seatColor(r.seat)}>
            <td data-label="玩家" className="primary">
              <span className="td-dot" aria-hidden="true" />
              {seatName(party, r.seat)}
              {bots.has(r.seat) && <span className="chip subtle">電腦</span>}
            </td>
            {versus && <td data-label="名次">{r.place ? `第 ${r.place} 名` : '還在場上'}</td>}
            <td data-label="擊倒">{r.kills}</td>
            <td data-label="傷害">{r.damage}</td>
            <td data-label="蓋塔">{r.built}</td>
            {versus && <td data-label="派兵">{r.sent}</td>}
            <td data-label="勝場">{r.wins}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 結算：贏了沒、戰績，下面接著「再來一局」的大廳 */
export function Results({
  party,
  view,
  spec,
  onLeave,
  onHide,
}: {
  party: TdRoom
  view: TdView
  spec: Spec
  onLeave: () => void
  /** 收起結算，回去看場地 */
  onHide: () => void
}) {
  const me = view.you
  let title: string
  let tone = ''
  let detail: ReactNode
  if (view.mode === 'coop') {
    title = view.won ? '守住了！' : '守不住了…'
    tone = view.won ? 'ok' : 'danger'
    detail = (
      <>
        {view.won ? `${view.wave} 波全部撐過去` : `倒在第 ${view.wave} 波`}
        {view.best > 0 && <span className="muted">（最佳 {view.best} 波）</span>}
      </>
    )
  } else {
    const place = me !== null ? view.players[me]?.place : null
    title = place === 1 ? '你贏了！' : place ? `第 ${place} 名` : view.winner !== null ? `${seatName(party, view.winner)} 獲勝！` : '結束了'
    tone = place === 1 ? 'ok' : place ? 'danger' : ''
    detail =
      view.winner !== null ? (
        <>
          <strong>{seatName(party, view.winner)}</strong> 撐到最後（第 {view.wave} 波）
        </>
      ) : (
        `打到第 ${view.wave} 波`
      )
  }
  return (
    <div className="td-layer td-center">
      <div className="td-panel td-result">
        <h2 className={tone}>{title}</h2>
        <p className="td-final">{detail}</p>
        <Scoreboard party={party} view={view} />
        <PartyLobby party={party} options={<Options party={party} spec={spec} />} />
        <PartyNotice party={party} />
        <details className="td-chat">
          <summary>聊天</summary>
          <ChatBox party={party} />
        </details>
        <div className="td-actions td-sticky">
          <button type="button" className="secondary" onClick={onLeave}>
            離開房間
          </button>
          <button type="button" className="secondary" onClick={onHide}>
            看場地
          </button>
        </div>
      </div>
    </div>
  )
}

/** 對戰中按 Esc：遊戲不會停，只是打開選單 */
export function PauseMenu({
  party,
  sound,
  onSound,
  onInfo,
  onResume,
  onLeave,
}: {
  party: TdRoom
  sound: boolean
  onSound: () => void
  /** 打開說明（玩法、圖鑑） */
  onInfo: () => void
  onResume: () => void
  onLeave: () => void
}) {
  return (
    <div className="td-layer td-center" onClick={onResume}>
      <div className="td-panel td-pause" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="選單">
        <h2>
          選單 <small className="muted">遊戲不會暫停</small>
        </h2>
        <button type="button" onClick={onResume}>
          回到遊戲
        </button>
        <button type="button" className="secondary" onClick={onSound} aria-pressed={sound}>
          {sound ? '🔊 音效：開' : '🔇 音效：關'}
        </button>
        <button type="button" className="secondary" onClick={onInfo}>
          ℹ️ 說明
        </button>
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
