import { useEffect, useMemo, useState } from 'react'
import { OnlinePanel } from '../shared/OnlinePanel'
import { load, save } from '../shared/storage'
import { GameLayout, Overlay, Segmented, StatusLine, Toolbar } from '../shared/ui'
import { useRoom } from '../shared/useRoom'
import { chooseMove, type Level } from './ai'
import type { AiRequest, AiResponse } from './ai.worker'
import { ChessBoard } from './Board'
import {
  BISHOP,
  BLACK,
  FLAG_CAPTURE,
  KNIGHT,
  QUEEN,
  ROOK,
  WHITE,
  moveFlags,
  moveFrom,
  movePromo,
  moveTo,
  type Color,
} from './engine'
import { ChessGame, moveToEvent, reduceOnline, replay, seatColor, type ChessEvent, type Result } from './game'
import { Piece } from './Piece'
import { Captures, MoveList } from './Record'
import './chess.css'

type Mode = 'ai' | 'local' | 'online'
type Side = 'white' | 'black'

const MODES: Mode[] = ['ai', 'local', 'online']
const LEVELS: Level[] = ['easy', 'normal', 'hard']
const PROMOTIONS = [QUEEN, ROOK, BISHOP, KNIGHT]
const PROMO_NAMES: Record<number, string> = { [QUEEN]: '后', [ROOK]: '車', [BISHOP]: '象', [KNIGHT]: '馬' }

function loadChoice<T>(key: string, allowed: T[], fallback: T): T {
  const value = load<T>(key, fallback)
  return allowed.includes(value) ? value : fallback
}

const colorName = (c: Color) => (c === WHITE ? '白方' : '黑方')

const REASONS: Record<Result['reason'], string> = {
  checkmate: '將死',
  resign: '認輸',
  stalemate: '逼和：輪到的一方無棋可走',
  fifty: '50 步規則：連續 50 回合沒有吃子或動兵',
  repetition: '同一局面出現三次',
  material: '雙方子力都不足以將死',
}

function describe(result: Result, me: Color | null): { title: string; detail: string; tone: 'ok' | 'danger' | 'accent' } {
  if (result.winner === null) return { title: '和局', detail: REASONS[result.reason], tone: 'accent' }
  const detail =
    result.reason === 'resign' ? `${colorName(-result.winner as Color)}認輸` : `${colorName(result.winner)}將死對手`
  if (me === null) return { title: `${colorName(result.winner)}獲勝`, detail, tone: 'ok' }
  return result.winner === me
    ? { title: '你贏了！', detail, tone: 'ok' }
    : { title: '你輸了', detail, tone: 'danger' }
}

export default function Chess() {
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(location.search).has('room') ? 'online' : loadChoice('chess:mode', MODES, 'ai'),
  )
  const [level, setLevel] = useState<Level>(() => loadChoice('chess:level', LEVELS, 'normal'))
  const [side, setSide] = useState<Side>(() => loadChoice<Side>('chess:side', ['white', 'black'], 'white'))
  const [moves, setMoves] = useState<number[]>([])
  // 選取、升變、關掉結算都綁定在當時的局面上，局面一變就自動失效，不用在 effect 裡清
  const [selection, setSelection] = useState<{ game: ChessGame; sq: number } | null>(null)
  const [promo, setPromo] = useState<{ game: ChessGame; from: number; to: number } | null>(null)
  const [dismissed, setDismissed] = useState<ChessGame | null>(null)
  const [flip, setFlip] = useState(false)
  const [recordOpen, setRecordOpen] = useState(() => !window.matchMedia('(max-width: 800px)').matches)

  const room = useRoom<ChessEvent>('chess', mode === 'online')
  const online = useMemo(() => reduceOnline(room.events), [room.events])
  const local = useMemo(() => replay(moves), [moves])
  const game = mode === 'online' ? online.game : local

  const human: Color = side === 'white' ? WHITE : BLACK
  let me: Color | null = null
  if (mode === 'ai') me = human
  else if (mode === 'online' && room.seat !== null) me = seatColor(room.seat, online.round)

  const ready = mode !== 'online' || (room.connected && room.peerOnline)
  const aiTurn = mode === 'ai' && !game.result && game.turn !== human
  const canMove = !game.result && ready && (me === null || game.turn === me) && (mode !== 'online' || me !== null)
  const pendingPromo = promo && promo.game === game ? promo : null
  const selected = canMove && selection && selection.game === game ? selection.sq : null

  const targets = useMemo(() => {
    const map = new Map<number, boolean>()
    if (selected === null) return map
    for (const m of game.legal) if (moveFrom(m) === selected) map.set(moveTo(m), (moveFlags(m) & FLAG_CAPTURE) !== 0)
    return map
  }, [game, selected])

  // 電腦走棋：每次思考開一個 worker，局面一變（悔棋、新局、換模式）就直接終止，舊結果不會被套用
  useEffect(() => {
    if (!aiTurn) return
    const snapshot = moves
    const started = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = (move: number) => {
      // 電腦太快時稍等一下，看得出是對方走的
      const wait = Math.max(0, 300 - (performance.now() - started))
      timer = setTimeout(() => {
        setMoves((prev) => (prev === snapshot && local.legal.includes(move) ? [...prev, move] : prev))
      }, wait)
    }
    const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<AiResponse>) => {
      worker.terminate()
      apply(e.data.move)
    }
    worker.onerror = () => {
      // worker 載入失敗時退回主執行緒的淺層搜尋（很快，不會卡）
      worker.terminate()
      apply(chooseMove(local.pos.clone(), 'easy'))
    }
    const request: AiRequest = { moves: snapshot, level }
    worker.postMessage(request)
    return () => {
      worker.terminate()
      clearTimeout(timer)
    }
  }, [aiTurn, moves, local, level])

  function newGame() {
    setMoves([])
    setSelection(null)
    setPromo(null)
  }

  function changeMode(next: Mode) {
    if (next === mode) return
    if (mode === 'online') room.leave()
    setMode(next)
    save('chess:mode', next)
    newGame()
  }

  function changeLevel(next: Level) {
    setLevel(next)
    save('chess:level', next)
    newGame()
  }

  function changeSide(next: Side) {
    setSide(next)
    save('chess:side', next)
    newGame()
  }

  function commit(m: number) {
    setSelection(null)
    setPromo(null)
    // 線上模式不先套用，等伺服器把事件送回來
    if (mode === 'online') room.send(moveToEvent(m))
    else setMoves((prev) => [...prev, m])
  }

  function clickSquare(sq: number) {
    if (!canMove || pendingPromo) return
    if (selected !== null && targets.has(sq)) {
      const options = game.legal.filter((m) => moveFrom(m) === selected && moveTo(m) === sq)
      if (options.length > 1) setPromo({ game, from: selected, to: sq })
      else commit(options[0])
      return
    }
    const piece = game.pos.board[sq]
    if (sq !== selected && piece * game.turn > 0) setSelection({ game, sq })
    else setSelection(null)
  }

  function choosePromotion(type: number) {
    if (!pendingPromo) return
    const m = game.legal.find(
      (x) => moveFrom(x) === pendingPromo.from && moveTo(x) === pendingPromo.to && movePromo(x) === type,
    )
    if (m !== undefined) commit(m)
  }

  // 電腦模式悔棋退回自己上一次走之前（通常兩手）；本地雙人退一手
  let undoTo = -1
  if (mode === 'local') undoTo = moves.length - 1
  else if (mode === 'ai') {
    for (let i = moves.length - 1; i >= 0; i--) {
      if ((i % 2 === 0 ? WHITE : BLACK) === human) {
        undoTo = i
        break
      }
    }
  }
  function undo() {
    if (undoTo < 0) return
    setMoves((prev) => prev.slice(0, undoTo))
    setSelection(null)
    setPromo(null)
  }

  function resign() {
    if (me !== null && window.confirm('確定要認輸嗎？')) room.send({ type: 'resign' })
  }

  function restart() {
    if (mode === 'online') room.send({ type: 'restart' })
    else newGame()
  }

  // ---- 狀態列 ----
  const inCheck = game.pos.inCheck()
  let status: string
  let tone: 'ok' | 'danger' | 'accent' | undefined
  const outcome = game.result ? describe(game.result, me) : null
  if (outcome) {
    status = `${outcome.title}（${outcome.detail}）`
    tone = outcome.tone
  } else if (mode === 'online' && !room.code) status = '建立房間，或輸入代碼加入朋友的房間'
  else if (mode === 'online' && !room.connected) status = '連線中…'
  else if (mode === 'online' && !room.peerOnline) status = '等待對手…'
  else {
    if (aiTurn) status = '電腦思考中…'
    else if (me === null) status = `輪到${colorName(game.turn)}`
    else if (game.turn === me) status = `輪到你（${colorName(me)}）`
    else status = '等待對手走棋…'
    if (inCheck) {
      status += '　將軍！'
      tone = 'danger'
    }
  }

  const last = game.lastMove
  const flipped = (me === BLACK) !== flip
  const canRestart = mode !== 'online' || room.connected

  return (
    <GameLayout
      side={
        <>
          <Segmented
            label="模式"
            value={mode}
            options={[
              { value: 'ai', label: '電腦' },
              { value: 'local', label: '本地雙人' },
              { value: 'online', label: '線上' },
            ]}
            onChange={changeMode}
          />
          {mode === 'ai' && (
            <>
              <Segmented
                label="難度"
                value={level}
                options={[
                  { value: 'easy', label: '簡單' },
                  { value: 'normal', label: '普通' },
                  { value: 'hard', label: '困難' },
                ]}
                onChange={changeLevel}
              />
              <Segmented
                label="執子"
                value={side}
                options={[
                  { value: 'white', label: '執白（先走）' },
                  { value: 'black', label: '執黑' },
                ]}
                onChange={changeSide}
              />
            </>
          )}
          {mode === 'online' && (
            <OnlinePanel
              room={room}
              seatNames={[colorName(seatColor(0, online.round)), colorName(seatColor(1, online.round))]}
            />
          )}
          <details className="chess-record" open={recordOpen} onToggle={(e) => setRecordOpen(e.currentTarget.open)}>
            <summary>棋譜與吃子</summary>
            <Captures played={game.played} board={game.pos.board} />
            <MoveList played={game.played} />
          </details>
        </>
      }
    >
      <StatusLine tone={tone}>{status}</StatusLine>
      <div className="board-box">
        <ChessBoard
          board={game.pos.board}
          flipped={flipped}
          selected={selected}
          targets={targets}
          lastMove={last === null ? null : [moveFrom(last), moveTo(last)]}
          checkSq={inCheck ? game.pos.kingOf(game.turn) : null}
          interactive={canMove && !pendingPromo}
          onSquare={clickSquare}
        />
        {pendingPromo && (
          <Overlay>
            <strong>升變為</strong>
            <div className="chess-promo">
              {PROMOTIONS.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="secondary"
                  aria-label={PROMO_NAMES[type]}
                  onClick={() => choosePromotion(type)}
                >
                  <Piece piece={type * game.turn} />
                </button>
              ))}
            </div>
            <button type="button" className="link" onClick={() => setPromo(null)}>
              取消
            </button>
          </Overlay>
        )}
        {outcome && dismissed !== game && (
          <Overlay>
            <strong className="chess-result">{outcome.title}</strong>
            <span>{outcome.detail}</span>
            <div className="game-toolbar">
              <button type="button" onClick={restart} disabled={!canRestart}>
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
        {mode !== 'online' && (
          <>
            <button type="button" className="secondary" onClick={undo} disabled={undoTo < 0}>
              悔棋
            </button>
            <button type="button" className="secondary" onClick={newGame} disabled={moves.length === 0}>
              新局
            </button>
          </>
        )}
        {mode === 'online' && room.code && !game.result && (
          <button type="button" className="danger" onClick={resign} disabled={me === null || !room.connected}>
            認輸
          </button>
        )}
        {mode === 'online' && game.result && (
          <button type="button" onClick={restart} disabled={!canRestart}>
            再來一局
          </button>
        )}
        <button type="button" className="secondary" onClick={() => setFlip((f) => !f)}>
          翻轉棋盤
        </button>
      </Toolbar>
    </GameLayout>
  )
}
