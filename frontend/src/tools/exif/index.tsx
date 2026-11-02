import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { downloadBlob, extension, stem } from '../image-kit/files'
import { useFileDrop, useFilePicker, usePasteImages } from '../image-kit/hooks'
import { DropVeil, DropZone } from '../image-kit/ImageDrop'
import { canStrip, inspect, stripAll, stripGps, type Format, type Inspection } from './container'
import { allFields, gpsOf, summary, type Gps } from './fields'
import { uniqueNames, zip } from './zip'
import './exif.css'

// 地圖（Leaflet）只有照片有 GPS 時才載入
const MiniMap = lazy(() => import('./MiniMap'))

type Kind = 'all' | 'gps'

type Item = {
  id: number
  file: File
  bytes: Uint8Array
  /** 縮圖用的網址 */
  url: string
  info: Inspection | null
  gps: Gps | null
  error?: string
  dims?: { w: number; h: number }
  result?: { ok: boolean; text: string }
}

const FORMAT_NAME: Record<Format, string> = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', heic: 'HEIC／AVIF', other: '其他' }
const MIME: Record<Format, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: '', other: '' }
const SUFFIX: Record<Kind, string> = { all: '已清除', gps: '無定位' }
/** 地圖一次最多自動顯示幾張，太多張就讓使用者自己點開 */
const AUTO_MAPS = 3

const size = (n: number) =>
  n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`

/** 處理後的檔案，順便重新讀一次確認真的清掉了 */
function process(item: Item, kind: Kind): { data: Uint8Array; name: string; check: string } {
  const data = kind === 'all' ? stripAll(item.bytes) : stripGps(item.bytes)
  const after = inspect(data)
  const left = gpsOf(after.tags) || after.xmpGps
  if (left) throw new Error('處理後仍讀得到 GPS，請回報這張照片的格式')
  let check = '已確認沒有 GPS 位置'
  if (kind === 'all') {
    const remaining = after.tags ? summary(after.tags).filter((r) => r.label !== '方向') : []
    if (remaining.length) throw new Error('處理後仍有中繼資料')
    const saved = item.bytes.length - data.length
    check = `已移除全部中繼資料${saved > 0 ? `，少了 ${size(saved)}` : ''}`
  }
  const ext = extension(item.file.name) || `.${item.info?.format === 'jpeg' ? 'jpg' : (item.info?.format ?? 'bin')}`
  return { data, name: `${stem(item.file.name)}-${SUFFIX[kind]}${ext}`, check }
}

function Card({
  item,
  showMap: mapDefault,
  onRun,
  onRemove,
  onDims,
}: {
  item: Item
  showMap: boolean
  onRun: (kind: Kind) => void
  onRemove: () => void
  onDims: (w: number, h: number) => void
}) {
  const [showMap, setShowMap] = useState(mapDefault)
  const [thumbOk, setThumbOk] = useState(true)
  const { info, gps } = item
  const rows = summary(info?.tags ?? null)
  const raw = allFields(info?.tags ?? null)
  const supported = !!info && canStrip(info.format)
  const hasGps = !!gps || !!info?.xmpGps

  return (
    <li className="card exif-card">
      <div className="exif-head">
        {thumbOk ? (
          <img
            className="exif-thumb"
            src={item.url}
            alt=""
            onLoad={(e) => onDims(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
            onError={() => setThumbOk(false)}
          />
        ) : (
          <span className="exif-thumb exif-thumb-none" aria-hidden="true">
            📷
          </span>
        )}
        <div className="exif-title">
          <strong>{item.file.name}</strong>
          <span className="muted">
            {info ? FORMAT_NAME[info.format] : '讀取中'} · {size(item.file.size)}
            {item.dims && ` · ${item.dims.w}×${item.dims.h}`}
          </span>
          <span>
            {hasGps ? (
              <span className="chip exif-chip-gps">含 GPS 位置</span>
            ) : info?.tags ? (
              <span className="chip subtle">沒有 GPS</span>
            ) : info ? (
              <span className="chip subtle">沒有 EXIF</span>
            ) : null}
          </span>
        </div>
        <button type="button" className="secondary exif-remove" onClick={onRemove} aria-label={`移除 ${item.file.name}`}>
          ✕
        </button>
      </div>

      {item.error && <p className="error">{item.error}</p>}
      {info && !supported && (
        <p className="muted">
          目前只支援 JPEG、PNG、WebP。{info.format === 'heic' && 'iPhone 的 HEIC 可以在「設定 → 相機 → 格式」改成「最相容」，或分享時選擇 JPEG。'}
        </p>
      )}

      {rows.length > 0 && (
        <dl className="exif-fields">
          {rows.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {gps && (
        <div className="exif-gps">
          <dl className="exif-fields">
            <div>
              <dt>座標</dt>
              <dd>
                {gps.lat.toFixed(6)}, {gps.lon.toFixed(6)}
              </dd>
            </div>
            {gps.alt !== undefined && (
              <div>
                <dt>高度</dt>
                <dd>{gps.alt.toFixed(1)} m</dd>
              </div>
            )}
            {gps.direction !== undefined && (
              <div>
                <dt>拍攝方向</dt>
                <dd>{gps.direction.toFixed(0)}°</dd>
              </div>
            )}
            {gps.time && (
              <div>
                <dt>定位時間</dt>
                <dd>{gps.time}</dd>
              </div>
            )}
          </dl>
          <div className="exif-links">
            <a className="text-link" href={`https://www.google.com/maps?q=${gps.lat},${gps.lon}`} target="_blank" rel="noreferrer">
              Google 地圖
            </a>
            <a
              className="text-link"
              href={`https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lon}#map=16/${gps.lat}/${gps.lon}`}
              target="_blank"
              rel="noreferrer"
            >
              OpenStreetMap
            </a>
            {!showMap && (
              <button type="button" className="secondary" onClick={() => setShowMap(true)}>
                顯示地圖
              </button>
            )}
          </div>
          {showMap && (
            <Suspense fallback={<div className="exif-map" />}>
              <MiniMap lat={gps.lat} lon={gps.lon} />
            </Suspense>
          )}
        </div>
      )}
      {!gps && info?.xmpGps && <p className="muted">EXIF 沒有座標，但 XMP 裡有 GPS 資料。</p>}

      {info && info.extras.length > 0 && (
        <p className="muted">其他中繼資料：{info.extras.join('、')}</p>
      )}

      {raw.length > 0 && (
        <details className="exif-raw">
          <summary className="ik-summary">全部 EXIF 欄位（{raw.length}）</summary>
          <div className="exif-raw-scroll">
            <table className="responsive">
              <thead>
                <tr>
                  <th>分類</th>
                  <th>欄位</th>
                  <th>值</th>
                </tr>
              </thead>
              <tbody>
                {raw.map((r, i) => (
                  <tr key={i}>
                    <td data-label="分類">{r.group}</td>
                    <td data-label="欄位">{r.name}</td>
                    <td data-label="值">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {supported && (
        <div className="ik-buttons">
          <button type="button" onClick={() => onRun('all')}>
            ⬇ 移除全部中繼資料
          </button>
          <button type="button" className="secondary" onClick={() => onRun('gps')} disabled={!hasGps}>
            ⬇ 只移除 GPS
          </button>
        </div>
      )}
      {item.result && (
        <p className={item.result.ok ? 'success' : 'error'} role="status">
          {item.result.text}
        </p>
      )}
    </li>
  )
}

export default function Exif() {
  const [items, setItems] = useState<Item[]>([])
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const nextId = useRef(0)

  const addFiles = async (files: File[]) => {
    setLoadError('')
    setNotice(null)
    const added: Item[] = []
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let info: Inspection | null = null
      let error: string | undefined
      try {
        info = inspect(bytes)
      } catch (err) {
        error = `讀取失敗：${err instanceof Error ? err.message : String(err)}`
      }
      added.push({ id: ++nextId.current, file, bytes, url: URL.createObjectURL(file), info, gps: gpsOf(info?.tags ?? null), error })
    }
    setItems((old) => [...old, ...added])
  }

  // 離開頁面時釋放縮圖網址
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  useEffect(() => () => itemsRef.current.forEach((it) => URL.revokeObjectURL(it.url)), [])

  const update = (id: number, patch: Partial<Item>) => setItems((old) => old.map((it) => (it.id === id ? { ...it, ...patch } : it)))

  const remove = (id: number) =>
    setItems((old) => {
      const it = old.find((x) => x.id === id)
      if (it) URL.revokeObjectURL(it.url)
      return old.filter((x) => x.id !== id)
    })

  const clear = () => {
    items.forEach((it) => URL.revokeObjectURL(it.url))
    setItems([])
    setNotice(null)
  }

  const runOne = (item: Item, kind: Kind) => {
    try {
      const out = process(item, kind)
      downloadBlob(new Blob([new Uint8Array(out.data)], { type: MIME[item.info!.format] }), out.name)
      update(item.id, { result: { ok: true, text: `${out.check}，已下載 ${out.name}` } })
    } catch (err) {
      update(item.id, { result: { ok: false, text: err instanceof Error ? err.message : '處理失敗' } })
    }
  }

  const supported = items.filter((it) => it.info && canStrip(it.info.format))

  const runAll = (kind: Kind) => {
    setNotice(null)
    const targets = kind === 'gps' ? supported.filter((it) => it.gps || it.info?.xmpGps) : supported
    if (!targets.length) {
      setNotice({ ok: false, text: kind === 'gps' ? '沒有含 GPS 的照片。' : '沒有可以處理的照片。' })
      return
    }
    if (targets.length === 1) {
      runOne(targets[0], kind)
      return
    }
    const outs: { name: string; data: Uint8Array }[] = []
    const failed: string[] = []
    for (const it of targets) {
      try {
        const out = process(it, kind)
        outs.push({ name: out.name, data: out.data })
        update(it.id, { result: { ok: true, text: out.check } })
      } catch (err) {
        failed.push(it.file.name)
        update(it.id, { result: { ok: false, text: err instanceof Error ? err.message : '處理失敗' } })
      }
    }
    if (outs.length) {
      const names = uniqueNames(outs.map((o) => o.name))
      downloadBlob(zip(outs.map((o, i) => ({ name: names[i], data: o.data }))), `照片-${SUFFIX[kind]}.zip`)
    }
    setNotice({
      ok: !failed.length,
      text: `已處理 ${outs.length} 張並打包成 ZIP${failed.length ? `；${failed.length} 張失敗：${failed.join('、')}` : ''}`,
    })
  }

  const picker = useFilePicker((files) => void addFiles(files), true)
  usePasteImages((files) => void addFiles(files))
  const { dragging, handlers } = useFileDrop(
    (files) => void addFiles(files),
    () => setLoadError('請放入圖片檔。'),
  )

  const gpsCount = supported.filter((it) => it.gps || it.info?.xmpGps).length

  return (
    <div className="ik exif" {...handlers}>
      {picker.input}
      {items.length ? (
        <>
          <div className="card exif-bar">
            <p className="muted">
              共 {items.length} 張，{gpsCount ? <strong className="exif-warn">{gpsCount} 張含 GPS 位置</strong> : '都沒有 GPS 位置'}
            </p>
            <div className="ik-buttons">
              <button type="button" onClick={() => runAll('all')} disabled={!supported.length}>
                全部移除中繼資料{supported.length > 1 ? '（ZIP）' : ''}
              </button>
              <button type="button" className="secondary" onClick={() => runAll('gps')} disabled={!gpsCount}>
                全部只移除 GPS{gpsCount > 1 ? '（ZIP）' : ''}
              </button>
            </div>
            <div className="ik-buttons">
              <button type="button" className="secondary" onClick={picker.open}>
                ＋ 加入照片
              </button>
              <button type="button" className="secondary" onClick={clear}>
                清空
              </button>
            </div>
            {notice && (
              <p className={notice.ok ? 'success' : 'error'} role="status">
                {notice.text}
              </p>
            )}
            {loadError && <p className="error">{loadError}</p>}
          </div>
          <ul className="exif-list">
            {items.map((it, i) => (
              <Card
                key={it.id}
                item={it}
                showMap={i < AUTO_MAPS}
                onRun={(kind) => runOne(it, kind)}
                onRemove={() => remove(it.id)}
                onDims={(w, h) => update(it.id, { dims: { w, h } })}
              />
            ))}
          </ul>
          {dragging && <DropVeil text="放開就加入這些照片" />}
        </>
      ) : (
        <DropZone dragging={dragging} onPick={picker.open} icon="📷" title="把照片拖到這裡（可以多張）" dropTitle="放開就開始讀取">
          {loadError && <p className="error">{loadError}</p>}
        </DropZone>
      )}

      <section className="ik-notes">
        <h2>說明</h2>
        <ul className="muted">
          <li>
            手機拍的照片通常記錄了拍攝時間、手機型號，開了定位的話還有 GPS 座標，直接傳到網路上別人就可能知道你家在哪裡。很多社群網站上傳時會自動清掉，但用電子郵件、雲端硬碟或通訊軟體的「原始檔」傳送時多半會保留。
          </li>
          <li>
            「移除全部中繼資料」會拿掉 EXIF、XMP、IPTC、註解與檔尾附加的資料（例如景深圖），只保留色彩描述檔；JPEG
            會留下照片方向，直拍的照片才不會躺下來。「只移除 GPS」會把座標、高度、定位時間清成零，拍攝時間和相機資訊保留。
          </li>
          <li>
            兩種都是直接改檔案結構，不重新壓縮，畫質完全不變。目前支援 JPEG、PNG、WebP；HEIC 只能看格式，無法讀取或清除。
          </li>
          <li>處理完會重新讀一次檔案，確認真的清掉了。多張照片一起處理時會打包成 ZIP 下載。</li>
          <li>全部在瀏覽器本機處理，照片不會送到伺服器；只有顯示小地圖時會向 Esri 下載地圖圖磚。</li>
        </ul>
      </section>
    </div>
  )
}
