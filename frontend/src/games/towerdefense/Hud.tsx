import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Countdown } from '../shared/Party'
import { Glyph, MonsterArt, TowerArt } from './Art'
import type { TowerInfo } from './game'
import { TOWER_LOOK } from './models'
import { AIM_MODES, seatName, type AimMode, type Spec, type TdRoom, type TdView, type TowerId, type TowerSpec } from './online'
import { goldOf, reachText, seatColor, spentOn, statCells, traitsOf, useStats, type StatCell, type StatsStore } from './stats'

/** 對戰中浮在 3D 畫面上的介面：資源、波次、商店、塔的面板、玩家列表、派兵（連線和操作在 index.tsx） */

/** 數字變多的時候跳一下（賞金進帳） */
function Bump({ value }: { value: number }) {
  const [seen, setSeen] = useState({ value, n: 0 })
  if (seen.value !== value) setSeen({ value, n: value > seen.value ? seen.n + 1 : seen.n })
  return (
    <strong key={seen.n} className={seen.n ? 'td-bump' : undefined}>
      {value}
    </strong>
  )
}

/** 左上：生命、錢、場上的怪物 */
export function Resources({
  view,
  stats,
  seat,
  look,
  income,
  leak,
}: {
  view: TdView
  stats: StatsStore
  seat: number | null
  look: number
  income: number
  /** 漏了幾次怪：每漏一次生命那一格晃一下 */
  leak: number
}) {
  const s = useStats(stats)
  const lives = s.lives[look] ?? view.fields[look]?.lives ?? 0
  const monsters = s.counts[look] ?? 0
  return (
    <div className="td-res" aria-live="off">
      <span key={leak} className={`td-chip td-stat td-lives${lives <= 5 ? ' low' : ''}${leak ? ' hit' : ''}`} title="生命：怪物走到出口就扣">
        <Glyph name="heart" size={18} />
        <strong>{lives}</strong>
      </span>
      {seat !== null && (
        <span className="td-chip td-stat td-gold" title="錢">
          <Glyph name="coin" size={18} />
          <Bump value={goldOf(view, s, seat)} />
          {view.mode === 'versus' && income > 0 && <small>+{income}／波</small>}
        </span>
      )}
      {monsters > 0 && (
        <span className="td-chip td-stat subtle" title="場上的怪物">
          <Glyph name="skull" size={17} />
          <strong>{monsters}</strong>
        </span>
      )}
    </div>
  )
}

/** 一波出什麼怪：小圖 × 幾隻 */
function Groups({ groups, spec, size }: { groups: [number, number][]; spec: Spec; size: number }) {
  return (
    <>
      {groups.map(([kind, count], i) => {
        const m = spec.monsters[kind]
        if (!m) return null
        return (
          <span key={i} className="td-next-item" title={`${m.name}：${m.blurb}`}>
            <MonsterArt id={m.id} size={size} />
            <span className="sr-only">{m.name}</span>×{count}
          </span>
        )
      })}
    </>
  )
}

/** 點開「下一波」：每種怪是什麼、有什麼本事 */
function WaveDetails({ title, groups, spec }: { title: string; groups: [number, number][]; spec: Spec }) {
  if (!groups.length) return null
  return (
    <section>
      <h3>{title}</h3>
      <ul>
        {groups.map(([kind, count], i) => {
          const m = spec.monsters[kind]
          if (!m) return null
          return (
            <li key={i}>
              <MonsterArt id={m.id} size={40} />
              <div>
                <strong>
                  {m.name} ×{count}
                </strong>
                {traitsOf(m).map((trait) => (
                  <span key={trait} className={`td-tag${trait === '魔王' ? ' danger' : trait === '飛行' ? ' air' : ''}`}>
                    {trait}
                  </span>
                ))}
                <p>{m.blurb}</p>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** 上方中間：第幾波、這一波還剩幾隻、下一波的預告和「準備好了」 */
export function WaveBar({
  view,
  spec,
  stats,
  look,
  ready,
  readyCount,
  readyTotal,
  canAct,
  onReady,
}: {
  view: TdView
  spec: Spec
  stats: StatsStore
  look: number
  ready: boolean
  readyCount: number
  readyTotal: number
  canAct: boolean
  onReady: (ready: boolean) => void
}) {
  const s = useStats(stats)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // 點開的說明：點別的地方、按 Esc 就收起來
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return
      // 先攔下來：不然外面那一層會以為要叫出選單
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
  const resting = view.nextIn !== null
  // 這一波還要對付幾隻：還沒出來的加上場上的；進度條照「這一波最多的時候」算
  const remaining = (s.left[look] ?? 0) + (s.counts[look] ?? 0)
  const key = `${view.game}:${view.wave}`
  const [peak, setPeak] = useState({ key, most: remaining })
  if (peak.key !== key) setPeak({ key, most: remaining })
  else if (remaining > peak.most) setPeak({ key, most: remaining })
  const done = peak.most > 0 ? 1 - remaining / peak.most : 0
  const has = (test: (kind: number) => boolean) => view.next.some(([kind]) => test(kind))
  const boss = has((kind) => (spec.monsters[kind]?.lives ?? 1) > 1)
  const air = has((kind) => spec.monsters[kind]?.air === true)
  return (
    <div className="td-wave td-chip" ref={root}>
      <div className="td-wave-main">
        <strong>
          {view.wave === 0 ? (
            '準備中'
          ) : (
            <>
              第 {view.wave}
              {view.mode === 'coop' && view.waves > 0 && <small>／{view.waves}</small>} 波
            </>
          )}
        </strong>
        {resting ? (
          <span className="td-wave-timer">
            下一波 <Countdown ms={view.nextIn} stamp={view} />
          </span>
        ) : (
          <span className="td-wave-left">
            剩 <b>{remaining}</b> 隻
          </span>
        )}
      </div>
      <button
        type="button"
        className={`td-next${open ? ' on' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="下一波會出現的怪物（點開看說明）"
      >
        <span className="td-next-label">下一波</span>
        <Groups groups={view.next} spec={spec} size={26} />
        {boss && <span className="td-tag danger">魔王</span>}
        {air && !boss && <span className="td-tag air">飛行</span>}
      </button>
      {canAct && (
        <button
          type="button"
          className={ready ? 'td-ready on' : 'td-ready'}
          aria-pressed={ready}
          onClick={() => onReady(!ready)}
          title="大家都準備好了，下一波就馬上開始（空白鍵）"
        >
          {ready ? (
            <>
              <Glyph name="check" size={16} />
              {readyTotal > 1 ? '等其他人' : '馬上開始'}
            </>
          ) : resting ? (
            '準備好了'
          ) : (
            '提早叫下一波'
          )}
          {readyTotal > 1 && (
            <small>
              {readyCount}/{readyTotal}
            </small>
          )}
        </button>
      )}
      {!resting && view.wave > 0 && (
        <div className="td-wave-bar" role="progressbar" aria-label="這一波的進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(done * 100)}>
          <span style={{ width: `${Math.round(done * 1000) / 10}%` }} />
        </div>
      )}
      {open && (
        <div className="td-wave-details td-chip">
          <WaveDetails title="下一波" groups={view.next} spec={spec} />
          {!resting && <WaveDetails title="這一波" groups={view.now} spec={spec} />}
        </div>
      )}
    </div>
  )
}

/** 新的一波開始：畫面中間跳出「第幾波」和這一波的怪 */
export function WaveBanner({ wave, groups, spec }: { wave: number; groups: [number, number][]; spec: Spec }) {
  const boss = groups.some(([kind]) => (spec.monsters[kind]?.lives ?? 1) > 1)
  return (
    <div className={`td-banner${boss ? ' boss' : ''}`} role="status">
      <span className="td-banner-kicker">{boss ? '魔王來襲' : '怪物來了'}</span>
      <strong>第 {wave} 波</strong>
      <div className="td-banner-mons">
        <Groups groups={groups} spec={spec} size={34} />
      </div>
    </div>
  )
}

/** 最下面一排：七種塔。選了空格的時候按一下直接蓋在那一格；滑鼠停在上面先看說明 */
export function Shop({
  spec,
  view,
  stats,
  seat,
  kind,
  onPick,
  onPeek,
  disabled,
}: {
  spec: Spec
  view: TdView
  stats: StatsStore
  seat: number | null
  kind: TowerId | null
  onPick: (kind: TowerId) => void
  onPeek: (kind: TowerId | null) => void
  disabled: boolean
}) {
  const gold = goldOf(view, useStats(stats), seat)
  return (
    <div className="td-shop" role="toolbar" aria-label="蓋塔">
      {spec.towers.map((t, i) => {
        const cost = t.levels[0].cost
        const look = TOWER_LOOK[t.id]
        return (
          <button
            key={t.id}
            type="button"
            className={`td-shop-item${kind === t.id ? ' on' : ''}${gold < cost ? ' poor' : ''}`}
            style={{ '--tower': look.accent } as CSSProperties}
            aria-pressed={kind === t.id}
            aria-label={`${t.name}，${cost} 元`}
            disabled={disabled}
            onClick={() => onPick(t.id)}
            onPointerEnter={(e) => e.pointerType === 'mouse' && onPeek(t.id)}
            onPointerLeave={() => onPeek(null)}
            onFocus={(e) => e.target.matches(':focus-visible') && onPeek(t.id)}
            onBlur={() => onPeek(null)}
          >
            <kbd className="td-key" aria-hidden="true">
              {i + 1}
            </kbd>
            <TowerArt id={t.id} size={44} className="td-shop-art" />
            <span className="td-shop-name">{t.name}</span>
            <span className="td-shop-cost">
              <Glyph name="coin" size={13} />
              {cost}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** 一格一格的數值；升級後會變的那幾格多標一個箭頭和新的值 */
function StatGrid({ cells }: { cells: StatCell[] }) {
  return (
    <dl className="td-stats">
      {cells.map((cell) => (
        <div key={cell.label} className={cell.next ? 'up' : undefined}>
          <dt>{cell.label}</dt>
          <dd>
            {cell.value}
            {cell.next && (
              <>
                <span className="td-arrow" aria-hidden="true">
                  →
                </span>
                <span className="sr-only">升級後</span>
                <b>{cell.next}</b>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Tags({ tower }: { tower: TowerSpec }) {
  return (
    <>
      {reachText(tower)
        .split('・')
        .map((tag) => (
          <span key={tag} className="td-tag">
            {tag}
          </span>
        ))}
    </>
  )
}

/** 錢不夠蓋這種塔的時候，說還差多少 */
function Short({ tower, view, stats, seat }: { tower: TowerSpec; view: TdView; stats: StatsStore; seat: number | null }) {
  const short = tower.levels[0].cost - goldOf(view, useStats(stats), seat)
  if (seat === null || short <= 0) return null
  return (
    <span className="td-gain short">
      <Glyph name="coin" size={14} />
      還差 {short} 元
    </span>
  )
}

/** 選了一種塔（或選了一個空格、滑鼠停在商店的塔上）時的說明 */
export function BuildInfo({
  tower,
  hint,
  gain,
  view,
  stats,
  seat,
  onCancel,
}: {
  tower: TowerSpec | null
  hint: string
  /** 蓋在游標那一格，路線會多幾格；沒在預覽是 null */
  gain: number | null
  view: TdView
  stats: StatsStore
  seat: number | null
  /** 沒給就是只是看看（滑鼠停在商店上），不顯示取消 */
  onCancel?: () => void
}) {
  return (
    <div className="td-info td-chip td-card">
      {tower && <TowerArt id={tower.id} size={64} className="td-card-art" />}
      <div className="td-card-body">
        <div className="td-info-head">
          {tower ? (
            <>
              <strong>{tower.name}</strong>
              <Tags tower={tower} />
            </>
          ) : (
            <strong>選一種塔</strong>
          )}
          {onCancel && (
            <button type="button" className="td-x" onClick={onCancel} aria-label="取消" title="取消（Esc）">
              <Glyph name="close" size={18} />
            </button>
          )}
        </div>
        {tower && <p className="td-blurb">{tower.blurb}</p>}
      </div>
      {/* 數值和提示橫跨整張卡片（窄螢幕上不要被左邊的圖擠到換行） */}
      <div className="td-card-foot">
        {tower && <StatGrid cells={statCells(tower, tower.levels[0])} />}
        <p className="td-hint">
          {tower && <Short tower={tower} view={view} stats={stats} seat={seat} />}
          {gain !== null && (
            <span className={`td-gain${gain > 0 ? ' more' : ''}`}>
              <Glyph name="route" size={15} />
              {gain > 0 ? `路線多 ${gain} 格` : gain < 0 ? `路線少 ${-gain} 格` : '路線不變'}
            </span>
          )}
          <span className="muted">{hint}</span>
        </p>
      </div>
    </div>
  )
}

/** 選到一座塔：升級、拆掉、先打誰 */
export function TowerPanel({
  tower,
  spec,
  view,
  stats,
  seat,
  ownerName,
  canManage,
  canUpgrade,
  onUpgrade,
  onSell,
  onMode,
  onClose,
  onPeekUpgrade,
}: {
  tower: TowerInfo
  spec: Spec
  view: TdView
  stats: StatsStore
  seat: number | null
  ownerName: string
  /** 可以拆、改瞄準（自己的，或主人是電腦、不在線上） */
  canManage: boolean
  canUpgrade: boolean
  onUpgrade: () => void
  onSell: () => void
  onMode: (mode: AimMode) => void
  onClose: () => void
  /** 指著「升級」：場地上把升級後的射程也畫出來 */
  onPeekUpgrade: (on: boolean) => void
}) {
  const gold = goldOf(view, useStats(stats), seat)
  const t = spec.towers[tower.kind]
  if (!t) return null
  const level = t.levels[tower.level - 1]
  const next = t.levels[tower.level]
  const spent = spentOn(t, tower.level)
  const refund = view.wave === 0 ? spent : Math.round(spent * spec.refund)
  const mode = AIM_MODES[tower.mode]?.value
  return (
    <div className="td-info td-chip td-card td-tower" style={seatColor(tower.owner)}>
      <TowerArt id={t.id} level={tower.level} size={64} className="td-card-art" />
      <div className="td-card-body">
        <div className="td-info-head">
          <strong>{t.name}</strong>
          <span className="td-level" title={`${tower.level} 級（最高 ${spec.maxLevel} 級）`}>
            <span className="sr-only">{tower.level} 級</span>
            {Array.from({ length: spec.maxLevel }, (_, i) => (
              <i key={i} className={i < tower.level ? 'on' : undefined} aria-hidden="true" />
            ))}
          </span>
          <span className="td-owner">{ownerName}</span>
          {tower.buff > 0 && (
            <span className="td-tag gold" title="在號角塔的範圍裡">
              號角 +{Math.round(tower.buff * 100)}%
            </span>
          )}
          <button type="button" className="td-x" onClick={onClose} aria-label="關閉" title="關閉（Esc）">
            <Glyph name="close" size={18} />
          </button>
        </div>
        <StatGrid cells={statCells(t, level, next)} />
      </div>
      <div className="td-card-foot">
        <div className="td-actions">
          {next ? (
            <button
              type="button"
              className="td-upgrade"
              disabled={!canUpgrade || gold < next.cost}
              onClick={onUpgrade}
              onPointerEnter={() => onPeekUpgrade(true)}
              onPointerLeave={() => onPeekUpgrade(false)}
              onFocus={() => onPeekUpgrade(true)}
              onBlur={() => onPeekUpgrade(false)}
              title="升級（U）"
            >
              <Glyph name="up" size={16} />
              升級
              <span className="td-cost">
                <Glyph name="coin" size={13} />
                {next.cost}
              </span>
            </button>
          ) : (
            <span className="td-tag gold td-max">已經最高級</span>
          )}
          {canManage && (
            <button type="button" className="secondary" onClick={onSell} title="拆掉（X）">
              拆掉
              <span className="td-cost">
                <Glyph name="coin" size={13} />+{refund}
              </span>
            </button>
          )}
        </div>
        {t.id !== 'beacon' && (
          <div className="td-modes" role="radiogroup" aria-label="先打誰">
            <span className="muted">先打</span>
            {AIM_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={mode === m.value}
                className={mode === m.value ? 'on' : undefined}
                disabled={!canManage}
                onClick={() => onMode(m.value)}
                title={m.hint}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** 玩家列表：錢、生命、戰績；合作可以給錢，對抗可以看別人的場地、指定要打誰 */
export function Players({
  party,
  view,
  stats,
  look,
  target,
  aim,
  onLook,
  onGive,
  onAim,
}: {
  party: TdRoom
  view: TdView
  stats: StatsStore
  look: number
  target: number | null
  aim: number | null
  onLook: (field: number) => void
  onGive: (seat: number, amount: number) => void
  onAim: (seat: number | null) => void
}) {
  const s = useStats(stats)
  const me = view.you
  const versus = view.mode === 'versus'
  const myGold = goldOf(view, s, me)
  const bots = new Set(view.bots)
  const iAmIn = me !== null && !view.players[me]?.out
  return (
    <ul className="td-players">
      {view.players.map((p, seat) => {
        const lives = s.lives[p.field] ?? view.fields[p.field]?.lives ?? 0
        return (
          <li key={seat} className={`${seat === me ? 'me' : ''}${p.out ? ' out' : ''}`} style={seatColor(seat)}>
            <span className="td-dot" aria-hidden="true" />
            <span className="td-player-name">
              {seatName(party, seat)}
              {seat === me && <span className="chip subtle">你</span>}
              {bots.has(seat) && <span className="chip subtle">電腦</span>}
              {!bots.has(seat) && !p.online && <span className="chip subtle">離線</span>}
              {p.out && <span className="chip subtle">第 {p.place} 名</span>}
            </span>
            <span className="td-player-stats">
              <span className="td-gold" title="錢">
                <Glyph name="coin" size={14} /> {goldOf(view, s, seat)}
              </span>
              {versus && (
                <span className="td-lives" title="生命">
                  <Glyph name="heart" size={14} /> {lives}
                </span>
              )}
              {versus && <span title="每波收入">+{p.income}／波</span>}
              <span title="擊倒">
                <Glyph name="skull" size={14} /> {s.kills[seat] ?? p.kills}
              </span>
            </span>
            <span className="td-player-actions">
              {!versus && iAmIn && seat !== me && (
                <>
                  <button type="button" className="secondary" disabled={myGold < 50} onClick={() => onGive(seat, 50)}>
                    給 50
                  </button>
                  <button type="button" className="secondary" disabled={myGold < 200} onClick={() => onGive(seat, 200)}>
                    給 200
                  </button>
                </>
              )}
              {versus && (
                <button
                  type="button"
                  className={look === p.field ? undefined : 'secondary'}
                  aria-pressed={look === p.field}
                  onClick={() => onLook(p.field)}
                >
                  {look === p.field ? '觀看中' : '看'}
                </button>
              )}
              {versus && iAmIn && seat !== me && !p.out && (
                <button
                  type="button"
                  className={target === seat ? undefined : 'secondary'}
                  aria-pressed={aim === seat}
                  onClick={() => onAim(aim === seat ? null : seat)}
                  title={aim === seat ? '改回自動（打下一位還在場上的人）' : '派兵都打他'}
                >
                  <Glyph name="target" size={15} />
                  {aim === seat ? ' 鎖定' : target === seat ? ' 目標' : ''}
                </button>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** 對抗：花錢派怪去打目標，每派一次自己每波的收入就變多 */
export function SendPanel({
  spec,
  view,
  stats,
  seat,
  targetName,
  onSend,
}: {
  spec: Spec
  view: TdView
  stats: StatsStore
  seat: number
  targetName: string | null
  onSend: (unit: number) => void
}) {
  const gold = goldOf(view, useStats(stats), seat)
  return (
    <div className="td-send">
      <p className="td-send-head">
        派兵打 <strong>{targetName ?? '（沒有對手了）'}</strong>
        <span className="muted">每派一次，自己每波的收入就變多</span>
      </p>
      <div className="td-send-list">
        {spec.units.map((u, i) => {
          const m = spec.monsters.find((x) => x.id === u.kind)
          if (!m) return null
          const locked = view.wave < u.unlock
          return (
            <button
              key={i}
              type="button"
              className="td-send-item"
              disabled={locked || gold < u.cost || targetName === null}
              onClick={() => onSend(i)}
              title={m.blurb}
            >
              <MonsterArt id={m.id} size={36} />
              <span>
                {m.name}×{u.count}
              </span>
              {locked ? (
                <small>第 {u.unlock} 波解鎖</small>
              ) : (
                <small>
                  <span className="td-cost">
                    <Glyph name="coin" size={12} />
                    {u.cost}
                  </span>
                  ・收入 +{u.income}
                </small>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
