// 解碼、縮放、編碼。worker 和主執行緒（瀏覽器沒有 OffscreenCanvas 時）共用這一份

export type OutFormat = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'
export const OUT_FORMATS: OutFormat[] = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']

export type Resize =
  | { mode: 'none' }
  /** 限制最大寬高，0 表示不限；只縮小不放大 */
  | { mode: 'fit'; maxW: number; maxH: number }
  | { mode: 'percent'; percent: number }

export type ConvertOptions = {
  format: OutFormat
  /** 0–1；PNG 不看 */
  quality: number
  resize: Resize
  /** JPG 沒有透明，透明的地方填這個顏色 */
  background: string
}

/** 檔案或已經解碼好的圖（HEIC、或 worker 讀不了改由主執行緒解碼的） */
export type Source = Blob | ImageBitmap

export type Converted = { blob: Blob; width: number; height: number; srcWidth: number; srcHeight: number }

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
type AnyContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

let offscreen2d: boolean | undefined
/** OffscreenCanvas 要能拿到 2d context 才算數（舊版 Safari 有 OffscreenCanvas 但只能 WebGL） */
export function hasOffscreen2d() {
  if (offscreen2d === undefined) {
    try {
      offscreen2d = typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d')
    } catch {
      offscreen2d = false
    }
  }
  return offscreen2d
}

function makeCanvas(w: number, h: number): [AnyCanvas, AnyContext] {
  let canvas: AnyCanvas
  if (hasOffscreen2d()) {
    canvas = new OffscreenCanvas(w, h)
  } else {
    canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d') as AnyContext | null
  if (!ctx) throw new Error('瀏覽器無法建立畫布（圖片可能太大）')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return [canvas, ctx]
}

/** 用完把畫布縮到 1×1，Safari 才會馬上放掉記憶體 */
function release(canvas: AnyCanvas) {
  canvas.width = 1
  canvas.height = 1
}

function encode(canvas: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('編碼失敗'))), type, quality),
  )
}

/** 瀏覽器不支援的格式會默默改出 PNG，所以看產出的 type 對不對 */
export async function supportedFormats(): Promise<OutFormat[]> {
  const out: OutFormat[] = []
  for (const f of OUT_FORMATS) {
    try {
      const [canvas] = makeCanvas(2, 2)
      const blob = await encode(canvas, f, 0.8)
      if (blob.type === f) out.push(f)
    } catch {
      // 不支援就跳過
    }
  }
  return out
}

export function targetSize(w: number, h: number, resize: Resize): [number, number] {
  let s = 1
  if (resize.mode === 'fit') {
    if (resize.maxW > 0) s = Math.min(s, resize.maxW / w)
    if (resize.maxH > 0) s = Math.min(s, resize.maxH / h)
  } else if (resize.mode === 'percent') {
    s = Math.min(1, Math.max(0.01, resize.percent / 100))
  }
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
}

export async function convert(source: Source, opts: ConvertOptions): Promise<Converted> {
  const own = source instanceof Blob
  let bitmap: ImageBitmap
  try {
    bitmap = own ? await createImageBitmap(source) : source
  } catch {
    throw new DecodeError()
  }
  const srcWidth = bitmap.width
  const srcHeight = bitmap.height
  const [width, height] = targetSize(srcWidth, srcHeight, opts.resize)

  try {
    // 縮很多時一次縮一半，邊緣比較不會有鋸齒
    let img: CanvasImageSource = bitmap
    let w = srcWidth
    let h = srcHeight
    const steps: AnyCanvas[] = []
    while (w / 2 >= width && h / 2 >= height) {
      w = Math.round(w / 2)
      h = Math.round(h / 2)
      const [c, ctx] = makeCanvas(w, h)
      ctx.drawImage(img, 0, 0, w, h)
      steps.push(c)
      img = c
    }

    const [canvas, ctx] = makeCanvas(width, height)
    if (opts.format === 'image/jpeg') {
      ctx.fillStyle = opts.background
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(img, 0, 0, width, height)
    steps.forEach(release)

    const blob = await encode(canvas, opts.format, opts.quality)
    release(canvas)
    if (blob.type !== opts.format) throw new Error('這個瀏覽器不支援輸出這種格式')
    return { blob, width, height, srcWidth, srcHeight }
  } finally {
    if (own) bitmap.close()
  }
}

/** 瀏覽器讀不了這個檔案（在 worker 裡讀不了的話，主執行緒會改用 <img> 再試一次） */
export class DecodeError extends Error {
  constructor() {
    super('decode')
  }
}
