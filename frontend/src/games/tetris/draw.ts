import { COLS, GARBAGE, HIDDEN, KINDS, ROWS, pieceCells, type Kind, type Tetris } from './engine'

export type Palette = {
  /** 索引 1～8：七種方塊與垃圾行 */
  cells: string[]
  bg: string
  grid: string
  text: string
  muted: string
  accent: string
  danger: string
  warn: string
  scrim: string
}

/** Canvas 不認得 CSS 變數，只能從計算後的樣式讀出實際顏色（主題切換時要重讀） */
export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    cells: ['', ...Array.from({ length: GARBAGE }, (_, i) => v(`--tet-${i + 1}`))],
    bg: v('--tet-bg'),
    grid: v('--border'),
    text: v('--text-h'),
    muted: v('--text'),
    accent: v('--accent'),
    danger: v('--danger'),
    warn: v('--warn'),
    scrim: v('--scrim'),
  }
}

/** 主盤面左邊的垃圾量表寬度（以格為單位） */
export const METER = 0.6

function block(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  const inset = Math.max(0.5, s * 0.06)
  ctx.fillStyle = color
  ctx.fillRect(x + inset, y + inset, s - inset * 2, s - inset * 2)
  // 左上一點亮面，看起來像方塊而不是色塊
  ctx.fillStyle = 'rgb(255 255 255 / 0.22)'
  ctx.fillRect(x + inset, y + inset, s - inset * 2, Math.max(1, s * 0.16))
}

/** 主盤面：寬 `METER + 10` 格、高 20 格 */
export function drawBoard(ctx: CanvasRenderingContext2D, w: number, game: Tetris, c: Palette) {
  const s = w / (COLS + METER)
  const h = s * ROWS
  const ox = s * METER
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = c.bg
  ctx.fillRect(ox, 0, w - ox, h)
  ctx.strokeStyle = c.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 1; x < COLS; x++) {
    ctx.moveTo(ox + x * s + 0.5, 0)
    ctx.lineTo(ox + x * s + 0.5, h)
  }
  for (let y = 1; y < ROWS; y++) {
    ctx.moveTo(ox, y * s + 0.5)
    ctx.lineTo(w, y * s + 0.5)
  }
  ctx.stroke()

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = game.get(x, y + HIDDEN)
      if (cell) block(ctx, ox + x * s, y * s, s, c.cells[cell])
    }
  }

  const p = game.piece
  if (p) {
    const color = c.cells[KINDS.indexOf(p.kind) + 1]
    const ghost = game.ghostY()
    ctx.globalAlpha = 0.25
    for (const [cx, cy] of pieceCells(p.kind, p.rot)) {
      const y = ghost + cy - HIDDEN
      if (y >= 0) block(ctx, ox + (p.x + cx) * s, y * s, s, color)
    }
    ctx.globalAlpha = 1
    for (const [cx, cy] of pieceCells(p.kind, p.rot)) {
      const y = p.y + cy - HIDDEN
      if (y >= 0) block(ctx, ox + (p.x + cx) * s, y * s, s, color)
    }
  }

  // 垃圾量表：還在等的是黃色，到時間（下一塊沒消行就會升上來）的是紅色
  let top = h
  for (const g of game.garbage) {
    const lines = Math.min(g.lines, Math.ceil(top / s))
    const height = lines * s
    ctx.fillStyle = g.readyAt <= game.clock ? c.danger : c.warn
    ctx.fillRect(0, top - height + 1, ox - 2, height - 2)
    top -= height
    if (top <= 0) break
  }
}

/** Hold 或 Next：一格高 3 格的欄位，由上往下排 */
export function drawPreview(
  ctx: CanvasRenderingContext2D,
  w: number,
  kinds: (Kind | null)[],
  c: Palette,
  dim = false,
) {
  const slot = w * 0.75
  ctx.clearRect(0, 0, w, slot * kinds.length)
  const s = w / 5
  kinds.forEach((kind, i) => {
    if (!kind) return
    const cells = pieceCells(kind, 0)
    const xs = cells.map(([x]) => x)
    const ys = cells.map(([, y]) => y)
    const pw = Math.max(...xs) - Math.min(...xs) + 1
    const ph = Math.max(...ys) - Math.min(...ys) + 1
    const ox = (w - pw * s) / 2 - Math.min(...xs) * s
    const oy = i * slot + (slot - ph * s) / 2 - Math.min(...ys) * s
    ctx.globalAlpha = dim ? 0.35 : 1
    for (const [x, y] of cells) block(ctx, ox + x * s, oy + y * s, s, c.cells[KINDS.indexOf(kind) + 1])
    ctx.globalAlpha = 1
  })
}

export type MiniLayout = { cols: number; size: number; gap: number; height: number }

const MINI_GAP = 3
/** 窄螢幕沒有高度限制時，每個小盤面大約的寬度 */
const MINI_WIDTH = 20

/** 排小盤面：有高度上限就挑放得下的最大尺寸，否則用固定寬度一直往下排 */
export function miniLayout(width: number, count: number, maxHeight: number | null): MiniLayout {
  const gap = MINI_GAP
  const fit = (cols: number) => {
    const size = Math.max(4, Math.floor((width - gap * (cols - 1)) / cols))
    const rows = Math.ceil(count / cols)
    return { cols, size, gap, height: count === 0 ? 0 : rows * (size * 2 + gap) - gap }
  }
  if (maxHeight !== null) {
    for (let cols = 1; cols <= Math.max(1, count); cols++) {
      const layout = fit(cols)
      if (layout.height <= maxHeight) return layout
    }
    return fit(Math.max(1, count))
  }
  return fit(Math.max(1, Math.floor((width + gap) / (MINI_WIDTH + gap))))
}

export type MiniInfo = {
  pid: number
  alive: boolean
  place: number | null
  /** 我正在打的人 */
  targeted: boolean
  /** 正在打我的人 */
  attacker: boolean
  /** 還沒參加這一局（在等下一局） */
  waiting: boolean
}

export function drawMinis(
  ctx: CanvasRenderingContext2D,
  w: number,
  layout: MiniLayout,
  minis: MiniInfo[],
  boards: Map<number, string>,
  c: Palette,
) {
  const { cols, size, gap } = layout
  ctx.clearRect(0, 0, w, layout.height)
  const cs = size / COLS
  minis.forEach((m, i) => {
    const x = (i % cols) * (size + gap)
    const y = Math.floor(i / cols) * (size * 2 + gap)
    ctx.fillStyle = c.bg
    ctx.fillRect(x, y, size, size * 2)
    const rows = boards.get(m.pid)
    if (rows) {
      for (let j = 0; j < rows.length; j++) {
        const cell = rows.charCodeAt(j) - 48
        if (cell <= 0) continue
        ctx.fillStyle = c.cells[cell] ?? c.muted
        ctx.fillRect(x + (j % COLS) * cs, y + Math.floor(j / COLS) * cs, Math.ceil(cs), Math.ceil(cs))
      }
    }
    if (!m.alive) {
      ctx.fillStyle = c.scrim
      ctx.fillRect(x, y, size, size * 2)
      if (m.place !== null && size >= 18) {
        ctx.fillStyle = c.text
        ctx.font = `600 ${Math.round(size * 0.42)}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(m.place), x + size / 2, y + size)
      }
    }
    if (m.attacker || m.targeted) {
      const line = Math.max(1.5, size * 0.09)
      ctx.lineWidth = line
      if (m.attacker) {
        ctx.strokeStyle = c.danger
        ctx.strokeRect(x + line / 2, y + line / 2, size - line, size * 2 - line)
      }
      if (m.targeted) {
        ctx.strokeStyle = c.accent
        const inset = m.attacker ? line * 1.5 : line / 2
        ctx.strokeRect(x + inset, y + inset, size - inset * 2, size * 2 - inset * 2)
      }
    }
    if (m.waiting) {
      ctx.globalAlpha = 0.5
      ctx.fillStyle = c.bg
      ctx.fillRect(x, y, size, size * 2)
      ctx.globalAlpha = 1
    }
  })
}

/** 點到第幾個小盤面；沒點到是 -1 */
export function miniAt(layout: MiniLayout, count: number, x: number, y: number): number {
  const { cols, size, gap } = layout
  const col = Math.floor(x / (size + gap))
  const row = Math.floor(y / (size * 2 + gap))
  if (col < 0 || col >= cols || row < 0) return -1
  if (x - col * (size + gap) > size || y - row * (size * 2 + gap) > size * 2) return -1
  const i = row * cols + col
  return i < count ? i : -1
}
