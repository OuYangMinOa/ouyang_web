import { H, PALETTE, PAPER, W, WIDTHS, type Stroke } from './types'

/** 倒顏料時，顏色和起點差多少以內算同一塊（RGB 三個差的絕對值加起來） */
const TOLERANCE = 96

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  const color = PALETTE[s.c] ?? PALETTE[1]
  const width = WIDTHS[s.w] ?? WIDTHS[1]
  const p = s.p
  if (p.length < 2) return
  if (p.length === 2) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(p[0], p[1], width / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(p[0], p[1])
  for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i], p[i + 1])
  ctx.stroke()
}

/**
 * 從 (x, y) 把相連、顏色和起點接近的像素塗成 `hex`（一列一列往上下擴散）。
 * 線條邊緣有反鋸齒的半透明色，塗完再往外多塗一圈蓋掉，不然會留一圈白邊；線條最細也有 6 像素，蓋不穿。
 */
export function floodFill(img: ImageData, x: number, y: number, hex: string) {
  const { width, data } = img
  const total = width * img.height
  const fr = parseInt(hex.slice(1, 3), 16)
  const fg = parseInt(hex.slice(3, 5), 16)
  const fb = parseInt(hex.slice(5, 7), 16)
  const seed = y * width + x
  const sr = data[seed * 4]
  const sg = data[seed * 4 + 1]
  const sb = data[seed * 4 + 2]
  const near = (i: number) =>
    Math.abs(data[i * 4] - sr) + Math.abs(data[i * 4 + 1] - sg) + Math.abs(data[i * 4 + 2] - sb) <= TOLERANCE

  const mask = new Uint8Array(total)
  const stack = [seed]
  while (stack.length > 0) {
    const i = stack.pop()!
    if (mask[i]) continue
    const row = i - (i % width)
    let l = i
    let r = i
    while (l > row && !mask[l - 1] && near(l - 1)) l--
    while (r < row + width - 1 && !mask[r + 1] && near(r + 1)) r++
    mask.fill(1, l, r + 1)
    // 上下兩列：每一段連續可以塗的只推一個起點
    for (const next of [row - width, row + width]) {
      if (next < 0 || next >= total) continue
      let open = false
      for (let k = l; k <= r; k++) {
        const j = k - row + next
        if (!mask[j] && near(j)) {
          if (!open) stack.push(j)
          open = true
        } else open = false
      }
    }
  }

  for (let i = 0; i < total; i++) {
    const col = i % width
    const hit =
      mask[i] ||
      (col > 0 && mask[i - 1]) ||
      (col < width - 1 && mask[i + 1]) ||
      (i >= width && mask[i - width]) ||
      (i + width < total && mask[i + width])
    if (!hit) continue
    data[i * 4] = fr
    data[i * 4 + 1] = fg
    data[i * 4 + 2] = fb
    data[i * 4 + 3] = 255
  }
}

/**
 * 把筆畫畫到畫布上（點最多三萬個，整張重畫一次不到幾毫秒，呼叫的人用 requestAnimationFrame 合併）。
 *
 * 倒顏料要看「目前畫成什麼樣子」才知道塗哪裡，所以有倒顏料時，到最後一次倒顏料為止的部分畫在固定
 * W×H 像素的點陣上（每個人的點陣一樣大，塗出來的範圍才會一樣），之後的筆畫照常用向量畫才清楚。
 * 點陣記得畫到哪一筆，之後接著畫就好；筆畫只會從最後面加或拿掉，所以只有復原了倒顏料、重連時才從頭畫。
 */
export class Paper {
  private bitmap: HTMLCanvasElement | null = null
  /** 點陣畫了前面幾筆，以及最後那一筆（用來確認前面的筆畫沒有換掉） */
  private count = 0
  private last: Stroke | null = null

  paint(el: HTMLCanvasElement, strokes: Stroke[]) {
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const fill = strokes.findLastIndex((s) => s.f)
    const bitmap = fill >= 0 ? this.update(strokes, fill + 1) : null
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, el.width, el.height)
    } else {
      ctx.fillStyle = PAPER
      ctx.fillRect(0, 0, el.width, el.height)
    }
    ctx.setTransform(el.width / W, 0, 0, el.height / H, 0, 0)
    for (let i = bitmap ? fill + 1 : 0; i < strokes.length; i++) {
      if (!strokes[i].f) drawStroke(ctx, strokes[i])
    }
  }

  /** 點陣畫到前 `count` 筆 */
  private update(strokes: Stroke[], count: number): HTMLCanvasElement | null {
    if (!this.bitmap) {
      this.bitmap = document.createElement('canvas')
      this.bitmap.width = W
      this.bitmap.height = H
    }
    const ctx = this.bitmap.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    if (this.count === 0 || this.count > count || strokes[this.count - 1] !== this.last) {
      ctx.fillStyle = PAPER
      ctx.fillRect(0, 0, W, H)
      this.count = 0
    }
    for (let i = this.count; i < count; i++) {
      const s = strokes[i]
      if (!s.f) {
        drawStroke(ctx, s)
        continue
      }
      const img = ctx.getImageData(0, 0, W, H)
      floodFill(img, clamp(s.p[0], 0, W - 1), clamp(s.p[1], 0, H - 1), PALETTE[s.c] ?? PALETTE[1])
      ctx.putImageData(img, 0, 0)
    }
    this.count = count
    this.last = strokes[count - 1]
    return this.bitmap
  }
}
