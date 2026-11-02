// 圖片小工具共用的上傳 hooks：拖曳、點選選檔、Ctrl+V 貼上
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { imageFiles } from './files'

/**
 * 整個工具範圍都能把檔案拖進來。dragenter/leave 會在子元素間反覆觸發，所以用計數。
 * onFiles 只會收到圖片；拖進來的不是圖片時 onReject 會被呼叫。
 */
export function useFileDrop(onFiles: (files: File[]) => void, onReject?: () => void) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setDragging(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = imageFiles(e.dataTransfer.files)
      if (files.length) onFiles(files)
      else onReject?.()
    },
  }
  return { dragging, handlers }
}

/** Ctrl+V 貼上圖片 */
export function usePasteImages(onFiles: (files: File[]) => void) {
  const latest = useRef(onFiles)
  useEffect(() => {
    latest.current = onFiles
  })
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData?.files)
      if (!files.length) return
      e.preventDefault()
      latest.current(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])
}

/** 隱藏的 file input 與打開它的函式 */
export function useFilePicker(onFiles: (files: File[]) => void, multiple = false) {
  const ref = useRef<HTMLInputElement>(null)
  const input = (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      multiple={multiple}
      hidden
      onChange={(e) => {
        const files = imageFiles(e.target.files)
        if (files.length) onFiles(multiple ? files : files.slice(0, 1))
        e.target.value = ''
      }}
    />
  )
  return { input, open: () => ref.current?.click() }
}
