import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import Editor, { type Loaded, type Progress } from './Editor'
import type { Backend, FromWorker, ToWorker } from './protocol'
import './remove-bg.css'

/** 編輯解析度的最長邊；超過就縮小來編輯，匯出時再放大回原尺寸 */
const MAX_EDIT = 2048

type Pending = { id: number; resolve: (mask: Uint8Array) => void; reject: (err: Error) => void }

function firstImage(files: FileList | File[] | undefined | null): File | null {
  for (const f of files ?? []) if (f.type.startsWith('image/')) return f
  return null
}

export default function RemoveBg() {
  const [image, setImage] = useState<Loaded | null>(null)
  const [soft, setSoft] = useState<Uint8Array | null>(null)
  const [backend, setBackend] = useState<Backend | null>(null)
  const [isnet, setIsnet] = useState<Progress>({ phase: 'idle' })
  const [sam, setSam] = useState<Progress>({ phase: 'idle' })
  const [loadError, setLoadError] = useState('')
  const [dragging, setDragging] = useState(false)

  const worker = useRef<Worker | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  /** 目前這張圖的編號；worker 回來的舊結果就丟掉 */
  const currentId = useRef(0)
  const imageRef = useRef<Loaded | null>(null)
  const pending = useRef(new Map<number, Pending>())
  const nextReq = useRef(0)
  const dragDepth = useRef(0)

  const onMessage = useCallback((e: MessageEvent<FromWorker>) => {
    const msg = e.data
    switch (msg.type) {
      case 'backend':
        setBackend(msg.backend)
        break
      case 'download': {
        const set = msg.task === 'isnet' ? setIsnet : setSam
        set({ phase: 'loading', loaded: msg.loaded, total: msg.total })
        break
      }
      case 'analyze':
        if (msg.id !== currentId.current) break
        ;(msg.task === 'isnet' ? setIsnet : setSam)({ phase: 'analyze' })
        break
      case 'mask':
        if (msg.id !== currentId.current) break
        setSoft(msg.data)
        setIsnet({ phase: 'idle' })
        break
      case 'segment': {
        const p = pending.current.get(msg.req)
        pending.current.delete(msg.req)
        setSam({ phase: 'idle' })
        if (p && p.id === currentId.current) p.resolve(msg.data)
        break
      }
      case 'error':
        if (msg.req !== undefined) {
          pending.current.get(msg.req)?.reject(new Error(msg.message))
          pending.current.delete(msg.req)
        }
        if (msg.id !== currentId.current) break
        ;(msg.task === 'isnet' ? setIsnet : setSam)({ phase: 'error', message: msg.message })
        break
    }
  }, [])

  const getWorker = useCallback(() => {
    if (!worker.current) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = onMessage
      w.onerror = (e) => {
        console.error(e)
        setIsnet({ phase: 'error', message: '背景執行緒啟動失敗' })
      }
      worker.current = w
    }
    return worker.current
  }, [onMessage])

  const send = useCallback(
    (msg: ToWorker, transfer: Transferable[] = []) => getWorker().postMessage(msg, transfer),
    [getWorker],
  )

  // 離開頁面：停掉 worker、釋放圖片
  useEffect(
    () => () => {
      worker.current?.terminate()
      worker.current = null
      imageRef.current?.full.close()
      imageRef.current = null
      for (const p of pending.current.values()) p.reject(new Error('已離開'))
      pending.current.clear()
    },
    [],
  )

  /** 把編輯解析度的圖交給 worker 去背 */
  const startRemoval = useCallback(
    async (img: Loaded) => {
      setSoft(null)
      setIsnet({ phase: 'loading' })
      const bitmap = await createImageBitmap(img.src)
      send({ type: 'remove', id: img.id, bitmap }, [bitmap])
    },
    [send],
  )

  const openFile = useCallback(
    async (file: File | null) => {
      if (!file) return
      setLoadError('')
      let full: ImageBitmap
      try {
        full = await createImageBitmap(file)
      } catch {
        setLoadError('讀不到這張圖片，可能是瀏覽器不支援的格式（例如 HEIC），請換成 JPG 或 PNG。')
        return
      }
      const s = Math.min(1, MAX_EDIT / Math.max(full.width, full.height))
      const w = Math.max(1, Math.round(full.width * s))
      const h = Math.max(1, Math.round(full.height * s))
      const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        full.close()
        setLoadError('瀏覽器無法建立畫布。')
        return
      }
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(full, 0, 0, w, h)

      const id = ++currentId.current
      const img: Loaded = { id, name: file.name, full, w, h, src: ctx.getImageData(0, 0, w, h) }
      imageRef.current?.full.close()
      imageRef.current = img
      for (const p of pending.current.values()) p.reject(new Error('已換圖'))
      pending.current.clear()
      setSam({ phase: 'idle' })
      setImage(img)
      await startRemoval(img)
    },
    [startRemoval],
  )

  const segment = useCallback(
    (points: [number, number][], labels: number[]) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const id = currentId.current
        const req = ++nextReq.current
        pending.current.set(req, { id, resolve, reject })
        setSam((s) => (s.phase === 'idle' || s.phase === 'error' ? { phase: 'busy' } : s))
        send({ type: 'segment', id, req, points, labels })
      }),
    [send],
  )

  const startOver = useCallback(() => {
    currentId.current++
    for (const p of pending.current.values()) p.reject(new Error('已換圖'))
    pending.current.clear()
    imageRef.current?.full.close()
    imageRef.current = null
    setImage(null)
    setSoft(null)
    setIsnet({ phase: 'idle' })
    setSam({ phase: 'idle' })
  }, [])

  // Ctrl+V 貼上圖片
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = firstImage(e.clipboardData?.files)
      if (!file) return
      e.preventDefault()
      void openFile(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [openFile])

  // 拖移：整個工具範圍都能放，dragenter/leave 會在子元素間反覆觸發，所以用計數
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const dragHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current++
      setDragging(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const file = firstImage(e.dataTransfer.files)
      if (file) void openFile(file)
      else setLoadError('請放入圖片檔。')
    },
  }

  return (
    <div className="rbg" {...dragHandlers}>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void openFile(firstImage(e.target.files))
          e.target.value = ''
        }}
      />

      {image ? (
        <>
          <Editor
            key={image.id}
            image={image}
            soft={soft}
            backend={backend}
            isnet={isnet}
            sam={sam}
            segment={segment}
            onRetry={() => void startRemoval(image)}
            onNew={startOver}
          />
          {loadError && <p className="error">{loadError}</p>}
          {dragging && (
            <div className="rbg-veil" aria-hidden="true">
              放開就換成這張圖
            </div>
          )}
        </>
      ) : (
        <div
          className={`rbg-drop${dragging ? ' over' : ''}`}
          onClick={() => fileInput.current?.click()}
        >
          <span className="rbg-drop-icon" aria-hidden="true">
            🖼️
          </span>
          <strong>{dragging ? '放開就開始去背' : '把圖片拖到這裡'}</strong>
          <span className="muted">或</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              fileInput.current?.click()
            }}
          >
            選擇圖片
          </button>
          <span className="muted">也可以直接貼上（Ctrl+V）</span>
          {loadError && <p className="error">{loadError}</p>}
        </div>
      )}

      <section className="rbg-notes">
        <h2>說明</h2>
        <ul className="muted">
          <li>
            去背模型是 DIS 的 ISNet（isnet-general-use，Apache-2.0），點選選區用 SlimSAM-77（Apache-2.0，約
            14–21 MB，第一次用到「點選」才下載）；模型都從 Hugging Face 下載，之後留在瀏覽器快取，不必再下載。
          </li>
          <li>
            瀏覽器支援 WebGPU（Chrome／Edge 121 以上）且顯示卡支援 fp16 時，用顯示卡跑 fp16 模型（88
            MB），一張圖幾秒；不支援就用 CPU 跑 int8 模型（46 MB），約半分鐘。運算在背景執行緒，畫面不會卡住。
          </li>
          <li>
            人像、產品圖效果好；髮絲、半透明、玻璃這類邊緣會比較毛。推論解析度固定 1024，超大圖的邊緣會略軟；編輯時最長邊縮到
            {MAX_EDIT}，下載時再放大回原尺寸。
          </li>
          <li>
            結果可以直接修：先選「保留」或「擦除」，再用「筆刷」沿著塗，或用「點選」點一下物件讓 AI
            自動選出整塊（每張圖第一次點選前要分析幾秒；Shift＋點可以加大上一次的選取、Alt＋點可以排除一塊）。勾「透顯原圖」看得到哪裡被去掉。「去除強度」與「邊緣」滑桿整體調整模型遮罩的切點與柔和度，修過的部分不受影響。
          </li>
          <li>全部在瀏覽器本機處理，圖片不會送到伺服器。</li>
        </ul>
      </section>
    </div>
  )
}
