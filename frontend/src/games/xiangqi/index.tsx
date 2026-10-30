import { useEffect, useMemo, useRef, useState } from 'react'
import { OnlinePanel } from '../shared/OnlinePanel'
import { load, save } from '../shared/storage'
import { GameLayout, Overlay, Segmented, StatusLine, Toolbar } from '../shared/ui'
import { useRoom } from '../shared/useRoom'
import type { Level } from './ai.ts'
import type { AiRequest, AiResponse } from './ai.worker.ts'
import XiangqiBoard from './Board.tsx'
import { redSeat, reduceOnline, seatSide, type XqEvent } from './online.ts'
import {
  BLACK,
  RED,
  applyMove,
  currentPosition,
  encodeMove,
  findKing,
  historySinceCapture,
  inCheck,
  legalMoves,
  moveFrom,
  moveTo,
  newGame,
  sideName,
  truncate,
  type Game,
  type Move,
  type Position,
  type Side,
} from './rules.ts'
import './xiangqi.css'

type Mode = 'ai' | 'local' | 'online'

const MODES: Mode[] = ['ai', 'local', 'online']
const LEVELS: Level[] = ['easy', 'normal', 'hard']

function pick<T>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

type Tone = 'ok' | 'danger' | 'accent' | undefined

export default function Xiangqi() {
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(window.location.search).has('room') ? 'online' : pick(load('xiangqi:mode', 'ai'), MODES, 'ai'),
  )
  const [level, setLevel] = useState<Level>(() => pick(load('xiangqi:level', 'normal'), LEVELS, 'normal'))
  const [playerSide, setPlayerSide] = useState<Side>(() => (load('xiangqi:side', RED) === BLACK ? BLACK : RED))
  const [localGame, setLocalGame] = useState<Game>(newGame)
  // 選取記住是在哪個局面選的，局面一變就自動失效，不用在 effect 裡清掉
  const [selection, setSelection] = useState<{ pos: Position; sq: number } | null>(null)
  const [dismissed, setDismissed] = useState<Game | null>(null)
  const [recordOpen, setRecordOpen] = useState(() => window.matchMedia('(min-width: 801px)').matches)

  const room = useRoom<XqEvent>('xiangqi', mode === 'online')
  const online = useMemo(() => reduceOnline(room.events), [room.events])

  const game = mode === 'online' ? online.game : localGame
  const pos = currentPosition(game)
  const result = game.result
  let mySide: Side | null = null
  if (mode === 'ai') mySide = playerSide
  else if (mode === 'online' && room.seat !== null) mySide = seatSide(room.seat, online.round)
  const aiSide = -playerSide as Side
  const thinking = mode === 'ai' && !result && pos.turn === aiSide
  const onlineReady = room.connected && room.peerOnline
  const canMove =
    !result &&
    (mode === 'local' ||
      (mode === 'ai' && pos.turn === playerSide) ||
      (mode === 'online' && onlineReady && mySide === pos.turn))
  const flipped = mode !== 'local' && mySide === BLACK

  const legal = useMemo(() => (result ? [] : legalMoves(pos)), [pos, result])
  const checkSq = useMemo(() => (inCheck(pos.board, pos.turn) ? findKing(pos.board, pos.turn) : null), [pos])
  const selected = canMove && selection && selection.pos === pos ? selection.sq : null
  const targets = selected === null ? [] : legal.filter((m) => moveFrom(m) === selected).map(moveTo)
  const last = game.records.at(-1)
  const lastMove = last ? { from: moveFrom(last.move), to: moveTo(last.move) } : null

  // ---- 電腦 ----
  const workerRef = useRef<Worker | null>(null)
  const requestRef = useRef(0)

  useEffect(
    () => () => {
      workerRef.current?.terminate()
      workerRef.current = null
    },
    [],
  )

  useEffect(() => {
    if (!thinking) return
    const id = ++requestRef.current
    if (!workerRef.current) {
      workerRef.current = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' })
    }
    const worker = workerRef.current
    const requested = localGame
    const started = performance.now()
    let busy = true
    let timer: ReturnType<typeof setTimeout> | undefined
    worker.onmessage = (e: MessageEvent<AiResponse>) => {
      if (e.data.id !== id) return
      busy = false
      // 太快回應看起來像沒想，至少等 300ms
      timer = setTimeout(
        () => setLocalGame((g) => (g === requested ? (applyMove(g, e.data.move) ?? g) : g)),
        Math.max(0, 300 - (performance.now() - started)),
      )
    }
    const request: AiRequest = {
      id,
      position: currentPosition(requested),
      past: historySinceCapture(requested),
      level,
    }
    worker.postMessage(request)
    return () => {
      clearTimeout(timer)
      // 還在算的話直接停掉 Worker，下次再開新的，免得等過期的搜尋算完
      if (busy) {
        worker.terminate()
        if (workerRef.current === worker) workerRef.current = null
      }
    }
  }, [thinking, localGame, level])

  // ---- 棋譜自動捲到最新一步 ----
  const listRef = useRef<HTMLOListElement | null>(null)
  const recordCount = game.records.length
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [recordCount, recordOpen])

  // ---- 操作 ----
  function restartLocal() {
    setLocalGame(newGame())
    setSelection(null)
  }

  function changeMode(next: Mode) {
    if (next === mode) return
    if (mode === 'online') room.leave()
    setMode(next)
    save('xiangqi:mode', next)
    restartLocal()
  }

  function changeLevel(next: Level) {
    setLevel(next)
    save('xiangqi:level', next)
    restartLocal()
  }

  function changeSide(next: Side) {
    setPlayerSide(next)
    save('xiangqi:side', next)
    restartLocal()
  }

  function play(m: Move) {
    setSelection(null)
    if (mode === 'online') room.send({ type: 'move', from: moveFrom(m), to: moveTo(m) })
    else setLocalGame((g) => applyMove(g, m) ?? g)
  }

  function onSquare(sq: number) {
    if (!canMove) return
    if (selected !== null && targets.includes(sq)) {
      play(encodeMove(selected, sq))
      return
    }
    if (pos.board[sq] * pos.turn > 0 && sq !== selected) setSelection({ pos, sq })
    else setSelection(null)
  }

  // 電腦模式退回玩家上一次輪到自己的局面；本地雙人退一手
  let undoTo = -1
  if (mode === 'local') undoTo = localGame.records.length - 1
  else if (mode === 'ai') {
    for (let k = localGame.records.length - 1; k >= 0; k--) {
      if (localGame.positions[k].turn === playerSide) {
        undoTo = k
        break
      }
    }
  }

  function undo() {
    if (undoTo < 0) return
    setLocalGame(truncate(localGame, undoTo))
    setSelection(null)
  }

  function playAgain() {
    if (mode === 'online') room.send({ type: 'restart' })
    else restartLocal()
  }

  // ---- 狀態列 ----
  let status: string
  let tone: Tone
  const check = checkSq !== null ? '將軍！' : ''
  if (result) {
    if (result.winner === null) {
      status = `和棋（${result.reason}）`
      tone = 'accent'
    } else if (mode !== 'local' && mySide !== null) {
      const won = result.winner === mySide
      status = `${won ? '你贏了！' : '你輸了'}（${result.reason}）`
      tone = won ? 'ok' : 'danger'
    } else {
      status = `${sideName(result.winner)}勝（${result.reason}）`
      tone = 'ok'
    }
  } else if (mode === 'online' && !room.code) {
    status = '建立房間或輸入代碼加入'
  } else if (mode === 'online' && room.error) {
    status = room.error
    tone = 'danger'
  } else if (mode === 'online' && !onlineReady) {
    status = room.connected ? '等待對手連線…' : '連線中…'
  } else {
    tone = check ? 'danger' : undefined
    if (thinking) status = `${check}電腦思考中…`
    else if (mode === 'local' || mySide === null) status = `${check}輪到${sideName(pos.turn)}`
    else if (pos.turn === mySide) status = `${check}輪到你（${sideName(mySide)}）`
    else status = `${check}等對手下（${sideName(pos.turn)}）`
  }

  const showOverlay = result !== null && dismissed !== game
  const canPlayAgain = mode !== 'online' || room.connected

  const seatNames: [string, string] = redSeat(online.round) === 0 ? ['紅方（先手）', '黑方'] : ['黑方', '紅方（先手）']

  const moveRows: [string, string | undefined][] = []
  for (let i = 0; i < game.records.length; i += 2) {
    moveRows.push([game.records[i].notation, game.records[i + 1]?.notation])
  }

  const side = (
    <>
      <Segmented<Mode>
        label="模式"
        value={mode}
        onChange={changeMode}
        options={[
          { value: 'ai', label: '電腦' },
          { value: 'local', label: '本地雙人' },
          { value: 'online', label: '線上' },
        ]}
      />
      {mode === 'ai' && (
        <>
          <Segmented<Level>
            label="難度"
            value={level}
            onChange={changeLevel}
            options={[
              { value: 'easy', label: '簡單' },
              { value: 'normal', label: '普通' },
              { value: 'hard', label: '困難' },
            ]}
          />
          <Segmented<Side>
            label="我執"
            value={playerSide}
            onChange={changeSide}
            options={[
              { value: RED, label: '紅（先）' },
              { value: BLACK, label: '黑（後）' },
            ]}
          />
        </>
      )}
      {mode === 'online' && <OnlinePanel room={room} seatNames={seatNames} />}
      <details className="xiangqi-record" open={recordOpen} onToggle={(e) => setRecordOpen(e.currentTarget.open)}>
        <summary>棋譜（{game.records.length} 步）</summary>
        {moveRows.length === 0 ? (
          <p className="muted">還沒有棋步</p>
        ) : (
          <ol ref={listRef}>
            {moveRows.map(([red, black], i) => (
              <li key={i}>
                <span className="xiangqi-record-no">{i + 1}.</span>
                <span className="xiangqi-record-red">{red}</span>
                <span>{black ?? ''}</span>
              </li>
            ))}
          </ol>
        )}
      </details>
    </>
  )

  return (
    <GameLayout side={side}>
      <StatusLine tone={tone}>{status}</StatusLine>
      <div className="board-box xiangqi-box">
        <XiangqiBoard
          board={pos.board}
          flipped={flipped}
          selected={selected}
          targets={targets}
          lastMove={lastMove}
          checkSq={checkSq}
          moveCount={game.records.length}
          disabled={!canMove}
          onSquare={onSquare}
        />
        {showOverlay && (
          <Overlay>
            <strong className="xiangqi-overlay-title">{status}</strong>
            <div className="game-toolbar">
              <button type="button" onClick={playAgain} disabled={!canPlayAgain}>
                再來一局
              </button>
              <button type="button" className="secondary" onClick={() => setDismissed(game)}>
                看棋盤
              </button>
            </div>
          </Overlay>
        )}
      </div>
      <Toolbar>
        {mode === 'online' ? (
          result ? (
            <button type="button" onClick={playAgain} disabled={!canPlayAgain}>
              再來一局
            </button>
          ) : (
            <button
              type="button"
              className="danger"
              onClick={() => room.send({ type: 'resign' })}
              disabled={!onlineReady || mySide === null}
            >
              認輸
            </button>
          )
        ) : (
          <>
            <button type="button" className="secondary" onClick={undo} disabled={undoTo < 0}>
              悔棋
            </button>
            <button type="button" className="secondary" onClick={restartLocal}>
              重新開始
            </button>
          </>
        )}
      </Toolbar>
    </GameLayout>
  )
}
