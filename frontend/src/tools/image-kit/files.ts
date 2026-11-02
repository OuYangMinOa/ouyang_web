// 圖片小工具共用的檔案處理：挑出圖片、下載、畫布轉檔

/** 從 FileList 挑出圖片檔 */
export function imageFiles(files: FileList | File[] | undefined | null): File[] {
  return [...(files ?? [])].filter(isImageFile)
}

/** 是不是圖片：有些系統（Windows）給 HEIC 的 type 是空字串，所以也看副檔名 */
export function isImageFile(f: File) {
  return f.type.startsWith('image/') || /\.(heic|heif|avif|webp|jpe?g|png|gif|bmp|svg|ico|tiff?)$/i.test(f.name)
}

/** 檔名去掉副檔名 */
export const stem = (name: string) => name.replace(/\.[^.]+$/, '') || 'image'

/** 副檔名（含點），沒有就是空字串 */
export const extension = (name: string) => /\.[^.]+$/.exec(name)?.[0] ?? ''

/** 觸發瀏覽器下載；網址等一下再釋放，Safari 太早釋放會下載失敗 */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('輸出圖片失敗'))), type, quality),
  )
}

/**
 * 把畫布輸出的 JPEG 標成指定 DPI（改 JFIF 檔頭的解析度欄位，不重新壓縮），
 * 印表機和相片沖印才會照實際尺寸印。沒有 JFIF 檔頭就原樣回傳。
 */
export async function setJpegDpi(blob: Blob, dpi: number): Promise<Blob> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  // FF D8 FF E0 len(2) 'JFIF\0' ver(2) units(1) Xdensity(2) Ydensity(2)
  const isJfif =
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff &&
    buf[3] === 0xe0 &&
    String.fromCharCode(...buf.subarray(6, 11)) === 'JFIF\0'
  if (!isJfif) return blob
  buf[13] = 1 // 單位：每英吋
  buf[14] = dpi >> 8
  buf[15] = dpi & 0xff
  buf[16] = dpi >> 8
  buf[17] = dpi & 0xff
  return new Blob([buf], { type: 'image/jpeg' })
}

/** 第一個取得到的 2D 畫布 context；拿不到就丟錯 */
export function context2d(canvas: HTMLCanvasElement, willReadFrequently = false) {
  const ctx = canvas.getContext('2d', { willReadFrequently })
  if (!ctx) throw new Error('瀏覽器無法建立畫布')
  return ctx
}

/** 讀圖；HEIC 之類瀏覽器不支援的格式給清楚的錯誤訊息 */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    throw new Error('讀不到這張圖片，可能是瀏覽器不支援的格式（例如 HEIC），請換成 JPG 或 PNG。')
  }
}
