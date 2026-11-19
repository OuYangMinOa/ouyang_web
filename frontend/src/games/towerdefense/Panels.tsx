import { useId, useMemo, useState, type ReactNode } from 'react'
import { ChatBox, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { Segmented } from '../shared/ui'
import { Glyph, MonsterArt, TowerArt } from './Art'
import { pondCells } from './board'
import { routesOf } from './maze'
import { seatName, tileAt, type Difficulty, type GameMode, type MapSpec, type Spec, type TdRoom, type TdView } from './online'
import { biomeOf } from './palette'
import { levelText, reachText, seatColor, traitsOf } from './stats'

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

/** 地圖的縮圖：岩石、池塘、入口（圓）、出口（菱形），和還沒蓋塔時怪物會走的路 */
function MiniMap({ map }: { map: MapSpec }) {
  const { blocks, paths, spawns, exits } = useMemo(() => {
    const ponds = pondCells(map)
    const blocks: { x: number; y: number; pond: boolean }[] = []
    for (let c = 0; c < map.w * map.h; c++) {
      if (tileAt(map, c) === 'rock') blocks.push({ x: c % map.w, y: Math.floor(c / map.w), pond: ponds.has(c) })
    }
    const at = (cell: number) => [(cell % map.w) + 0.5, Math.floor(cell / map.w) + 0.5]
    return {
      blocks,
      paths: (routesOf(map, () => false)?.paths ?? []).map((path) => path.map((cell) => at(cell).join(',')).join(' ')),
      spawns: [...new Set(map.routes.map((r) => r[0]))].map(at),
      exits: [...new Set(map.routes.map((r) => r[1]))].map(at),
    }
  }, [map])
  return (
    <svg className={`td-minimap ${biomeOf(map.id)}`} viewBox={`-0.6 -0.6 ${map.w + 1.2} ${map.h + 1.2}`} aria-hidden="true" focusable="false">
      <rect width={map.w} height={map.h} rx="1" fill="var(--mini)" stroke="var(--td-tile-line)" strokeWidth="0.3" />
      {blocks.map((b) => (
        <rect
          key={`${b.x},${b.y}`}
          x={b.x + 0.08}
          y={b.y + 0.08}
          width="0.84"
          height="0.84"
          rx="0.3"
          fill={b.pond ? 'var(--td-water)' : 'color-mix(in srgb, var(--text-h) 42%, var(--mini))'}
        />
      ))}
      {paths.map((points, i) => (
        <polyline key={i} points={points} fill="none" stroke="var(--accent)" strokeWidth="0.42" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      ))}
      {spawns.map(([x, y]) => (
        <circle key={`${x},${y}`} cx={x} cy={y} r="0.85" fill="var(--td-spawn)" />
      ))}
      {exits.map(([x, y]) => (
        <rect key={`${x},${y}`} x={x - 0.72} y={y - 0.72} width="1.44" height="1.44" rx="0.2" fill="var(--td-exit)" transform={`rotate(45 ${x} ${y})`} />
      ))}
    </svg>
  )
}

/** 選地圖：每張一格，上面是縮圖 */
function MapPicker({ maps, value, onChange, disabled }: { maps: MapSpec[]; value: string; onChange: (id: string) => void; disabled: boolean }) {
  const id = useId()
  return (
    <div className="segmented-field">
      <span className="segmented-label" id={id}>
        地圖
      </span>
      <div className="td-maps" role="radiogroup" aria-labelledby={id}>
        {maps.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={m.id === value}
            className={`td-map${m.id === value ? ' active' : ''}`}
            disabled={disabled}
            onClick={() => onChange(m.id)}
          >
            <MiniMap map={m} />
            {m.name}
          </button>
        ))}
      </div>
    </div>
  )
}

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
      <MapPicker maps={spec.maps} value={o.map} onChange={(id) => set({ map: id })} disabled={locked} />
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
        <li>怪物一波一波從紫色的傳送門走向出口的水晶，走到一隻扣一條命（魔王扣 5 條）。</li>
        <li>
          <strong>塔會擋路</strong>：怪物要繞過去，所以塔同時也是迷宮的牆。把路排得越長，怪物挨打越久；但不能完全堵死。
          地上流動的箭頭是怪物現在會走的路，要蓋之前會先用綠色畫出新的路線、告訴你多繞了幾格。
        </li>
        <li>飛行的怪不走迷宮，從入口直直飛向出口；火砲和毒藤打不到牠們。</li>
        <li>打倒怪物拿賞金，每一波開始還有補給金。塔可以升到 4 級（越升越氣派），拆掉退七成（第一波開始前全額退，放心試排）。</li>
        <li>
          {touch
            ? '操作：點下面的塔、再點格子看範圍，再點一次同一格就蓋。點蓋好的塔可以升級、拆掉、改先打誰。一指拖曳移動畫面，兩指捏合縮放、扭轉旋轉。'
            : '操作：按 1～7 或點下面的塔，再點格子就蓋（右鍵或 Esc 取消）。點蓋好的塔可以升級（U）、拆掉（X）、改先打誰。拖曳移動畫面，滾輪縮放，右鍵拖曳或 Q／E 旋轉，空白鍵「準備好了」。'}
        </li>
        <li>
          多人：右邊的傷害榜是每個人到現在一共打了多少。
          {touch
            ? '按右邊的標記鈕，再按住場地往旁邊拖，可以標記給隊友看（危險、我來處理、這裡要塔、？；點一下不拖是「注意這裡」）。'
            : '按住 Alt 或 G（或先按右邊的標記鈕）再按住場地往旁邊拖，可以標記給隊友看（上：危險、右：我來處理、下：這裡要塔、左：？；按一下不拖是「注意這裡」）。'}
          隊友的塔只有蓋的人能拆，但可以在塔的面板上「提議拆掉」，蓋的人會看到、自己決定拆掉還是留著。
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
              <TowerArt id={t.id} size={48} />
              <div>
                <strong>{t.name}</strong>
                {reachText(t)
                  .split('・')
                  .map((tag) => (
                    <span key={tag} className="td-tag">
                      {tag}
                    </span>
                  ))}
                <span className="td-tag gold">{t.levels[0].cost} 元</span>
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
              <MonsterArt id={m.id} size={48} />
              <div>
                <strong>{m.name}</strong>
                {traitsOf(m).map((trait) => (
                  <span key={trait} className={`td-tag${trait === '魔王' ? ' danger' : trait === '飛行' ? ' air' : ''}`}>
                    {trait}
                  </span>
                ))}
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
          <Glyph name={sound ? 'sound' : 'mute'} size={18} />
          {sound ? '音效：開' : '音效：關'}
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
