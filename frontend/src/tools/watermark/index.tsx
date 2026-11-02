import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { Range, Seg, Swatches } from '../image-kit/controls'
import { canvasToBlob, decodeImage, downloadBlob, stem } from '../image-kit/files'
import { useFileDrop, useFilePicker, usePasteImages } from '../image-kit/hooks'
import { DropVeil, DropZone } from '../image-kit/ImageDrop'
import { render, type Mark, type Redaction } from './render'
import './watermark.css'

type Loaded = { id: number; name: string; bitmap: ImageBitmap }
type Tool = 'none' | 'mosaic' | 'black'

/** 預覽的最長邊；下載時用原尺寸 */
const PREVIEW_MAX = 1600
/** iOS Safari 的畫布面積上限，超過就等比縮小輸出 */
const MAX_EXPORT_AREA = 16_777_216

const PRESETS = ['僅供 ○○ 申請使用，他用無效', '僅供 ○○ 銀行開戶使用', '此影本僅供 ○○ 使用，再複印無效']

// 浮水印的顏色是印在圖上的，跟主題無關
const COLORS = [
  { value: '#7f7f7f', label: '灰色' },
  { value: '#000000', label: '黑色' },
  { value: '#ffffff', label: '白色' },
  { value: '#d6202a', label: '紅色' },
  { value: '#1d4ed8', label: '藍色' },
]

const TOOLS: { value: Tool; label: string }[] = [
  { value: 'none', label: '關閉' },
  { value: 'mosaic', label: '▦ 馬賽克' },
  { value: 'black', label: '■ 塗黑' },
]

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export default function Watermark() {
  const [image, setImage] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState('')
  const [text, setText] = useState(PRESETS[0])
  const [withDate, setWithDate] = useState(false)
  const [size, setSize] = useState(5)
  const [opacity, setOpacity] = useState(35)
  const [color, setColor] = useState(COLORS[0].value)
  const [angle, setAngle] = useState(-30)
  const [density, setDensity] = useState(5)
  const [bold, setBold] = useState(true)
  const [redactions, setRedactions] = useState<Redaction[]>([])
  const [tool, setTool] = useState<Tool>('none')
  const [draft, setDraft] = useState<Redaction | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nextId = useRef(0)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)

  const mark: Mark = {
    text: withDate ? `${text.trim()} ${today()}` : text,
    size,
    opacity,
    color,
    angle,
    density,
    bold,
  }

  const openFile = useCallback(async (file: File | undefined) => {
    if (!file) return
    setLoadError('')
    try {
      const bitmap = await decodeImage(file)
      setImage((old) => {
        old?.bitmap.close()
        return { id: ++nextId.current, name: file.name, bitmap }
      })
      setRedactions([])
      setNotice(null)
    } catch (err) {
      setLoadError((err as Error).message)
    }
  }, [])

  // 離開頁面時釋放圖片
  const imageRef = useRef<Loaded | null>(null)
  useEffect(() => {
    imageRef.current = image
  }, [image])
  useEffect(() => () => imageRef.current?.bitmap.close(), [])

  const picker = useFilePicker((files) => void openFile(files[0]))
  usePasteImages((files) => void openFile(files[0]))
  const { dragging, handlers } = useFileDrop(
    (files) => void openFile(files[0]),
    () => setLoadError('請放入圖片檔。'),
  )

  // 預覽：設定一改就重畫（縮小到 1600 邊長，文字幾百個也很快）
  const markKey = JSON.stringify(mark)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image) return
    const { bitmap } = image
    const k = Math.min(1, PREVIEW_MAX / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * k))
    const h = Math.max(1, Math.round(bitmap.height * k))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    render(canvas, bitmap, JSON.parse(markKey) as Mark, redactions)
  }, [image, markKey, redactions])

  // ---- 框選遮蔽區域 ----

  const toUnit = (e: { clientX: number; clientY: number }) => {
    const b = canvasRef.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)),
      y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)),
    }
  }

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (tool === 'none' || drag.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toUnit(e)
    drag.current = { id: e.pointerId, ...p }
    setDraft({ kind: tool, x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || tool === 'none') return
    const p = toUnit(e)
    setDraft({ kind: tool, x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) })
  }

  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    // 太小的（誤觸）不算
    if (draft && draft.w > 0.005 && draft.h > 0.005) setRedactions((rs) => [...rs, draft])
    setDraft(null)
  }

  // ---- 輸出 ----

  const exportCanvas = () => {
    if (!image) throw new Error('沒有圖片')
    const { bitmap } = image
    const k = Math.min(1, Math.sqrt(MAX_EXPORT_AREA / (bitmap.width * bitmap.height)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * k))
    canvas.height = Math.max(1, Math.round(bitmap.height * k))
    render(canvas, bitmap, mark, redactions)
    return canvas
  }

  const download = async (type: 'image/jpeg' | 'image/png') => {
    if (!image) return
    setBusy(true)
    setNotice(null)
    try {
      const blob = await canvasToBlob(exportCanvas(), type, 0.92)
      downloadBlob(blob, `${stem(image.name)}-浮水印.${type === 'image/png' ? 'png' : 'jpg'}`)
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : '下載失敗', ok: false })
    } finally {
      setBusy(false)
    }
  }

  const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write
  const copy = async () => {
    setBusy(true)
    setNotice(null)
    try {
      // 直接給 Promise，Safari 才會認定是使用者的操作
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(exportCanvas(), 'image/png') })])
      setNotice({ text: '已複製到剪貼簿', ok: true })
    } catch {
      setNotice({ text: '複製失敗，請改用下載', ok: false })
    } finally {
      setBusy(false)
    }
  }

  const kindName = (r: Redaction) => (r.kind === 'mosaic' ? '馬賽克' : '塗黑')

  return (
    <div className="ik wm" {...handlers}>
      {picker.input}
      {image ? (
        <div className="ik-editor">
          <div className="ik-stage">
            <div className="wm-box">
              <canvas
                ref={canvasRef}
                className={`wm-canvas${tool === 'none' ? '' : ' drawing'}`}
                aria-label="加上浮水印的預覽；選了馬賽克或塗黑時可以拖曳框選範圍"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
              {draft && (
                <span
                  className={`wm-draft ${draft.kind}`}
                  style={{
                    left: `${draft.x * 100}%`,
                    top: `${draft.y * 100}%`,
                    width: `${draft.w * 100}%`,
                    height: `${draft.h * 100}%`,
                  }}
                />
              )}
            </div>
            {tool !== 'none' && <p className="muted">在圖上拖曳框出要{tool === 'mosaic' ? '打馬賽克' : '塗黑'}的範圍。</p>}
          </div>

          <div className="ik-panel">
            <label className="ik-field">
              <span className="ik-label">浮水印文字</span>
              <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：僅供 ○○ 申請使用" />
            </label>
            <div className="wm-presets">
              {PRESETS.map((p) => (
                <button key={p} type="button" className="secondary" onClick={() => setText(p)}>
                  {p}
                </button>
              ))}
            </div>
            <label className="ik-check">
              <input type="checkbox" checked={withDate} onChange={(e) => setWithDate(e.target.checked)} />
              加上今天日期（{today()}）
            </label>
            <Swatches label="顏色" value={color} options={COLORS} onChange={setColor} />
            <Range label="字級" value={size} min={2} max={15} step={0.5} onChange={setSize} display={`${size}%`} />
            <Range label="不透明度" value={opacity} min={5} max={100} onChange={setOpacity} display={`${opacity}%`} />
            <Range label="角度" value={angle} min={-90} max={90} onChange={setAngle} display={`${angle}°`} />
            <Range label="密度" value={density} min={1} max={10} onChange={setDensity} />
            <label className="ik-check">
              <input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} />
              粗體
            </label>

            <h3>遮蔽敏感資料</h3>
            <Seg label="框選工具" value={tool} options={TOOLS} onChange={setTool} />
            {redactions.length > 0 && (
              <ul className="wm-list">
                {redactions.map((r, i) => (
                  <li key={i}>
                    <span>
                      {i + 1}. {kindName(r)}
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`刪除第 ${i + 1} 個${kindName(r)}`}
                      onClick={() => setRedactions((rs) => rs.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="ik-buttons">
              <button
                type="button"
                className="secondary"
                onClick={() => setRedactions((rs) => rs.slice(0, -1))}
                disabled={!redactions.length}
              >
                ↶ 復原
              </button>
              <button type="button" className="secondary" onClick={() => setRedactions([])} disabled={!redactions.length}>
                全部清除
              </button>
            </div>

            <h3>下載</h3>
            <div className="ik-buttons">
              <button type="button" onClick={() => void download('image/jpeg')} disabled={busy}>
                ⬇ JPG
              </button>
              <button type="button" onClick={() => void download('image/png')} disabled={busy}>
                ⬇ PNG
              </button>
              {canCopy && (
                <button type="button" className="secondary" onClick={() => void copy()} disabled={busy}>
                  複製
                </button>
              )}
            </div>
            {notice && (
              <p className={notice.ok ? 'success' : 'error'} role="status">
                {notice.text}
              </p>
            )}
            <button type="button" className="secondary" onClick={picker.open}>
              換一張
            </button>
            {loadError && <p className="error">{loadError}</p>}
          </div>
          {dragging && <DropVeil text="放開就換成這張圖" />}
        </div>
      ) : (
        <DropZone dragging={dragging} onPick={picker.open} icon="🔏" title="把證件照片拖到這裡" dropTitle="放開就開始">
          {loadError && <p className="error">{loadError}</p>}
        </DropZone>
      )}

      <section className="ik-notes">
        <h2>說明</h2>
        <ul className="muted">
          <li>
            交給別人的證件影本加上「僅供 ○○ 申請使用，他用無效」這類浮水印，萬一外流也比較難被拿去冒用。記得把 ○○
            換成實際的單位或用途，加上日期更好。
          </li>
          <li>浮水印要蓋過證件上的文字與照片才有效，但也別濃到對方看不清楚；預設的灰色、35% 不透明度通常剛好。</li>
          <li>
            不需要給對方看的資料（例如身分證背面的配偶、住址、存摺的餘額）可以框起來打馬賽克或塗黑。塗黑最保險；馬賽克的格子夠大，一般無法還原。
          </li>
          <li>下載的圖片是重新畫過的，不會帶原檔的 EXIF（拍攝時間、GPS 位置等）。</li>
          <li>全部在瀏覽器本機處理，圖片不會送到伺服器。</li>
        </ul>
      </section>
    </div>
  )
}
