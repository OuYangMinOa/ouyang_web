import { useState, type ReactNode } from 'react'
import { ChatBox, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { Segmented } from '../shared/ui'
import { MONSTER_LOOK, TOWER_LOOK } from './models'
import { seatName, type Difficulty, type GameMode, type Spec, type TdRoom, type TdView } from './online'
import { levelText, reachText, seatColor } from './stats'

/** 選單、大廳的選項、說明、結算、對戰中的選單（連線和開局在 index.tsx） */

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
      <p className="td-help">
        {o.mode === 'coop'
          ? '合作：大家守同一塊場地、共用生命，各自有各自的錢。怪物的血量跟著人數變多，打倒一隻每個人都拿到賞金。'
          : '對抗：每個人守自己的場地，出一樣的波次。可以花錢派怪去打別人（順便提高自己每波的收入），撐到最後的人贏。至少 2 個人，可以加電腦。'}
      </p>
      <Segmented
        label="地圖"
        value={o.map}
        options={spec.maps.map((m) => ({ value: m.id, label: m.name }))}
        onChange={(id) => set({ map: id })}
        disabled={locked}
      />
      {map && (
        <p className="td-help">
          {map.blurb}（{map.w}×{map.h} 格）
        </p>
      )}
      <Segmented label="難度" value={o.difficulty} options={LEVELS} onChange={(difficulty) => set({ difficulty })} disabled={locked} />
      {o.mode === 'coop' && (
        <Segmented label="要撐幾波" value={o.waves} options={WAVES} onChange={(waves) => set({ waves })} disabled={locked} />
      )}
      {room.players.some((p) => p.bot) && (
        <Segmented label="電腦強度" value={o.bots} options={LEVELS} onChange={(bots) => set({ bots })} disabled={locked} />
      )}
      {!party.isHost && <p className="muted td-help">這些設定由房主決定。</p>}
    </>
  )
}

function HowTo({ touch }: { touch: boolean }) {
  return (
    <div className="td-help">
      <ul>
        <li>怪物一波一波從紫色的入口走向出口的水晶，走到一隻扣一條命（魔王扣 5 條）。</li>
        <li>
          <strong>塔會擋路</strong>：怪物要繞過去，所以塔同時也是迷宮的牆。把路排得越長，怪物挨打越久；但不能完全堵死，地上的箭頭是怪物現在會走的路。
        </li>
        <li>飛行的怪不走迷宮，從入口直直飛向出口；火砲和毒藤打不到牠們。</li>
        <li>打倒怪物拿賞金，每一波開始還有補給金。塔可以升到 4 級，拆掉退七成（第一波開始前全額退，放心試排）。</li>
        <li>
          {touch
            ? '操作：點下面的塔、再點格子看範圍，再點一次同一格就蓋。點蓋好的塔可以升級、拆掉、改先打誰。一指拖曳移動畫面，兩指捏合縮放、扭轉旋轉。'
            : '操作：按 1～7 或點下面的塔，再點格子就蓋（右鍵或 Esc 取消）。點蓋好的塔可以升級（U）、拆掉（X）、改先打誰。拖曳移動畫面，滾輪縮放，右鍵拖曳或 Q／E 旋轉，空白鍵「準備好了」。'}
        </li>
      </ul>
    </div>
  )
}

/** 塔和怪物的圖鑑 */
function Guide({ spec }: { spec: Spec }) {
  const [tab, setTab] = useState<'towers' | 'monsters'>('towers')
  return (
    <section className="td-guide">
      <Segmented
        label="圖鑑"
        value={tab}
        options={[
          { value: 'towers', label: '塔' },
          { value: 'monsters', label: '怪物' },
        ]}
        onChange={setTab}
      />
      {tab === 'towers' ? (
        <ul className="td-cards">
          {spec.towers.map((t) => (
            <li key={t.id}>
              <span className="td-card-icon" aria-hidden="true">
                {TOWER_LOOK[t.id].icon}
              </span>
              <div>
                <strong>{t.name}</strong>
                <span className="chip subtle">{reachText(t)}</span>
                <span className="chip subtle">{t.levels[0].cost} 元</span>
                <p>{t.blurb}</p>
                <p className="muted">
                  1 級：{levelText(t, t.levels[0])}
                  <br />
                  {t.levels.length} 級：{levelText(t, t.levels[t.levels.length - 1])}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="td-cards">
          {spec.monsters.map((m) => (
            <li key={m.id}>
              <span className="td-card-icon" aria-hidden="true">
                {MONSTER_LOOK[m.id].icon}
              </span>
              <div>
                <strong>{m.name}</strong>
                {m.air && <span className="chip subtle">飛行</span>}
                {m.phys < 1 && <span className="chip subtle">物理抗性 {Math.round((1 - m.phys) * 100)}%</span>}
                {m.magic < 1 && <span className="chip subtle">魔法抗性 {Math.round((1 - m.magic) * 100)}%</span>}
                <p>{m.blurb}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 選單畫面：還沒進房間時建立／加入（也可以一鍵自己練習），進了房間是大廳和聊天 */
export function Menu({
  party,
  spec,
  touch,
  onPractice,
}: {
  party: TdRoom
  spec: Spec
  touch: boolean
  onPractice: () => void
}) {
  if (!party.code) {
    return (
      <>
        <PartyEntry party={party}>
          <p className="td-help">
            蓋塔擋住一波一波的怪物：塔會擋路，所以怎麼排迷宮和蓋什麼塔一樣重要。可以大家一起守同一塊場地（合作），
            也可以各守各的、派怪去打別人（對抗）。1～8 人，人不夠可以加電腦。
          </p>
          <button type="button" className="secondary" onClick={onPractice} disabled={party.busy}>
            自己先練習（一個人、合作模式）
          </button>
        </PartyEntry>
        <HowTo touch={touch} />
        <Guide spec={spec} />
      </>
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
          <HowTo touch={touch} />
          <Guide spec={spec} />
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
        {view.best > 0 && <span className="muted">（這個房間最多撐過 {view.best} 波）</span>}
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
  touch,
  sound,
  onSound,
  onResume,
  onLeave,
}: {
  party: TdRoom
  touch: boolean
  sound: boolean
  onSound: () => void
  onResume: () => void
  onLeave: () => void
}) {
  return (
    <div className="td-layer td-center" onClick={onResume}>
      <div className="td-panel td-pause" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="選單">
        <h2>選單</h2>
        <p className="td-help">遊戲不會暫停，怪物還在走！</p>
        <button type="button" onClick={onResume}>
          回到遊戲
        </button>
        <button type="button" className="secondary" onClick={onSound} aria-pressed={sound}>
          {sound ? '🔊 音效：開' : '🔇 音效：關'}
        </button>
        <ChatBox party={party} />
        <details className="td-chat">
          <summary>怎麼玩</summary>
          <HowTo touch={touch} />
        </details>
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
