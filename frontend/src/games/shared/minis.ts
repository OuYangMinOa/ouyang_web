/**
 * 大逃殺裡其他玩家的小盤面（俄羅斯方塊、魔法氣泡共用）：每個都是寬 1、高 2 的格子，全部畫在同一張 canvas 上。
 */

/** 盤面字串的格式：每列幾格、最上面幾列不畫（魔法氣泡看不到的第 13 列）；看得到的部分要剛好是寬 1 高 2 */
export type MiniShape = { cols: number; hidden: number; round?: boolean }

/** 索引 1 開始是盤面字元 `1`、`2`…的顏色 */
export type MiniPalette = {
  cells: string[]
  bg: string
  text: string
  muted: string
  accent: string
  danger: string
  scrim: string
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
  shape: MiniShape,
  c: MiniPalette,
) {
  const { cols, size, gap } = layout
  ctx.clearRect(0, 0, w, layout.height)
  const cs = size / shape.cols
  const skip = shape.hidden * shape.cols
  minis.forEach((m, i) => {
    const x = (i % cols) * (size + gap)
    const y = Math.floor(i / cols) * (size * 2 + gap)
    ctx.fillStyle = c.bg
    ctx.fillRect(x, y, size, size * 2)
    const rows = boards.get(m.pid)
    if (rows) {
      for (let j = skip; j < rows.length; j++) {
        const cell = rows.charCodeAt(j) - 48
        if (cell <= 0) continue
        const cx = x + (j % shape.cols) * cs
        const cy = y + (Math.floor(j / shape.cols) - shape.hidden) * cs
        ctx.fillStyle = c.cells[cell] ?? c.muted
        // 格子夠大才畫成圓的，太小畫圓只會糊成一團
        if (shape.round && cs >= 4) {
          ctx.beginPath()
          ctx.arc(cx + cs / 2, cy + cs / 2, cs * 0.48, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.fillRect(cx, cy, Math.ceil(cs), Math.ceil(cs))
        }
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
