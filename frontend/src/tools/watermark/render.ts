// 浮水印與遮蔽的合成：預覽和下載用同一份程式，只差輸出尺寸

/** 遮蔽區域；座標是相對圖片寬高的比例（0–1），預覽和原尺寸都能用 */
export type Redaction = { kind: 'mosaic' | 'black'; x: number; y: number; w: number; h: number }

export type Mark = {
  text: string
  /** 字級：圖片短邊的百分比 */
  size: number
  /** 不透明度 0–100 */
  opacity: number
  color: string
  /** 角度（度），負的是往右上斜 */
  angle: number
  /** 密度 1–10，越大越密 */
  density: number
  bold: boolean
}

const FONT = "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif"

/** 馬賽克一格的大小：短邊的 1/45，預覽和原尺寸看起來一樣粗 */
const mosaicBlock = (w: number, h: number) => Math.max(4, Math.round(Math.min(w, h) / 45))

function redact(ctx: CanvasRenderingContext2D, r: Redaction, W: number, H: number) {
  const x = Math.max(0, Math.floor(r.x * W))
  const y = Math.max(0, Math.floor(r.y * H))
  const w = Math.min(W, Math.ceil((r.x + r.w) * W)) - x
  const h = Math.min(H, Math.ceil((r.y + r.h) * H)) - y
  if (w <= 0 || h <= 0) return
  if (r.kind === 'black') {
    // 塗黑一定是純黑，跟主題無關
    ctx.fillStyle = '#000000'
    ctx.fillRect(x, y, w, h)
    return
  }
  // 先平均縮小成一格一點，再不做平滑放大回去
  const block = mosaicBlock(W, H)
  const tiny = document.createElement('canvas')
  tiny.width = Math.max(1, Math.ceil(w / block))
  tiny.height = Math.max(1, Math.ceil(h / block))
  const t = tiny.getContext('2d')
  if (!t) return
  t.imageSmoothingEnabled = true
  t.imageSmoothingQuality = 'high'
  t.drawImage(ctx.canvas, x, y, w, h, 0, 0, tiny.width, tiny.height)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x, y, tiny.width * block, tiny.height * block)
  ctx.restore()
}

function watermark(ctx: CanvasRenderingContext2D, m: Mark, W: number, H: number) {
  const text = m.text.trim()
  if (!text) return
  const fs = Math.max(6, (m.size / 100) * Math.min(W, H))
  ctx.save()
  ctx.globalAlpha = m.opacity / 100
  ctx.fillStyle = m.color
  ctx.font = `${m.bold ? 700 : 400} ${fs}px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const tw = ctx.measureText(text).width
  const gap = fs * (3.6 - m.density * 0.3)
  const stepX = tw + gap * 1.5
  const stepY = fs + gap
  ctx.translate(W / 2, H / 2)
  ctx.rotate((m.angle * Math.PI) / 180)
  // 轉過之後要蓋滿整張，範圍取對角線
  const reach = Math.hypot(W, H) / 2
  const rows = Math.ceil(reach / stepY) + 1
  const cols = Math.ceil(reach / stepX) + 2
  for (let j = -rows; j <= rows; j++) {
    const shift = j % 2 ? stepX / 2 : 0
    for (let i = -cols; i <= cols; i++) ctx.fillText(text, i * stepX + shift, j * stepY)
  }
  ctx.restore()
}

/** 畫到 canvas（尺寸要先設好）：原圖 → 遮蔽 → 浮水印 */
export function render(canvas: HTMLCanvasElement, image: CanvasImageSource, mark: Mark, redactions: Redaction[]) {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('瀏覽器無法建立畫布')
  const W = canvas.width
  const H = canvas.height
  ctx.save()
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, W, H)
  for (const r of redactions) {
    // 馬賽克最後一格會超出框，先把畫的範圍限制在框內
    ctx.save()
    ctx.beginPath()
    ctx.rect(r.x * W, r.y * H, r.w * W, r.h * H)
    ctx.clip()
    redact(ctx, r, W, H)
    ctx.restore()
  }
  watermark(ctx, mark, W, H)
  ctx.restore()
}
