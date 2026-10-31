import { datamatrix } from 'bwip-js/browser'
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type HTMLAttributes } from 'react'
import { useVisitTracking } from '../visits'
import { encode, pad5, parseScanned, type FieldId, type Fields, type Mode } from './format'
import { canScanLive, decodeImageFile, liveDetector } from './scanner'
import './datamatrix.css'

// 隱藏頁面：不在任何選單裡，網址是 /bcs。誰來過記在 系統管理 › 頁面訪客。

type Entry = Partial<Record<FieldId, string>>
type ListKind = 'fav' | 'history'
type Lists = Record<ListKind, Record<Mode, Entry[]>>
type Toast = { message: string; kind: 'error' | 'success' | 'info'; id: number }

const STATE_KEY = 'dmx_state'
// 最愛和歷史記住的欄位；料件模式不含 DC 和 SER，套用時沿用目前的日期與序號
const QUICK_KEYS: Record<Mode, FieldId[]> = { slot: ['sloc', 'bin', 'styp'], item: ['model', 'mo', 'qty'] }
const HISTORY_MAX = 15
/** 打字停這麼久也自動記進歷史 */
const HISTORY_DELAY = 3000
const TOAST_MS = 2800

const MODES: { value: Mode; label: string; title: string }[] = [
  { value: 'slot', label: '倉位', title: '倉位資訊' },
  { value: 'item', label: '料件', title: '料件資訊' },
]

const FIELDS: Record<
  Mode,
  {
    id: FieldId
    label: string
    placeholder?: string
    type?: string
    inputMode?: HTMLAttributes<HTMLInputElement>['inputMode']
  }[]
> = {
  slot: [
    { id: 'sloc', label: 'SLOC', placeholder: '例如 A031' },
    { id: 'bin', label: 'BIN', placeholder: '例如 B01044' },
    { id: 'styp', label: 'STYP', placeholder: '例如 B04' },
  ],
  item: [
    { id: 'model', label: '料號 MODEL' },
    { id: 'mo', label: '批次 MO' },
    { id: 'qty', label: '數量 QTY', inputMode: 'numeric' },
    { id: 'dc', label: '日期 DC', type: 'date' },
  ],
}

const randomSer = () => Math.floor(Math.random() * 99999) + 1

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存不了就只在這次有效
  }
}

function loadSaved(): { mode: Mode; serNum: number; fields: Fields } {
  const s = (readJson(STATE_KEY) ?? {}) as Record<string, unknown>
  const text = (key: FieldId, fallback: string) => (typeof s[key] === 'string' ? s[key] : fallback)
  return {
    mode: s.mode === 'item' ? 'item' : 'slot',
    serNum: Number.isInteger(s.serNum) ? (s.serNum as number) : randomSer(),
    fields: {
      sloc: text('sloc', 'A031'),
      bin: text('bin', 'B01044'),
      styp: text('styp', 'B04'),
      model: text('model', ''),
      mo: text('mo', ''),
      qty: text('qty', ''),
      dc: text('dc', today()),
    },
  }
}

const listKey = (kind: ListKind, mode: Mode) => `dmx_${kind}_${mode}`

function loadList(kind: ListKind, mode: Mode): Entry[] {
  const list = readJson(listKey(kind, mode))
  return Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : []
}

function loadLists(): Lists {
  return {
    fav: { slot: loadList('fav', 'slot'), item: loadList('fav', 'item') },
    history: { slot: loadList('history', 'slot'), item: loadList('history', 'item') },
  }
}

function entryOf(mode: Mode, fields: Fields): Entry {
  return Object.fromEntries(QUICK_KEYS[mode].map((id) => [id, fields[id].trim().toUpperCase()]))
}

function sameEntry(mode: Mode, a: Entry, b: Entry) {
  return QUICK_KEYS[mode].every((id) => (a[id] ?? '') === (b[id] ?? ''))
}

/** 手機上 http 網站沒有 navigator.clipboard，改用隱藏的 textarea */
async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

function CameraIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

/** 即時掃描相機畫面，掃到第一個條碼就交給 onResult */
function LiveScanner({
  onResult,
  onError,
  onCancel,
}: {
  onResult: (raw: string) => void
  onError: () => void
  onCancel: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  // 父層每次重繪都會給新的函式，放在 ref 裡，相機才不會重開
  const handlers = useRef({ onResult, onError, onCancel })
  useEffect(() => {
    handlers.current = { onResult, onError, onCancel }
  })

  useEffect(() => {
    let active = true
    let stream: MediaStream | null = null
    let frame = 0

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        })
        const video = videoRef.current
        if (!active || !video) return
        video.srcObject = stream
        await video.play()
        const detector = liveDetector()
        const tick = async () => {
          if (!active) return
          try {
            const codes = await detector.detect(video)
            if (codes.length > 0 && active) {
              handlers.current.onResult(codes[0].rawValue)
              return
            }
          } catch {
            // 這一格解不出來就等下一格
          }
          frame = requestAnimationFrame(tick)
        }
        tick()
      } catch {
        if (active) handlers.current.onError()
      }
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handlers.current.onCancel()
    }

    start()
    window.addEventListener('keydown', onKey)
    return () => {
      active = false
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((t) => t.stop())
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div className="dmx-scanner" role="dialog" aria-label="掃描條碼">
      <video ref={videoRef} autoPlay playsInline muted />
      <div className="dmx-scan-ui">
        <div className="dmx-scan-frame">
          <span className="corner tl" />
          <span className="corner tr" />
          <span className="corner bl" />
          <span className="corner br" />
          <span className="dmx-scan-line" />
        </div>
        <p className="dmx-scan-hint">將條碼對準框內</p>
      </div>
      <button type="button" className="secondary dmx-scan-cancel" onClick={onCancel}>
        取消
      </button>
    </div>
  )
}

export default function DataMatrixPage() {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const codeRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const historyTimer = useRef(0)
  const copiedTimer = useRef(0)
  const track = useVisitTracking('bcs', rootRef)

  const [saved] = useState(loadSaved)
  const [mode, setMode] = useState(saved.mode)
  const [fields, setFields] = useState(saved.fields)
  const [serNum, setSerNum] = useState(saved.serNum)
  const [lists, setLists] = useState(loadLists)
  const [quickTab, setQuickTab] = useState<ListKind>('fav')
  const [copied, setCopied] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  // 要先知道能不能即時掃描：iOS 只允許在點擊的當下（不能 await 之後）打開選照片
  const [liveScan, setLiveScan] = useState(false)
  const [scanning, setScanning] = useState(false)

  const text = encode(mode, fields, serNum)
  const list = lists[quickTab][mode]
  const isFav = lists.fav[mode].some((e) => sameEntry(mode, e, entryOf(mode, fields)))

  useEffect(() => {
    canScanLive().then(setLiveScan)
    return () => {
      clearTimeout(historyTimer.current)
      clearTimeout(copiedTimer.current)
    }
  }, [])

  useEffect(() => {
    writeJson(STATE_KEY, { mode, serNum, ...fields })
  }, [mode, serNum, fields])

  useEffect(() => {
    if (!canvasRef.current) return
    try {
      datamatrix(canvasRef.current, { bcid: 'datamatrix', text, scale: 7, paddingwidth: 10, paddingheight: 10 })
    } catch {
      // 內容編不出來時保留上一張
    }
  }, [text])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const showToast = useCallback(
    (message: string, kind: Toast['kind'] = 'error') => {
      setToast({ message, kind, id: Date.now() })
      if (kind === 'error') track('error', `toast: ${message}`)
    },
    [track],
  )

  function updateList(kind: ListKind, m: Mode, change: (list: Entry[]) => Entry[]) {
    setLists((prev) => {
      const next = change(prev[kind][m])
      writeJson(listKey(kind, m), next)
      return { ...prev, [kind]: { ...prev[kind], [m]: next } }
    })
  }

  /** 欄位都有填才記錄，重複的移到最前面 */
  function recordHistory(m: Mode = mode, f: Fields = fields) {
    clearTimeout(historyTimer.current)
    const entry = entryOf(m, f)
    if (QUICK_KEYS[m].some((id) => !entry[id])) return
    updateList('history', m, (prev) => [entry, ...prev.filter((e) => !sameEntry(m, e, entry))].slice(0, HISTORY_MAX))
  }

  function onField(id: FieldId, value: string) {
    const next = { ...fields, [id]: value }
    setFields(next)
    clearTimeout(historyTimer.current)
    historyTimer.current = window.setTimeout(() => recordHistory(mode, next), HISTORY_DELAY)
  }

  function toggleFavorite() {
    const entry = entryOf(mode, fields)
    if (QUICK_KEYS[mode].every((id) => !entry[id])) {
      showToast('欄位是空的')
      return
    }
    updateList('fav', mode, (prev) => (isFav ? prev.filter((e) => !sameEntry(mode, e, entry)) : [entry, ...prev]))
    showToast(isFav ? '已從最愛移除' : '已加入最愛 ★', 'success')
  }

  function applyEntry(entry: Entry) {
    const next = { ...fields }
    for (const id of QUICK_KEYS[mode]) next[id] = entry[id] ?? ''
    setFields(next)
    recordHistory(mode, next)
  }

  function removeEntry(index: number) {
    updateList(quickTab, mode, (prev) => prev.filter((_, i) => i !== index))
  }

  function clearHistory() {
    if (confirm('確定清除這個模式的所有歷史紀錄？')) updateList('history', mode, () => [])
  }

  function generate() {
    recordHistory()
    codeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  async function copy() {
    recordHistory()
    await copyToClipboard(text)
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  function handleScanned(raw: string) {
    setScanning(false)
    track('scan')
    const scanned = parseScanned(raw)
    if (!scanned) {
      showToast('無法解析條碼，格式不符')
      return
    }
    const next = { ...fields, ...scanned.values }
    setMode(scanned.mode)
    setFields(next)
    recordHistory(scanned.mode, next)
    showToast('掃描成功', 'success')
  }

  // 要在點擊的當下同步呼叫 click()，iOS 才會打開相機
  function openScanner() {
    if (liveScan) setScanning(true)
    else fileRef.current?.click()
  }

  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    showToast('辨識中…', 'info')
    try {
      handleScanned(await decodeImageFile(file))
    } catch {
      showToast('無法辨識條碼，請重新拍照')
    }
  }

  const closeScanner = useCallback(() => setScanning(false), [])
  const cameraFailed = useCallback(() => {
    setScanning(false)
    showToast('無法開啟相機，請確認已允許相機權限')
  }, [showToast])

  return (
    <div className="dmx" ref={rootRef}>
      <title>Data Matrix 生成器</title>
      <meta name="robots" content="noindex, nofollow" />

      <h1 className="dmx-title">
        <span>Data Matrix</span> 生成器
      </h1>

      <div className="dmx-modes">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            className={mode === m.value ? 'active' : undefined}
            aria-pressed={mode === m.value}
            onClick={() => setMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <section className="dmx-box dmx-quick">
        <div className="dmx-quick-head">
          <div className="dmx-tabs">
            <button
              type="button"
              className={quickTab === 'fav' ? 'active' : undefined}
              onClick={() => setQuickTab('fav')}
            >
              ★ 最愛
            </button>
            <button
              type="button"
              className={quickTab === 'history' ? 'active' : undefined}
              onClick={() => setQuickTab('history')}
            >
              歷史
            </button>
          </div>
          <button type="button" className={`dmx-fav ${isFav ? 'on' : ''}`} onClick={toggleFavorite}>
            {isFav ? '★ 已在最愛' : '☆ 加入最愛'}
          </button>
        </div>
        <div className="dmx-chips">
          {list.length === 0 ? (
            <p className="dmx-empty">
              {quickTab === 'fav' ? '還沒有最愛，按「☆ 加入最愛」收藏目前內容' : '還沒有紀錄'}
            </p>
          ) : (
            list.map((entry, i) => (
              <div key={QUICK_KEYS[mode].map((id) => entry[id]).join('|')} className="dmx-chip">
                <button type="button" data-track="chip" onClick={() => applyEntry(entry)}>
                  {QUICK_KEYS[mode].map((id) => entry[id] || '—').join(' · ')}
                </button>
                <button
                  type="button"
                  className="dmx-chip-del"
                  data-track="chip-del"
                  aria-label="刪除"
                  onClick={() => removeEntry(i)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
        {quickTab === 'history' && list.length > 0 && (
          <button type="button" className="dmx-clear" onClick={clearHistory}>
            清除歷史
          </button>
        )}
      </section>

      <section className="dmx-box">
        <h2>{MODES.find((m) => m.value === mode)?.title}</h2>
        <button type="button" className="dmx-scan" onClick={openScanner}>
          <CameraIcon />
          掃描條碼
        </button>
        {FIELDS[mode].map((field) => (
          <label key={field.id} className="dmx-field">
            <span>{field.label}</span>
            <input
              type={field.type ?? 'text'}
              value={fields[field.id]}
              placeholder={field.placeholder}
              inputMode={field.inputMode}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => onField(field.id, e.target.value)}
            />
          </label>
        ))}
        {mode === 'item' && (
          <div className="dmx-field">
            <span>序號 SER</span>
            <div className="dmx-ser">
              <input value={pad5(serNum)} readOnly aria-label="序號 SER" />
              <button type="button" className="secondary" onClick={() => setSerNum(randomSer())}>
                重新生成
              </button>
            </div>
          </div>
        )}
      </section>

      <button type="button" className="dmx-generate" onClick={generate}>
        生成 Data Matrix
      </button>

      <div className="dmx-code" ref={codeRef}>
        <canvas ref={canvasRef} width={448} height={448} />
      </div>
      <div className="dmx-result">{text}</div>
      <button type="button" className={`secondary dmx-copy ${copied ? 'copied' : ''}`} onClick={copy}>
        {copied ? '已複製 ✓' : '複製內容'}
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="dmx-file"
        onChange={onPhoto}
        tabIndex={-1}
        aria-hidden="true"
      />
      {scanning && <LiveScanner onResult={handleScanned} onError={cameraFailed} onCancel={closeScanner} />}
      {toast && (
        <div key={toast.id} className={`dmx-toast ${toast.kind}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  )
}
