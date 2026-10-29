import { DELTA, type Game } from './logic'

export type Palette = {
  cell: string
  cellAlt: string
  snake: string
  head: string
  apple: string
  danger: string
  eye: string
  accent: string
}

/** Canvas 不認得 CSS 變數，只能從計算後的樣式讀出實際顏色（主題切換時要重讀） */
export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    cell: v('--cell'),
    cellAlt: v('--cell-alt'),
    snake: v('--snake'),
    head: v('--snake-head'),
    apple: v('--apple'),
    danger: v('--danger'),
    eye: v('--bg'),
    accent: v('--accent'),
  }
}

export type DrawOptions = {
  /** 蘋果剩下的時間比例（1 → 0）；null 表示蘋果不會動 */
  appleLeft: number | null
  /** 閃爍中這一幀不畫蘋果本體 */
  appleHidden: boolean
  /** 頭尾互換後的提示光圈（1 → 0） */
  flash: number
}

export function drawGame(ctx: CanvasRenderingContext2D, px: number, game: Game, c: Palette, o: DrawOptions) {
  const n = game.size
  const cell = px / n

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? c.cell : c.cellAlt
      ctx.fillRect(x * cell, y * cell, cell + 0.5, cell + 0.5)
    }
  }

  if (game.apple) {
    const ax = (game.apple.x + 0.5) * cell
    const ay = (game.apple.y + 0.5) * cell
    if (o.appleLeft !== null) {
      // 倒數環：繞一圈就換位置
      ctx.save()
      ctx.globalAlpha = 0.55
      ctx.strokeStyle = c.apple
      ctx.lineWidth = Math.max(1.5, cell * 0.09)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.arc(ax, ay, cell * 0.46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * o.appleLeft)
      ctx.stroke()
      ctx.restore()
    }
    if (!o.appleHidden) {
      ctx.fillStyle = c.apple
      ctx.beginPath()
      ctx.arc(ax, ay, cell * 0.32, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = c.snake
      ctx.fillRect(ax - cell * 0.03, ay - cell * 0.42, cell * 0.08, cell * 0.14)
    }
  }

  const dead = game.over === 'dead'
  const inset = cell * 0.1
  const body = game.snake
  // 由尾往頭畫，頭蓋在最上面
  for (let i = body.length - 1; i >= 0; i--) {
    const p = body[i]
    ctx.fillStyle = i === 0 ? (dead ? c.danger : c.head) : c.snake
    ctx.beginPath()
    ctx.roundRect(p.x * cell + inset, p.y * cell + inset, cell - inset * 2, cell - inset * 2, cell * 0.28)
    ctx.fill()
    // 補上和前一節之間的縫，讓身體連成一條
    const prev = body[i - 1]
    if (prev) {
      ctx.fillStyle = c.snake
      if (p.y === prev.y) ctx.fillRect((Math.min(p.x, prev.x) + 0.5) * cell, p.y * cell + inset, cell, cell - inset * 2)
      else ctx.fillRect(p.x * cell + inset, (Math.min(p.y, prev.y) + 0.5) * cell, cell - inset * 2, cell)
    }
  }

  const head = body[0]
  const hx = (head.x + 0.5) * cell
  const hy = (head.y + 0.5) * cell
  const d = DELTA[game.dir]
  // 眼睛：沿前進方向偏前，左右各一
  ctx.fillStyle = c.eye
  for (const side of [-1, 1]) {
    ctx.beginPath()
    ctx.arc(hx + d.x * cell * 0.15 + d.y * side * cell * 0.18, hy + d.y * cell * 0.15 + d.x * side * cell * 0.18,
      Math.max(1, cell * 0.08), 0, Math.PI * 2)
    ctx.fill()
  }

  if (o.flash > 0) {
    ctx.save()
    ctx.globalAlpha = o.flash
    ctx.strokeStyle = c.accent
    ctx.lineWidth = Math.max(2, cell * 0.12)
    ctx.beginPath()
    ctx.arc(hx, hy, cell * (0.6 + (1 - o.flash) * 0.8), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}
