/** 後端收的格式；其他格式（例如 HEIC、BMP）先轉成 WebP 再傳 */
const ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** 長邊超過這個就縮小 */
const MAX_SIDE = 2400
/** 這個大小以內、尺寸也沒超過就原檔上傳（截圖的文字比較清楚） */
const KEEP_BYTES = 1.5 * 1024 * 1024
/** 跟後端的上限一樣 */
export const MAX_BYTES = 5 * 1024 * 1024

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
}

/** 太大的圖片先在瀏覽器縮小、轉成 WebP（不支援就 JPEG），省流量也不會撞到上傳上限 */
export async function prepareImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) {
    if (ACCEPTED.includes(file.type)) return file
    throw new Error('看不懂這個圖片格式')
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size <= KEEP_BYTES && ACCEPTED.includes(file.type)) {
    bitmap.close()
    return file
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('瀏覽器無法處理圖片')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  for (const quality of [0.9, 0.75, 0.6]) {
    let blob = await toBlob(canvas, 'image/webp', quality)
    // 不支援 WebP 的瀏覽器會改給 PNG
    if (blob && blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality)
    if (blob && blob.size <= MAX_BYTES) return blob
  }
  throw new Error('圖片太大（上限 5 MB）')
}

/** 剪貼簿裡的圖片。同時有文字時當作貼文字（例如從試算表複製的儲存格也會附一張圖） */
export function imagesFromClipboard(data: DataTransfer): File[] {
  if (data.getData('text/plain')) return []
  return Array.from(data.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

/** 拖曳進來或檔案選擇器選到的圖片 */
export function filesOf(source: { files: FileList | null }): File[] {
  return Array.from(source.files ?? []).filter((file) => file.type.startsWith('image/'))
}
