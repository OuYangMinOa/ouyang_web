import { COL_LABELS, cellName, CELLS, shipCells, SIZE, type Placement, type ShotResult } from './rules'

export type Mark = ShotResult | 'pending' | null
export type Ghost = { cells: number[]; ok: boolean }
/** 要畫出來的船：sunk 是被擊沉的，faint 是結束後才公開、沒被打沉的 */
export type DrawnShip = Placement & { state?: 'sunk' | 'faint' | 'selected' }

type ShipPart = { ship: DrawnShip; index: number; len: number }

const ROWS = Array.from({ length: SIZE }, (_, i) => i)

function markLabel(mark: Mark): string {
  if (mark === 'miss') return '沒打中'
  if (mark === 'hit') return '擊中'
  if (mark === 'sunk') return '擊沉'
  if (mark === 'pending') return '等待回報'
  return ''
}

/**
 * 10×10 的海域（每格一個按鈕，鍵盤和讀螢幕軟體都能用）。
 * 船畫成連續的一條：船頭、船身、船尾各有不同的圓角；開砲的結果疊在上面。
 */
export function Grid({
  label,
  ships,
  marks,
  fresh,
  ghost,
  canPick,
  onPick,
  onHover,
}: {
  label: string
  ships: DrawnShip[]
  marks: Mark[]
  /** 剛打的那一格，播放水花或爆炸的動畫 */
  fresh: number | null
  ghost?: Ghost | null
  canPick: (cell: number) => boolean
  onPick: (cell: number) => void
  onHover?: (cell: number | null) => void
}) {
  const parts = new Map<number, ShipPart>()
  for (const ship of ships) {
    const cells = shipCells(ship) ?? []
    cells.forEach((c, index) => parts.set(c, { ship, index, len: cells.length }))
  }
  const ghostCells = new Set(ghost?.cells ?? [])
  const anyPick = Array.from({ length: CELLS }, (_, c) => c).some(canPick)

  return (
    <div
      className={`bs-grid${anyPick ? ' live' : ''}`}
      role="group"
      aria-label={label}
      onPointerLeave={() => onHover?.(null)}
    >
      <span className="bs-corner" aria-hidden="true" />
      {COL_LABELS.map((c) => (
        <span key={c} className="bs-label" aria-hidden="true">
          {c}
        </span>
      ))}
      {ROWS.map((row) => (
        <Row
          key={row}
          row={row}
          parts={parts}
          marks={marks}
          fresh={fresh}
          ghostCells={ghostCells}
          ghostOk={ghost?.ok ?? true}
          canPick={canPick}
          onPick={onPick}
          onHover={onHover}
        />
      ))}
    </div>
  )
}

function Row({
  row,
  parts,
  marks,
  fresh,
  ghostCells,
  ghostOk,
  canPick,
  onPick,
  onHover,
}: {
  row: number
  parts: Map<number, ShipPart>
  marks: Mark[]
  fresh: number | null
  ghostCells: Set<number>
  ghostOk: boolean
  canPick: (cell: number) => boolean
  onPick: (cell: number) => void
  onHover?: (cell: number | null) => void
}) {
  return (
    <>
      <span className="bs-label" aria-hidden="true">
        {row + 1}
      </span>
      {ROWS.map((col) => {
        const cell = row * SIZE + col
        const part = parts.get(cell)
        const mark = marks[cell]
        const pickable = canPick(cell)
        const classes = ['bs-cell']
        if (part) {
          classes.push('ship', part.ship.vertical ? 'v' : 'h')
          if (part.index === 0) classes.push('bow')
          if (part.index === part.len - 1) classes.push('stern')
          if (part.ship.state) classes.push(part.ship.state)
        }
        if (mark) classes.push(mark)
        if (fresh === cell && mark) classes.push('fresh')
        if (ghostCells.has(cell)) classes.push(ghostOk ? 'ghost' : 'ghost bad')
        if (pickable) classes.push('pick')
        const desc = [part ? '有船' : '', markLabel(mark)].filter(Boolean).join('、') || '未知'
        return (
          <button
            key={col}
            type="button"
            className={classes.join(' ')}
            aria-label={`${cellName(cell)}：${desc}`}
            aria-disabled={!pickable}
            tabIndex={pickable ? 0 : -1}
            onClick={() => pickable && onPick(cell)}
            onPointerEnter={(e) => e.pointerType === 'mouse' && onHover?.(cell)}
          >
            {mark && <span className="bs-mark" aria-hidden="true" />}
          </button>
        )
      })}
    </>
  )
}
