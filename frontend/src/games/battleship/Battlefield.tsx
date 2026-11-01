import { useState } from 'react'
import { Grid, type DrawnShip, type Mark } from './Grid'
import { CELLS, FLEET, other, shipCells, shotsOn, stats, type Battle, type Layout, type Side } from './rules'

type Board = 'enemy' | 'mine'

/** side 這一方海域上每一格的開砲結果；沉船的每一格都標成擊沉 */
function marksOn(battle: Battle, side: Side): Mark[] {
  const marks: Mark[] = Array.from({ length: CELLS }, () => null)
  for (const s of shotsOn(battle, side)) marks[s.cell] = s.result ?? 'pending'
  for (const ship of battle.sunk[side]) for (const c of shipCells(ship) ?? []) marks[c] = 'sunk'
  return marks
}

function freshOn(battle: Battle, side: Side): number | null {
  const last = battle.shots.at(-1)
  return last && last.by !== side ? last.cell : null
}

/**
 * 對戰中的兩片海域。寬的時候並排；窄的時候一大一小：輪到自己（或剛打完、對手還沒動）時放大敵方海域，
 * 對手開砲時放大自己的海域，看得到砲彈落在哪裡。點小的那片可以手動交換，到下一砲為止。
 */
export function Battlefield({
  battle,
  me,
  myLayout,
  enemyLayout,
  canShoot,
  onShoot,
  titles = ['敵方海域', '我方海域'],
}: {
  battle: Battle
  me: Side
  myLayout: Layout | null
  /** 對方公開（或本地已知）的佈局；結束後才畫出來 */
  enemyLayout: Layout | null
  canShoot: boolean
  onShoot: (cell: number) => void
  titles?: [string, string]
}) {
  const enemy = other(me)
  const last = battle.shots.at(-1)
  const over = battle.phase === 'over'
  const auto: Board = over || battle.toMove === me || last?.by === me ? 'enemy' : 'mine'
  const turnKey = `${battle.round}:${battle.shots.length}:${battle.phase}`
  const [manual, setManual] = useState<{ key: string; board: Board } | null>(null)
  const primary = manual?.key === turnKey ? manual.board : auto

  const enemyMarks = marksOn(battle, enemy)
  const myMarks = marksOn(battle, me)
  const shotAt = new Set(shotsOn(battle, enemy).map((s) => s.cell))

  const sunkIds = (side: Side) => new Set(battle.sunk[side].map((p) => p.id))
  const enemySunk = sunkIds(enemy)
  const mySunk = sunkIds(me)
  const enemyShips: DrawnShip[] = battle.sunk[enemy].map((p) => ({ ...p, state: 'sunk' }))
  if (over && enemyLayout) {
    for (const p of enemyLayout) if (!enemySunk.has(p.id)) enemyShips.push({ ...p, state: 'faint' })
  }
  const myShips: DrawnShip[] = (myLayout ?? battle.sunk[me]).map((p) => ({
    ...p,
    state: mySunk.has(p.id) ? 'sunk' : undefined,
  }))

  const board = (which: Board) => {
    const isEnemy = which === 'enemy'
    const isPrimary = primary === which
    const title = isEnemy ? titles[0] : titles[1]
    return (
      <section className={`bs-board ${which} ${isPrimary ? 'primary' : 'secondary'}`} aria-label={title}>
        <header className="bs-board-head">
          <h2>{title}</h2>
          {!isPrimary && (
            <button
              type="button"
              className="secondary bs-swap"
              onClick={() => setManual({ key: turnKey, board: which })}
            >
              放大
            </button>
          )}
        </header>
        <Grid
          label={title}
          ships={isEnemy ? enemyShips : myShips}
          marks={isEnemy ? enemyMarks : myMarks}
          fresh={freshOn(battle, isEnemy ? enemy : me)}
          canPick={(cell) => isEnemy && canShoot && !shotAt.has(cell)}
          onPick={onShoot}
        />
      </section>
    )
  }

  return (
    <div className="bs-field">
      <div className={`bs-play${canShoot ? ' my-turn' : ''}`}>
        {board('enemy')}
        {board('mine')}
      </div>
    </div>
  )
}

/** 側邊欄：雙方艦隊還剩哪些、開砲統計 */
export function FleetPanel({ battle, me, names }: { battle: Battle; me: Side; names: [string, string] }) {
  const sides: Side[] = [other(me), me]
  return (
    <div className="bs-fleets">
      {sides.map((side) => {
        const sunk = new Set(battle.sunk[side].map((p) => p.id))
        const shooter = other(side)
        const { shots, hits } = stats(battle, shooter)
        return (
          <div key={side} className="bs-fleet">
            <h3>
              {names[side]}的艦隊
              <span className="muted">剩 {FLEET.length - sunk.size} 艘</span>
            </h3>
            <ul>
              {FLEET.map((s) => (
                <li key={s.id} className={sunk.has(s.id) ? 'sunk' : ''}>
                  <span>{s.name}</span>
                  <span className="bs-ship-size" aria-label={`${s.len} 格${sunk.has(s.id) ? '，已擊沉' : ''}`}>
                    {'■'.repeat(s.len)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted bs-stat">
              {names[shooter]}開砲 {shots} 次，命中 {hits} 次{shots > 0 && `（${Math.round((hits / shots) * 100)}%）`}
            </p>
          </div>
        )
      })}
    </div>
  )
}
