import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import {
  ERASE,
  KEEP,
  applyMask,
  buildLut,
  composite,
  crop,
  dilate,
  maskAlpha,
  maskBounds,
  restore,
  strokeLine,
  union,
  type Patch,
  type Rect,
} from './mask'
import type { Backend } from './protocol'

export type Loaded = {
  id: number
  name: string
  /** 原尺寸，匯出用 */
  full: ImageBitmap
  /** 編輯解析度 */
  w: number
  h: number
  src: ImageData
}

export type Progress = {
  phase: 'idle' | 'loading' | 'analyze' | 'busy' | 'error'
  loaded?: number
  total?: number
  message?: string
}

type Mode = 'keep' | 'erase'
type Tool = 'brush' | 'click'

const UNDO_LIMIT = 30
/** iOS Safari 的畫布面積上限，超過就等比縮小匯出 */
const MAX_EXPORT_AREA = 16_777_216

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'keep', label: '保留' },
  { value: 'erase', label: '擦除' },
]
const TOOL_OPTIONS: { value: Tool; label: string }[] = [
  { value: 'brush', label: '🖌️ 筆刷' },
  { value: 'click', label: '👆 點選' },
]

const mb = (n: number) => (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)

function loadingText(p: Progress, what: string) {
  if (!p.total) return `載入${what}…`
  return `下載${what}… ${Math.floor(((p.loaded ?? 0) / p.total) * 100)}%（${mb(p.loaded ?? 0)} / ${mb(p.total)} MB）`
}

/** 檔名去掉副檔名 */
const stem = (name: string) => name.replace(/\.[^.]+$/, '') || 'image'

function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="rbg-field">
      <span className="rbg-label">{label}</span>
      <div className="rbg-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? 'active' : ''}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Range({
  label,
  value,
  min,
  max,
  onChange,
  suffix = '',
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  suffix?: string
}) {
  return (
    <label className="rbg-range">
      <span className="rbg-range-head">
        <span>{label}</span>
        <output>
          {value}
          {suffix}
        </output>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

export default function Editor({
  image,
  soft: softIn,
  backend,
  isnet,
  sam,
  segment,
  onRetry,
  onNew,
}: {
  image: Loaded
  /** 模型的柔和遮罩；還沒算完是 null */
  soft: Uint8Array | null
  backend: Backend | null
  isnet: Progress
  sam: Progress
  segment: (points: [number, number][], labels: number[]) => Promise<Uint8Array>
  onRetry: () => void
  onNew: () => void
}) {
  const { w: W, h: H, src } = image
  // 保險：尺寸不合的遮罩（換圖的瞬間）當作還沒算完
  const soft = softIn?.length === W * H ? softIn : null
  const [mode, setMode] = useState<Mode>('keep')
  const [tool, setTool] = useState<Tool>('brush')
  const [brush, setBrush] = useState(32)
  const [strength, setStrength] = useState(50)
  const [edge, setEdge] = useState(70)
  const [ghost, setGhost] = useState(false)
  const [undoCount, setUndoCount] = useState(0)
  const [view, setView] = useState({ width: 0, height: 0 })
  const [marker, setMarker] = useState<{ x: number; y: number; neg: boolean } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  // 大塊資料放在 state 的初始值裡（只建一次），之後直接改內容，不觸發重繪
  /** 手動修改圖層：0 沒動、1 保留、2 擦除 */
  const [ovr] = useState(() => new Uint8Array(W * H))
  /** 預覽用的 RGBA：RGB 是原圖，A 每次重算 */
  const [disp] = useState(() => new ImageData(new Uint8ClampedArray(src.data), W, H))

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const undo = useRef<Patch[]>([])
  const stroke = useRef<{ id: number; before: Uint8Array; x: number; y: number; r: number; value: number; dirty: Rect | null } | null>(null)
  /** 上一次點選：Shift／Alt＋點時沿用它的點再加一點 */
  const sel = useRef<{ points: [number, number][]; labels: number[]; value: number; patch: Patch } | null>(null)
  const picking = useRef(false)
  const urls = useRef<string[]>([])

  const lut = useMemo(() => buildLut(strength, edge), [strength, edge])
  /** 事件處理器要讀的最新設定 */
  const live = useRef({ soft, lut, ghost })

  /** 重算並畫出一塊區域 */
  const draw = useCallback(
    (r: Rect | null) => {
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx || !r) return
      const { soft, lut, ghost } = live.current
      if (soft) composite(disp.data, src.data, soft, ovr, lut, ghost, W, r)
      ctx.putImageData(disp, 0, 0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
    },
    [disp, src, ovr, W],
  )

  // 遮罩、滑桿、透顯改變時整張重畫（查表運算，2048 邊長也只要幾十毫秒）
  useEffect(() => {
    live.current = { soft, lut, ghost }
    draw({ x0: 0, y0: 0, x1: W, y1: H })
  }, [soft, lut, ghost, draw, W, H])

  // 畫布縮放到容器寬度，高度不超過視窗的 70%
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const fit = () => {
      const maxH = Math.max(240, window.innerHeight * 0.7)
      const k = Math.min(el.clientWidth / W, maxH / H)
      const width = Math.max(1, Math.floor(W * k))
      const height = Math.max(1, Math.floor(H * k))
      setView((v) => (v.width === width && v.height === height ? v : { width, height }))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    window.addEventListener('resize', fit)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [W, H])

  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u)
    },
    [],
  )

  const pushUndo = useCallback((p: Patch) => {
    undo.current.push(p)
    if (undo.current.length > UNDO_LIMIT) undo.current.shift()
    setUndoCount(undo.current.length)
  }, [])

  const undoLast = useCallback(() => {
    if (stroke.current || picking.current) return
    const p = undo.current.pop()
    if (!p) return
    draw(restore(ovr, W, p))
    setUndoCount(undo.current.length)
  }, [draw, ovr, W])

  const resetEdits = () => {
    if (stroke.current || picking.current || !ovr.some((v) => v)) return
    pushUndo(crop(ovr, W, { x0: 0, y0: 0, x1: W, y1: H }))
    ovr.fill(0)
    sel.current = null
    draw({ x0: 0, y0: 0, x1: W, y1: H })
  }

  // Ctrl+Z（Mac 是 ⌘Z）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return
      const t = e.target as HTMLElement | null
      if (t?.isContentEditable || t?.matches('textarea, input:not([type=range]):not([type=checkbox])')) return
      e.preventDefault()
      undoLast()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoLast])

  /** 螢幕座標 → 編輯解析度的像素座標；k 是每個 CSS 像素對應幾個圖片像素 */
  const toImage = (e: { clientX: number; clientY: number }) => {
    const b = canvasRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - b.left) * W) / b.width, y: ((e.clientY - b.top) * H) / b.height, k: W / b.width }
  }

  const moveRing = (e: PointerEvent) => {
    const ring = ringRef.current
    if (!ring) return
    const show = e.pointerType !== 'touch' && tool === 'brush' && !!soft
    ring.style.opacity = show ? '1' : '0'
    if (!show) return
    // 相對畫布定位（外層有 container-type，position: fixed 不能用）
    const b = canvasRef.current!.getBoundingClientRect()
    ring.style.transform = `translate(${e.clientX - b.left}px, ${e.clientY - b.top}px) translate(-50%, -50%)`
  }

  const pick = async (x: number, y: number, shift: boolean, alt: boolean) => {
    if (picking.current) return
    const value = mode === 'keep' ? KEEP : ERASE
    const pt: [number, number] = [Math.min(W - 1, Math.max(0, Math.floor(x))), Math.min(H - 1, Math.max(0, Math.floor(y)))]
    const prev = sel.current
    // 加點或排除只對「上一次點選、而且之後沒有再修改」有效，否則當成新的點選
    const refine = (shift || alt) && prev && prev.value === value && undo.current.at(-1) === prev.patch ? prev : null
    const points: [number, number][] = refine ? [...refine.points, pt] : [pt]
    const labels = refine ? [...refine.labels, alt ? 0 : 1] : [1]
    picking.current = true
    setMarker({ x: pt[0], y: pt[1], neg: !!refine && alt })
    try {
      const raw = await segment(points, labels)
      if (raw.length !== W * H) return
      // 長邊每 400px 外擴 1px，蓋掉物件邊緣那一圈
      const mask = dilate(raw, W, Math.max(1, Math.round(Math.max(W, H) / 400)))
      if (refine && undo.current.at(-1) === refine.patch) {
        undo.current.pop()
        draw(restore(ovr, W, refine.patch))
      }
      const rect = maskBounds(mask, W)
      sel.current = null
      if (rect) {
        const patch = crop(ovr, W, rect)
        applyMask(ovr, mask, value)
        pushUndo(patch)
        draw(rect)
        sel.current = { points, labels, value, patch }
      } else {
        setUndoCount(undo.current.length)
      }
    } catch {
      // 錯誤訊息由狀態列顯示
    } finally {
      picking.current = false
      setMarker(null)
    }
  }

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!soft || stroke.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    const p = toImage(e)
    if (tool === 'click') {
      void pick(p.x, p.y, e.shiftKey, e.altKey)
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    const value = mode === 'keep' ? KEEP : ERASE
    const r = Math.max(0.5, (brush / 2) * p.k)
    const before = ovr.slice()
    const dirty = strokeLine(ovr, W, H, p.x, p.y, p.x, p.y, r, value)
    stroke.current = { id: e.pointerId, before, x: p.x, y: p.y, r, value, dirty }
    draw(dirty)
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    moveRing(e)
    const s = stroke.current
    if (!s || s.id !== e.pointerId) return
    // 合併事件讓快速移動時線條也連續
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? []
    let rect: Rect | null = null
    for (const ev of coalesced.length ? coalesced : [e.nativeEvent]) {
      const p = toImage(ev)
      rect = union(rect, strokeLine(ovr, W, H, s.x, s.y, p.x, p.y, s.r, s.value))
      s.x = p.x
      s.y = p.y
    }
    s.dirty = union(s.dirty, rect)
    draw(rect)
  }

  const endStroke = (e: PointerEvent<HTMLCanvasElement>) => {
    const s = stroke.current
    if (!s || s.id !== e.pointerId) return
    stroke.current = null
    if (s.dirty) pushUndo(crop(s.before, W, s.dirty))
    sel.current = null
  }

  /** 原尺寸、套上最終遮罩的 PNG */
  const exportBlob = async (): Promise<Blob> => {
    const { soft, lut } = live.current
    if (!soft) throw new Error('還沒去背完成')
    const alpha = maskAlpha(soft, ovr, lut)
    const { full } = image
    const k = Math.min(1, Math.sqrt(MAX_EXPORT_AREA / (full.width * full.height)))
    const FW = Math.max(1, Math.round(full.width * k))
    const FH = Math.max(1, Math.round(full.height * k))
    const out = document.createElement('canvas')
    out.width = FW
    out.height = FH
    const ctx = out.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('無法建立畫布')
    ctx.drawImage(full, 0, 0, FW, FH)
    const px = ctx.getImageData(0, 0, FW, FH)

    // 遮罩是編輯解析度，用畫布的平滑縮放放大到原尺寸
    let a: ArrayLike<number> = alpha
    let stride = 1
    if (FW !== W || FH !== H) {
      const m = new Uint8ClampedArray(W * H * 4)
      for (let i = 0; i < alpha.length; i++) {
        m[i * 4] = alpha[i]
        m[i * 4 + 3] = 255
      }
      const small = document.createElement('canvas')
      small.width = W
      small.height = H
      small.getContext('2d')?.putImageData(new ImageData(m, W, H), 0, 0)
      const big = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      if (!big) throw new Error('無法建立畫布')
      big.canvas.width = FW
      big.canvas.height = FH
      big.imageSmoothingQuality = 'high'
      big.drawImage(small, 0, 0, FW, FH)
      a = big.getImageData(0, 0, FW, FH).data
      stride = 4
    }
    const d = px.data
    for (let i = 0, n = FW * FH; i < n; i++) d[i * 4 + 3] = (d[i * 4 + 3] * a[i * stride] + 127) / 255
    ctx.putImageData(px, 0, 0)
    return await new Promise((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('輸出 PNG 失敗'))), 'image/png'),
    )
  }

  const download = async () => {
    setExporting(true)
    setNotice(null)
    try {
      const url = URL.createObjectURL(await exportBlob())
      urls.current.push(url)
      const a = document.createElement('a')
      a.href = url
      a.download = `${stem(image.name)}-去背.png`
      a.click()
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : '下載失敗', ok: false })
    } finally {
      setExporting(false)
    }
  }

  const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write
  const copy = async () => {
    setExporting(true)
    setNotice(null)
    try {
      // 直接給 Promise，Safari 才會認定是使用者的操作
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })])
      setNotice({ text: '已複製到剪貼簿', ok: true })
    } catch {
      setNotice({ text: '複製失敗，請改用下載', ok: false })
    } finally {
      setExporting(false)
    }
  }

  // 蓋在畫布上的狀態
  let overlay: ReactNode = null
  let progress: Progress | null = null
  if (isnet.phase === 'error') {
    overlay = (
      <>
        <span>去背失敗：{isnet.message}</span>
        <button type="button" onClick={onRetry}>
          重試
        </button>
      </>
    )
  } else if (!soft) {
    progress = isnet
    overlay =
      isnet.phase === 'analyze'
        ? backend === 'webgpu'
          ? '分析中…（顯示卡）'
          : '分析中…（CPU，約半分鐘）'
        : loadingText(isnet, '去背模型')
  } else if (sam.phase === 'loading') {
    progress = sam
    overlay = loadingText(sam, '點選模型')
  } else if (sam.phase === 'analyze') {
    overlay = '分析中…（每張圖第一次點選要幾秒）'
  } else if (sam.phase === 'busy') {
    overlay = '選取中…'
  }

  return (
    <div className="rbg-editor">
      <div className="rbg-stage" ref={stageRef}>
        <div className="rbg-box" style={{ width: view.width, height: view.height }}>
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            className={`rbg-canvas${soft ? ` ${tool}` : ''}`}
            aria-label="去背結果，可以用筆刷或點選修改"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerEnter={moveRing}
            onPointerLeave={() => {
              if (ringRef.current) ringRef.current.style.opacity = '0'
            }}
            onContextMenu={(e) => tool === 'click' && e.preventDefault()}
          />
          <div ref={ringRef} className="rbg-ring" style={{ width: brush, height: brush }} aria-hidden="true" />
          {marker && (
            <span
              className={`rbg-marker${marker.neg ? ' neg' : ''}`}
              style={{ left: `${((marker.x + 0.5) / W) * 100}%`, top: `${((marker.y + 0.5) / H) * 100}%` }}
            />
          )}
        </div>
        {overlay && (
          <div className="rbg-overlay" role="status">
            {overlay}
            {progress?.total ? (
              <span className="rbg-bar">
                <span style={{ width: `${((progress.loaded ?? 0) / progress.total) * 100}%` }} />
              </span>
            ) : null}
          </div>
        )}
      </div>
      <div className="rbg-panel">
        {backend && (
          <p className="muted">
            運算：<span className="chip subtle">{backend === 'webgpu' ? 'WebGPU（顯示卡）' : 'CPU（WASM）'}</span>
          </p>
        )}
        <fieldset className="rbg-fields" disabled={!soft}>
          <Seg label="模式" value={mode} options={MODE_OPTIONS} onChange={setMode} />
          <Seg label="工具" value={tool} options={TOOL_OPTIONS} onChange={setTool} />
          {tool === 'brush' ? (
            <Range label="筆刷大小" value={brush} min={4} max={160} onChange={setBrush} suffix=" px" />
          ) : (
            <p className="muted">點一下物件自動選出整塊。Shift＋點：加大上一次的選取；Alt＋點：從中排除。</p>
          )}
          <Range label="去除強度" value={strength} min={0} max={100} onChange={setStrength} />
          <Range label="邊緣" value={edge} min={0} max={100} onChange={setEdge} />
          <label className="rbg-check">
            <input type="checkbox" checked={ghost} onChange={(e) => setGhost(e.target.checked)} />
            透顯原圖
          </label>
          <div className="rbg-buttons">
            <button type="button" className="secondary" onClick={undoLast} disabled={!undoCount}>
              ↶ 復原
            </button>
            <button type="button" className="secondary" onClick={resetEdits}>
              重設修改
            </button>
          </div>
        </fieldset>
        {sam.phase === 'error' && <p className="error">點選失敗：{sam.message}</p>}

        <div className="rbg-buttons">
          <button type="button" onClick={download} disabled={!soft || exporting}>
            ⬇ 下載 PNG
          </button>
          {canCopy && (
            <button type="button" className="secondary" onClick={copy} disabled={!soft || exporting}>
              複製
            </button>
          )}
          <button type="button" className="secondary" onClick={onNew}>
            換一張
          </button>
        </div>
        {notice && (
          <p className={notice.ok ? 'success' : 'error'} role="status">
            {notice.text}
          </p>
        )}
      </div>
    </div>
  )
}
