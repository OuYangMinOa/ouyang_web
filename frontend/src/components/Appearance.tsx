import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  setStylePreference,
  setThemePreference,
  useAppearance,
  type Origin,
  type StylePreference,
  type ThemePreference,
} from '../theme'
import './Appearance.css'

const STYLES: { value: StylePreference; name: string; desc: string }[] = [
  { value: 'ink', name: '墨與陽', desc: '宣紙與墨，乾淨俐落' },
  { value: 'doodle', name: '塗鴉', desc: '手畫線條，筆記本與黑板' },
  { value: 'mist', name: '山嵐', desc: '霧灰與松綠，安靜耐看' },
  { value: 'sticker', name: '貼紙', desc: '點點紙、粗黑框，一張張貼上去' },
]

const THEMES: { value: ThemePreference; icon: string; label: string }[] = [
  { value: 'system', icon: '◐', label: '跟隨系統' },
  { value: 'light', icon: '☀', label: '亮色' },
  { value: 'dark', icon: '☾', label: '深色' },
]

const HINTS: Record<StylePreference, { light: string; dark: string }> = {
  ink: { light: '亮色是宣紙上的墨', dark: '深色是夜裡的餘燼' },
  doodle: { light: '亮色是方格筆記本上的原子筆和螢光筆', dark: '深色是黑板上的粉筆' },
  mist: { light: '亮色是清晨起霧的山', dark: '深色是入夜的山谷' },
  sticker: { light: '亮色是奶油色點點紙上的貼紙', dark: '深色是黑卡紙上的貼紙' },
}

/** 滑鼠按著色票移動超過這麼多 px 才算拖曳，不然就是點一下 */
const DRAG_START = 8

/** 色票的縮圖：data-preview 會把那個風格＋深淺的變數套在縮圖上（index.css） */
function Thumb({ preview }: { preview: string }) {
  return (
    <span className="appearance-thumb" data-preview={preview} aria-hidden="true">
      <span className="thumb-bar">
        <b>歐陽天地</b>
        <i />
        <i />
      </span>
      <span className="thumb-title">
        小<span className="thumb-mark">天地</span>
      </span>
      <span className="thumb-cards">
        <span />
        <span />
      </span>
      <span className="thumb-button">按鈕</span>
    </span>
  )
}

/** 元素的正中央，新的外觀從這裡暈開 */
function centerOf(element: Element): Origin {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/**
 * 頁首右上角的「外觀」：打開一塊不擋畫面的面板（popover），裡面是風格的色票和深淺。
 * 點色票，新的風格從色票暈開到整個畫面；用滑鼠也可以把色票拖出去，在頁面上放開的地方暈開。
 * 轉場本身在 theme.ts 和 Appearance.css 最後面。選了馬上套用，記在這台裝置上。
 */
export default function Appearance() {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLSpanElement>(null)
  const { style, theme, dark } = useAppearance()
  const styleName = STYLES.find((s) => s.value === style)?.name
  const themeLabel = THEMES.find((t) => t.value === theme)?.label
  const mode = dark ? 'dark' : 'light'
  const hint = HINTS[style][mode]

  // 面板貼在按鈕下面、右邊對齊按鈕（手機是從下面滑上來的面板，用不到這兩個值）
  function place() {
    const rect = button.current?.getBoundingClientRect()
    if (!rect || !panel.current) return
    panel.current.style.setProperty('--panel-top', `${Math.round(rect.bottom + 10)}px`)
    panel.current.style.setProperty('--panel-right', `${Math.round(window.innerWidth - rect.right)}px`)
  }
  useEffect(() => {
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [])

  // ---- 把色票拖到頁面上 ----
  // press 是按下去還沒放開的那一張；移動超過 DRAG_START 才變成拖曳（dragging），這時跟著游標的小圓貼紙才出現
  const press = useRef<{ value: StylePreference; x: number; y: number; dragged: boolean } | null>(null)
  const [dragging, setDragging] = useState<StylePreference | null>(null)
  // 拖曳結束後瀏覽器還會補一個 click，要吃掉，不然等於又點了一次色票
  const swallowClick = useRef(false)

  function moveGhost(x: number, y: number) {
    if (ghost.current) ghost.current.style.translate = `${x}px ${y}px`
  }
  // 小圓貼紙出現的那一刻就要在游標底下
  useEffect(() => {
    if (dragging && press.current) moveGhost(press.current.x, press.current.y)
  }, [dragging])

  function onPointerDown(e: ReactPointerEvent<HTMLLabelElement>, value: StylePreference) {
    // 觸控螢幕上拖曳是捲動面板，只有滑鼠和觸控筆能拖色票
    if (e.pointerType === 'touch' || e.button !== 0) return
    press.current = { value, x: e.clientX, y: e.clientY, dragged: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: ReactPointerEvent<HTMLLabelElement>) {
    const p = press.current
    if (!p) return
    if (!p.dragged) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START) return
      p.dragged = true
      setDragging(p.value)
    }
    p.x = e.clientX
    p.y = e.clientY
    moveGhost(p.x, p.y)
  }
  function onPointerUp(e: ReactPointerEvent<HTMLLabelElement>) {
    const p = press.current
    press.current = null
    if (!p?.dragged) return
    swallowClick.current = true
    setDragging(null)
    // 放回面板上當作反悔；放在頁面上就從那個點換過去
    const rect = panel.current?.getBoundingClientRect()
    const overPanel =
      rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
    if (!overPanel) setStylePreference(p.value, { x: e.clientX, y: e.clientY })
  }
  function onPointerCancel() {
    press.current = null
    setDragging(null)
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="appearance-button"
        popoverTarget={id}
        aria-haspopup="dialog"
        title={`外觀：${styleName}・${themeLabel}`}
        onClick={place}
      >
        <span aria-hidden="true">🎨</span>
        <span className="appearance-label">外觀</span>
      </button>

      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-labelledby={`${id}-title`}
        className={`appearance-panel ${dragging ? 'is-dragging' : ''}`}
      >
        <div className="appearance-body">
          <header className="appearance-head">
            <h2 id={`${id}-title`}>外觀</h2>
            <button
              type="button"
              className="appearance-close"
              popoverTarget={id}
              popoverTargetAction="hide"
              aria-label="關閉"
            >
              ✕
            </button>
          </header>

          <section className="appearance-section">
            <h3 id={`${id}-style`}>風格</h3>
            <div className="appearance-styles" role="radiogroup" aria-labelledby={`${id}-style`}>
              {STYLES.map((s) => (
                <label
                  key={s.value}
                  className="appearance-option"
                  onPointerDown={(e) => onPointerDown(e, s.value)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerCancel}
                  onClickCapture={(e) => {
                    if (!swallowClick.current) return
                    swallowClick.current = false
                    e.preventDefault()
                  }}
                  // 圖片預設的拖曳會搶走 pointer 事件
                  onDragStart={(e) => e.preventDefault()}
                >
                  <input
                    type="radio"
                    name={`${id}-style`}
                    value={s.value}
                    checked={style === s.value}
                    onChange={(e) => setStylePreference(s.value, centerOf(e.currentTarget.parentElement!))}
                  />
                  <Thumb preview={`${s.value}-${mode}`} />
                  <span className="appearance-option-text">
                    <strong>{s.name}</strong>
                    <small>{s.desc}</small>
                  </span>
                  <span className="appearance-check" aria-hidden="true">
                    ✓
                  </span>
                </label>
              ))}
            </div>
            <p className="appearance-hint appearance-tip">
              點一下就換<span className="appearance-tip-drag">；也可以把它拖到頁面上，從放開的地方換過去</span>。
            </p>
          </section>

          <section className="appearance-section">
            <h3 id={`${id}-theme`}>深淺</h3>
            <div className="appearance-themes" role="radiogroup" aria-labelledby={`${id}-theme`}>
              {THEMES.map((t) => (
                <label key={t.value}>
                  <input
                    type="radio"
                    name={`${id}-theme`}
                    value={t.value}
                    checked={theme === t.value}
                    onChange={(e) => setThemePreference(t.value, centerOf(e.currentTarget.parentElement!))}
                  />
                  <span className="appearance-theme-icon" aria-hidden="true">
                    {t.icon}
                  </span>
                  {t.label}
                </label>
              ))}
            </div>
            <p className="appearance-hint">
              {theme === 'system' ? `跟著系統切換，現在是${dark ? '深色' : '亮色'}：${hint}。` : `${hint}。`}
              記在這台裝置上。
            </p>
          </section>
        </div>

        {/* 拖曳時跟著游標的小圓貼紙，用的是那個風格的顏色 */}
        {dragging && <span ref={ghost} className="appearance-ghost" data-preview={`${dragging}-${mode}`} aria-hidden="true" />}
      </div>
    </>
  )
}
