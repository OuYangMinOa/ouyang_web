import { useEffect, useRef, useState, type DragEvent } from 'react'

/** 是不是圖片：有些系統（Windows）給 HEIC 的 type 是空字串，所以也看副檔名 */
export function isImageFile(f: File) {
  return f.type.startsWith('image/') || /\.(heic|heif|avif|webp|jpe?g|png|gif|bmp|svg|ico|tiff?)$/i.test(f.name)
}

/**
 * 拖檔案進來、Ctrl+V 貼上圖片。
 * 拖移的 dragenter/leave 會在子元素間反覆觸發，所以用計數；貼上掛在 window，enabled 為 false 時不接。
 */
export function useFileDrop(onFiles: (files: File[]) => void, { paste = true, enabled = true } = {}) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  // 父層每次重繪都會給新的函式，放在 ref 裡，貼上的監聽才不用一直重掛
  const handler = useRef(onFiles)
  useEffect(() => {
    handler.current = onFiles
  })

  useEffect(() => {
    if (!paste || !enabled) return
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter(isImageFile)
      if (files.length === 0) return
      e.preventDefault()
      handler.current(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [paste, enabled])

  const hasFiles = (e: DragEvent) => enabled && e.dataTransfer.types.includes('Files')
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
      handler.current([...e.dataTransfer.files])
    },
  }

  return { dragging, handlers }
}
