import { useEffect, useState } from 'react'
import { formatTime } from '../shared/format'
import { load, save } from '../shared/storage'
import { GameLayout, Overlay, Segmented, Toolbar } from '../shared/ui'
import {
  DIFFICULTY_NAME,
  applyHint,
  createGame,
  digitCounts,
  erase,
  hintCell,
  isGame,
  isGiven,
  moveSelection,
  place,
  sameHouse,
  toggleNote,
  type Game,
} from './game'
import { generate, type Difficulty } from './logic'
import type { GenRequest, GenResponse } from './sudoku.worker'
import './sudoku.css'

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'expert']
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
const EMPTY = Array(81).fill(0)
const UNDO_LIMIT = 300

type Records = Partial<Record<Difficulty, number>>
type Snapshot = Pick<Game, 'values' | 'notes'>

function loadSaved(): Game | null {
  const g = load<unknown>('sudoku:game', null)
  return isGame(g) && !g.done ? g : null
}

let requestSeq = 0

export default function Sudoku() {
  const [saved] = useState(loadSaved)
  const [game, setGame] = useState<Game | null>(saved)
  const [difficulty, setDifficulty] = useState<Difficulty>(() => saved?.difficulty ?? load('sudoku:difficulty', 'easy'))
  // 正在產生的題目；有存檔就直接接著玩
  const [pending, setPending] = useState<GenRequest | null>(() =>
    saved ? null : { id: ++requestSeq, difficulty: load<Difficulty>('sudoku:difficulty', 'easy') },
  )
  const [selected, setSelected] = useState<number | null>(null)
  const [notesMode, setNotesMode] = useState(false)
  const [check, setCheck] = useState(() => load('sudoku:check', true))
  const [undoStack, setUndoStack] = useState<Snapshot[]>([])
  const [records, setRecords] = useState<Records>(() => load<Records>('sudoku:best', {}))
  const [newRecord, setNewRecord] = useState(false)

  // 產生題目：每次請求開一個 Worker，換難度或卸載就直接終止，舊結果不會回來
  useEffect(() => {
    if (!pending) return
    const accept = (res: Omit<GenResponse, 'id'>) => {
      setGame(createGame(pending.difficulty, res.puzzle, res.solution))
      setPending(null)
      setUndoStack([])
      setSelected(null)
      setNewRecord(false)
    }
    let worker: Worker | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      worker = new Worker(new URL('./sudoku.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<GenResponse>) => accept(e.data)
      worker.postMessage(pending)
    } catch {
      // 不支援 module worker 的瀏覽器：退回主執行緒（通常也在 100ms 內）
      timer = setTimeout(() => accept(generate(pending.difficulty)), 0)
    }
    return () => {
      worker?.terminate()
      clearTimeout(timer)
    }
  }, [pending])

  useEffect(() => {
    if (game) save('sudoku:game', game)
  }, [game])

  // 計時：切到別的分頁（document.hidden）時不算
  const running = !!game && !game.done && !pending
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      if (document.hidden) return
      setGame((g) => (g && !g.done ? { ...g, elapsed: g.elapsed + 1 } : g))
    }, 1000)
    return () => clearInterval(id)
  }, [running])

  function startNew(d: Difficulty) {
    setDifficulty(d)
    save('sudoku:difficulty', d)
    setPending({ id: ++requestSeq, difficulty: d })
  }

  function changeDifficulty(d: Difficulty) {
    const inProgress = game && !game.done && game.values.some((v, i) => v !== game.puzzle[i])
    if (inProgress && !window.confirm(`放棄目前這局，開始新的「${DIFFICULTY_NAME[d]}」題目？`)) return
    startNew(d)
  }

  /** 套用一個操作；盤面有變才記錄復原點，完成時更新最佳紀錄 */
  function commit(next: Game) {
    if (!game || next === game) return
    if (next.values !== game.values || next.notes !== game.notes) {
      setUndoStack([...undoStack.slice(-UNDO_LIMIT + 1), { values: game.values, notes: game.notes }])
    }
    setGame(next)
    if (next.done && !game.done) {
      const prev = records[next.difficulty]
      if (prev === undefined || next.elapsed < prev) {
        const updated = { ...records, [next.difficulty]: next.elapsed }
        setRecords(updated)
        save('sudoku:best', updated)
        setNewRecord(true)
      }
    }
  }

  const playable = !!game && !game.done && !pending

  function input(d: number) {
    if (!game || !playable || selected === null) return
    commit(notesMode ? toggleNote(game, selected, d) : place(game, selected, d, check))
  }

  function eraseSelected() {
    if (!game || !playable || selected === null) return
    commit(erase(game, selected))
  }

  function undo() {
    if (!game || !playable || !undoStack.length) return
    const last = undoStack[undoStack.length - 1]
    setUndoStack(undoStack.slice(0, -1))
    setGame({ ...game, ...last })
  }

  function hint() {
    if (!game || !playable) return
    const i = hintCell(game, selected)
    if (i < 0) return
    setSelected(i)
    commit(applyHint(game, i))
  }

  function toggleCheck(value: boolean) {
    setCheck(value)
    save('sudoku:check', value)
  }

  // 實體鍵盤：1–9、方向鍵、Backspace/Delete、N 切換筆記
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      if (/^[1-9]$/.test(e.key)) input(Number(e.key))
      else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') eraseSelected()
      else if (e.key === 'n' || e.key === 'N') setNotesMode((m) => !m)
      else if (e.key.startsWith('Arrow')) setSelected(selected === null ? 40 : moveSelection(selected, e.key))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const values = game?.values ?? EMPTY
  const counts = digitCounts(values)
  const selValue = selected !== null ? values[selected] : 0
  const best = game ? records[game.difficulty] : undefined

  const side = (
    <>
      <Segmented
        label="難度"
        value={difficulty}
        options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_NAME[d] }))}
        onChange={changeDifficulty}
        disabled={!!pending}
      />
      <label className="sudoku-check">
        <input type="checkbox" checked={check} onChange={(e) => toggleCheck(e.target.checked)} />
        即時檢查錯誤（填錯標紅並計入錯誤次數）
      </label>
      <button type="button" className="secondary" disabled={!!pending} onClick={() => startNew(difficulty)}>
        新題目
      </button>
      <div className="card sudoku-records">
        <h3>最佳紀錄</h3>
        <dl>
          {DIFFICULTIES.map((d) => (
            <div key={d}>
              <dt>{DIFFICULTY_NAME[d]}</dt>
              <dd>{records[d] === undefined ? '—' : formatTime(records[d])}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="muted">鍵盤：1–9 填入、方向鍵移動、Backspace 擦除、N 切換筆記。</p>
    </>
  )

  return (
    <GameLayout side={side}>
      <div className="sudoku-stack">
        <div className="sudoku-info" role="status">
          <span>{game ? DIFFICULTY_NAME[game.difficulty] : DIFFICULTY_NAME[difficulty]}</span>
          <span>⏱ {formatTime(game?.elapsed ?? 0)}</span>
          {check && <span className={game?.mistakes ? 'sudoku-bad' : ''}>錯誤 {game?.mistakes ?? 0}</span>}
          <span>提示 {game?.hints ?? 0}</span>
        </div>

        <div className="board-box">
          <div className="sudoku-board" aria-label="數獨盤面">
            {values.map((v, i) => {
              const given = game ? isGiven(game, i) : false
              const wrong = !!game && check && v !== 0 && !given && v !== game.solution[i]
              const cls = ['sudoku-cell']
              if (i % 9 === 2 || i % 9 === 5) cls.push('thick-r')
              if (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5) cls.push('thick-b')
              if (given) cls.push('given')
              else if (v) cls.push('filled')
              if (wrong) cls.push('wrong')
              if (i === selected) cls.push('selected')
              else if (selValue && v === selValue) cls.push('same')
              else if (selected !== null && sameHouse(i, selected)) cls.push('peer')
              const notes = !v && game ? game.notes[i] : 0
              return (
                <button
                  key={i}
                  type="button"
                  className={cls.join(' ')}
                  aria-label={`第 ${Math.floor(i / 9) + 1} 列第 ${(i % 9) + 1} 行，${v ? v : '空格'}`}
                  aria-pressed={i === selected}
                  disabled={!game}
                  onClick={() => setSelected(i)}
                >
                  {v ? (
                    v
                  ) : notes ? (
                    <span className="sudoku-notes" aria-hidden="true">
                      {DIGITS.map((d) => (
                        <span key={d} className={selValue === d ? 'hit' : ''}>
                          {notes & (1 << d) ? d : ''}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          {pending && (
            <Overlay>
              <p>產生題目中…</p>
            </Overlay>
          )}
          {game?.done && !pending && (
            <Overlay>
              <strong className="sudoku-done">完成！</strong>
              <p>
                {DIFFICULTY_NAME[game.difficulty]} · 時間 {formatTime(game.elapsed)}
                <br />
                錯誤 {game.mistakes} · 提示 {game.hints}
                <br />
                {newRecord ? '🎉 新紀錄！' : best !== undefined ? `最佳紀錄 ${formatTime(best)}` : ''}
              </p>
              <button type="button" onClick={() => startNew(game.difficulty)}>
                再來一題
              </button>
            </Overlay>
          )}
        </div>

        <div className="sudoku-pad">
          {DIGITS.map((d) => {
            const left = 9 - counts[d]
            return (
              <button
                key={d}
                type="button"
                className={`secondary${left <= 0 ? ' used-up' : ''}`}
                disabled={!playable}
                aria-label={`${d}，剩 ${Math.max(0, left)} 個`}
                onClick={() => input(d)}
              >
                <span className="sudoku-pad-digit">{d}</span>
                <span className="sudoku-pad-left">{Math.max(0, left)}</span>
              </button>
            )
          })}
        </div>

        <Toolbar>
          <button type="button" className="secondary" disabled={!playable || !undoStack.length} onClick={undo}>
            ↶ 復原
          </button>
          <button type="button" className="secondary" disabled={!playable || selected === null} onClick={eraseSelected}>
            擦除
          </button>
          <button
            type="button"
            className={notesMode ? '' : 'secondary'}
            aria-pressed={notesMode}
            disabled={!playable}
            onClick={() => setNotesMode(!notesMode)}
          >
            ✎ 筆記
          </button>
          <button type="button" className="secondary" disabled={!playable} onClick={hint}>
            💡 提示
          </button>
        </Toolbar>
      </div>
    </GameLayout>
  )
}
