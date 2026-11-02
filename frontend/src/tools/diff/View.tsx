import { Fragment, useState, type ReactNode } from 'react'
import type { DiffResult, Part, Row } from './engine'

export type Layout = 'side' | 'unified'

/** 相同的行前後各留幾行，其餘摺起來 */
const CONTEXT = 3

const NONE: ReadonlySet<number> = new Set()

type Item = Row | { kind: 'fold'; start: number; rows: Row[] }

function fold(rows: Row[]): Item[] {
  const out: Item[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind !== 'eq') {
      out.push(rows[i++])
      continue
    }
    let e = i
    while (e < rows.length && rows[e].kind === 'eq') e++
    const head = i === 0 ? 0 : CONTEXT
    const tail = e === rows.length ? 0 : CONTEXT
    if (e - i > head + tail + 1) {
      out.push(...rows.slice(i, i + head))
      out.push({ kind: 'fold', start: i + head, rows: rows.slice(i + head, e - tail) })
      out.push(...rows.slice(e - tail, e))
    } else out.push(...rows.slice(i, e))
    i = e
  }
  return out
}

/** 行內比對：只畫某一邊（a 是左邊／原文，b 是右邊／修改後） */
function Inline({ parts, side }: { parts: Part[]; side: 'a' | 'b' }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === 'eq') return <Fragment key={i}>{p[side]}</Fragment>
        if (side === 'a' && p.type === 'del') return <del key={i}>{p.a}</del>
        if (side === 'b' && p.type === 'ins') return <ins key={i}>{p.b}</ins>
        return null
      })}
    </>
  )
}

/** 合併檢視的逐字結果：刪除和新增穿插在同一段文字裡 */
function Merged({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.type === 'eq' ? <Fragment key={i}>{p.b}</Fragment> : p.type === 'del' ? <del key={i}>{p.a}</del> : <ins key={i}>{p.b}</ins>,
      )}
    </>
  )
}

type Cell = { no: number; cls: string; content: ReactNode } | null

/** 左右並排：刪除和新增的行盡量排在同一列 */
function sideRows(rows: Row[]): [Cell, Cell][] {
  const out: [Cell, Cell][] = []
  let i = 0
  while (i < rows.length) {
    const r = rows[i]
    if (r.kind === 'eq') {
      out.push([
        { no: r.aNo, cls: '', content: r.a },
        { no: r.bNo, cls: '', content: r.b },
      ])
      i++
    } else if (r.kind === 'mod') {
      out.push([
        { no: r.aNo, cls: 'del', content: <Inline parts={r.parts} side="a" /> },
        { no: r.bNo, cls: 'ins', content: <Inline parts={r.parts} side="b" /> },
      ])
      i++
    } else {
      const dels: Cell[] = []
      const inss: Cell[] = []
      while (i < rows.length && rows[i].kind === 'del') {
        const d = rows[i++] as Extract<Row, { kind: 'del' }>
        dels.push({ no: d.aNo, cls: 'del', content: d.a })
      }
      while (i < rows.length && rows[i].kind === 'ins') {
        const d = rows[i++] as Extract<Row, { kind: 'ins' }>
        inss.push({ no: d.bNo, cls: 'ins', content: d.b })
      }
      for (let k = 0; k < Math.max(dels.length, inss.length); k++) out.push([dels[k] ?? null, inss[k] ?? null])
    }
  }
  return out
}

function SideCells({ cells }: { cells: [Cell, Cell] }) {
  return (
    <>
      {cells.map((c, k) =>
        c ? (
          <Fragment key={k}>
            <span className={`dif-no ${c.cls}`}>{c.no}</span>
            <span className={`dif-text ${c.cls}${k === 0 ? ' dif-left' : ''}`}>{c.content}</span>
          </Fragment>
        ) : (
          <span key={k} className={`dif-empty${k === 0 ? ' dif-left' : ''}`} />
        ),
      )}
    </>
  )
}

function UnifiedRow({ row }: { row: Row }) {
  const line = (a: number | '', b: number | '', sign: string, cls: string, content: ReactNode) => (
    <>
      <span className={`dif-no ${cls}`}>{a}</span>
      <span className={`dif-no ${cls}`}>{b}</span>
      <span className={`dif-sign ${cls}`} aria-hidden="true">
        {sign}
      </span>
      <span className={`dif-text ${cls}`}>{content}</span>
    </>
  )
  switch (row.kind) {
    case 'eq':
      return line(row.aNo, row.bNo, '', '', row.b)
    case 'del':
      return line(row.aNo, '', '−', 'del', row.a)
    case 'ins':
      return line('', row.bNo, '+', 'ins', row.b)
    case 'mod':
      return (
        <>
          {line(row.aNo, '', '−', 'del', <Inline parts={row.parts} side="a" />)}
          {line('', row.bNo, '+', 'ins', <Inline parts={row.parts} side="b" />)}
        </>
      )
  }
}

export default function DiffView({ result, layout }: { result: DiffResult; layout: Layout }) {
  // 展開過的摺疊段（以起始列標記）；只對產生它的那份結果有效，文字一改就全部收回
  const [expanded, setExpanded] = useState<{ of: DiffResult; starts: Set<number> } | null>(null)
  const open = expanded?.of === result ? expanded.starts : NONE

  if (result.kind === 'inline') {
    return layout === 'side' ? (
      <div className="dif-panes">
        <div className="dif-pane">
          <Inline parts={result.parts} side="a" />
        </div>
        <div className="dif-pane">
          <Inline parts={result.parts} side="b" />
        </div>
      </div>
    ) : (
      <div className="dif-pane">
        <Merged parts={result.parts} />
      </div>
    )
  }

  const items = fold(result.rows)
  const expand = (start: number) => setExpanded({ of: result, starts: new Set(open).add(start) })
  const renderRows = (rows: Row[]) =>
    layout === 'side'
      ? sideRows(rows).map((cells, i) => <SideCells key={i} cells={cells} />)
      : rows.map((r, i) => <UnifiedRow key={i} row={r} />)

  // 摺疊段把前後切開，各段分別排版，左右並排時刪除和新增才會對齊
  const blocks: ReactNode[] = []
  let pending: Row[] = []
  const flush = () => {
    if (pending.length) blocks.push(<Fragment key={`r${blocks.length}`}>{renderRows(pending)}</Fragment>)
    pending = []
  }
  for (const it of items) {
    if (it.kind !== 'fold') {
      pending.push(it)
    } else if (open.has(it.start)) {
      pending.push(...it.rows)
    } else {
      flush()
      blocks.push(
        <button key={`f${it.start}`} type="button" className="dif-fold" onClick={() => expand(it.start)}>
          ⋯ 展開 {it.rows.length.toLocaleString()} 行相同的內容
        </button>,
      )
    }
  }
  flush()

  return <div className={`dif-grid ${layout}`}>{blocks}</div>
}
