import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { canvasToBlob, downloadBlob, setJpegDpi, stem } from '../image-kit/files'
import { Range, Seg, Swatches } from '../image-kit/controls'
import { buildLut } from '../remove-bg/mask'
import { autoFit, buildCutout, coverFit, drawPhoto, layoutSheet, renderPhoto, renderSheet, rotateAt, zoomAt, type Transform } from './geometry'
import { customSpec, DPI, mmToPx, PAPERS, PX_PER_MM, SPECS, type Spec } from './specs'
import type { useMatting } from './useMatting'

export type Source = {
  id: number
  name: string
  /** 編輯解析度的原圖 */
  canvas: HTMLCanvasElement
  pixels: ImageData
}

// 背景色是印在照片上的顏色，跟網站主題無關
const BACKGROUNDS = [
  { value: '#ffffff', label: '白色' },
  { value: '#dbe8f5', label: '淺藍' },
  { value: '#ebebeb', label: '淺灰' },
  { value: '#438edb', label: '藍色' },
  { value: '#d9363e', label: '紅色' },
]

/** 縮放滑桿：以「整張填滿相框」為 100%，對數刻度 50%–1600% */
const ZOOM_MIN = -100
const ZOOM_MAX = 400

const mb = (n: number) => (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)
const DEG = Math.PI / 180

export default function Editor({
  source,
  matting,
  onRetry,
  onNew,
  onPick,
}: {
  source: Source
  matting: ReturnType<typeof useMatting>
  onRetry: () => void
  onNew: () => void
  onPick: () => void
}) {
  const { canvas: original, pixels } = source
  const W = pixels.width
  const H = pixels.height
  const { state, backend } = matting
  // 保險：別張圖的遮罩當作還沒算完
  const mask = matting.mask?.id === source.id && matting.mask.data.length === W * H ? matting.mask.data : null

  const [specId, setSpecId] = useState(SPECS[0].id)
  const [custom, setCustom] = useState({ w: 35, h: 45 })
  const [background, setBackground] = useState(BACKGROUNDS[0].value)
  const [keepOriginal, setKeepOriginal] = useState(false)
  const [strength, setStrength] = useState(50)
  const [edge, setEdge] = useState(70)
  const [guides, setGuides] = useState(true)
  const [paperId, setPaperId] = useState(PAPERS[0].id)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const spec: Spec = useMemo(
    () => SPECS.find((s) => s.id === specId) ?? customSpec(custom.w, custom.h),
    [specId, custom.w, custom.h],
  )
  const paper = PAPERS.find((p) => p.id === paperId) ?? PAPERS[0]
  const sheet = layoutSheet(spec, paper)

  const [t, setT] = useState<Transform>(() => coverFit(W, H, spec))
  /** 使用者自己調過位置之後，遮罩算好也不要再自動對齊 */
  const touched = useRef(false)

  const fit = (s: Spec) => {
    touched.current = false
    setT((mask && autoFit(mask, W, H, s)) || coverFit(W, H, s))
  }

  // 去背完成：第一次自動對齊（使用者已經動過就不動）
  useEffect(() => {
    if (!mask || touched.current) return
    const next = autoFit(mask, W, H, spec)
    if (next) setT(next)
    // 只在遮罩出來時做一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mask])

  const lut = useMemo(() => buildLut(strength, edge), [strength, edge])
  const cutout = useMemo(() => (mask ? buildCutout(pixels, mask, lut) : null), [pixels, mask, lut])
  /** 實際要畫的圖與背景 */
  const useCutout = !!cutout && !keepOriginal
  const image: CanvasImageSource = useCutout ? cutout : original
  const fill = useCutout ? background : '#ffffff'

  // ---- 預覽 ----

  const frameRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sheetRef = useRef<HTMLCanvasElement>(null)
  const pw = mmToPx(spec.w)
  const ph = mmToPx(spec.h)

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    drawPhoto(ctx, image, spec, t, fill, pw / spec.w)
  }, [image, spec, t, fill, pw])

  // 相紙預覽：停手一下再重畫，拖曳時不必每一格都排版
  useEffect(() => {
    const id = setTimeout(() => {
      const el = sheetRef.current
      if (!el) return
      const photo = renderPhoto(image, spec, t, fill)
      const small = renderSheet(photo, spec, paper, 3)
      el.width = small.width
      el.height = small.height
      el.getContext('2d')?.drawImage(small, 0, 0)
    }, 250)
    return () => clearTimeout(id)
  }, [image, spec, t, fill, paper])

  // ---- 拖曳、縮放 ----

  const pointers = useRef(new Map<number, { x: number; y: number }>())

  /** 螢幕座標 → 相框內的 mm */
  const toMm = (x: number, y: number) => {
    const b = frameRef.current!.getBoundingClientRect()
    return { x: ((x - b.left) * spec.w) / b.width, y: ((y - b.top) * spec.h) / b.height }
  }

  const adjust = (f: (t: Transform) => Transform) => {
    touched.current = true
    setT(f)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const map = pointers.current
    const prev = map.get(e.pointerId)
    if (!prev) return
    const before = [...map.values()].map((p) => toMm(p.x, p.y))
    map.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const after = [...map.values()].map((p) => toMm(p.x, p.y))
    if (after.length === 1) {
      const dx = after[0].x - before[0].x
      const dy = after[0].y - before[0].y
      adjust((t) => ({ ...t, x: t.x + dx, y: t.y + dy }))
    } else if (after.length >= 2) {
      // 兩指：中點的移動是平移，距離的變化是縮放
      const mid = (p: { x: number; y: number }[]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 })
      const dist = (p: { x: number; y: number }[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)
      const m0 = mid(before)
      const m1 = mid(after)
      const k = dist(before) > 0 ? dist(after) / dist(before) : 1
      adjust((t) => zoomAt({ ...t, x: t.x + m1.x - m0.x, y: t.y + m1.y - m0.y }, k, m1.x, m1.y))
    }
  }

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
  }

  // 滾輪縮放：要能 preventDefault，所以自己掛非 passive 的監聽
  const live = useRef({ spec })
  useEffect(() => {
    live.current = { spec }
  })
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { spec } = live.current
      const b = el.getBoundingClientRect()
      const px = ((e.clientX - b.left) * spec.w) / b.width
      const py = ((e.clientY - b.top) * spec.h) / b.height
      const k = Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.002)
      touched.current = true
      setT((t) => zoomAt(t, k, px, py))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const cx = spec.w / 2
  const cy = spec.h / 2

  /** 方向鍵移動、+／- 縮放、[ ] 旋轉 */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 2 : 0.5
    const moves: Record<string, (t: Transform) => Transform> = {
      ArrowLeft: (t) => ({ ...t, x: t.x - step }),
      ArrowRight: (t) => ({ ...t, x: t.x + step }),
      ArrowUp: (t) => ({ ...t, y: t.y - step }),
      ArrowDown: (t) => ({ ...t, y: t.y + step }),
      '+': (t) => zoomAt(t, 1.03, cx, cy),
      '=': (t) => zoomAt(t, 1.03, cx, cy),
      '-': (t) => zoomAt(t, 1 / 1.03, cx, cy),
      '[': (t) => rotateAt(t, -0.5 * DEG, cx, cy),
      ']': (t) => rotateAt(t, 0.5 * DEG, cx, cy),
    }
    const f = moves[e.key]
    if (!f) return
    e.preventDefault()
    adjust(f)
  }

  const baseZ = coverFit(W, H, spec).z
  const zoomValue = Math.round(Math.log2(t.z / baseZ) * 100)
  const setZoom = (v: number) => adjust((t) => zoomAt(t, (baseZ * 2 ** (v / 100)) / t.z, cx, cy))
  const setRotation = (deg: number) => adjust((t) => rotateAt(t, deg * DEG - t.r, cx, cy))

  // ---- 輸出 ----

  const exportJpeg = async (canvas: HTMLCanvasElement, name: string) => {
    setBusy(true)
    setNotice('')
    try {
      const blob = await setJpegDpi(await canvasToBlob(canvas, 'image/jpeg', 0.95), DPI)
      downloadBlob(blob, name)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '輸出失敗')
    } finally {
      setBusy(false)
    }
  }

  const size = `${spec.w}x${spec.h}mm`
  const downloadPhoto = () => void exportJpeg(renderPhoto(image, spec, t, fill), `${stem(source.name)}-證件照-${size}.jpg`)
  const downloadSheet = () =>
    void exportJpeg(
      renderSheet(renderPhoto(image, spec, t, fill), spec, paper, PX_PER_MM),
      `${stem(source.name)}-證件照-${size}-${paper.id}-${sheet.cols * sheet.rows}張.jpg`,
    )

  // ---- 輔助線（相框座標，單位 mm） ----

  const headMid = (spec.head[0] + spec.head[1]) / 2
  const topMid = (spec.top[0] + spec.top[1]) / 2
  const label = Math.min(spec.w, spec.h) * 0.065

  let overlay: ReactNode = null
  if (state.phase === 'error') {
    overlay = (
      <>
        <span>去背失敗：{state.message}</span>
        <button type="button" onClick={onRetry}>
          重試
        </button>
      </>
    )
  } else if (state.phase === 'loading') {
    overlay = state.total
      ? `下載去背模型… ${Math.floor(((state.loaded ?? 0) / state.total) * 100)}%（${mb(state.loaded ?? 0)} / ${mb(state.total)} MB）`
      : '載入去背模型…'
  } else if (state.phase === 'analyze') {
    overlay = backend === 'webgpu' ? '去背中…（顯示卡）' : '去背中…（CPU，約半分鐘）'
  }

  return (
    <div className="ik-editor">
      <div className="ik-stage">
        <div
          ref={frameRef}
          className="idp-frame"
          style={{ aspectRatio: `${spec.w} / ${spec.h}`, width: `min(100%, ${spec.w >= spec.h ? 340 : 320}px)` }}
          tabIndex={0}
          role="application"
          aria-label="證件照取景：拖曳移動、滾輪或兩指縮放；鍵盤可用方向鍵移動、加減號縮放、中括號旋轉"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <canvas ref={canvasRef} width={pw} height={ph} />
          {guides && (
            <svg
              className="idp-guides"
              viewBox={`0 0 ${spec.w} ${spec.h}`}
              aria-hidden="true"
              // 文字外框用照片的背景色，字才不會像貼了一塊補丁
              style={{ '--idp-halo': fill } as CSSProperties}
            >
              <rect className="idp-band" x={0} y={spec.top[0]} width={spec.w} height={spec.top[1] - spec.top[0]} />
              <rect
                className="idp-band"
                x={0}
                y={topMid + spec.head[0]}
                width={spec.w}
                height={spec.head[1] - spec.head[0]}
              />
              <line className="idp-line dashed" x1={cx} y1={0} x2={cx} y2={spec.h} />
              <ellipse className="idp-line" cx={cx} cy={topMid + headMid / 2} rx={headMid * 0.37} ry={headMid / 2} />
              <line
                className="idp-line dashed faint"
                x1={cx - headMid * 0.45}
                x2={cx + headMid * 0.45}
                y1={topMid + headMid * 0.47}
                y2={topMid + headMid * 0.47}
              />
              <text className="idp-text" x={spec.w - label * 0.4} y={spec.top[1] - label * 0.25} fontSize={label}>
                頭頂
              </text>
              <text className="idp-text" x={spec.w - label * 0.4} y={topMid + spec.head[1] - label * 0.25} fontSize={label}>
                下巴
              </text>
            </svg>
          )}
        </div>
        {overlay && (
          <div className="ik-overlay" role="status">
            {overlay}
            {state.phase === 'loading' && state.total ? (
              <span className="ik-bar">
                <span style={{ width: `${((state.loaded ?? 0) / state.total) * 100}%` }} />
              </span>
            ) : null}
          </div>
        )}
        <p className="muted idp-hint">
          拖曳移動，滾輪或兩指縮放。頭頂對齊上方色帶、下巴落在下方色帶（頭頂到下巴 {spec.head[0]}–{spec.head[1]} mm）。
        </p>
      </div>

      <div className="ik-panel">
        <label className="ik-field">
          <span className="ik-label">規格</span>
          <select
            value={specId}
            onChange={(e) => {
              setSpecId(e.target.value)
              fit(SPECS.find((s) => s.id === e.target.value) ?? customSpec(custom.w, custom.h))
            }}
          >
            {SPECS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.w / 10}×{s.h / 10} cm）
              </option>
            ))}
            <option value="custom">自訂尺寸</option>
          </select>
        </label>
        {specId === 'custom' && (
          <div className="idp-custom">
            {(['w', 'h'] as const).map((k) => (
              <label key={k} className="ik-field">
                <span className="ik-label">{k === 'w' ? '寬（mm）' : '高（mm）'}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={10}
                  max={100}
                  value={custom[k]}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (!Number.isFinite(v) || v <= 0) return
                    const next = { ...custom, [k]: Math.min(100, Math.max(10, v)) }
                    setCustom(next)
                    fit(customSpec(next.w, next.h))
                  }}
                />
              </label>
            ))}
          </div>
        )}
        <p className="muted">{spec.note}</p>

        <Swatches
          label="背景色"
          value={background}
          options={BACKGROUNDS}
          onChange={(v) => {
            setBackground(v)
            setKeepOriginal(false)
          }}
        />
        <label className="ik-check">
          <input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} />
          不去背，保留原本的背景
        </label>

        <Range label="縮放" value={zoomValue} min={ZOOM_MIN} max={ZOOM_MAX} onChange={setZoom} display={`${Math.round((t.z / baseZ) * 100)}%`} />
        <Range
          label="旋轉"
          value={Math.round((t.r / DEG) * 2) / 2}
          min={-20}
          max={20}
          step={0.5}
          onChange={setRotation}
          display={`${(t.r / DEG).toFixed(1)}°`}
        />
        <div className="ik-buttons">
          <button type="button" className="secondary" onClick={() => fit(spec)} disabled={!mask}>
            自動對齊
          </button>
          <button type="button" className="secondary" onClick={() => adjust(() => coverFit(W, H, spec))}>
            整張填滿
          </button>
        </div>
        <label className="ik-check">
          <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} />
          顯示臉部比例輔助線
        </label>

        <details className="idp-details">
          <summary className="ik-summary">去背微調</summary>
          <Range label="去除強度" value={strength} min={0} max={100} onChange={setStrength} />
          <Range label="邊緣柔和" value={edge} min={0} max={100} onChange={setEdge} />
        </details>

        <h3>下載</h3>
        <button type="button" onClick={downloadPhoto} disabled={busy}>
          ⬇ 單張 JPG（{pw}×{ph} px）
        </button>
        <Seg label="相紙" value={paperId} options={PAPERS.map((p) => ({ value: p.id, label: p.name }))} onChange={setPaperId} />
        <canvas ref={sheetRef} className="idp-sheet" aria-label={`${paper.name}相紙排版預覽`} />
        <button type="button" onClick={downloadSheet} disabled={busy || !sheet.cols || !sheet.rows}>
          ⬇ 排版 JPG（{sheet.cols * sheet.rows} 張）
        </button>
        {notice && (
          <p className="error" role="status">
            {notice}
          </p>
        )}
        <div className="ik-buttons">
          <button type="button" className="secondary" onClick={onPick}>
            換一張
          </button>
          <button type="button" className="secondary" onClick={onNew}>
            重新開始
          </button>
        </div>
      </div>
    </div>
  )
}
