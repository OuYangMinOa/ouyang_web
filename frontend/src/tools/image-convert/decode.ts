// 主執行緒的解碼：HEIC，以及 worker 讀不了的檔案（例如 SVG）

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])

/** 看檔頭的 ftyp brand；iPhone 傳過來的檔名常常是 .JPG 但其實是 HEIC，反過來也有 */
export async function isHeic(file: File): Promise<boolean> {
  if (/heic|heif/i.test(file.type)) return true
  try {
    const head = new Uint8Array(await file.slice(4, 12).arrayBuffer())
    const text = String.fromCharCode(...head)
    // mif1 也可能是 AVIF；AVIF 瀏覽器自己讀得了，交給下面的原生解碼
    return text.startsWith('ftyp') && HEIC_BRANDS.has(text.slice(4)) && !/\.avif$/i.test(file.name)
  } catch {
    return false
  }
}

/** 先試瀏覽器原生解碼（Safari 讀得了 HEIC），不行才下載 libheif（heic-to，3.2 MB、gzip 後約 800 KB，只有遇到 HEIC 才載入） */
export async function decodeHeic(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    // 交給 libheif
  }
  const { heicTo } = await import('heic-to/csp')
  return heicTo({ blob: file, type: 'bitmap' })
}

/** 用 <img> 讀：SVG 這類 worker 的 createImageBitmap 不吃的格式 */
export async function decodeWithImg(file: Blob): Promise<ImageBitmap> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    // SVG 沒寫寬高時給個預設大小
    const w = img.naturalWidth || 1024
    const h = img.naturalHeight || 1024
    if (img.naturalWidth) return await createImageBitmap(img)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')?.drawImage(img, 0, 0, w, h)
    return await createImageBitmap(canvas)
  } finally {
    URL.revokeObjectURL(url)
  }
}
