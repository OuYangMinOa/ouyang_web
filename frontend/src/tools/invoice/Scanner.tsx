import { useEffect, useRef } from 'react'

// 掃描：瀏覽器有 BarcodeDetector（而且認得 QR Code）就用它，整個畫面一次找出所有條碼；
// 沒有的話（iOS Safari、Firefox）每 0.2 秒把取景框裡的畫面交給 ZXing 解一次。
// 電子發票證明聯有左右兩個 QR Code，ZXing 只看框內，所以要請使用者把左邊那個對準框。

type DetectedBarcode = { rawValue: string }
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorClass = {
  new (options: { formats: string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<string[]>
}

const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector

type Decode = (video: HTMLVideoElement) => Promise<string[]>

async function nativeDecoder(): Promise<Decode | null> {
  if (!Detector) return null
  try {
    if (!(await Detector.getSupportedFormats()).includes('qr_code')) return null
    const detector = new Detector({ formats: ['qr_code'] })
    return async (video) => (await detector.detect(video)).map((c) => c.rawValue)
  } catch {
    return null
  }
}

/** 取景框佔畫面短邊的比例，要跟 CSS 的 .inv-scan-frame 差不多 */
const FRAME_RATIO = 0.75
/** 交給 ZXing 的影像邊長，太大手機會解很久 */
const DECODE_SIZE = 640

async function zxingDecoder(): Promise<Decode> {
  const { BinaryBitmap, DecodeHintType, HybridBinarizer, QRCodeReader, RGBLuminanceSource } = await import('@zxing/library')
  const reader = new QRCodeReader()
  const hints = new Map<number, unknown>([[DecodeHintType.TRY_HARDER, true]])
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = DECODE_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const luminance = new Uint8ClampedArray(DECODE_SIZE * DECODE_SIZE)
  return async (video) => {
    const { videoWidth: w, videoHeight: h } = video
    if (!ctx || !w || !h) return []
    // video 用 object-fit: cover 鋪滿畫面，取景框在正中間，所以裁影像正中間的正方形
    const side = Math.min(w, h) * FRAME_RATIO
    ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, DECODE_SIZE, DECODE_SIZE)
    const { data } = ctx.getImageData(0, 0, DECODE_SIZE, DECODE_SIZE)
    for (let i = 0; i < luminance.length; i++) {
      luminance[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000
    }
    try {
      const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance, DECODE_SIZE, DECODE_SIZE)))
      return [reader.decode(bitmap, hints).getText()]
    } catch {
      return [] // 這一格找不到
    } finally {
      reader.reset()
    }
  }
}

export type ScanStatus = { tone: 'win' | 'maybe' | 'miss' | 'info'; title: string; detail?: string }

/**
 * 連續掃描：每掃到條碼就交給 onCodes，回傳 true 表示認得（是發票），之後停一下再繼續掃下一張。
 * 結果由父層算好用 status 顯示在畫面上方。
 */
export default function Scanner({
  status,
  onCodes,
  onError,
  onClose,
}: {
  status: ScanStatus | null
  onCodes: (codes: string[]) => boolean
  onError: () => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  // 父層每次重繪都會給新的函式，放在 ref 裡，相機才不會重開
  const handlers = useRef({ onCodes, onError, onClose })
  useEffect(() => {
    handlers.current = { onCodes, onError, onClose }
  })

  useEffect(() => {
    let active = true
    let stream: MediaStream | null = null
    let timer = 0

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        })
        const video = videoRef.current
        if (!active || !video) return
        video.srcObject = stream
        await video.play()
        const native = await nativeDecoder()
        const decode = native ?? (await zxingDecoder())
        const interval = native ? 100 : 200
        const tick = async () => {
          if (!active) return
          let pause = interval
          try {
            const codes = await decode(video)
            // 認得的話停 1.5 秒，讓人看結果、換下一張
            if (active && codes.length > 0 && handlers.current.onCodes(codes)) pause = 1500
          } catch {
            // 這一格解不出來就等下一格
          }
          if (active) timer = window.setTimeout(tick, pause)
        }
        tick()
      } catch {
        if (active) handlers.current.onError()
      }
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handlers.current.onClose()
    }

    start()
    window.addEventListener('keydown', onKey)
    return () => {
      active = false
      clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div className="inv-scanner" role="dialog" aria-label="掃描電子發票">
      <video ref={videoRef} autoPlay playsInline muted />
      <div className="inv-scan-ui">
        <div className={`inv-scan-status ${status?.tone ?? 'info'}`} aria-live="assertive">
          <strong>{status?.title ?? '對準證明聯左邊的 QR Code'}</strong>
          {status?.detail && <span>{status.detail}</span>}
        </div>
        <div className="inv-scan-frame">
          <span className="inv-scan-line" />
        </div>
        <p className="inv-scan-hint">可以一張接一張掃，掃完按「完成」</p>
      </div>
      <button type="button" className="secondary inv-scan-close" onClick={onClose}>
        完成
      </button>
    </div>
  )
}
