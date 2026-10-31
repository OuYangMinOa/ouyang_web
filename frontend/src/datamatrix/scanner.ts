// 掃描：支援 BarcodeDetector（而且認得 Data Matrix）的瀏覽器即時掃描相機畫面；
// 其他（iOS、HTTP 網站）改成拍照後解碼，解不出來再用 ZXing。

type DetectedBarcode = { rawValue: string }
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorClass = {
  new (options: { formats: string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<string[]>
}

// TypeScript 的 DOM 型別還沒有 BarcodeDetector；它也只在 HTTPS 才存在
const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector

/** 即時掃描要 BarcodeDetector 認得 data_matrix，相機也只在 HTTPS 能用 */
export async function canScanLive(): Promise<boolean> {
  if (!Detector || !navigator.mediaDevices?.getUserMedia) return false
  try {
    return (await Detector.getSupportedFormats()).includes('data_matrix')
  } catch {
    return false
  }
}

export function liveDetector(): BarcodeDetectorLike {
  if (!Detector) throw new Error('這個瀏覽器不支援即時掃描')
  return new Detector({ formats: ['qr_code', 'data_matrix'] })
}

/** 太大的照片先縮小，ZXing 在手機上才不會跑很久 */
const MAX_DECODE_SIZE = 2000

async function loadImage(file: File): Promise<HTMLImageElement> {
  const img = new Image()
  const url = URL.createObjectURL(file)
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
  return img
}

export async function decodeImageFile(file: File): Promise<string> {
  const img = await loadImage(file)

  // iOS 的 Vision 對靜態圖片支援的格式比即時影像多，getSupportedFormats 沒列 data_matrix 也可能解得出來
  if (Detector) {
    for (const formats of [['qr_code', 'data_matrix'], ['qr_code']]) {
      try {
        const codes = await new Detector({ formats }).detect(img)
        if (codes.length > 0) return codes[0].rawValue
      } catch {
        // 格式不支援就試下一組
      }
    }
  }

  const ratio = Math.min(1, MAX_DECODE_SIZE / Math.max(img.naturalWidth, img.naturalHeight))
  const width = Math.round(img.naturalWidth * ratio)
  const height = Math.round(img.naturalHeight * ratio)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('無法讀取圖片')
  ctx.drawImage(img, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)
  // ZXing 要的是灰階亮度，不是 RGBA
  const luminance = new Uint8ClampedArray(width * height)
  for (let i = 0; i < luminance.length; i++) {
    luminance[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000
  }

  const { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } =
    await import('@zxing/library')
  const reader = new MultiFormatReader()
  reader.setHints(
    new Map<number, unknown>([
      [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX]],
      [DecodeHintType.TRY_HARDER, true],
    ]),
  )
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance, width, height)))
  return reader.decode(bitmap).getText() // 找不到會丟 NotFoundException
}
