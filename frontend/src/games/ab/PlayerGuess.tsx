import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { GameLayout, StatusLine, Toolbar } from '../shared/ui'
import { load, save } from '../shared/storage'
import { AnalysisView } from './AnalysisView'
import {
  CODES,
  TOTAL,
  allIndices,
  fbOf,
  filterPool,
  indexOf,
  randomCode,
  score,
  summarize,
  type Clue,
  type StepAnalysis,
} from './logic'
import { useAbWorker } from './useAbWorker'

type Status = 'playing' | 'won' | 'gaveup'

// 清單一開始只畫這麼多個，避免一次產生上千個按鈕
const PREVIEW = 120

/** 你猜：電腦出題 */
export function PlayerGuess({ modeSwitch }: { modeSwitch: ReactNode }) {
  const [answer, setAnswer] = useState(() => randomCode())
  const [clues, setClues] = useState<Clue[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('playing')
  const [hidePool, setHidePool] = useState(() => load('ab:hidePool', false))
  const [showAll, setShowAll] = useState(false)
  const [game, setGame] = useState(0)
  const [analysis, setAnalysis] = useState<{ game: number; steps: StepAnalysis[] } | null>(null)
  const request = useAbWorker()

  // sizes[k] = 第 k 次猜之前的可能數；最後一個是目前的
  const { pool, sizes } = useMemo(() => {
    let p = allIndices()
    const s = [p.length]
    for (const c of clues) {
      p = filterPool(p, indexOf(c.guess), fbOf(c.a, c.b))
      s.push(p.length)
    }
    return { pool: p, sizes: s }
  }, [clues])

  const playing = status === 'playing'
  const ended = !playing && clues.length > 0
  const steps = analysis && analysis.game === game ? analysis.steps : null
  // 建議的措辭跟「隱藏可能組合」有關，在這裡算，切換開關時不用重跑分析
  const summary = useMemo(
    () => (steps ? summarize(steps, status === 'won', hidePool) : null),
    [steps, status, hidePool],
  )

  useEffect(() => {
    if (!ended) return
    let cancelled = false
    request({ type: 'analyze', clues }).then((res) => {
      if (!cancelled) setAnalysis({ game, steps: res.steps })
    })
    return () => {
      cancelled = true
    }
  }, [ended, clues, game, request])

  function press(d: string) {
    if (!playing || input.length >= 4 || input.includes(d)) return
    setInput(input + d)
    setError(null)
  }

  function backspace() {
    if (!playing) return
    setInput(input.slice(0, -1))
    setError(null)
  }

  function submit() {
    if (!playing) return
    if (input.length < 4) {
      setError('請輸入四個不重複的數字')
      return
    }
    if (clues.some((c) => c.guess === input)) {
      setError(`${input} 已經猜過了`)
      return
    }
    const { a, b } = score(input, answer)
    setClues([...clues, { guess: input, a, b }])
    setInput('')
    setError(null)
    if (a === 4) setStatus('won')
  }

  function newGame() {
    setAnswer(randomCode())
    setClues([])
    setInput('')
    setError(null)
    setStatus('playing')
    setShowAll(false)
    setGame(game + 1)
  }

  function toggleHide(value: boolean) {
    setHidePool(value)
    save('ab:hidePool', value)
  }

  // 實體鍵盤：數字、Backspace、Enter
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (/^[0-9]$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') backspace()
      else if (e.key === 'Enter') {
        // 焦點在按鈕上時 Enter 會觸發按鈕本身，不要重複送出
        if (target?.tagName === 'BUTTON') return
        submit()
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  let statusLine
  if (status === 'won')
    statusLine = (
      <StatusLine tone="ok">
        猜中了！答案是 {answer}，共猜 {clues.length} 次
      </StatusLine>
    )
  else if (status === 'gaveup') statusLine = <StatusLine tone="danger">答案是 {answer}</StatusLine>
  else if (error) statusLine = <StatusLine tone="danger">{error}</StatusLine>
  else
    statusLine = (
      <StatusLine>
        {clues.length ? `第 ${clues.length + 1} 次猜測` : '猜一組四位不重複的數字（0–9，首位可為 0）'}
      </StatusLine>
    )

  const shown = showAll ? pool : pool.slice(0, PREVIEW)

  const side = (
    <details className="ab-pool" open>
      <summary>
        <h3>可能組合</h3>
        {!hidePool && <span className="chip">{pool.length} 種</span>}
      </summary>
      <label className="ab-check">
        <input type="checkbox" checked={hidePool} onChange={(e) => toggleHide(e.target.checked)} />
        隱藏可能組合（自己推理）
      </label>
      {hidePool ? (
        <p className="muted">已隱藏。結束後的分析仍會告訴你哪些猜測不可能是答案。</p>
      ) : pool.length === TOTAL ? (
        <p className="muted">還沒有線索，全部 {TOTAL} 種都有可能。</p>
      ) : (
        <>
          <p className="muted">點一下可以填入輸入框。</p>
          <div className="ab-pool-list">
            {shown.map((i) => (
              <button
                key={i}
                type="button"
                className={`secondary${CODES[i] === input ? ' active' : ''}`}
                disabled={!playing}
                onClick={() => {
                  setInput(CODES[i])
                  setError(null)
                }}
              >
                {CODES[i]}
              </button>
            ))}
          </div>
          {pool.length > shown.length && (
            <button type="button" className="secondary" onClick={() => setShowAll(true)}>
              顯示全部 {pool.length} 種
            </button>
          )}
        </>
      )}
    </details>
  )

  return (
    <GameLayout side={side}>
      {modeSwitch}
      {statusLine}
      <div className="ab-slots" aria-label="目前輸入">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`ab-slot${i === input.length && playing ? ' cursor' : ''}`}>
            {playing ? (input[i] ?? '') : answer[i]}
          </span>
        ))}
      </div>

      {playing ? (
        <>
          <div className="ab-keypad">
            {'1234567890'.split('').map((d) => (
              <button
                key={d}
                type="button"
                className="secondary"
                disabled={input.includes(d) || input.length >= 4}
                onClick={() => press(d)}
              >
                {d}
              </button>
            ))}
            <button type="button" className="secondary ab-wide" disabled={!input} onClick={backspace}>
              ⌫ 退格
            </button>
            <button type="button" className="ab-wide" disabled={input.length < 4} onClick={submit}>
              送出
            </button>
          </div>
          <Toolbar>
            <button type="button" className="danger" disabled={!clues.length} onClick={() => setStatus('gaveup')}>
              放棄（揭曉答案）
            </button>
          </Toolbar>
        </>
      ) : (
        <Toolbar>
          <button type="button" onClick={newGame}>
            再玩一次
          </button>
        </Toolbar>
      )}

      <History clues={clues} sizes={sizes} hideSizes={hidePool && playing} />

      {ended &&
        (steps && summary ? (
          <AnalysisView steps={steps} summary={summary} />
        ) : (
          <p className="muted" role="status">
            分析中…
          </p>
        ))}
    </GameLayout>
  )
}

function History({ clues, sizes, hideSizes }: { clues: Clue[]; sizes: number[]; hideSizes: boolean }) {
  if (!clues.length) return null
  return (
    <table className="ab-history">
      <thead>
        <tr>
          <th>#</th>
          <th>猜測</th>
          <th>結果</th>
          <th>可能組合</th>
        </tr>
      </thead>
      <tbody>
        {clues.map((c, i) => (
          <tr key={c.guess}>
            <td>{i + 1}</td>
            <td className="ab-code">{c.guess}</td>
            <td className={c.a === 4 ? 'ab-win' : ''}>
              {c.a}A{c.b}B
            </td>
            <td>{hideSizes ? '—' : `${sizes[i]} → ${sizes[i + 1]}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
