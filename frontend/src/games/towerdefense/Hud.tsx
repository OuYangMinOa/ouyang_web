import type { CSSProperties } from 'react'
import { Countdown } from '../shared/Party'
import type { TowerInfo } from './game'
import { MONSTER_LOOK, TOWER_LOOK } from './models'
import { AIM_MODES, seatName, type AimMode, type Spec, type TdRoom, type TdView, type TowerId, type TowerSpec } from './online'
import { goldOf, levelText, reachText, seatColor, spentOn, useStats, type StatsStore } from './stats'

/** 對戰中浮在 3D 畫面上的介面：資源、波次、商店、塔的面板、玩家列表、派兵（連線和操作在 index.tsx） */

/** 左上：生命和錢 */
export function Resources({
  view,
  stats,
  seat,
  look,
  income,
}: {
  view: TdView
  stats: StatsStore
  seat: number | null
  look: number
  income: number
}) {
  const s = useStats(stats)
  const lives = s.lives[look] ?? view.fields[look]?.lives ?? 0
  const monsters = s.counts[look] ?? 0
  return (
    <div className="td-res" aria-live="off">
      <span className={`td-chip td-stat${lives <= 5 ? ' danger' : ''}`} title="生命：怪物走到出口就扣">
        <span aria-hidden="true">❤</span>
        <strong>{lives}</strong>
      </span>
      {seat !== null && (
        <span className="td-chip td-stat" title="錢">
          <span aria-hidden="true">🪙</span>
          <strong>{goldOf(view, s, seat)}</strong>
          {view.mode === 'versus' && income > 0 && <small>+{income}／波</small>}
        </span>
      )}
      {monsters > 0 && (
        <span className="td-chip td-stat subtle" title="場上的怪物">
          <span aria-hidden="true">👾</span>
          <strong>{monsters}</strong>
        </span>
      )}
    </div>
  )
}

/** 上方中間：第幾波、下一波的倒數和「準備好了」 */
export function WaveBar({
  view,
  spec,
  ready,
  readyCount,
  readyTotal,
  canAct,
  onReady,
}: {
  view: TdView
  spec: Spec
  ready: boolean
  readyCount: number
  readyTotal: number
  canAct: boolean
  onReady: (ready: boolean) => void
}) {
  const total = view.mode === 'coop' && view.waves > 0 ? `／${view.waves}` : ''
  const resting = view.nextIn !== null
  return (
    <div className="td-wave td-chip">
      <div className="td-wave-main">
        <strong>{view.wave === 0 ? '準備中' : `第 ${view.wave}${total} 波`}</strong>
        {resting ? (
          <span className="td-wave-timer">
            下一波 <Countdown ms={view.nextIn} stamp={view} />
          </span>
        ) : (
          <span className="muted">進攻中</span>
        )}
      </div>
      <div className="td-next" title="下一波會出現的怪物">
        <span className="muted">下一波</span>
        {view.next.map(([kind, count], i) => {
          const m = spec.monsters[kind]
          return (
            <span key={i} className="td-next-item" title={m ? `${m.name}：${m.blurb}` : undefined}>
              <span aria-hidden="true">{m ? MONSTER_LOOK[m.id].icon : '?'}</span>
              <span className="sr-only">{m?.name}</span>×{count}
            </span>
          )
        })}
      </div>
      {canAct && (
        <button
          type="button"
          className={ready ? 'td-ready on' : 'td-ready'}
          aria-pressed={ready}
          onClick={() => onReady(!ready)}
          title="大家都準備好了，下一波就馬上開始（空白鍵）"
        >
          {ready ? '✓ 等其他人' : resting ? '準備好了' : '提早叫下一波'}
          {readyTotal > 1 && (
            <small>
              {readyCount}/{readyTotal}
            </small>
          )}
        </button>
      )}
    </div>
  )
}

/** 最下面一排：七種塔。選了空格的時候按一下直接蓋在那一格 */
export function Shop({
  spec,
  view,
  stats,
  seat,
  kind,
  onPick,
  disabled,
}: {
  spec: Spec
  view: TdView
  stats: StatsStore
  seat: number | null
  kind: TowerId | null
  onPick: (kind: TowerId) => void
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
            disabled={disabled}
            onClick={() => onPick(t.id)}
            title={`${t.name}（${i + 1}）：${t.blurb}`}
          >
            <span className="td-shop-icon" aria-hidden="true">
              {look.icon}
            </span>
            <span className="td-shop-name">{t.name}</span>
            <span className="td-shop-cost">{cost}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 選了一種塔（或選了一個空格）時的說明 */
export function BuildInfo({ tower, hint, onCancel }: { tower: TowerSpec | null; hint: string; onCancel: () => void }) {
  return (
    <div className="td-info td-chip">
      <div className="td-info-head">
        {tower ? (
          <>
            <strong>
              <span aria-hidden="true">{TOWER_LOOK[tower.id].icon}</span> {tower.name}
            </strong>
            <span className="chip subtle">{reachText(tower)}</span>
          </>
        ) : (
          <strong>選一種塔</strong>
        )}
        <button type="button" className="td-x" onClick={onCancel} aria-label="取消" title="取消（Esc）">
          ×
        </button>
      </div>
      {tower && <p>{tower.blurb}</p>}
      {tower && <p className="td-info-stats">{levelText(tower, tower.levels[0])}</p>}
      <p className="muted">{hint}</p>
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
    <div className="td-info td-chip td-tower" style={seatColor(tower.owner)}>
      <div className="td-info-head">
        <strong>
          <span aria-hidden="true">{TOWER_LOOK[t.id].icon}</span> {t.name}
          <span className="td-level">Lv {tower.level}</span>
        </strong>
        <span className="td-owner">{ownerName}</span>
        <button type="button" className="td-x" onClick={onClose} aria-label="關閉" title="關閉（Esc）">
          ×
        </button>
      </div>
      <p className="td-info-stats">{levelText(t, level)}</p>
      {next && <p className="muted">升級後：{levelText(t, next)}</p>}
      <div className="td-actions">
        {next ? (
          <button type="button" disabled={!canUpgrade || gold < next.cost} onClick={onUpgrade} title="升級（U）">
            升級 <span className="td-cost">{next.cost}</span>
          </button>
        ) : (
          <span className="chip subtle">已經最高級</span>
        )}
        {canManage && (
          <button type="button" className="secondary" onClick={onSell} title="拆掉（X）">
            拆掉 <span className="td-cost">+{refund}</span>
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
              <span title="錢">🪙 {goldOf(view, s, seat)}</span>
              {versus && <span title="生命">❤ {lives}</span>}
              {versus && <span title="每波收入">+{p.income}</span>}
              <span title="擊倒">⚔ {s.kills[seat] ?? p.kills}</span>
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
                  🎯{aim === seat ? ' 鎖定' : target === seat ? ' 目標' : ''}
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
              <span className="td-shop-icon" aria-hidden="true">
                {MONSTER_LOOK[m.id].icon}
              </span>
              <span>
                {m.name}×{u.count}
              </span>
              {locked ? (
                <small>第 {u.unlock} 波解鎖</small>
              ) : (
                <small>
                  <span className="td-cost">{u.cost}</span>・收入 +{u.income}
                </small>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
