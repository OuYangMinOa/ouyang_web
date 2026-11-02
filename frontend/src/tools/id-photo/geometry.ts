// 相片的擺放、自動對齊、合成與相紙排版
import { context2d } from '../image-kit/files'
import { mmToPx, PX_PER_MM, type Paper, type Spec } from './specs'

/**
 * 原圖怎麼擺在相框裡：先縮放 z（每個原圖像素是幾 mm）、再以原圖左上角為軸旋轉 r（弧度），
 * 最後把原圖左上角移到相框的 (x, y)（mm）。
 */
export type Transform = { x: number; y: number; z: number; r: number }

/** 相框內的點 (px, py) 不動，縮放 k 倍 */
export function zoomAt(t: Transform, k: number, px: number, py: number): Transform {
  return { ...t, z: t.z * k, x: px + (t.x - px) * k, y: py + (t.y - py) * k }
}

/** 繞相框內的點 (px, py) 旋轉 d 弧度 */
export function rotateAt(t: Transform, d: number, px: number, py: number): Transform {
  const c = Math.cos(d)
  const s = Math.sin(d)
  const dx = t.x - px
  const dy = t.y - py
  return { ...t, r: t.r + d, x: px + dx * c - dy * s, y: py + dx * s + dy * c }
}

/** 還沒去背時：整張圖填滿相框、置中 */
export function coverFit(W: number, H: number, spec: Spec): Transform {
  const z = Math.max(spec.w / W, spec.h / H)
  return { z, r: 0, x: (spec.w - W * z) / 2, y: (spec.h - H * z) / 2 }
}

/**
 * 從去背遮罩估計頭的位置，讓頭頂、頭長落在規格的中間值。
 * 頭頂是遮罩最上面那一列；頭寬取頭頂往下、到肩膀變寬之前最寬的一列，頭長（頭頂到下巴）約是頭寬的 1.35 倍。
 * 只是起點，使用者再自己微調。找不到人就回傳 null。
 */
export function autoFit(mask: Uint8Array, W: number, H: number, spec: Spec): Transform | null {
  const count = new Uint32Array(H)
  const sumX = new Float64Array(H)
  for (let y = 0; y < H; y++) {
    let c = 0
    let s = 0
    for (let x = 0, i = y * W; x < W; x++, i++) {
      if (mask[i] >= 128) {
        c++
        s += x
      }
    }
    count[y] = c
    sumX[y] = s
  }
  // 太細的（零星髮絲、雜點）不算頭頂
  const minRow = Math.max(3, W * 0.01)
  let y0 = 0
  while (y0 < H && count[y0] < minRow) y0++
  if (y0 >= H) return null

  let wmax = 0
  let cx = 0
  let n = 0
  for (let y = y0; y < H; y++) {
    // 往下掃到大約下巴的位置就停，肩膀還沒出現
    if (wmax > 0 && y - y0 > 1.3 * wmax) break
    if (count[y] > wmax) wmax = count[y]
    if (count[y]) {
      cx += sumX[y] / count[y]
      n++
    }
  }
  if (wmax < 8 || !n) return null
  cx /= n

  const headPx = wmax * 1.35
  const headMm = (spec.head[0] + spec.head[1]) / 2
  const topMm = (spec.top[0] + spec.top[1]) / 2
  const z = headMm / headPx
  return { z, r: 0, x: spec.w / 2 - cx * z, y: topMm - y0 * z }
}

/** 原圖套上遮罩（查表後的不透明度）變成去背圖 */
export function buildCutout(src: ImageData, mask: Uint8Array, lut: Uint8Array): HTMLCanvasElement {
  const { width: W, height: H } = src
  const out = new ImageData(new Uint8ClampedArray(src.data), W, H)
  const d = out.data
  for (let i = 0; i < mask.length; i++) d[i * 4 + 3] = (lut[mask[i]] * d[i * 4 + 3] + 127) / 255
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  context2d(canvas).putImageData(out, 0, 0)
  return canvas
}

/** 把一張證件照畫進 ctx 目前的 (0,0)–(w,h)；scale 是每 mm 幾個畫布像素 */
export function drawPhoto(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  spec: Spec,
  t: Transform,
  background: string,
  scale: number,
) {
  ctx.save()
  ctx.fillStyle = background
  ctx.fillRect(0, 0, spec.w * scale, spec.h * scale)
  ctx.beginPath()
  ctx.rect(0, 0, spec.w * scale, spec.h * scale)
  ctx.clip()
  ctx.scale(scale, scale)
  ctx.translate(t.x, t.y)
  ctx.rotate(t.r)
  ctx.scale(t.z, t.z)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0)
  ctx.restore()
}

/** 300 DPI 的單張證件照 */
export function renderPhoto(image: CanvasImageSource, spec: Spec, t: Transform, background: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = mmToPx(spec.w)
  canvas.height = mmToPx(spec.h)
  const ctx = context2d(canvas)
  // 用實際像素對 mm 的比例，邊緣才不會差半格
  ctx.scale(canvas.width / (spec.w * PX_PER_MM), canvas.height / (spec.h * PX_PER_MM))
  drawPhoto(ctx, image, spec, t, background, PX_PER_MM)
  return canvas
}

/** 相片之間的間隔與相紙留白 */
const GAP = 2
const MARGIN = 3

export type Sheet = { w: number; h: number; cols: number; rows: number; x0: number; y0: number }

/** 相紙直放或橫放，哪個排得多就用哪個；格子整組置中 */
export function layoutSheet(spec: Spec, paper: Paper): Sheet {
  const fit = (pw: number, ph: number) => {
    const cols = Math.max(0, Math.floor((pw - 2 * MARGIN + GAP) / (spec.w + GAP)))
    const rows = Math.max(0, Math.floor((ph - 2 * MARGIN + GAP) / (spec.h + GAP)))
    return { w: pw, h: ph, cols, rows }
  }
  const portrait = fit(paper.w, paper.h)
  const landscape = fit(paper.h, paper.w)
  const best = landscape.cols * landscape.rows > portrait.cols * portrait.rows ? landscape : portrait
  const gridW = best.cols * spec.w + Math.max(0, best.cols - 1) * GAP
  const gridH = best.rows * spec.h + Math.max(0, best.rows - 1) * GAP
  return { ...best, x0: (best.w - gridW) / 2, y0: (best.h - gridH) / 2 }
}

/** 排好的相紙：白底，每張外面一圈淺灰裁切線 */
export function renderSheet(photo: HTMLCanvasElement, spec: Spec, paper: Paper, scale = PX_PER_MM): HTMLCanvasElement {
  const s = layoutSheet(spec, paper)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(s.w * scale)
  canvas.height = Math.round(s.h * scale)
  const ctx = context2d(canvas)
  // 相紙一定是白的，跟主題無關
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  const pw = Math.round(spec.w * scale)
  const ph = Math.round(spec.h * scale)
  ctx.strokeStyle = '#c8c8c8'
  ctx.lineWidth = Math.max(1, scale * 0.1)
  for (let r = 0; r < s.rows; r++) {
    for (let c = 0; c < s.cols; c++) {
      const x = Math.round((s.x0 + c * (spec.w + GAP)) * scale)
      const y = Math.round((s.y0 + r * (spec.h + GAP)) * scale)
      ctx.drawImage(photo, x, y, pw, ph)
      ctx.strokeRect(x - ctx.lineWidth / 2, y - ctx.lineWidth / 2, pw + ctx.lineWidth, ph + ctx.lineWidth)
    }
  }
  return canvas
}
