import { useCallback, useMemo, useState } from 'react'
import { OnlinePanel } from '../shared/OnlinePanel'
import { load, save } from '../shared/storage'
import { GameLayout, Segmented, StatusLine, Toolbar, type Option } from '../shared/ui'
import { useRoom } from '../shared/useRoom'
import type { Level } from './ai'
import { ReversiBoard } from './Board'
import { blackSeat, reduceEvents, seatColor, type ReversiEvent } from './online'
import {
  BLACK,
  countDiscs,
  discName,
  legalMoves,
  other,
  play,
  replay,
  WHITE,
  type Disc,
  type GameState,
} from './rules'
import { useComputerMove, type ComputerJob } from './useComputer'
import './reversi.css'

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
  { value: BLACK, label: '執黑（先手）' },
  { value: WHITE, label: '執白（後手）' },
]

/** 讀偏好；存的值不在選項裡（舊版本或被竄改）就用預設 */
function loadChoice<T extends string | number>(key: string, options: Option<T>[], fallback: T): T {
  const value = load<unknown>(key, fallback)
  return options.some((o) => o.value === value) ? (value as T) : fallback
}

export default function Reversi() {
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(location.search).has('room') ? 'online' : loadChoice('reversi:mode', MODES, 'ai'),
  )
  const [level, setLevel] = useState<Level>(() => loadChoice('reversi:level', LEVELS, 'normal'))
  const [human, setHuman] = useState<Disc>(() => loadChoice('reversi:color', COLORS, BLACK))
  const [moves, setMoves] = useState<number[]>([])

  const room = useRoom<ReversiEvent>('reversi', mode === 'online')
  const online = useMemo(() => reduceEvents(room.events), [room.events])
  const offline = useMemo(() => replay(moves), [moves])
  const game: GameState = mode === 'online' ? online : offline
  const { result, toMove, passed } = game
  const [blackCount, whiteCount] = countDiscs(game.board)

  const myOnlineColor = room.seat === null ? null : seatColor(online.round, room.seat)
  const computer = other(human)
  const thinking = mode === 'ai' && !result && toMove === computer

  let canPlay = false
  if (mode === 'ai') canPlay = !result && toMove === human
  else if (mode === 'local') canPlay = !result
  else canPlay = !result && room.connected && room.peerOnline && myOnlineColor === toMove

  const hints = useMemo(() => legalMoves(game.board, game.toMove), [game.board, game.toMove])

  const job = useMemo<ComputerJob | null>(
    () =>
      mode === 'ai' && !offline.result && offline.toMove === computer
        ? { board: offline.board, color: computer, level, ply: offline.moves.length }
        : null,
    [mode, offline, computer, level],
  )
  const applyComputer = useCallback((pos: number, ply: number) => {
    setMoves((prev) => (prev.length === ply ? [...prev, pos] : prev))
  }, [])
  useComputerMove(job, applyComputer)

  function newGame() {
    setMoves([])
  }

  function changeMode(next: Mode) {
    if (next === mode) return
    if (mode === 'online') room.leave()
    setMode(next)
    save('reversi:mode', next)
    newGame()
  }

  function pick(pos: number) {
    if (!canPlay || !play(game, pos)) return
    if (mode === 'online') room.send({ type: 'move', pos })
    else setMoves([...moves, pos])
  }

  // 電腦模式退回玩家上一次輪到自己的局面（中間可能有 pass，所以看每一手是誰下的）
  let undoTo = -1
  if (mode === 'local') undoTo = moves.length - 1
  else if (mode === 'ai') undoTo = offline.movers.lastIndexOf(human)
  function undo() {
    if (undoTo >= 0) setMoves(moves.slice(0, undoTo))
  }

  function resign() {
    if (window.confirm('確定要認輸嗎？')) room.send({ type: 'resign' })
  }

  // 狀態列
  const mine = (disc: Disc | null) =>
    mode === 'ai' ? disc === human : mode === 'online' ? disc === myOnlineColor : null
  const who = (disc: Disc) => {
    if (mode === 'local') return discName(disc)
    if (mine(disc)) return '你'
    return mode === 'ai' ? '電腦' : '對手'
  }
  let status: string
  let tone: 'ok' | 'danger' | 'accent' | undefined
  if (result) {
    const score = `黑 ${blackCount} : 白 ${whiteCount}，`
    const w = result.winner
    if (w === null) status = `${score}平手`
    else if (result.reason === 'resign') status = mine(w) ? '對手認輸，你贏了！' : '你認輸了'
    else if (mode === 'local') status = `${score}${discName(w)}獲勝！`
    else status = mine(w) ? `${score}你贏了！` : `${score}${who(w)}獲勝`
    tone = w === null ? undefined : mode === 'local' || mine(w) ? 'ok' : 'danger'
  } else if (mode === 'online' && !room.code) {
    status = '建立或加入房間開始對戰'
  } else if (mode === 'online' && room.error) {
    status = room.error
    tone = 'danger'
  } else if (mode === 'online' && (!room.connected || !room.peerOnline)) {
    status = room.connected ? '等待對手…' : '連線中…'
  } else {
    const prefix = passed ? `${discName(passed)}無處可下，` : ''
    if (thinking) {
      status = `${prefix}電腦思考中…`
      tone = 'accent'
    } else if (mode === 'local') {
      status = passed ? `${prefix}換${discName(toMove)}` : `輪到${discName(toMove)}`
    } else if (mine(toMove)) {
      status = `${prefix}輪到你（${discName(toMove)}）`
      tone = 'accent'
    } else {
      status = `${prefix}等待對手（${discName(toMove)}）`
    }
  }

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
              save('reversi:level', v)
              newGame()
            }}
          />
          <Segmented
            label="執子"
            value={human}
            options={COLORS}
            onChange={(v) => {
              setHuman(v)
              save('reversi:color', v)
              newGame()
            }}
          />
        </>
      )}
      {mode === 'online' && <OnlinePanel room={room} seatNames={seatNames} />}
      <p className="muted">
        規則：黑先。下子要夾住對方的子（橫、直、斜皆可），被夾住的全部翻面。沒有地方可下就自動跳過，
        雙方都不能下時結束，子多的一方獲勝。
      </p>
    </>
  )

  const turnClass = (disc: Disc) => `reversi-count${!result && toMove === disc ? ' turn' : ''}`

  return (
    <GameLayout side={side}>
      <StatusLine tone={tone}>{status}</StatusLine>
      <div className="reversi-score" aria-label={`黑 ${blackCount}，白 ${whiteCount}`}>
        <span className={turnClass(BLACK)}>
          <span className="reversi-chip black" aria-hidden="true" />
          黑 {blackCount}
          {mode !== 'local' && mine(BLACK) && <span className="muted">（你）</span>}
        </span>
        <span className={turnClass(WHITE)}>
          <span className="reversi-chip white" aria-hidden="true" />
          白 {whiteCount}
          {mode !== 'local' && mine(WHITE) && <span className="muted">（你）</span>}
        </span>
      </div>
      <div className="board-box">
        <ReversiBoard
          board={game.board}
          last={game.moves.at(-1) ?? null}
          flipped={game.flipped}
          ply={game.moves.length}
          hints={hints}
          interactive={canPlay}
          onPick={pick}
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
