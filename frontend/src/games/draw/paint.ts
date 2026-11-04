import { H, PALETTE, PAPER, W, WIDTHS, type Stroke } from './types'

/**
 * 整張重畫（點最多兩萬個，一次不到幾毫秒），呼叫的人用 requestAnimationFrame 合併。
 * 你畫我猜的畫布和傳話畫畫的唯讀畫都用這個。
 */
export function paint(el: HTMLCanvasElement, strokes: Stroke[]) {
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, el.width, el.height)
  ctx.setTransform(el.width / W, 0, 0, el.height / H, 0, 0)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of strokes) {
    const color = PALETTE[s.c] ?? PALETTE[1]
    const width = WIDTHS[s.w] ?? WIDTHS[1]
    const p = s.p
    if (p.length < 2) continue
    if (p.length === 2) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(p[0], p[1], width / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.moveTo(p[0], p[1])
    for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i], p[i + 1])
    ctx.stroke()
  }
}
