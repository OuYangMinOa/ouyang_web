import { useCallback, useMemo, useState } from 'react'
import { OnlinePanel } from '../shared/OnlinePanel'
import { load, save } from '../shared/storage'
import { GameLayout, Segmented, StatusLine, Toolbar, type Option } from '../shared/ui'
import { useRoom } from '../shared/useRoom'
import type { Level } from './ai'
import { GomokuBoard, type Ghost } from './Board'
import { blackSeat, reduceEvents, seatColor, type GomokuEvent } from './online'
import { BLACK, colorOfPly, other, replay, stoneName, WHITE, type GameState, type Stone } from './rules'
import { useComputerMove, type ComputerJob } from './useComputer'
import './gomoku.css'

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
const COLORS: Option<Stone>[] = [
  { value: BLACK, label: '執黑（先手）' },
  { value: WHITE, label: '執白（後手）' },
]

/** 讀偏好；存的值不在選項裡（舊版本或被竄改）就用預設 */
function loadChoice<T extends string | number>(key: string, options: Option<T>[], fallback: T): T {
  const value = load<unknown>(key, fallback)
  return options.some((o) => o.value === value) ? (value as T) : fallback
}

function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

export default function Gomoku() {
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(location.search).has('room') ? 'online' : loadChoice('gomoku:mode', MODES, 'ai'),
  )
  const [level, setLevel] = useState<Level>(() => loadChoice('gomoku:level', LEVELS, 'normal'))
  const [human, setHuman] = useState<Stone>(() => loadChoice('gomoku:color', COLORS, BLACK))
  const [confirmMove, setConfirmMove] = useState<boolean>(() => load('gomoku:confirm', isTouch()) === true)
  const [moves, setMoves] = useState<number[]>([])
  const [pending, setPending] = useState<{ pos: number; key: string } | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  const room = useRoom<GomokuEvent>('gomoku', mode === 'online')
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
  else canPlay = !result && room.connected && room.peerOnline && myOnlineColor === game.toMove

  // 預覽（落子確認）只在同一個局面有效，局面一變就自動失效
  const positionKey = `${mode}:${online.round}:${game.moves.length}`
  const pendingPos = canPlay && pending?.key === positionKey ? pending.pos : null

  const job = useMemo<ComputerJob | null>(
    () =>
      mode === 'ai' && !offline.result && offline.toMove === computer
        ? { board: offline.board, color: computer, level, ply: offline.moves.length }
        : null,
    [mode, offline, computer, level],
  )
  const applyComputer = useCallback((pos: number, ply: number) => {
    setMoves((prev) => (prev.length === ply && !prev.includes(pos) ? [...prev, pos] : prev))
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
    save('gomoku:mode', next)
    newGame()
  }

  function pick(pos: number) {
    if (!canPlay || game.board[pos] !== 0) return
    if (confirmMove && pendingPos !== pos) {
      setPending({ pos, key: positionKey })
      return
    }
    setPending(null)
    if (mode === 'online') room.send({ type: 'move', pos })
    else setMoves([...moves, pos])
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

  // 狀態列
  let status: string
  let tone: 'ok' | 'danger' | 'accent' | undefined
  const mine = (stone: Stone | null) =>
    mode === 'ai' ? stone === human : mode === 'online' ? stone === myOnlineColor : null
  if (result) {
    const who = result.winner
    if (who === null) status = '棋盤下滿了，和局'
    else if (mode === 'local') status = `${stoneName(who)}獲勝！`
    else if (mine(who)) status = result.reason === 'resign' ? '對手認輸，你贏了！' : '你贏了！'
    else if (mode === 'ai') status = '電腦獲勝'
    else status = result.reason === 'resign' ? '你認輸了' : '對手獲勝'
    tone = who === null ? undefined : mode === 'local' || mine(who) ? 'ok' : 'danger'
  } else if (mode === 'online' && !room.code) {
    status = '建立或加入房間開始對戰'
  } else if (mode === 'online' && room.error) {
    status = room.error
    tone = 'danger'
  } else if (mode === 'online' && (!room.connected || !room.peerOnline)) {
    status = room.connected ? '等待對手…' : '連線中…'
  } else if (thinking) {
    status = '電腦思考中…'
    tone = 'accent'
  } else if (pendingPos !== null) {
    status = '再點一次同一點確認落子'
    tone = 'accent'
  } else if (mode === 'local') {
    status = `輪到${stoneName(game.toMove)}`
  } else if (mine(game.toMove)) {
    status = `輪到你（${stoneName(game.toMove)}）`
    tone = 'accent'
  } else {
    status = `等待對手（${stoneName(game.toMove)}）`
  }

  let ghost: Ghost | null = null
  if (pendingPos !== null) ghost = { pos: pendingPos, color: game.toMove, kind: 'pending' }
  else if (canPlay && hover !== null && !confirmMove) ghost = { pos: hover, color: game.toMove, kind: 'hover' }

  const blackIsSeat0 = blackSeat(online.round) === 0
  const seatNames: [string, string] = blackIsSeat0 ? ['黑棋（先手）', '白棋（後手）'] : ['白棋（後手）', '黑棋（先手）']

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
              save('gomoku:level', v)
              newGame()
            }}
          />
          <Segmented
            label="執子"
            value={human}
            options={COLORS}
            onChange={(v) => {
              setHuman(v)
              save('gomoku:color', v)
              newGame()
            }}
          />
        </>
      )}
      {mode === 'online' && <OnlinePanel room={room} seatNames={seatNames} />}
      <label className="gomoku-option">
        <input
          type="checkbox"
          checked={confirmMove}
          onChange={(e) => {
            setConfirmMove(e.target.checked)
            save('gomoku:confirm', e.target.checked)
            setPending(null)
          }}
        />
        落子確認（先預覽，再點一次才下）
      </label>
      <p className="muted">規則：黑先，連成五子或以上即勝（自由規則，不設禁手）；棋盤下滿為和局。</p>
    </>
  )

  return (
    <GameLayout side={side}>
      <StatusLine tone={tone}>{status}</StatusLine>
      <div className="board-box">
        <GomokuBoard
          board={game.board}
          last={game.moves.at(-1) ?? null}
          line={result?.line ?? null}
          ghost={ghost}
          interactive={canPlay}
          onPick={pick}
          onHover={setHover}
        />
      </div>
      <Toolbar>
        {mode === 'online' ? (
          room.code &&
          (result ? (
            <button type="button" onClick={() => room.send({ type: 'restart' })} disabled={!room.connected}>
              再來一局
            </button>
          ) : (
            <button
              type="button"
              className="danger"
              onClick={resign}
              disabled={!room.connected || myOnlineColor === null}
            >
              認輸
            </button>
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
