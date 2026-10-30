import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { entryColor, load, parsePrizes, randInt, reducedMotion, save, shuffle, type Entry } from './pool'

const MIN_COL = 52
const ROW_H = 26
const PAD = 14
const BLANK = '銘謝惠顧'
const DEFAULT_PRIZES = '頭獎\n二獎\n三獎'

type Game = {
  /** 哪些格子之間有橫線：rungs[列][欄] 代表第 欄 和第 欄+1 條線在這一列相連 */
  rungs: boolean[][]
  /** 底下第 i 格的獎項 */
  prizes: string[]
  /** 獎項比人多時，有幾個沒用到 */
  unused: number
  /** 名單和獎項變了就重新產生 */
  sig: string
}

function makeGame(n: number, list: string[], sig: string): Game {
  const picked = list.length > n ? shuffle(list).slice(0, n) : list
  const prizes = shuffle([...picked, ...Array.from({ length: Math.max(0, n - picked.length) }, () => BLANK)])
  const rows = Math.min(28, Math.max(10, n * 2 + 4))
  const rungs = Array.from({ length: rows }, () => Array<boolean>(Math.max(0, n - 1)).fill(false))
  for (const row of rungs) {
    for (let c = 0; c < n - 1; c++) {
      // 同一列相鄰的兩條橫線不能接在一起，否則會分岔
      if (!row[c - 1] && randInt(100) < 42) row[c] = true
    }
  }
  // 每兩條線之間至少要有一條橫線
  for (let c = 0; c < n - 1; c++) {
    if (rungs.some((row) => row[c])) continue
    const free = rungs.filter((row) => !row[c - 1] && !row[c + 1])
    if (free.length) free[randInt(free.length)][c] = true
  }
  return { rungs, prizes, unused: Math.max(0, list.length - n), sig }
}

/** 從第 start 條線頂端往下走，回傳經過的點與最後落在第幾格 */
function walk(rungs: boolean[][], start: number, colX: (c: number) => number, height: number) {
  let c = start
  const pts: [number, number][] = [[colX(c), 0]]
  rungs.forEach((row, r) => {
    const y = PAD + (r + 0.5) * ROW_H
    if (row[c]) {
      pts.push([colX(c), y], [colX(c + 1), y])
      c++
    } else if (c > 0 && row[c - 1]) {
      pts.push([colX(c), y], [colX(c - 1), y])
      c--
    }
  })
  pts.push([colX(c), height])
  return { pts, end: c }
}

const isText = (v: unknown): v is string => typeof v === 'string'

export default function Ladder({ entries, onBusy, onDone }: { entries: Entry[]; onBusy: (busy: boolean) => void; onDone: (lines: string[]) => void }) {
  const [prizeText, setPrizeText] = useState(() => load('prizes', DEFAULT_PRIZES, isText))
  const prizeList = parsePrizes(prizeText)
  const n = entries.length
  const sig = `${entries.map((e) => e.name).join('\n')}\u0000${prizeList.join('\n')}`

  const [game, setGame] = useState(() => makeGame(n, prizeList, sig))
  /** 每個人（頂端第幾條線）的狀態：走線中或已揭曉 */
  const [traced, setTraced] = useState<Record<number, 'run' | 'done'>>({})
  /** 突顯哪個人的線；其他人的線變淡，全部揭曉後才看得清楚 */
  const [focus, setFocus] = useState<number | null>(null)
  const [width, setWidth] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  /** 哪一張梯子已經記過紀錄 */
  const reportedFor = useRef<Game | null>(null)

  // 名單或獎項改了：重畫一張新的梯子
  if (game.sig !== sig) {
    setGame(makeGame(n, prizeList, sig))
    setTraced({})
    setFocus(null)
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const running = Object.values(traced).includes('run')
  useEffect(() => onBusy(running), [running, onBusy])

  const colW = Math.max(MIN_COL, n ? width / n : 0)
  const totalW = colW * n
  const height = PAD * 2 + game.rungs.length * ROW_H
  const colX = (c: number) => (c + 0.5) * colW
  const paths = entries.map((_, i) => walk(game.rungs, i, colX, height))
  /** 底下第 c 格是誰走到的 */
  const owner = new Map(paths.map((p, i) => [p.end, i]))
  const doneCount = Object.values(traced).filter((s) => s === 'done').length

  // 全部揭曉後記一筆紀錄（同一張梯子只記一次）
  useEffect(() => {
    if (n < 2 || doneCount < n || reportedFor.current === game) return
    reportedFor.current = game
    onDone(entries.map((e, i) => `${e.name} → ${game.prizes[paths[i].end]}`))
  })

  function run(i: number, delay = 0) {
    const steps = paths[i].pts.length
    const ms = reducedMotion() ? 0 : 900 + steps * 60
    timers.current.push(
      setTimeout(() => {
        setFocus(i)
        setTraced((t) => ({ ...t, [i]: 'run' }))
        timers.current.push(setTimeout(() => setTraced((t) => ({ ...t, [i]: 'done' })), ms))
      }, delay),
    )
  }

  function revealAll() {
    const todo = entries.map((_, i) => i).filter((i) => !traced[i])
    todo.forEach((i, k) => run(i, reducedMotion() ? 0 : k * 350))
  }

  function regenerate() {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setGame(makeGame(n, prizeList, sig))
    setTraced({})
    setFocus(null)
  }

  function changePrizes(text: string) {
    setPrizeText(text)
    save('prizes', text)
  }

  return (
    <div className="lot-ladder">
      <label>
        獎項（一行一個，「二獎*2」代表兩份；不夠的格子是「{BLANK}」）
        <textarea rows={3} value={prizeText} onChange={(e) => changePrizes(e.target.value)} disabled={running} />
      </label>
      {game.unused > 0 && <p className="lot-warn">獎項比人多，隨機少放 {game.unused} 個。</p>}

      {n < 2 ? (
        <p className="muted">名單至少要兩個人。</p>
      ) : (
        <>
          <div className="lot-actions">
            <button type="button" onClick={revealAll} disabled={running || doneCount >= n}>
              全部揭曉
            </button>
            <button type="button" className="secondary" onClick={regenerate} disabled={running}>
              重新畫線
            </button>
          </div>
          <p className="muted">點上面的名字，看會走到哪一格；揭曉過的再點一次可以單獨看那條線。</p>

          <div className="lot-ladder-scroll" ref={scrollRef}>
            <div className="lot-ladder-board" style={{ width: totalW || undefined }}>
              <div className="lot-ladder-row">
                {entries.map((e, i) => (
                  <button
                    key={e.id}
                    type="button"
                    className={`lot-ladder-name${traced[i] ? ' picked' : ''}${focus === i ? ' focus' : ''}`}
                    style={{ width: colW, borderColor: entryColor(e.id) }}
                    onClick={() => (traced[i] ? setFocus(i) : run(i))}
                    disabled={traced[i] === 'run'}
                    aria-pressed={traced[i] ? focus === i : undefined}
                    title={e.name}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
              {width > 0 && (
                <svg width={totalW} height={height} viewBox={`0 0 ${totalW} ${height}`} className="lot-ladder-svg" aria-hidden="true">
                  {entries.map((_, c) => (
                    <line key={c} x1={colX(c)} y1={0} x2={colX(c)} y2={height} className="lot-ladder-pole" />
                  ))}
                  {game.rungs.map((row, r) =>
                    row.map((on, c) =>
                      on ? (
                        <line
                          key={`${r}-${c}`}
                          x1={colX(c)}
                          x2={colX(c + 1)}
                          y1={PAD + (r + 0.5) * ROW_H}
                          y2={PAD + (r + 0.5) * ROW_H}
                          className="lot-ladder-pole"
                        />
                      ) : null,
                    ),
                  )}
                  {entries.map((e, i) =>
                    traced[i] ? (
                      <polyline
                        key={`p${e.id}`}
                        points={paths[i].pts.map((p) => p.join(',')).join(' ')}
                        pathLength={1}
                        className={`lot-trace${traced[i] === 'run' ? ' drawing' : focus !== i ? ' faded' : ''}`}
                        style={{ stroke: entryColor(e.id), animationDuration: `${900 + paths[i].pts.length * 60}ms` }}
                      />
                    ) : null,
                  )}
                </svg>
              )}
              <div className="lot-ladder-row">
                {game.prizes.map((prize, c) => {
                  const who = owner.get(c)
                  const shown = who !== undefined && traced[who] === 'done'
                  return (
                    <div
                      key={c}
                      className={`lot-ladder-prize${shown ? ' shown' : ''}${shown && prize === BLANK ? ' blank' : ''}`}
                      style={{ width: colW, borderColor: shown ? entryColor(entries[who].id) : undefined }}
                      title={shown ? prize : undefined}
                    >
                      {shown ? prize : '?'}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {doneCount > 0 && (
            <ul className="lot-pairs" aria-live="polite">
              {entries.map((e, i) =>
                traced[i] === 'done' ? (
                  <li key={e.id}>
                    <span className="lot-dot" style={{ background: entryColor(e.id) }} aria-hidden="true" />
                    {e.name} <span className="muted">→</span> <strong className={game.prizes[paths[i].end] === BLANK ? 'muted' : ''}>{game.prizes[paths[i].end]}</strong>
                  </li>
                ) : null,
              )}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
