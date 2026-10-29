import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { GameLayout, Segmented, StatusLine, Toolbar } from '../shared/ui'
import { COMPUTER_AVERAGE, TOTAL, poolAfter, validFeedback, type Clue } from './logic'
import { useAbWorker } from './useAbWorker'

const DIGITS = [0, 1, 2, 3, 4]
const THINK_MS = 300

/** 電腦猜：玩家心中想一組數字，回報每次猜測的 A／B */
export function ComputerGuess({ modeSwitch }: { modeSwitch: ReactNode }) {
  const [started, setStarted] = useState(false)
  const [clues, setClues] = useState<Clue[]>([])
  // 每次改動紀錄就換版本；電腦的猜測標上它對應的版本，過期的直接作廢
  const [version, setVersion] = useState(0)
  const [next, setNext] = useState<{ version: number; guess: string | null } | null>(null)
  const [a, setA] = useState<number | null>(null)
  const [b, setB] = useState<number | null>(null)
  const request = useAbWorker()

  const pool = useMemo(() => poolAfter(clues), [clues])
  const won = clues.length > 0 && clues[clues.length - 1].a === 4
  const contradiction = pool.length === 0
  const guess = next && next.version === version ? next.guess : null
  const thinking = started && !won && !contradiction && !guess

  useEffect(() => {
    if (!started || won || contradiction || (next && next.version === version)) return
    let cancelled = false
    const begin = performance.now()
    request({ type: 'next', clues }).then((res) => {
      const wait = Math.max(0, THINK_MS - (performance.now() - begin))
      setTimeout(() => {
        if (!cancelled) setNext({ version, guess: res.guess })
      }, wait)
    })
    return () => {
      cancelled = true
    }
  }, [started, won, contradiction, next, version, clues, request])

  function report() {
    if (!guess || a === null || b === null || !validFeedback(a, b)) return
    setClues([...clues, { guess, a, b }])
    setVersion(version + 1)
    setA(null)
    setB(null)
  }

  /** 撤銷上一筆：電腦回到那一步的猜測，讓玩家重新回報 */
  function undo() {
    const last = clues[clues.length - 1]
    if (!last) return
    setClues(clues.slice(0, -1))
    setVersion(version + 1)
    setNext({ version: version + 1, guess: last.guess })
    setA(last.a)
    setB(last.b)
  }

  function restart() {
    setClues([])
    setVersion(version + 1)
    setNext(null)
    setA(null)
    setB(null)
    setStarted(false)
  }

  function pickA(value: number) {
    setA(value)
    if (value === 4) setB(0)
    else if (b !== null && !validFeedback(value, b)) setB(null)
  }

  let status: ReactNode
  if (!started) status = <StatusLine>在心中想好一組四位不重複的數字</StatusLine>
  else if (won) status = <StatusLine tone="ok">電腦猜中了！共用了 {clues.length} 次</StatusLine>
  else if (contradiction) status = <StatusLine tone="danger">你的回答前後矛盾，沒有任何數字符合所有回報</StatusLine>
  else if (thinking) status = <StatusLine tone="accent">電腦思考中…</StatusLine>
  else status = <StatusLine>第 {clues.length + 1} 次：電腦猜</StatusLine>

  const side = (
    <div className="card ab-info">
      <h3>剩餘可能</h3>
      <p className="ab-big">{started ? pool.length : TOTAL}</p>
      <p className="muted">
        電腦每次從全部 {TOTAL} 組中，挑出「猜完後平均剩下最少可能」的組合（同分時優先挑可能是答案的）， 平均約{' '}
        {COMPUTER_AVERAGE} 次猜中，最多 7 次。
      </p>
    </div>
  )

  return (
    <GameLayout side={side}>
      {modeSwitch}
      {status}

      {!started ? (
        <div className="card ab-intro">
          <p>想好之後不用輸入，按「開始」讓電腦猜。每次電腦猜一組數字，你告訴它幾 A 幾 B：</p>
          <ul>
            <li>A：數字和位置都對</li>
            <li>B：數字對但位置錯</li>
          </ul>
          <button type="button" onClick={() => setStarted(true)}>
            開始
          </button>
        </div>
      ) : (
        <>
          <div className={`ab-slots${thinking ? ' thinking' : ''}`} aria-label="電腦的猜測">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="ab-slot">
                {guess?.[i] ?? '?'}
              </span>
            ))}
          </div>

          {!won && !contradiction && (
            <div className="ab-report">
              <Segmented
                label="A（數字、位置都對）"
                value={a ?? -1}
                options={DIGITS.map((n) => ({ value: n, label: String(n) }))}
                onChange={pickA}
                disabled={!guess}
              />
              <Segmented
                label="B（數字對、位置錯）"
                value={b ?? -1}
                options={DIGITS.map((n) => ({
                  value: n,
                  label: String(n),
                  disabled: a !== null && !validFeedback(a, n),
                }))}
                onChange={setB}
                disabled={!guess || a === null}
              />
              <button
                type="button"
                disabled={!guess || a === null || b === null || !validFeedback(a, b)}
                onClick={report}
              >
                回報 {a ?? '?'}A{b ?? '?'}B
              </button>
            </div>
          )}

          {contradiction && (
            <p className="muted">
              可能是某一次的 A 或 B 算錯了。檢查下面的紀錄，按「修改上一次回答」重新回報，或一路撤銷到有問題的那一步。
            </p>
          )}

          <Toolbar>
            <button type="button" className="secondary" disabled={!clues.length} onClick={undo}>
              {contradiction ? '修改上一次回答' : '撤銷上一筆回報'}
            </button>
            <button type="button" className="secondary" onClick={restart}>
              重新開始
            </button>
          </Toolbar>

          {clues.length > 0 && (
            <table className="ab-history">
              <thead>
                <tr>
                  <th>#</th>
                  <th>電腦猜</th>
                  <th>你的回報</th>
                </tr>
              </thead>
              <tbody>
                {clues.map((c, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td className="ab-code">{c.guess}</td>
                    <td className={c.a === 4 ? 'ab-win' : ''}>
                      {c.a}A{c.b}B
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </GameLayout>
  )
}
