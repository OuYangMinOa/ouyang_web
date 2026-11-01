import { useId, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { cellAt, COLS, landingRow, ROWS, type Disc } from './rules'

export type Ghost = { col: number; color: Disc; kind: 'pending' | 'hover' }

const R_DISC = 0.4
const R_HOLE = 0.42
const CELLS = Array.from({ length: ROWS * COLS }, (_, p) => p)

/** 第 p 格的圓心：最上面留一列給預覽（還沒投下的棋子），所以棋盤從 y = 1 開始 */
function xy(p: number) {
  return { x: (p % COLS) + 0.5, y: Math.floor(p / COLS) + 1.5 }
}

/**
 * 7 × 6 的直立棋盤（SVG，每格 1 單位，上面多一列預覽）。
 * 棋子畫在棋盤後面，棋盤用 mask 挖洞，落下的動畫看起來就像從洞裡滑下去。點擊或觸控換算成欄位。
 */
export function Connect4Board({
  board,
  last,
  dropKey,
  line,
  ghost,
  interactive,
  onPick,
  onHover,
  onKeyDown,
}: {
  board: Int8Array
  /** 最後一手的格子：標記並播放落下動畫 */
  last: number | null
  /** 最後一手變了（例如悔棋後又下同一格）就要重播動畫 */
  dropKey: number
  line: number[] | null
  ghost: Ghost | null
  interactive: boolean
  onPick: (col: number) => void
  onHover: (col: number | null) => void
  onKeyDown?: (e: KeyboardEvent<SVGSVGElement>) => void
}) {
  const maskId = `c4-holes-${useId()}`

  function colAt(e: { clientX: number; currentTarget: Element }): number {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.min(COLS - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * COLS)))
  }

  const winning = new Set(line ?? [])
  const discs = CELLS.filter((p) => board[p] !== 0)
  const count = discs.length

  let landing = -1
  if (ghost) {
    const row = landingRow(board, ghost.col)
    if (row >= 0) landing = cellAt(row, ghost.col)
  }

  return (
    <svg
      className={`c4-board${interactive ? ' interactive' : ''}`}
      viewBox={`0 0 ${COLS} ${ROWS + 1}`}
      role="img"
      aria-label={`四子棋棋盤，已下 ${count} 手`}
      tabIndex={interactive ? 0 : -1}
      onClick={(e) => interactive && onPick(colAt(e))}
      onPointerMove={(e: PointerEvent<SVGSVGElement>) => interactive && e.pointerType === 'mouse' && onHover(colAt(e))}
      onPointerLeave={() => onHover(null)}
      onKeyDown={onKeyDown}
    >
      <defs>
        <mask id={maskId}>
          <rect x={0} y={1} width={COLS} height={ROWS} fill="white" />
          {CELLS.map((p) => (
            <circle key={p} cx={xy(p).x} cy={xy(p).y} r={R_HOLE} fill="black" />
          ))}
        </mask>
      </defs>

      {discs.map((p) => {
        const dropping = p === last
        const style = dropping ? ({ '--drop': Math.floor(p / COLS) + 1 } as CSSProperties) : undefined
        let cls = `c4-disc ${board[p] === 1 ? 'red' : 'yellow'}`
        if (dropping) cls += ' dropping'
        if (line && !winning.has(p)) cls += ' dim'
        return (
          <g key={dropping ? `d${p}-${dropKey}` : `d${p}`} className={cls} style={style}>
            <circle cx={xy(p).x} cy={xy(p).y} r={R_DISC} />
            <circle className="c4-disc-inner" cx={xy(p).x} cy={xy(p).y} r={R_DISC * 0.68} />
          </g>
        )
      })}

      <rect className="c4-frame" x={0} y={1} width={COLS} height={ROWS} rx={0.3} mask={`url(#${maskId})`} />
      {CELLS.map((p) => (
        <circle key={`h${p}`} className="c4-rim" cx={xy(p).x} cy={xy(p).y} r={R_HOLE} />
      ))}

      {line?.map((p) => (
        <circle key={`w${p}`} className="c4-win" cx={xy(p).x} cy={xy(p).y} r={R_DISC} />
      ))}
      {last !== null && !winning.has(last) && board[last] !== 0 && (
        <circle className="c4-last" cx={xy(last).x} cy={xy(last).y} r={0.1} />
      )}

      {ghost && landing >= 0 && (
        <>
          <g className={`c4-disc ${ghost.color === 1 ? 'red' : 'yellow'} ghost ${ghost.kind}`}>
            <circle cx={ghost.col + 0.5} cy={0.5} r={R_DISC} />
          </g>
          <circle className={`c4-landing ${ghost.kind}`} cx={xy(landing).x} cy={xy(landing).y} r={R_DISC * 0.92} />
        </>
      )}
    </svg>
  )
}
