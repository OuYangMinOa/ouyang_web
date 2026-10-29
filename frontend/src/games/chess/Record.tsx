import { useEffect, useRef } from 'react'
import { BLACK, WHITE, type Color } from './engine'
import type { Played } from './game'
import { Piece } from './Piece'

// 計算子力差用的傳統分值
const POINTS = [0, 1, 3, 3, 5, 9, 0]

/** 雙方吃掉的棋子與子力差 */
export function Captures({ played, board }: { played: Played[]; board: Int8Array }) {
  let balance = 0
  for (const p of board) balance += Math.sign(p) * POINTS[Math.abs(p)]
  const row = (color: Color, label: string) => {
    const taken = played
      .filter((p) => p.color === color && p.captured)
      .map((p) => p.captured)
      .sort((a, b) => POINTS[Math.abs(b)] - POINTS[Math.abs(a)] || Math.abs(b) - Math.abs(a))
    const lead = balance * color
    return (
      <div className="chess-captures-row">
        <span className="chess-captures-label">{label}</span>
        <span className="chess-captures-pieces">
          {taken.length ? taken.map((p, i) => <Piece key={i} piece={p} />) : <span className="muted">—</span>}
        </span>
        {lead > 0 && <span className="chess-lead">+{lead}</span>}
      </div>
    )
  }
  return (
    <div className="chess-captures">
      {row(WHITE, '白方吃')}
      {row(BLACK, '黑方吃')}
    </div>
  )
}

/** SAN 棋譜，每列一個回合 */
export function MoveList({ played }: { played: Played[] }) {
  const ref = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [played.length])

  if (!played.length) return <p className="muted chess-moves-empty">還沒有棋步</p>
  const rows: Played[][] = []
  for (let i = 0; i < played.length; i += 2) rows.push(played.slice(i, i + 2))
  const last = played.length - 1
  return (
    <ol className="chess-moves" ref={ref}>
      {rows.map((pair, i) => (
        <li key={i}>
          <span className="chess-move-no">{i + 1}.</span>
          {pair.map((p, j) => (
            <span key={j} className={i * 2 + j === last ? 'chess-move current' : 'chess-move'}>
              {p.san}
            </span>
          ))}
        </li>
      ))}
    </ol>
  )
}
