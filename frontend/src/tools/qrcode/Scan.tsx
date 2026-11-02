import { useEffect, useRef, useState } from 'react'
import { decodeImageFile } from '../../datamatrix/scanner'
import { isImageFile, useFileDrop } from '../useFileDrop'
import { parseScanned } from './payload'
import { CopyButton } from './ui'

type DetectedBarcode = { rawValue: string }
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorClass = {
  new (options: { formats: string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<string[]>
}
// TypeScript 的 DOM 型別還沒有 BarcodeDetector；它也只在 HTTPS 才存在
const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector

/** 相機只在 HTTPS（或 localhost）能用 */
const canUseCamera = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext

/** ZXing 每秒試幾次；每次把畫面縮到這個長邊再解 */
const ZXING_INTERVAL = 200
const ZXING_SIZE = 720

/** 有 BarcodeDetector（Android Chrome、macOS）就用它，沒有（iOS、Firefox）就每隔一下拿畫面給 ZXing 解 */
async function makeFrameDecoder(): Promise<(video: HTMLVideoElement) => Promise<string | null>> {
  if (Detector) {
    try {
      if ((await Detector.getSupportedFormats()).includes('qr_code')) {
        const detector = new Detector({ formats: ['qr_code'] })
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null
      }
    } catch {
      // 改用 ZXing
    }
  }
  const { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } = await import('@zxing/library')
  const reader = new QRCodeReader()
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return async (video) => {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!ctx || !vw || !vh) return null
    const s = Math.min(1, ZXING_SIZE / Math.max(vw, vh))
    const w = Math.round(vw * s)
    const h = Math.round(vh * s)
    canvas.width = w
    canvas.height = h
    ctx.drawImage(video, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)
    const lum = new Uint8ClampedArray(w * h)
    for (let i = 0; i < lum.length; i++) lum[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000
    try {
      return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, w, h)))).getText()
    } catch {
      return null // 這一格找不到
    }
  }
}

function LiveScanner({ onResult, onError, onClose }: { onResult: (t: string) => void; onError: (m: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const handlers = useRef({ onResult, onError, onClose })
  useEffect(() => {
    handlers.current = { onResult, onError, onClose }
  })

  useEffect(() => {
    let active = true
    let stream: MediaStream | null = null
    let timer = 0

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
      } catch (err) {
        const name = err instanceof DOMException ? err.name : ''
        if (active) {
          handlers.current.onError(
            name === 'NotAllowedError'
              ? '沒有相機權限。請在瀏覽器的網站設定允許使用相機，或改用「選擇圖片」。'
              : name === 'NotFoundError'
                ? '找不到相機。'
                : '無法開啟相機。',
          )
        }
        return
      }
      const v = video.current
      if (!active || !v) return
      v.srcObject = stream
      try {
        await v.play()
      } catch {
        // iOS 有時 play() 會丟錯但畫面照樣出來
      }
      const decode = await makeFrameDecoder()
      const tick = async () => {
        if (!active) return
        const text = await decode(v).catch(() => null)
        if (!active) return
        if (text) {
          navigator.vibrate?.(80)
          handlers.current.onResult(text)
          return
        }
        timer = window.setTimeout(tick, Detector ? 100 : ZXING_INTERVAL)
      }
      void tick()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handlers.current.onClose()
    }
    void start()
    window.addEventListener('keydown', onKey)
    return () => {
      active = false
      clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div className="qr-live">
      <video ref={video} autoPlay playsInline muted />
      <div className="qr-live-frame" aria-hidden="true">
        <span className="qr-live-line" />
      </div>
      <p className="qr-live-hint">把 QR Code 對準框內</p>
      <button type="button" className="secondary qr-live-close" onClick={onClose}>
        關閉相機
      </button>
    </div>
  )
}

function ScanResult({ text }: { text: string }) {
  const parsed = parseScanned(text)
  return (
    <div className="qr-result">
      {parsed.kind === 'url' && (
        <>
          <span className="qr-result-kind">網址</span>
          <a className="qr-result-link" href={parsed.url} target="_blank" rel="noopener noreferrer">
            {parsed.url}
          </a>
          <p className="muted">打開前先確認網域是你認得的網站。</p>
          <div className="qr-buttons">
            <a className="qr-btn-link" href={parsed.url} target="_blank" rel="noopener noreferrer">
              開啟連結
            </a>
            <CopyButton text={parsed.url} label="複製網址" />
          </div>
        </>
      )}

      {parsed.kind === 'wifi' && (
        <>
          <span className="qr-result-kind">Wi-Fi</span>
          <dl className="qr-dl">
            <div>
              <dt>網路名稱</dt>
              <dd>
                <span>{parsed.wifi.ssid || '（空白）'}</span>
                <CopyButton text={parsed.wifi.ssid} />
              </dd>
            </div>
            <div>
              <dt>密碼</dt>
              <dd>
                <span className="qr-mono">{parsed.wifi.auth === 'nopass' ? '（沒有密碼）' : parsed.wifi.password}</span>
                {parsed.wifi.auth !== 'nopass' && <CopyButton text={parsed.wifi.password} />}
              </dd>
            </div>
            <div>
              <dt>加密方式</dt>
              <dd>{parsed.wifi.auth === 'nopass' ? '無' : parsed.type || parsed.wifi.auth}</dd>
            </div>
            {parsed.wifi.hidden && (
              <div>
                <dt>隱藏網路</dt>
                <dd>是</dd>
              </div>
            )}
          </dl>
        </>
      )}

      {parsed.kind === 'fields' && (
        <>
          <span className="qr-result-kind">{parsed.title}</span>
          <dl className="qr-dl">
            {parsed.fields.map((f, i) => (
              <div key={i}>
                <dt>{f.label}</dt>
                <dd>
                  {f.href ? (
                    <a href={f.href} target="_blank" rel="noopener noreferrer">
                      {f.value}
                    </a>
                  ) : (
                    <span>{f.value}</span>
                  )}
                  {f.copy && <CopyButton text={f.value} />}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}

      {parsed.kind === 'text' && <span className="qr-result-kind">文字</span>}

      <details className="qr-raw" open={parsed.kind === 'text'}>
        <summary>原始內容</summary>
        <pre>{text}</pre>
        <CopyButton text={text} label="複製全部" />
      </details>
    </div>
  )
}

export default function Scan() {
  const [result, setResult] = useState('')
  const [camera, setCamera] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function decodeFile(file: File | undefined) {
    if (!file) return
    if (!isImageFile(file)) {
      setError('請選擇圖片檔。')
      return
    }
    setCamera(false)
    setBusy(true)
    setError('')
    try {
      setResult(await decodeImageFile(file))
    } catch {
      setResult('')
      setError('這張圖片裡找不到 QR Code。試試看裁切到只剩條碼、或拍清楚一點。')
    } finally {
      setBusy(false)
    }
  }

  const { dragging, handlers } = useFileDrop((files) => void decodeFile(files[0]))

  return (
    <div className={`qr-scan${dragging ? ' over' : ''}`} {...handlers}>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void decodeFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {camera ? (
        <LiveScanner
          onResult={(t) => {
            setResult(t)
            setError('')
            setCamera(false)
          }}
          onError={(m) => {
            setError(m)
            setCamera(false)
          }}
          onClose={() => setCamera(false)}
        />
      ) : (
        <div className="qr-scan-start">
          <span className="qr-scan-icon" aria-hidden="true">
            📷
          </span>
          <div className="qr-buttons">
            {canUseCamera && (
              <button
                type="button"
                onClick={() => {
                  setError('')
                  setCamera(true)
                }}
              >
                開啟相機掃描
              </button>
            )}
            <button type="button" className={canUseCamera ? 'secondary' : ''} onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? '解碼中…' : '選擇圖片'}
            </button>
          </div>
          <span className="muted">
            {dragging ? '放開就開始解碼' : '也可以把圖片拖到這裡，或直接貼上（Ctrl+V）'}
            {!canUseCamera && '。相機只在 HTTPS 網站能用。'}
          </span>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {result && <ScanResult text={result} />}
    </div>
  )
}
