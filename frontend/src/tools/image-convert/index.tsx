import { useCallback, useEffect, useRef, useState } from 'react'
import { isImageFile, useFileDrop } from '../useFileDrop'
import Compare from './Compare'
import { DecodeError, OUT_FORMATS, type ConvertOptions, type Converted, type OutFormat, type Resize, type Source } from './convert'
import { decodeHeic, decodeWithImg, isHeic } from './decode'
import { CancelError, ConvertPool } from './pool'
import { download, formatBytes, FORMAT_LABEL, outputName, zipName } from './util'
import { makeZip, uniqueNames } from './zip'
import './image-convert.css'

type FormatChoice = 'keep' | OutFormat
type ResizeMode = Resize['mode']

type Settings = {
  format: FormatChoice
  /** 1–100 */
  quality: number
  resize: ResizeMode
  maxW: number
  maxH: number
  percent: number
  background: string
  /** 同格式、同尺寸卻變大時，直接用原檔 */
  keepSmaller: boolean
}

type Result = { blob: Blob; url: string; width: number; height: number; format: OutFormat; kept: boolean }

type Item = {
  id: number
  file: File
  status: 'decoding' | 'working' | 'done' | 'error'
  error?: string
  /** 原圖預覽；HEIC 是解碼後另外產生的 JPG */
  before: string | null
  srcW?: number
  srcH?: number
  result: Result | null
}

const SETTINGS_KEY = 'tool_image_convert'
const DEFAULTS: Settings = {
  format: 'keep',
  quality: 80,
  resize: 'none',
  maxW: 1920,
  maxH: 1920,
  percent: 50,
  background: '#ffffff',
  keepSmaller: true,
}
/** HEIC 原圖預覽的最長邊 */
const PREVIEW_MAX = 1600

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null
    return { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) }
  } catch {
    return DEFAULTS
  }
}

function toResize(s: Settings): Resize {
  if (s.resize === 'fit') return { mode: 'fit', maxW: s.maxW || 0, maxH: s.maxH || 0 }
  if (s.resize === 'percent') return { mode: 'percent', percent: s.percent }
  return { mode: 'none' }
}

/** 「維持原格式」：瀏覽器能輸出就照舊，不能的話有透明可能的用 PNG、照片用 JPG */
function outputFormat(choice: FormatChoice, file: File, supported: OutFormat[]): OutFormat {
  if (choice !== 'keep') return supported.includes(choice) ? choice : 'image/jpeg'
  const t = file.type as OutFormat
  if (OUT_FORMATS.includes(t) && supported.includes(t)) return t
  if (/png|gif|bmp|svg|icon|tiff/.test(file.type) || /\.(png|gif|bmp|svg|ico|tiff?)$/i.test(file.name)) {
    return 'image/png'
  }
  return 'image/jpeg'
}

/** 原圖預覽：HEIC 這類 <img> 顯示不了的，畫成小張 JPG */
async function previewOf(bitmap: ImageBitmap): Promise<string | null> {
  const s = Math.min(1, PREVIEW_MAX / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * s))
  canvas.height = Math.max(1, Math.round(bitmap.height * s))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
  return blob ? URL.createObjectURL(blob) : null
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; disabled?: boolean; title?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="imc-field">
      <span className="imc-label">{label}</span>
      <div className="imc-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? 'active' : ''}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function savingText(before: number, after: number) {
  const pct = Math.round((1 - after / before) * 100)
  if (pct > 0) return { text: `−${pct}%`, cls: 'good' }
  if (pct < 0) return { text: `+${-pct}%`, cls: 'bad' }
  return { text: '±0%', cls: '' }
}

export default function ImageConvert() {
  const [settings, setSettings] = useState(loadSettings)
  /** 拖滑桿時不要每動一格就全部重做，停下來 300ms 才套用 */
  const [applied, setApplied] = useState(settings)
  const [formats, setFormats] = useState<OutFormat[] | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [comparing, setComparing] = useState<number | null>(null)
  const [zipping, setZipping] = useState(false)
  const [notice, setNotice] = useState('')

  const pool = useRef<ConvertPool | null>(null)
  const sources = useRef(new Map<number, Source>())
  const urls = useRef(new Map<number, { before?: string; result?: string }>())
  const itemsRef = useRef(items)
  const appliedRef = useRef(applied)
  /** 設定的版本；舊設定算出來的結果就丟掉 */
  const version = useRef(0)
  const nextId = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    const size = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))
    const p = new ConvertPool(size)
    pool.current = p
    void p.ready.then(setFormats)
    const sourceMap = sources.current
    const urlMap = urls.current
    return () => {
      p.destroy()
      pool.current = null
      for (const s of sourceMap.values()) if (!(s instanceof Blob)) s.close()
      sourceMap.clear()
      for (const u of urlMap.values()) {
        if (u.before) URL.revokeObjectURL(u.before)
        if (u.result) URL.revokeObjectURL(u.result)
      }
      urlMap.clear()
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // 存不了就只在這次有效
    }
    const t = setTimeout(() => setApplied(settings), 300)
    return () => clearTimeout(t)
  }, [settings])

  const patch = useCallback((id: number, p: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)))
  }, [])

  const setUrl = useCallback((id: number, kind: 'before' | 'result', url: string | null) => {
    const entry = urls.current.get(id) ?? {}
    const old = entry[kind]
    if (old && old !== url) URL.revokeObjectURL(old)
    entry[kind] = url ?? undefined
    urls.current.set(id, entry)
  }, [])

  /** 用目前套用的設定轉一張 */
  const process = useCallback(
    async (id: number) => {
      const p = pool.current
      const item = itemsRef.current.find((it) => it.id === id)
      let source = sources.current.get(id)
      if (!p || !item || !source) return
      const ver = version.current
      const s = appliedRef.current
      const supported = await p.ready
      const format = outputFormat(s.format, item.file, supported)
      const options: ConvertOptions = {
        format,
        quality: s.quality / 100,
        resize: toResize(s),
        background: s.background,
      }
      patch(id, { status: 'working', error: undefined })

      let r: Converted
      try {
        try {
          r = await p.convert(source, options)
        } catch (err) {
          // worker 讀不了（例如 SVG），改由主執行緒用 <img> 解碼後再送一次
          if (!(err instanceof DecodeError) || !(source instanceof Blob)) throw err
          const bitmap = await decodeWithImg(source).catch(() => {
            throw new Error('讀不到這個檔案，可能不是圖片，或是瀏覽器不支援的格式。')
          })
          if (!sources.current.has(id)) return bitmap.close()
          sources.current.set(id, bitmap)
          source = bitmap
          r = await p.convert(source, options)
        }
      } catch (err) {
        if (err instanceof CancelError || ver !== version.current) return
        patch(id, { status: 'error', error: err instanceof Error ? err.message : String(err) })
        return
      }
      if (ver !== version.current || !sources.current.has(id)) return

      // 同格式、沒縮放還變大：直接用原檔
      const kept =
        s.keepSmaller &&
        source instanceof Blob &&
        item.file.type === format &&
        r.width === r.srcWidth &&
        r.height === r.srcHeight &&
        r.blob.size >= item.file.size
      const blob = kept ? item.file : r.blob
      const url = URL.createObjectURL(blob)
      setUrl(id, 'result', url)
      patch(id, {
        status: 'done',
        srcW: r.srcWidth,
        srcH: r.srcHeight,
        result: { blob, url, width: r.width, height: r.height, format, kept },
      })
    },
    [patch, setUrl],
  )

  // 設定變了：取消排隊中的，全部重做
  useEffect(() => {
    appliedRef.current = applied
    version.current++
    pool.current?.clear()
    for (const it of itemsRef.current) if (sources.current.has(it.id)) void process(it.id)
  }, [applied, process])

  const addFiles = useCallback(
    async (files: File[]) => {
      const images = files.filter(isImageFile)
      setNotice(images.length < files.length ? `略過 ${files.length - images.length} 個不是圖片的檔案。` : '')
      for (const file of images) {
        const id = ++nextId.current
        const heic = await isHeic(file)
        const before = heic ? null : URL.createObjectURL(file)
        if (before) setUrl(id, 'before', before)
        const item: Item = { id, file, status: heic ? 'decoding' : 'working', before, result: null }
        itemsRef.current = [...itemsRef.current, item]
        setItems(itemsRef.current)
        if (!heic) {
          sources.current.set(id, file)
          void process(id)
          continue
        }
        void (async () => {
          try {
            const bitmap = await decodeHeic(file)
            if (!itemsRef.current.some((it) => it.id === id)) return bitmap.close()
            sources.current.set(id, bitmap)
            const preview = await previewOf(bitmap)
            setUrl(id, 'before', preview)
            patch(id, { before: preview, srcW: bitmap.width, srcH: bitmap.height })
            void process(id)
          } catch (err) {
            console.error(err)
            patch(id, { status: 'error', error: 'HEIC 解碼失敗，檔案可能損壞，或是網路斷線下載不到解碼器。' })
          }
        })()
      }
    },
    [patch, process, setUrl],
  )

  const remove = useCallback(
    (id: number) => {
      const s = sources.current.get(id)
      if (s && !(s instanceof Blob)) s.close()
      sources.current.delete(id)
      setUrl(id, 'before', null)
      setUrl(id, 'result', null)
      urls.current.delete(id)
      itemsRef.current = itemsRef.current.filter((it) => it.id !== id)
      setItems(itemsRef.current)
    },
    [setUrl],
  )

  const clearAll = () => {
    pool.current?.clear()
    for (const it of itemsRef.current) remove(it.id)
    setNotice('')
  }

  const { dragging, handlers } = useFileDrop((files) => void addFiles(files))

  const done = items.filter((it) => it.status === 'done' && it.result)
  const busy = items.some((it) => it.status === 'working' || it.status === 'decoding')
  const totalBefore = done.reduce((n, it) => n + it.file.size, 0)
  const totalAfter = done.reduce((n, it) => n + (it.result?.blob.size ?? 0), 0)

  const names = uniqueNames(
    done.map((it) => (it.result!.kept ? it.file.name : outputName(it.file.name, it.result!.format))),
  )

  async function downloadAll() {
    if (done.length === 0) return
    if (done.length === 1) {
      download(done[0].result!.blob, names[0])
      return
    }
    setZipping(true)
    try {
      const zip = await makeZip(done.map((it, i) => ({ name: names[i], blob: it.result!.blob })))
      download(zip, zipName())
    } catch (err) {
      console.error(err)
      setNotice('打包失敗，可能是檔案太多、記憶體不足，請改成一張一張下載。')
    } finally {
      setZipping(false)
    }
  }

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }))
  const effFormat = settings.format === 'keep' || !formats || formats.includes(settings.format) ? settings.format : 'image/jpeg'
  const unsupported = formats ? OUT_FORMATS.filter((f) => !formats.includes(f)) : []
  const mayJpeg = effFormat === 'image/jpeg' || effFormat === 'keep'
  const comparingItem = items.find((it) => it.id === comparing)

  return (
    <div className="imc" {...handlers}>
      <input
        ref={fileInput}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          void addFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />

      <div
        className={`imc-drop${dragging ? ' over' : ''}${items.length ? ' compact' : ''}`}
        onClick={() => fileInput.current?.click()}
      >
        <span className="imc-drop-icon" aria-hidden="true">
          🔄
        </span>
        <strong>{dragging ? '放開就加入' : items.length ? '再加入圖片' : '把圖片拖到這裡'}</strong>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            fileInput.current?.click()
          }}
        >
          選擇圖片
        </button>
        <span className="muted">可以一次多張，也可以貼上（Ctrl+V）；支援 iPhone 的 HEIC</span>
      </div>
      {notice && <p className="error">{notice}</p>}

      <section className="imc-settings" aria-label="輸出設定">
        <Segmented<FormatChoice>
          label="輸出格式"
          value={effFormat}
          onChange={(v) => set('format', v)}
          options={[
            { value: 'keep', label: '原格式' },
            ...OUT_FORMATS.map((f) => ({
              value: f,
              label: FORMAT_LABEL[f],
              disabled: formats !== null && !formats.includes(f),
              title: formats !== null && !formats.includes(f) ? '這個瀏覽器不支援輸出這種格式' : undefined,
            })),
          ]}
        />
        {unsupported.length > 0 && (
          <p className="muted imc-hint">
            這個瀏覽器不支援輸出 {unsupported.map((f) => FORMAT_LABEL[f]).join('、')}
            {unsupported.includes('image/webp') ? '（Safari 不能輸出 WebP，可以改用 Chrome、Edge 或 Firefox）' : ''}
            {unsupported.includes('image/avif') ? '；目前主要瀏覽器的畫布都還不能輸出 AVIF。' : '。'}
          </p>
        )}

        <label className="imc-range">
          <span className="imc-range-head">
            <span>品質</span>
            <output>{effFormat === 'image/png' ? '無損' : settings.quality}</output>
          </span>
          <input
            type="range"
            min={1}
            max={100}
            value={settings.quality}
            disabled={effFormat === 'image/png'}
            onChange={(e) => set('quality', Number(e.target.value))}
          />
        </label>
        {effFormat === 'image/png' && (
          <p className="muted imc-hint">PNG 是無損格式，品質不影響大小；想變小可以縮小尺寸，或改用 WebP／JPG。</p>
        )}

        <Segmented<ResizeMode>
          label="尺寸"
          value={settings.resize}
          onChange={(v) => set('resize', v)}
          options={[
            { value: 'none', label: '原尺寸' },
            { value: 'fit', label: '限制寬高' },
            { value: 'percent', label: '百分比' },
          ]}
        />
        {settings.resize === 'fit' && (
          <div className="imc-row">
            <label>
              最大寬度（px）
              <input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="不限"
                value={settings.maxW || ''}
                onChange={(e) => set('maxW', Math.max(0, Math.round(Number(e.target.value) || 0)))}
              />
            </label>
            <label>
              最大高度（px）
              <input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="不限"
                value={settings.maxH || ''}
                onChange={(e) => set('maxH', Math.max(0, Math.round(Number(e.target.value) || 0)))}
              />
            </label>
          </div>
        )}
        {settings.resize === 'fit' && <p className="muted imc-hint">維持長寬比，只縮小不放大；空白表示不限。</p>}
        {settings.resize === 'percent' && (
          <label className="imc-range">
            <span className="imc-range-head">
              <span>縮放比例</span>
              <output>{settings.percent}%</output>
            </span>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={settings.percent}
              onChange={(e) => set('percent', Number(e.target.value))}
            />
          </label>
        )}

        <div className="imc-options">
          {mayJpeg && (
            <label className="imc-inline">
              <input
                type="color"
                value={settings.background}
                onChange={(e) => set('background', e.target.value)}
                aria-label="JPG 透明處的底色"
              />
              <span>JPG 透明處的底色</span>
            </label>
          )}
          <label className="imc-check">
            <input type="checkbox" checked={settings.keepSmaller} onChange={(e) => set('keepSmaller', e.target.checked)} />
            <span>同格式、同尺寸卻變大時保留原檔</span>
          </label>
        </div>
      </section>

      {items.length > 0 && (
        <>
          <div className="imc-summary">
            <div className="imc-summary-text">
              <strong>
                {done.length}／{items.length} 張完成
              </strong>
              {done.length > 0 && (
                <span>
                  {formatBytes(totalBefore)} → {formatBytes(totalAfter)}
                  <span className={`imc-badge ${savingText(totalBefore, totalAfter).cls}`}>
                    {savingText(totalBefore, totalAfter).text}
                  </span>
                </span>
              )}
              {busy && <span className="muted">處理中…</span>}
            </div>
            <div className="imc-buttons">
              <button type="button" onClick={() => void downloadAll()} disabled={done.length === 0 || zipping}>
                {zipping ? '打包中…' : done.length > 1 ? `全部下載（ZIP，${done.length} 張）` : '下載'}
              </button>
              <button type="button" className="secondary" onClick={clearAll}>
                全部清除
              </button>
            </div>
          </div>

          <ul className="imc-list">
            {items.map((it) => {
              const r = it.result
              const name = r ? (r.kept ? it.file.name : outputName(it.file.name, r.format)) : it.file.name
              const saving = r ? savingText(it.file.size, r.blob.size) : null
              const thumb = r?.url ?? it.before
              return (
                <li key={it.id} className={`imc-item ${it.status}`}>
                  <button
                    type="button"
                    className="imc-thumb"
                    onClick={() => setComparing(it.id)}
                    disabled={!r || !it.before}
                    aria-label={`前後對照：${it.file.name}`}
                  >
                    {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span aria-hidden="true">🖼️</span>}
                    {it.status === 'decoding' && <span className="imc-thumb-state">解碼 HEIC…</span>}
                    {it.status === 'working' && <span className="imc-thumb-state">處理中…</span>}
                  </button>
                  <div className="imc-item-body">
                    <strong className="imc-ellipsis" title={it.file.name}>
                      {name}
                    </strong>
                    {it.status === 'error' ? (
                      <p className="error">{it.error}</p>
                    ) : (
                      <>
                        <span className="imc-meta">
                          {formatBytes(it.file.size)}
                          {r && (
                            <>
                              {' → '}
                              <strong>{formatBytes(r.blob.size)}</strong>
                              <span className={`imc-badge ${saving!.cls}`}>{saving!.text}</span>
                            </>
                          )}
                        </span>
                        {it.srcW && (
                          <span className="imc-meta">
                            {it.srcW}×{it.srcH}
                            {r && (r.width !== it.srcW || r.height !== it.srcH) && ` → ${r.width}×${r.height}`}
                            {r && ` · ${r.kept ? '保留原檔' : FORMAT_LABEL[r.format]}`}
                          </span>
                        )}
                        {r && saving?.cls === 'bad' && (
                          <span className="imc-meta warn">比原檔大，可以調低品質、縮小尺寸或換格式。</span>
                        )}
                      </>
                    )}
                    <div className="imc-buttons">
                      <button type="button" className="secondary" disabled={!r} onClick={() => r && download(r.blob, name)}>
                        下載
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!r || !it.before}
                        onClick={() => setComparing(it.id)}
                      >
                        對照
                      </button>
                      <button
                        type="button"
                        className="secondary imc-icon-btn"
                        onClick={() => remove(it.id)}
                        aria-label={`移除 ${it.file.name}`}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {comparingItem?.result && comparingItem.before && (
        <Compare
          name={comparingItem.file.name}
          before={comparingItem.before}
          after={comparingItem.result.url}
          width={comparingItem.result.width}
          height={comparingItem.result.height}
          beforeSize={comparingItem.file.size}
          afterSize={comparingItem.result.blob.size}
          onClose={() => setComparing(null)}
        />
      )}

      {dragging && items.length > 0 && (
        <div className="imc-veil" aria-hidden="true">
          放開就加入這些圖片
        </div>
      )}

      <section className="imc-notes">
        <h2>說明</h2>
        <ul className="muted">
          <li>全部在瀏覽器本機處理，圖片不會上傳。轉檔在背景執行緒進行，大圖也不會卡住畫面。</li>
          <li>
            iPhone 的 HEIC／HEIF：Safari 可以直接讀；其他瀏覽器第一次遇到 HEIC 時會下載 libheif 解碼器（壓縮後約 800
            KB，LGPL-3.0），之後留在快取。
          </li>
          <li>重新編碼會去掉 EXIF（拍攝地點、相機資訊），照片的方向會先轉正。GIF 動畫只會留下第一格。</li>
          <li>
            JPG、WebP 適合照片，品質 75–85 通常看不出差別；PNG 適合截圖、圖示和需要透明的圖。點縮圖或「對照」可以拖動分隔線比較前後差異。
          </li>
        </ul>
      </section>
    </div>
  )
}
