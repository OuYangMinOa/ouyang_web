import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { errorMessage } from '../api'
import { uploadImage, type Draft } from './api'
import { filesOf, imagesFromClipboard, prepareImage } from './images'

/** 跟後端的上限一樣 */
const MAX_IMAGES = 6

/** 貼上的圖片：一貼上就開始上傳，拿到 id 才能送出 */
type PendingImage = { key: number; url: string; id?: number; error?: string }

type Props = {
  /** 送出；丟出錯誤會顯示在輸入框下面，成功才清空 */
  onSubmit: (draft: Draft) => Promise<void>
  placeholder?: string
  submitLabel?: string
  /** 放在輸入框上面的欄位（例如新增時的種類和標題） */
  children?: ReactNode
}

/** 留言輸入框：Ctrl+V 貼上截圖、拖曳或選擇圖片，Ctrl+Enter 送出 */
export default function Composer({ onSubmit, placeholder, submitLabel = '送出', children }: Props) {
  const [body, setBody] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const nextKey = useRef(0)
  // 離開頁面時釋放預覽圖
  const urls = useRef(new Set<string>())
  useEffect(() => {
    const live = urls.current
    return () => live.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  function update(key: number, patch: Partial<PendingImage>) {
    setImages((prev) => prev.map((image) => (image.key === key ? { ...image, ...patch } : image)))
  }

  function addFiles(files: File[]) {
    if (files.length === 0) return
    const room = MAX_IMAGES - images.length
    setError(files.length > room ? `一則留言最多 ${MAX_IMAGES} 張圖片` : null)
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = nextKey.current++
      const url = URL.createObjectURL(file)
      urls.current.add(url)
      setImages((prev) => [...prev, { key, url }])
      prepareImage(file)
        .then(uploadImage)
        .then(
          (id) => update(key, { id }),
          (e) => update(key, { error: errorMessage(e) }),
        )
    }
  }

  function remove(image: PendingImage) {
    URL.revokeObjectURL(image.url)
    urls.current.delete(image.url)
    setImages((prev) => prev.filter((i) => i.key !== image.key))
  }

  function onPaste(e: ClipboardEvent) {
    const files = imagesFromClipboard(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }

  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragging(true)
  }

  function onDrop(e: DragEvent) {
    setDragging(false)
    const files = filesOf(e.dataTransfer)
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }

  const uploading = images.some((i) => i.id === undefined && !i.error)
  const failed = images.some((i) => i.error)
  const empty = !body.trim() && images.length === 0
  const canSend = !busy && !uploading && !failed && !empty

  async function submit() {
    if (!canSend) return
    setBusy(true)
    try {
      await onSubmit({ body, images: images.map((i) => i.id!) })
      images.forEach((image) => {
        URL.revokeObjectURL(image.url)
        urls.current.delete(image.url)
      })
      setBody('')
      setImages([])
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <form
      className={`fb-composer ${dragging ? 'dragging' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {children}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={4}
        maxLength={4000}
        aria-label="內容"
      />
      {images.length > 0 && (
        <ul className="fb-pending">
          {images.map((image) => (
            <li key={image.key} className={image.error ? 'failed' : image.id === undefined ? 'uploading' : ''}>
              <img src={image.url} alt="" />
              {image.id === undefined && !image.error && <span className="fb-pending-state">上傳中…</span>}
              {image.error && <span className="fb-pending-state">{image.error}</span>}
              <button type="button" className="fb-pending-remove" onClick={() => remove(image)} aria-label="移除圖片">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      <div className="fb-composer-bar">
        <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>
          🖼 附加圖片
        </button>
        <span className="muted fb-hint">可以直接 Ctrl+V 貼上截圖，Ctrl+Enter 送出</span>
        <button type="submit" disabled={!canSend}>
          {busy ? '送出中…' : uploading ? '圖片上傳中…' : submitLabel}
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          addFiles(filesOf(e.target))
          e.target.value = ''
        }}
      />
    </form>
  )
}
