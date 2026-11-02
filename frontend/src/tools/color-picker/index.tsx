import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { copyToClipboard } from '../../clipboard'
import { decodeHeic, decodeWithImg, isHeic } from '../image-convert/decode'
import { isImageFile, useFileDrop } from '../useFileDrop'
import { hslText, parseHex, rgbText, toHex, type RGB } from './color'
import Contrast from './Contrast'
import { extractPalette } from './palette'
import Picker from './Picker'
import type { Loaded } from './sample'
import './color-picker.css'

/** 取色用的圖最長邊；再大取色也不會更準，只是吃記憶體 */
const MAX_SIDE = 2560
/** 萃取調色盤前先縮到這個長邊 */
const PALETTE_SIDE = 160
const HISTORY_MAX = 16

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> }
const EyeDropper = (globalThis as { EyeDropper?: EyeDropperCtor }).EyeDropper

type Picture = Loaded & { name: string; small: Uint8ClampedArray }

async function loadImage(file: File): Promise<Picture> {
  let bitmap: ImageBitmap
  if (await isHeic(file)) bitmap = await decodeHeic(file)
  else {
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      bitmap = await decodeWithImg(file)
    }
  }
  try {
    const s = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * s))
    canvas.height = Math.max(1, Math.round(bitmap.height * s))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('canvas')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)

    const ps = Math.min(1, PALETTE_SIDE / Math.max(canvas.width, canvas.height))
    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.round(canvas.width * ps))
    small.height = Math.max(1, Math.round(canvas.height * ps))
    const sctx = small.getContext('2d', { willReadFrequently: true })
    if (!sctx) throw new Error('canvas')
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(canvas, 0, 0, small.width, small.height)
    return { name: file.name, canvas, data, small: sctx.getImageData(0, 0, small.width, small.height).data }
  } finally {
    bitmap.close()
  }
}

function Swatch({ color, onClick, label }: { color: RGB; onClick: () => void; label: string }) {
  return <button type="button" className="cpk-swatch" style={{ background: toHex(color) }} onClick={onClick} aria-label={label} title={label} />
}

export default function ColorPicker() {
  const [image, setImage] = useState<Picture | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sample, setSample] = useState(1)
  const [count, setCount] = useState(6)
  const [current, setCurrent] = useState<RGB | null>(null)
  const [history, setHistory] = useState<RGB[]>([])
  const [fg, setFg] = useState<RGB>([28, 26, 23])
  const [bg, setBg] = useState<RGB>([251, 248, 242])
  const [toast, setToast] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const palette = useMemo(() => (image ? extractPalette(image.small, count) : []), [image, count])

  const copy = useCallback(async (text: string) => {
    await copyToClipboard(text)
    setToast(`已複製 ${text}`)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 1600)
  }, [])

  const pick = useCallback((c: RGB) => {
    setCurrent(c)
    setHistory((h) => [c, ...h.filter((x) => toHex(x) !== toHex(c))].slice(0, HISTORY_MAX))
  }, [])

  const open = useCallback(async (files: File[]) => {
    const file = files.find(isImageFile)
    if (!file) {
      setError('請選擇圖片檔。')
      return
    }
    setError('')
    setLoading(true)
    try {
      setImage(await loadImage(file))
    } catch (err) {
      console.error(err)
      setError('讀不到這張圖片，可能是瀏覽器不支援的格式。')
    } finally {
      setLoading(false)
    }
  }, [])

  const { dragging, handlers } = useFileDrop((files) => void open(files))

  async function fromScreen() {
    if (!EyeDropper) return
    try {
      const r = await new EyeDropper().open()
      const c = parseHex(r.sRGBHex) ?? parseHex(r.sRGBHex.replace(/^rgba?\(|\)$/g, ''))
      if (c) pick(c)
    } catch {
      // 按 Esc 取消
    }
  }

  const formats = current
    ? [
        { label: 'HEX', value: toHex(current) },
        { label: 'RGB', value: rgbText(current) },
        { label: 'HSL', value: hslText(current) },
      ]
    : []

  return (
    <div className="cpk" {...handlers}>
      <input
        ref={fileInput}
        type="file"
        accept="image/*,.heic,.heif"
        hidden
        onChange={(e) => {
          void open([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />

      {image ? (
        <div className="cpk-main">
          <div className="cpk-left">
            <Picker image={image} sample={sample} onPick={pick} />
            <div className="cpk-toolbar">
              <div className="cpk-seg" role="radiogroup" aria-label="取樣範圍">
                {[1, 3, 5].map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={sample === s}
                    className={sample === s ? 'active' : ''}
                    onClick={() => setSample(s)}
                  >
                    {s === 1 ? '單一像素' : `${s}×${s} 平均`}
                  </button>
                ))}
              </div>
              <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>
                換一張
              </button>
              {EyeDropper && (
                <button type="button" className="secondary" onClick={() => void fromScreen()}>
                  從螢幕取色
                </button>
              )}
            </div>
            <p className="muted">
              {matchMedia('(pointer: coarse)').matches ? '手指按住拖動找顏色，放開就取色。' : '移動滑鼠看放大鏡，點一下取色。'}
            </p>
          </div>

          <div className="cpk-right">
            <div className="cpk-current">
              <div
                className={`cpk-current-swatch${current ? '' : ' empty'}`}
                style={current ? { background: toHex(current) } : undefined}
              >
                {!current && '還沒取色'}
              </div>
              {current && (
                <ul className="cpk-formats">
                  {formats.map((f) => (
                    <li key={f.label}>
                      <span className="cpk-format-label">{f.label}</span>
                      <code>{f.value}</code>
                      <button type="button" className="secondary" onClick={() => void copy(f.value)} aria-label={`複製 ${f.value}`}>
                        複製
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {current && (
                <div className="cpk-buttons">
                  <button type="button" className="secondary" onClick={() => setFg(current)}>
                    設為文字色
                  </button>
                  <button type="button" className="secondary" onClick={() => setBg(current)}>
                    設為背景色
                  </button>
                </div>
              )}
            </div>

            {history.length > 0 && (
              <div>
                <h3 className="cpk-h3">取過的顏色</h3>
                <div className="cpk-history">
                  {history.map((c) => (
                    <Swatch key={toHex(c)} color={c} label={`${toHex(c)}（點一下選取並複製）`} onClick={() => {
                      setCurrent(c)
                      void copy(toHex(c))
                    }} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={`cpk-drop${dragging ? ' over' : ''}`} onClick={() => fileInput.current?.click()}>
          <span className="cpk-drop-icon" aria-hidden="true">
            🎨
          </span>
          <strong>{loading ? '讀取中…' : dragging ? '放開就開啟' : '把圖片拖到這裡'}</strong>
          <div className="cpk-buttons">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                fileInput.current?.click()
              }}
            >
              選擇圖片
            </button>
            {EyeDropper && (
              <button
                type="button"
                className="secondary"
                onClick={(e) => {
                  e.stopPropagation()
                  void fromScreen()
                }}
              >
                從螢幕取色
              </button>
            )}
          </div>
          <span className="muted">也可以直接貼上（Ctrl+V）</span>
          {current && (
            <span className="cpk-inline-pick">
              <i style={{ background: toHex(current) }} />
              <code>{toHex(current)}</code>
              <button type="button" className="secondary" onClick={(e) => {
                e.stopPropagation()
                void copy(toHex(current))
              }}>
                複製
              </button>
            </span>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {image && (
        <section className="cpk-section">
          <div className="cpk-section-head">
            <h2>主要顏色</h2>
            <div className="cpk-seg" role="radiogroup" aria-label="顏色數量">
              {[5, 6, 7, 8].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={count === n}
                  className={count === n ? 'active' : ''}
                  onClick={() => setCount(n)}
                >
                  {n} 色
                </button>
              ))}
            </div>
          </div>
          <ul className="cpk-palette">
            {palette.map((s) => (
              <li key={toHex(s.rgb)}>
                <button
                  type="button"
                  className="cpk-palette-swatch"
                  style={{ background: toHex(s.rgb) }}
                  onClick={() => {
                    setCurrent(s.rgb)
                    void copy(toHex(s.rgb))
                  }}
                  aria-label={`${toHex(s.rgb)}，佔 ${Math.round(s.share * 100)}%，點一下複製`}
                />
                <code>{toHex(s.rgb)}</code>
                <span className="muted">{(s.share * 100).toFixed(s.share < 0.1 ? 1 : 0)}%</span>
              </li>
            ))}
          </ul>
          <div className="cpk-buttons">
            <button type="button" className="secondary" onClick={() => void copy(palette.map((s) => toHex(s.rgb)).join(', '))}>
              複製全部 HEX
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void copy(palette.map((s, i) => `--color-${i + 1}: ${toHex(s.rgb)};`).join('\n'))}
            >
              複製成 CSS 變數
            </button>
          </div>
        </section>
      )}

      <section className="cpk-section">
        <h2>對比檢查（WCAG）</h2>
        <Contrast fg={fg} bg={bg} setFg={setFg} setBg={setBg} swatches={[...history, ...palette.map((s) => s.rgb)]} />
      </section>

      <section className="cpk-notes">
        <h2>說明</h2>
        <ul className="muted">
          <li>圖片只在瀏覽器裡讀取，不會上傳。支援 iPhone 的 HEIC（非 Safari 第一次會下載解碼器）。</li>
          <li>主要顏色是把圖片縮小後，在 OKLab 色彩空間用 k-means 分群算出來的，百分比是那個顏色大約佔的面積。</li>
          <li>照片有雜訊時，「3×3／5×5 平均」取到的顏色比單一像素穩定。</li>
          <li>對比值依 WCAG 2.1 計算：一般文字至少 4.5:1（AA），大字和圖示至少 3:1。</li>
        </ul>
      </section>

      <div className="cpk-toast" role="status" aria-live="polite">
        {toast && <span>{toast}</span>}
      </div>
    </div>
  )
}
