import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { load, save } from '../shared/storage'
import { GameLayout, Overlay, Segmented, StatusLine, Toolbar } from '../shared/ui'
import {
  SIZES,
  TARGET,
  UNDOS,
  canMove,
  canUndo,
  isGame,
  maxTile,
  move,
  newGame,
  reachedTarget,
  undo,
  type Dir,
  type Game,
  type Size,
  type ViewTile,
} from './logic'
import './merge.css'

type Board = { game: Game; view: ViewTile[] }
type Records = Partial<Record<Size, number>>

// 用 code 而不是 key：注音輸入法開著時 WASD 一樣能用
const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
}

const SWIPE_PX = 24

function loadSize(): Size {
  const s = load<unknown>('merge:size', 4)
  return SIZES.includes(s as Size) ? (s as Size) : 4
}

/** 這個大小的盤面有存檔就接著玩，沒有就開新的 */
function loadBoard(size: Size): Board {
  const saved = load<unknown>(`merge:game:${size}`, null)
  const game = isGame(saved, size) ? saved : newGame(size)
  return { game, view: game.tiles.map((t) => ({ ...t, kind: 'new' })) }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

/** 方塊的顏色分級：2 是第 1 級，2048 是第 11 級，再大都用第 12 級 */
function tileClass(t: ViewTile): string {
  const level = Math.min(Math.log2(t.value), 12)
  const digits = Math.min(String(t.value).length, 5)
  return `mg-tile mg-v${level} mg-d${digits} mg-${t.kind}`
}

export default function Merge() {
  const [size, setSize] = useState(loadSize)
  const [board, setBoard] = useState(() => loadBoard(size))
  const [records, setRecords] = useState<Records>(() => load<Records>('merge:best', {}))
  // 「+分數」的小字：key 每一步都換，動畫才會重播
  const [gain, setGain] = useState<{ key: number; value: number } | null>(null)
  const swipe = useRef<{ x: number; y: number; done: boolean } | null>(null)

  const { game, view } = board
  const over = !canMove(game)
  const won = reachedTarget(game)
  const best = Math.max(records[size] ?? 0, game.score)

  useEffect(() => {
    save(`merge:game:${game.size}`, game)
  }, [game])

  function slide(dir: Dir) {
    if (over || won) return
    const r = move(game, dir)
    if (!r.moved) return
    setBoard({ game: r.game, view: r.view })
    if (r.gained > 0) setGain({ key: r.game.moves, value: r.gained })
    if (r.game.score > (records[size] ?? 0)) {
      const next = { ...records, [size]: r.game.score }
      setRecords(next)
      save('merge:best', next)
    }
  }

  function back() {
    if (!canUndo(game)) return
    const prev = undo(game)
    setBoard({ game: prev, view: prev.tiles.map((t) => ({ ...t, kind: 'stay' })) })
    setGain(null)
  }

  function restart() {
    if (game.moves > 0 && !over && !window.confirm('放棄目前這局，重新開始？')) return
    const fresh = newGame(size)
    setBoard({ game: fresh, view: fresh.tiles.map((t) => ({ ...t, kind: 'new' })) })
    setGain(null)
  }

  function keepPlaying() {
    setBoard({ game: { ...game, keepPlaying: true }, view: game.tiles.map((t) => ({ ...t, kind: 'stay' })) })
  }

  function changeSize(next: Size) {
    if (next === size) return
    // 每種大小各有自己的存檔，換過去不會弄丟這一局
    setSize(next)
    save('merge:size', next)
    setBoard(loadBoard(next))
    setGain(null)
  }

  function onKey(e: KeyboardEvent) {
    if (e.altKey || isTyping(e.target)) return
    if (e.code === 'KeyZ' || e.code === 'Backspace') {
      if (e.code === 'Backspace' && (e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      back()
      return
    }
    if (e.ctrlKey || e.metaKey) return
    const d = KEY_DIRS[e.code]
    if (d) {
      e.preventDefault()
      slide(d)
    }
  }

  // 事件只註冊一次，透過 ref 呼叫最新版本的函式
  const actions = useRef({ onKey })
  useEffect(() => {
    actions.current = { onKey }
  })
  useEffect(() => {
    const key = (e: KeyboardEvent) => actions.current.onKey(e)
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    swipe.current = { x: e.clientX, y: e.clientY, done: false }
  }

  function onPointerMove(e: PointerEvent) {
    const s = swipe.current
    if (!s || s.done) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return
    // 一次滑動只走一步，放開再滑下一步
    s.done = true
    slide(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up')
  }

  const target = TARGET[size]
  const recordNow = game.score > 0 && game.score >= (records[size] ?? 0)
  const undoLabel = `↶ 上一步（剩 ${game.undosLeft} 次）`
  // 依 id 排：舊方塊的 DOM 順序不會變（搬動 DOM 節點會打斷滑動的動畫），新的接在後面、疊在上面。
  // 被合併掉的方塊沿用原本的 id 和 key，才會從原來的位置滑過去
  const tiles = [...view].sort((a, b) => a.id - b.id)

  const side = (
    <>
      <Segmented
        label="盤面"
        value={size}
        options={SIZES.map((s) => ({ value: s, label: `${s}×${s}` }))}
        onChange={changeSize}
      />
      <p className="muted">
        方塊會一起往同一個方向滑到底，兩個相同的數字撞在一起就合成一個兩倍的。每走一步會冒出一個新的 2 或 4，
        {size}×{size} 合出 {target} 就過關，之後可以繼續玩。
      </p>
      <p className="muted">
        方向鍵／WASD 移動，Z 或 Backspace 退回上一步（每局 {UNDOS} 次）；手機在盤面上滑動。每種盤面各自存檔，換過去再換回來會接著玩。
      </p>
    </>
  )

  return (
    <GameLayout side={side}>
      <StatusLine tone={over ? 'danger' : won ? 'ok' : undefined}>
        <span className="mg-score">
          分數 {game.score}
          {gain && (
            <span key={gain.key} className="mg-gain" aria-hidden="true">
              +{gain.value}
            </span>
          )}
        </span>
        <span className="mg-best"> · 最高 {best}</span>
      </StatusLine>

      <div
        className="board-box mg-box"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (swipe.current = null)}
        onPointerCancel={() => (swipe.current = null)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="mg-board"
          style={{ '--n': size } as CSSProperties}
          role="img"
          aria-label={`${size}×${size} 盤面，最大的方塊是 ${maxTile(game)}`}
        >
          <div className="mg-slots" aria-hidden="true">
            {Array.from({ length: size * size }, (_, i) => (
              <div key={i} className="mg-slot" />
            ))}
          </div>
          <div className="mg-tiles" aria-hidden="true">
            {tiles.map((t) => (
              <div
                key={t.id}
                className={tileClass(t)}
                style={{ '--r': t.r, '--c': t.c } as CSSProperties}
              >
                <span className="mg-face">{t.value}</span>
              </div>
            ))}
          </div>
        </div>

        {won && !over && (
          <Overlay>
            <strong className="mg-overlay-title">🎉 合出 {target} 了！</strong>
            <span>
              {game.moves} 步，得分 {game.score}
            </span>
            <div className="mg-overlay-actions">
              <button type="button" onClick={keepPlaying}>
                繼續玩
              </button>
              <button type="button" className="secondary" onClick={restart}>
                重新開始
              </button>
            </div>
          </Overlay>
        )}
        {over && (
          <Overlay>
            <strong className="mg-overlay-title">沒有能走的了</strong>
            <span>
              得分 {game.score}
              {recordNow ? '，新紀錄！' : `（最高 ${best}）`}
            </span>
            <div className="mg-overlay-actions">
              <button type="button" onClick={restart}>
                再玩一次
              </button>
              {canUndo(game) && (
                <button type="button" className="secondary" onClick={back}>
                  {undoLabel}
                </button>
              )}
            </div>
          </Overlay>
        )}
      </div>

      <Toolbar>
        <button type="button" className="secondary" onClick={back} disabled={!canUndo(game)}>
          {undoLabel}
        </button>
        <button type="button" className="secondary" onClick={restart}>
          重新開始
        </button>
      </Toolbar>
    </GameLayout>
  )
}
