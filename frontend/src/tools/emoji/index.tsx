import {
  memo,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { codepoints, loadEmojiData, searchEmojis, withTone, type EmojiData, type Variant } from './data'
import './emoji.css'

type Mode = 'copy' | 'compose'
type Section = { key: string; title: string; icon: string; items: Variant[] }

const RECENT_KEY = 'tools:emoji:recent'
const TONE_KEY = 'tools:emoji:tone'
const MODE_KEY = 'tools:emoji:mode'
const RECENT_MAX = 24

// 跟 emoji.css 的格子大小一致，用來估算還沒畫出來的分類有多高
const CELL = 44
const GAP = 2
const HEADING = 46

/** 滑鼠停在格子上這麼久才更新詳細資訊，移向下方面板時經過的格子不會蓋掉 */
const HOVER_MS = 150
const LONG_PRESS_MS = 450
const MOVE_TOLERANCE = 10

const TONES = [
  { label: '預設膚色', hand: '✋' },
  { label: '淺膚色', hand: '✋🏻' },
  { label: '中淺膚色', hand: '✋🏼' },
  { label: '一般膚色', hand: '✋🏽' },
  { label: '中深膚色', hand: '✋🏾' },
  { label: '深膚色', hand: '✋🏿' },
]

const MODES: { value: Mode; label: string }[] = [
  { value: 'copy', label: '點一下就複製' },
  { value: 'compose', label: '加到組合' },
]

// localStorage 在無痕模式或封鎖網站資料時可能讀寫失敗，失敗就當作沒有存過
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存不了就只在這次有效
  }
}

function readTone(): number {
  const n = Number(read(TONE_KEY))
  return Number.isInteger(n) && n >= 0 && n < TONES.length ? n : 0
}

function readMode(): Mode {
  return read(MODE_KEY) === 'compose' ? 'compose' : 'copy'
}

function readRecent(): string[] {
  try {
    const list: unknown = JSON.parse(read(RECENT_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 不是 https 或沒有權限，改用舊方法
  }
  const prev = document.activeElement as HTMLElement | null
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.opacity = '0'
  document.body.append(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  prev?.focus({ preventScroll: true })
  return ok
}

/** 把元素高度寫進 .emj 的 CSS 變數，讓格子捲動時不會躲在黏住的工具列或面板底下 */
function heightVar(name: string) {
  return (el: HTMLElement | null) => {
    const root = el?.closest<HTMLElement>('.emj')
    if (!el || !root) return
    const ro = new ResizeObserver(() => root.style.setProperty(name, `${el.offsetHeight}px`))
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.removeProperty(name)
    }
  }
}
const barHeightRef = heightVar('--emj-bar-h')
const detailHeightRef = heightVar('--emj-detail-h')

export default function EmojiTool() {
  const [data, setData] = useState<EmojiData | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    loadEmojiData().then(
      (d) => alive && setData(d),
      () => alive && setFailed(true),
    )
    return () => {
      alive = false
    }
  }, [attempt])

  if (failed) {
    return (
      <div className="stack">
        <p className="error">emoji 資料載入失敗，請檢查網路連線。</p>
        <button
          type="button"
          onClick={() => {
            setFailed(false)
            setAttempt((a) => a + 1)
          }}
        >
          重試
        </button>
      </div>
    )
  }
  if (!data) {
    return (
      <p className="muted emj-loading" role="status">
        <span className="emj-spin" aria-hidden="true">
          😀
        </span>
        正在載入 emoji 資料…
      </p>
    )
  }
  return <Picker data={data} />
}

function Picker({ data }: { data: EmojiData }) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [tone, setTone] = useState(readTone)
  const [mode, setMode] = useState(readMode)
  const [compose, setCompose] = useState('')
  const [recent, setRecent] = useState(readRecent)
  const [detail, setDetail] = useState<Variant | null>(null)
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  const [activeKey, setActiveKey] = useState('')
  const [cols, setCols] = useState(8)

  const bodyRef = useRef<HTMLDivElement>(null)
  const chipsRef = useRef<HTMLElement>(null)
  /** 方向鍵移動用：整個 emoji 區只有一格可以 Tab 進來 */
  const roving = useRef<HTMLElement | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const pointerType = useRef('mouse')
  /** 長按已經開了詳細資訊，接下來那個 click 不要複製 */
  const skipClick = useRef(false)
  /** 關掉面板後把焦點還給格子，這次聚焦不要又把面板打開 */
  const quietFocus = useRef(false)

  const searching = deferredQuery.trim() !== ''
  const results = useMemo(
    () => searchEmojis(data.all, deferredQuery).map((e) => withTone(e, tone)),
    [data, deferredQuery, tone],
  )
  const sections = useMemo<Section[]>(
    () =>
      data.groups.map((g) => ({
        key: `g${g.id}`,
        title: g.name,
        icon: g.icon,
        items: g.emojis.map((e) => withTone(e, tone)),
      })),
    [data, tone],
  )
  const recentItems = useMemo(
    () => recent.map((h) => data.byHex.get(h)).filter((v): v is Variant => v !== undefined),
    [data, recent],
  )
  const hasRecent = recentItems.length > 0
  const firstKey = hasRecent ? 'recent' : (sections[0]?.key ?? '')

  // 依實際寬度算一列幾格，估算分類高度給 content-visibility 用
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const ro = new ResizeObserver(() => {
      setCols(Math.max(1, Math.floor((body.clientWidth + GAP) / (CELL + GAP))))
    })
    ro.observe(body)
    return () => ro.disconnect()
  }, [])

  // 確保 emoji 區永遠有一格能用 Tab 進來（原本那格可能因為搜尋或換膚色被拿掉了）
  useEffect(() => {
    const body = bodyRef.current
    if (!body || (roving.current && body.contains(roving.current))) return
    const first = body.querySelector<HTMLElement>('.emj-cell')
    if (first) first.tabIndex = 0
    roving.current = first
  })

  // 捲動時標出目前所在的分類
  useEffect(() => {
    if (searching) return
    let raf = 0
    const update = () => {
      raf = 0
      const body = bodyRef.current
      const bar = body?.parentElement?.querySelector('.emj-bar')
      if (!body || !bar) return
      const line = bar.getBoundingClientRect().bottom + 1
      let current = firstKey
      for (const sec of body.querySelectorAll<HTMLElement>('.emj-section')) {
        if (sec.getBoundingClientRect().top > line) break
        current = sec.dataset.key ?? current
      }
      setActiveKey(current)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [searching, firstKey])

  // 目前的分類標籤捲進可見範圍（只在標籤列裡橫向捲動）
  useEffect(() => {
    const box = chipsRef.current
    const chip = box?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!box || !chip) return
    const left = chip.offsetLeft
    const right = left + chip.offsetWidth
    if (left < box.scrollLeft) box.scrollTo({ left: left - 8, behavior: 'smooth' })
    else if (right > box.scrollLeft + box.clientWidth)
      box.scrollTo({ left: right - box.clientWidth + 8, behavior: 'smooth' })
  }, [activeKey])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1600)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current)
      if (press.current) clearTimeout(press.current.timer)
    },
    [],
  )

  function notify(text: string) {
    setToast({ text, id: Date.now() })
  }

  async function copy(text: string, message: string) {
    notify((await copyText(text)) ? message : '複製失敗，請手動選取複製')
  }

  function remember(v: Variant) {
    const next = [v.hex, ...recent.filter((h) => h !== v.hex)].slice(0, RECENT_MAX)
    setRecent(next)
    write(RECENT_KEY, JSON.stringify(next))
  }

  function choose(v: Variant) {
    remember(v)
    if (mode === 'compose') setCompose((c) => c + v.char)
    else void copy(v.char, `已複製 ${v.char}`)
  }

  function clearRecent() {
    setRecent([])
    write(RECENT_KEY, '[]')
  }

  function changeTone(t: number) {
    setTone(t)
    write(TONE_KEY, String(t))
  }

  function changeMode(m: Mode) {
    setMode(m)
    write(MODE_KEY, m)
  }

  function backspace() {
    // 用字素切開，才不會把 👨‍👩‍👧 或膚色拆成一半
    const parts = Array.from(new Intl.Segmenter().segment(compose), (s) => s.segment)
    setCompose(parts.slice(0, -1).join(''))
  }

  function closeDetail() {
    const inside = document.activeElement?.closest('.emj-detail')
    setDetail(null)
    const cell = roving.current
    if (!inside || !cell) return
    quietFocus.current = true
    cell.focus({ preventScroll: true })
    quietFocus.current = false
    cell.scrollIntoView({ block: 'nearest' })
  }

  function jump(key: string) {
    document.getElementById(`emj-${key}`)?.scrollIntoView({ block: 'start' })
  }

  // ---- emoji 格子的事件都委派到外層，不用每格各掛一組 ----

  function cellOf(target: EventTarget | null): { el: HTMLElement; v: Variant } | null {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>('.emj-cell')
    const v = el?.dataset.hex ? data.byHex.get(el.dataset.hex) : undefined
    return el && v ? { el, v } : null
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
    const hit = cellOf(e.target)
    if (!hit) return
    const timer = setTimeout(() => {
      press.current = null
      skipClick.current = true
      navigator.vibrate?.(15)
      setDetail(hit.v)
    }, LONG_PRESS_MS)
    press.current = { x: e.clientX, y: e.clientY, timer }
  }

  function onPointerMove(e: PointerEvent) {
    const p = press.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) cancelPress()
  }

  function onPointerOver(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return
    clearTimeout(hoverTimer.current)
    const hit = cellOf(e.target)
    if (hit) hoverTimer.current = setTimeout(() => setDetail(hit.v), HOVER_MS)
  }

  function onClick(e: MouseEvent) {
    if (skipClick.current) {
      skipClick.current = false
      return
    }
    const hit = cellOf(e.target)
    if (!hit) return
    choose(hit.v)
    // 滑鼠或鍵盤（detail 為 0）順便顯示詳細資訊；觸控要長按才顯示，免得面板一直跳出來
    if (e.detail === 0 || pointerType.current === 'mouse') {
      clearTimeout(hoverTimer.current)
      setDetail(hit.v)
    }
  }

  function onContextMenu(e: MouseEvent) {
    const hit = cellOf(e.target)
    if (!hit) return
    e.preventDefault()
    // 觸控長按也會觸發 contextmenu，那已經由長按計時器處理了
    if (pointerType.current === 'mouse') setDetail(hit.v)
  }

  function onFocus(e: FocusEvent) {
    const hit = cellOf(e.target)
    if (!hit) return
    if (roving.current !== hit.el) {
      if (roving.current) roving.current.tabIndex = -1
      hit.el.tabIndex = 0
      roving.current = hit.el
    }
    if (!quietFocus.current && hit.el.matches(':focus-visible')) setDetail(hit.v)
  }

  function onKeyDown(e: KeyboardEvent) {
    const hit = cellOf(e.target)
    const body = bodyRef.current
    if (!hit || !body || e.altKey || e.ctrlKey || e.metaKey) return
    const cells = Array.from(body.querySelectorAll<HTMLElement>('.emj-cell'))
    const i = cells.indexOf(hit.el)
    let next: HTMLElement | undefined
    switch (e.key) {
      case 'ArrowRight':
        next = cells[i + 1]
        break
      case 'ArrowLeft':
        next = cells[i - 1]
        break
      case 'ArrowDown':
        next = verticalNeighbor(cells, i, 1)
        break
      case 'ArrowUp':
        next = verticalNeighbor(cells, i, -1)
        break
      case 'Home':
        next = cells[0]
        break
      case 'End':
        next = cells[cells.length - 1]
        break
      default:
        return
    }
    e.preventDefault()
    if (next) {
      next.focus({ preventScroll: true })
      next.scrollIntoView({ block: 'nearest' })
    }
  }

  function onSearchKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown') return
    const first = bodyRef.current?.querySelector<HTMLElement>('.emj-cell')
    if (!first) return
    e.preventDefault()
    first.focus()
  }

  return (
    <div
      className="emj"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && detail) closeDetail()
      }}
    >
      <div className="emj-controls">
        <input
          type="search"
          className="emj-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="搜尋：笑、貓、heart、:smile:"
          aria-label="搜尋 emoji（中文或英文）"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="emj-options">
          <div className="emj-seg" role="radiogroup" aria-label="點 emoji 時">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={mode === m.value}
                onClick={() => changeMode(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="emj-tones" role="radiogroup" aria-label="膚色">
            {TONES.map((t, i) => (
              <button
                key={t.label}
                type="button"
                role="radio"
                aria-checked={tone === i}
                aria-label={t.label}
                title={t.label}
                onClick={() => changeTone(i)}
              >
                {t.hand}
              </button>
            ))}
          </div>
        </div>
      </div>

      {(!searching || mode === 'compose') && (
        <div className="emj-bar" ref={barHeightRef}>
          {mode === 'compose' && (
            <div className="emj-compose">
              <input
                value={compose}
                onChange={(e) => setCompose(e.target.value)}
                placeholder="點 emoji 加到這裡"
                aria-label="組合的文字"
              />
              <button type="button" onClick={() => void copy(compose, '已複製組合')} disabled={!compose}>
                複製
              </button>
              <button
                type="button"
                className="secondary emj-icon-btn"
                onClick={backspace}
                disabled={!compose}
                aria-label="刪除最後一個"
                title="刪除最後一個"
              >
                ⌫
              </button>
              <button type="button" className="secondary" onClick={() => setCompose('')} disabled={!compose}>
                清除
              </button>
            </div>
          )}
          {!searching && (
            <nav className="emj-chips" ref={chipsRef} aria-label="emoji 分類">
              {hasRecent && (
                <button
                  type="button"
                  aria-current={activeKey === 'recent' ? 'true' : undefined}
                  onClick={() => jump('recent')}
                >
                  <span className="emj-glyph" aria-hidden="true">
                    🕘
                  </span>
                  最近使用
                </button>
              )}
              {sections.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-current={activeKey === s.key ? 'true' : undefined}
                  onClick={() => jump(s.key)}
                >
                  <span className="emj-glyph" aria-hidden="true">
                    {s.icon}
                  </span>
                  {s.title}
                </button>
              ))}
            </nav>
          )}
        </div>
      )}

      <div
        className="emj-body"
        ref={bodyRef}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerOver={onPointerOver}
        onPointerLeave={() => clearTimeout(hoverTimer.current)}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      >
        {searching ? (
          <section aria-label="搜尋結果">
            <p className="muted emj-count" role="status">
              {results.length > 0 ? `找到 ${results.length} 個` : `找不到符合「${deferredQuery.trim()}」的 emoji`}
            </p>
            <EmojiGrid items={results} />
          </section>
        ) : (
          <>
            {hasRecent && (
              <section className="emj-section" id="emj-recent" data-key="recent" aria-labelledby="emj-recent-h">
                <div className="emj-heading-row">
                  <h2 className="emj-heading" id="emj-recent-h">
                    最近使用
                  </h2>
                  <button type="button" className="link emj-clear" onClick={clearRecent}>
                    清除
                  </button>
                </div>
                <EmojiGrid items={recentItems} />
              </section>
            )}
            <Sections sections={sections} cols={cols} />
          </>
        )}
      </div>

      {detail && (
        <Details
          v={detail}
          mode={mode}
          onCopyEmoji={() => {
            remember(detail)
            void copy(detail.char, `已複製 ${detail.char}`)
          }}
          onCopy={(text) => void copy(text, `已複製 ${text}`)}
          onAdd={() => {
            remember(detail)
            setCompose((c) => c + detail.char)
          }}
          onClose={closeDetail}
        />
      )}

      <div className="emj-toast" role="status" aria-live="polite">
        {toast && <span key={toast.id}>{toast.text}</span>}
      </div>
    </div>
  )
}

/** 上下鍵：找下一列（或上一列）裡水平位置最接近的那格 */
function verticalNeighbor(cells: HTMLElement[], i: number, dir: 1 | -1): HTMLElement | undefined {
  const from = cells[i].getBoundingClientRect()
  let rowTop: number | null = null
  let best: HTMLElement | undefined
  let bestDist = Infinity
  for (let j = i + dir; j >= 0 && j < cells.length; j += dir) {
    const r = cells[j].getBoundingClientRect()
    if (rowTop === null) {
      if (Math.abs(r.top - from.top) < 1) continue
      rowTop = r.top
    } else if (Math.abs(r.top - rowTop) >= 1) break
    const d = Math.abs(r.left - from.left)
    if (d < bestDist) {
      bestDist = d
      best = cells[j]
    }
  }
  return best
}

const EmojiGrid = memo(function EmojiGrid({ items }: { items: Variant[] }) {
  return (
    <div className="emj-grid">
      {items.map((v) => (
        <button key={v.hex} type="button" className="emj-cell" data-hex={v.hex} aria-label={v.zh} tabIndex={-1}>
          {v.char}
        </button>
      ))}
    </div>
  )
})

// 分類很多格，畫面外的交給 content-visibility 跳過，這裡先估好高度讓捲軸和跳轉準確
const Sections = memo(function Sections({ sections, cols }: { sections: Section[]; cols: number }) {
  return sections.map((s) => {
    const rows = Math.ceil(s.items.length / cols)
    return (
      <section
        key={s.key}
        className="emj-section emj-lazy"
        id={`emj-${s.key}`}
        data-key={s.key}
        aria-labelledby={`emj-${s.key}-h`}
        style={{ containIntrinsicBlockSize: `auto ${HEADING + rows * (CELL + GAP) - GAP}px` }}
      >
        <h2 className="emj-heading" id={`emj-${s.key}-h`}>
          {s.title}
        </h2>
        <EmojiGrid items={s.items} />
      </section>
    )
  })
})

function Details({
  v,
  mode,
  onCopyEmoji,
  onCopy,
  onAdd,
  onClose,
}: {
  v: Variant
  mode: Mode
  onCopyEmoji: () => void
  onCopy: (text: string) => void
  onAdd: () => void
  onClose: () => void
}) {
  const cps = codepoints(v.char)
  const cpText = cps.map((c) => `U+${c}`).join(' ')
  const entity = cps.map((c) => `&#x${c};`).join('')
  return (
    <aside className="emj-detail" ref={detailHeightRef} aria-label={`${v.zh} 的詳細資訊`}>
      <div className="emj-detail-glyph" aria-hidden="true">
        {v.char}
      </div>
      <div className="emj-detail-info">
        <strong>{v.zh}</strong>
        {v.en && <span lang="en">{v.en}</span>}
        <code>{cpText}</code>
        {v.shortcodes.length > 0 && (
          <span className="emj-codes">
            {v.shortcodes.map((c) => (
              <code key={c}>:{c}:</code>
            ))}
          </span>
        )}
      </div>
      <button type="button" className="secondary emj-icon-btn emj-close" onClick={onClose} aria-label="關閉詳細資訊">
        ×
      </button>
      <div className="emj-detail-actions">
        {mode === 'compose' && (
          <button type="button" onClick={onAdd}>
            加到組合
          </button>
        )}
        <button type="button" className={mode === 'compose' ? 'secondary' : ''} onClick={onCopyEmoji}>
          複製 <span className="emj-glyph">{v.char}</span>
        </button>
        <button type="button" className="secondary" onClick={() => onCopy(cpText)}>
          複製碼位
        </button>
        <button type="button" className="secondary" onClick={() => onCopy(entity)}>
          複製 HTML
        </button>
      </div>
    </aside>
  )
}
