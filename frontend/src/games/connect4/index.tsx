import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { OnlinePanel } from '../shared/OnlinePanel'
import { load, save } from '../shared/storage'
import { TakebackButton, TakebackNotice } from '../shared/TakebackControls'
import { GameLayout, Segmented, StatusLine, Toolbar, type Option } from '../shared/ui'
import { useRoom } from '../shared/useRoom'
import type { Level } from './ai'
import { Connect4Board, type Ghost } from './Board'
import { reduceEvents, redSeat, seatColor, type Connect4Event } from './online'
import {
  colorOfPly,
  COLS,
  discName,
  landingRow,
  lastCell,
  other,
  RED,
  replay,
  YELLOW,
  type Disc,
  type GameState,
} from './rules'
import { useComputerMove, type ComputerJob } from './useComputer'
import './connect4.css'

type Mode = 'ai' | 'local' | 'online'

const MODES: Option<Mode>[] = [
  { value: 'ai', label: '電腦' },
  { value: 'local', label: '本地雙人' },
  { value: 'online', label: '線上' },
]
const LEVELS: Option<Level>[] = [
  { value: 'easy', label: '簡單' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困難' },
]
const COLORS: Option<Disc>[] = [
  { value: RED, label: '執紅（先手）' },
  { value: YELLOW, label: '執黃（後手）' },
]

/** 讀偏好；存的值不在選項裡（舊版本或被竄改）就用預設 */
function loadChoice<T extends string | number>(key: string, options: Option<T>[], fallback: T): T {
  const value = load<unknown>(key, fallback)
  return options.some((o) => o.value === value) ? (value as T) : fallback
}

function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

function Chip({ disc }: { disc: Disc }) {
  return <span className={`c4-chip ${disc === RED ? 'red' : 'yellow'}`} aria-hidden="true" />
}

export default function Connect4() {
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(location.search).has('room') ? 'online' : loadChoice('connect4:mode', MODES, 'ai'),
  )
  const [level, setLevel] = useState<Level>(() => loadChoice('connect4:level', LEVELS, 'normal'))
  const [human, setHuman] = useState<Disc>(() => loadChoice('connect4:color', COLORS, RED))
  const [confirmMove, setConfirmMove] = useState<boolean>(() => load('connect4:confirm', isTouch()) === true)
  const [moves, setMoves] = useState<number[]>([])
  const [pending, setPending] = useState<{ col: number; key: string } | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  const room = useRoom<Connect4Event>('connect4', mode === 'online')
  const online = useMemo(() => reduceEvents(room.events), [room.events])
  const offline = useMemo(() => replay(moves), [moves])
  const game: GameState = mode === 'online' ? online : offline
  const { result } = game

  const myOnlineColor = room.seat === null ? null : seatColor(online.round, room.seat)
  const computer = other(human)
  const thinking = mode === 'ai' && !result && game.toMove === computer

  let canPlay = false
  if (mode === 'ai') canPlay = !result && game.toMove === human
  else if (mode === 'local') canPlay = !result
  else canPlay = !result && room.connected && room.peerOnline && myOnlineColor === game.toMove && !online.takeback.pending

  // 預覽（落子確認）只在同一個局面有效，局面一變就自動失效
  const positionKey = `${mode}:${online.round}:${game.moves.length}`
  const pendingCol = canPlay && pending?.key === positionKey ? pending.col : null

  const job = useMemo<ComputerJob | null>(
    () =>
      mode === 'ai' && !offline.result && offline.toMove === computer ? { moves: offline.moves, level } : null,
    [mode, offline, computer, level],
  )
  const applyComputer = useCallback((col: number, ply: number) => {
    setMoves((prev) => (prev.length === ply ? [...prev, col] : prev))
  }, [])
  useComputerMove(job, applyComputer)

  function newGame() {
    setMoves([])
    setPending(null)
  }

  function changeMode(next: Mode) {
    if (next === mode) return
    if (mode === 'online') room.leave()
    setMode(next)
    save('connect4:mode', next)
    newGame()
  }

  function pick(col: number) {
    if (!canPlay || landingRow(game.board, col) < 0) return
    if (confirmMove && pendingCol !== col) {
      setPending({ col, key: positionKey })
      return
    }
    setPending(null)
    if (mode === 'online') room.send({ type: 'move', col })
    else setMoves([...moves, col])
  }

  // 鍵盤：左右鍵選欄、Enter／空白鍵投下，或直接按 1～7
  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (!canPlay) return
    const current = pendingCol ?? hover ?? 3
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const next = Math.min(COLS - 1, Math.max(0, current + (e.key === 'ArrowLeft' ? -1 : 1)))
      if (confirmMove) setPending({ col: next, key: positionKey })
      else setHover(next)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(current)
    } else if (e.key === 'Escape') {
      setPending(null)
    } else if (/^[1-7]$/.test(e.key)) {
      e.preventDefault()
      pick(Number(e.key) - 1)
    }
  }

  // 電腦模式退回玩家上一次輪到自己的局面（電腦還沒下時只退一手）
  let undoTo = -1
  if (mode === 'local') undoTo = moves.length - 1
  else if (mode === 'ai') {
    for (let i = moves.length - 1; i >= 0; i--) {
      if (colorOfPly(i) === human) {
        undoTo = i
        break
      }
    }
  }
  function undo() {
    if (undoTo < 0) return
    setMoves(moves.slice(0, undoTo))
    setPending(null)
  }

  function resign() {
    if (window.confirm('確定要認輸嗎？')) room.send({ type: 'resign' })
  }

  // 狀態列：觀戰的人和同一台輪流下一樣，只說哪一色
  const watching = mode === 'online' && room.spectator
  const neutral = mode === 'local' || watching
  let status: string
  let tone: 'ok' | 'danger' | 'accent' | undefined
  let chip: Disc | null = null
  const mine = (disc: Disc | null) =>
    mode === 'ai' ? disc === human : mode === 'online' ? disc === myOnlineColor : null
  if (result) {
    const who = result.winner
    chip = who
    if (who === null) status = '棋盤下滿了，和局'
    else if (neutral) status = `${discName(who)}獲勝！`
    else if (mine(who)) status = result.reason === 'resign' ? '對手認輸，你贏了！' : '你贏了！'
    else if (mode === 'ai') status = '電腦獲勝'
    else status = result.reason === 'resign' ? '你認輸了' : '對手獲勝'
    tone = who === null ? undefined : neutral || mine(who) ? 'ok' : 'danger'
  } else if (mode === 'online' && !room.code) {
    status = '建立或加入房間開始對戰'
  } else if (mode === 'online' && room.error) {
    status = room.error
    tone = 'danger'
  } else if (mode === 'online' && (!room.connected || !room.peerOnline)) {
    status = !room.connected ? '連線中…' : watching ? '等待對局的人連線…' : '等待對手…'
  } else if (thinking) {
    status = '電腦思考中…'
    tone = 'accent'
    chip = game.toMove
  } else if (pendingCol !== null) {
    status = '再點一次同一欄確認落子'
    tone = 'accent'
    chip = game.toMove
  } else if (neutral) {
    status = `輪到${discName(game.toMove)}`
    chip = game.toMove
  } else if (mode === 'online' && online.takeback.pending) {
    status = '悔棋請求中，暫停落子'
    chip = game.toMove
  } else if (mine(game.toMove)) {
    status = `輪到你（${discName(game.toMove)}）`
    tone = 'accent'
    chip = game.toMove
  } else {
    status = `等待對手（${discName(game.toMove)}）`
    chip = game.toMove
  }

  let ghost: Ghost | null = null
  if (pendingCol !== null) ghost = { col: pendingCol, color: game.toMove, kind: 'pending' }
  else if (canPlay && hover !== null && !confirmMove) ghost = { col: hover, color: game.toMove, kind: 'hover' }

  const redIsSeat0 = redSeat(online.round) === 0
  const seatNames: [string, string] = redIsSeat0 ? ['紅方（先手）', '黃方（後手）'] : ['黃方（後手）', '紅方（先手）']

  const side = (
    <>
      <Segmented label="模式" value={mode} options={MODES} onChange={changeMode} />
      {mode === 'ai' && (
        <>
          <Segmented
            label="難度"
            value={level}
            options={LEVELS}
            onChange={(v) => {
              setLevel(v)
              save('connect4:level', v)
              newGame()
            }}
          />
          <Segmented
            label="執子"
            value={human}
            options={COLORS}
            onChange={(v) => {
              setHuman(v)
              save('connect4:color', v)
              newGame()
            }}
          />
        </>
      )}
      {mode === 'online' && <OnlinePanel room={room} seatNames={seatNames} />}
      <label className="c4-option">
        <input
          type="checkbox"
          checked={confirmMove}
          onChange={(e) => {
            setConfirmMove(e.target.checked)
            save('connect4:confirm', e.target.checked)
            setPending(null)
          }}
        />
        落子確認（先預覽，再點一次才下）
      </label>
      <p className="muted">
        規則：紅方先手，輪流把棋子投進任一欄，棋子會落到那一欄最下面的空格。先在橫、直或斜線上連成四子的一方獲勝；42
        格全部下滿為和局。
      </p>
      <p className="muted">鍵盤：左右鍵選欄、Enter 投下，或直接按 1～7。</p>
    </>
  )

  const takebackProps = {
    takeback: online.takeback,
    seat: room.seat,
    active: !result && room.connected && room.peerOnline,
    send: room.send,
  }

  return (
    <GameLayout side={side}>
      <StatusLine tone={tone}>
        {chip !== null && <Chip disc={chip} />}
        {status}
      </StatusLine>
      {mode === 'online' && <TakebackNotice {...takebackProps} />}
      <div className="board-box c4-box">
        <Connect4Board
          board={game.board}
          last={lastCell(game)}
          dropKey={game.moves.length}
          line={result?.line ?? null}
          ghost={ghost}
          interactive={canPlay}
          onPick={pick}
          onHover={setHover}
          onKeyDown={onKeyDown}
        />
      </div>
      <Toolbar>
        {mode === 'online' ? (
          room.code &&
          !room.spectator &&
          (result ? (
            <button type="button" onClick={() => room.send({ type: 'restart' })} disabled={!room.connected}>
              再來一局
            </button>
          ) : (
            <>
              <TakebackButton {...takebackProps} />
              <button
                type="button"
                className="danger"
                onClick={resign}
                disabled={!room.connected || myOnlineColor === null}
              >
                認輸
              </button>
            </>
          ))
        ) : (
          <>
            <button type="button" className="secondary" onClick={undo} disabled={undoTo < 0}>
              悔棋
            </button>
            <button type="button" className={result ? '' : 'secondary'} onClick={newGame}>
              {result ? '再來一局' : '重新開始'}
            </button>
          </>
        )}
      </Toolbar>
    </GameLayout>
  )
}
