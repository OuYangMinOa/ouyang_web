import type { ReactNode } from 'react'

// 自己畫的簡潔棋子（100×100），顏色全部交給 CSS 變數，亮暗主題都清楚

const BASE = <rect x="22" y="78" width="56" height="12" rx="4" />

const SHAPES: Record<number, ReactNode> = {
  1: (
    <>
      <path d="M36 80 C38 64 43 56 44 50 H56 C57 56 62 64 64 80 Z" />
      <rect x="38" y="44" width="24" height="7" rx="3" />
      <circle cx="50" cy="31" r="12" />
      {BASE}
    </>
  ),
  2: (
    <>
      <path d="M33 80 C32 66 38 58 44 52 L40 50 C32 54 25 52 23 46 C22 40 32 30 38 24 L40 13 L48 21 C62 22 72 36 70 56 C69 66 67 74 67 80 Z" />
      <circle className="chess-detail" cx="40" cy="33" r="2.5" />
      {BASE}
    </>
  ),
  3: (
    <>
      <path d="M41 70 L36 80 H64 L59 70 Z" />
      <rect x="37" y="63" width="26" height="8" rx="3" />
      <path d="M50 21 C37 31 34 46 40 63 H60 C66 46 63 31 50 21 Z" />
      <path className="chess-detail" d="M50 46 L58 34" fill="none" />
      <circle cx="50" cy="15" r="6" />
      {BASE}
    </>
  ),
  4: (
    <>
      <path d="M36 80 L38 46 H62 L64 80 Z" />
      <path d="M29 18 H38 V26 H45 V18 H55 V26 H62 V18 H71 V38 L64 46 H36 L29 38 Z" />
      {BASE}
    </>
  ),
  5: (
    <>
      <path d="M33 72 L25 33 L37 52 L38 27 L46 49 L50 22 L54 49 L62 27 L63 52 L75 33 L67 72 Z" />
      <rect x="31" y="70" width="38" height="9" rx="3" />
      <circle cx="25" cy="30" r="5" />
      <circle cx="38" cy="23" r="5" />
      <circle cx="50" cy="17" r="5" />
      <circle cx="62" cy="23" r="5" />
      <circle cx="75" cy="30" r="5" />
      {BASE}
    </>
  ),
  6: (
    <>
      <path d="M33 70 C22 56 24 38 38 38 C44 38 48 43 50 48 C52 43 56 38 62 38 C76 38 78 56 67 70 Z" />
      <rect x="31" y="68" width="38" height="11" rx="3" />
      <path d="M46 8 H54 V16 H62 V24 H54 V40 H46 V24 H38 V16 H46 Z" />
      {BASE}
    </>
  ),
}

/** piece：帶正負號的棋子（正數白方） */
export function Piece({ piece, className = '' }: { piece: number; className?: string }) {
  return (
    <svg
      className={`chess-piece ${piece > 0 ? 'white' : 'black'} ${className}`}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[Math.abs(piece)]}
    </svg>
  )
}
