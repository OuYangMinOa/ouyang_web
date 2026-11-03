import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'

/** 一格長什麼樣子 */
export type CellLook = { text: string; className: string; label: string }

/**
 * 格子被操作的方式：
 * - `primary`：一般點擊（照目前的工具挖開或插旗）
 * - `alt`：右鍵或長按（和目前工具相反的動作）
 * - `flag`：鍵盤的 F，一律插旗／拔旗
 */
export type Press = 'primary' | 'alt' | 'flag'

const LONG_PRESS_MS = 350
/** 手指移動超過這個距離就當作在捲動棋盤，不算長按 */
const MOVE_TOLERANCE = 10

// 直向螢幕時把高級（30×16）轉成 16 欄 × 30 列，比較好捲動和點
const PORTRAIT = '(orientation: portrait)'
function subscribePortrait(cb: () => void) {
  const mq = window.matchMedia(PORTRAIT)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const isPortrait = () => window.matchMedia(PORTRAIT).matches

/**
 * 踩地雷的棋盤（單人和線上競速共用）：負責畫格子、長按／右鍵插旗、鍵盤操作，以及直向螢幕時轉置。
 * 規則不在這裡，每一格長怎樣由 `look` 決定，操作交給 `onPress`。
 */
export function MineBoard({
  cols,
  rows,
  look,
  onPress,
  done,
  className,
}: {
  cols: number
  rows: number
  look: (i: number) => CellLook
  onPress: (i: number, press: Press) => void
  /** 結束了：格子不再顯示可以點的樣子 */
  done: boolean
  className?: string
}) {
  const portrait = useSyncExternalStore(subscribePortrait, isPortrait, () => false)
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const pointerType = useRef('mouse')
  /** 長按已經處理過，接下來那個 click 要忽略 */
  const skipClick = useRef(false)

  // 長按的計時器在 render 之後才觸發，透過 ref 呼叫最新的 onPress
  const pressRef = useRef(onPress)
  useEffect(() => {
    pressRef.current = onPress
  })

  function indexOf(target: EventTarget): number | null {
    const el = (target as HTMLElement).closest<HTMLElement>('[data-i]')
    return el ? Number(el.dataset.i) : null
  }

  function cancelPress() {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }

  function onPointerDown(e: PointerEvent) {
    pointerType.current = e.pointerType
    skipClick.current = false
    cancelPress()
    if (e.pointerType === 'mouse') return
    const i = indexOf(e.target)
    if (i === null) return
    const timer = setTimeout(() => {
      press.current = null
      skipClick.current = true
      navigator.vibrate?.(15)
      pressRef.current(i, 'alt')
    }, LONG_PRESS_MS)
    press.current = { x: e.clientX, y: e.clientY, timer }
  }

  function onPointerMove(e: PointerEvent) {
    const p = press.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) cancelPress()
  }

  function onClick(e: MouseEvent) {
    if (skipClick.current) {
      skipClick.current = false
      return
    }
    const i = indexOf(e.target)
    if (i !== null) onPress(i, 'primary')
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault()
    // 觸控長按也會觸發 contextmenu，那已經由長按計時器處理了
    if (pointerType.current !== 'mouse') return
    const i = indexOf(e.target)
    if (i !== null) onPress(i, 'alt')
  }

  function onKeyDown(e: KeyboardEvent) {
    // 鍵盤操作：Enter／空白鍵挖開（按鈕預設行為），F 插旗
    if (e.code !== 'KeyF' || e.ctrlKey || e.metaKey || e.altKey) return
    const i = indexOf(e.target)
    if (i !== null) onPress(i, 'flag')
  }

  const transposed = portrait && cols > rows
  const viewCols = transposed ? rows : cols
  const viewRows = transposed ? cols : rows

  const cells = []
  for (let vr = 0; vr < viewRows; vr++) {
    for (let vc = 0; vc < viewCols; vc++) {
      // 轉置時畫面上的 (列, 欄) 對應到邏輯上的 (欄, 列)；相鄰關係不變，所以規則不用改
      const i = transposed ? vc * cols + vr : vr * cols + vc
      const view = look(i)
      cells.push(
        <button
          key={i}
          type="button"
          data-i={i}
          className={view.className}
          aria-label={`第 ${vr + 1} 列第 ${vc + 1} 欄：${view.label}`}
        >
          {view.text}
        </button>,
      )
    }
  }

  return (
    <div className="ms-scroll">
      <div
        className={['ms-board', done ? 'done' : '', className ?? ''].filter(Boolean).join(' ')}
        style={{ '--cols': viewCols, '--rows': viewRows } as CSSProperties}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerLeave={cancelPress}
        onKeyDown={onKeyDown}
      >
        {cells}
      </div>
    </div>
  )
}
