import { qrcode, type DrawingContext, type RenderOptions } from 'bwip-js/browser'

export type EcLevel = 'L' | 'M' | 'Q' | 'H'

/** n×n 的模組，1 = 深色 */
export type Matrix = { n: number; cells: Uint8Array }

/**
 * 用 bwip-js 編碼，再把它畫出來的多邊形（even-odd 填色）在每個模組中心取樣，換回格子。
 * 自己畫格子才能精準控制輸出的像素大小、顏色和 SVG。文字預設用 UTF-8 編碼。
 */
export function encodeQr(text: string, eclevel: EcLevel): Matrix {
  let width = 0
  let scale = 1
  const polys: [number, number][][] = []
  const drawing: DrawingContext<Matrix> = {
    scale(sx) {
      scale = sx
      return null
    },
    measure: () => ({ width: 0, ascent: 0, descent: 0 }),
    init(w) {
      width = w
    },
    line() {},
    polygon(pts) {
      polys.push(pts)
    },
    hexagon() {},
    ellipse() {},
    fill() {},
    text() {},
    end() {
      const n = Math.round(width / scale)
      const cells = new Uint8Array(n * n)
      // 每一列取模組中心的水平線，算出跟所有邊的交點，兩兩之間是深色
      for (let r = 0; r < n; r++) {
        const y = (r + 0.5) * scale
        const xs: number[] = []
        for (const p of polys) {
          for (let i = 0; i < p.length; i++) {
            const [x0, y0] = p[i]
            const [x1, y1] = p[(i + 1) % p.length]
            if ((y0 <= y) !== (y1 <= y)) xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0))
          }
        }
        xs.sort((a, b) => a - b)
        for (let k = 0; k + 1 < xs.length; k += 2) {
          for (let c = Math.max(0, Math.ceil(xs[k] / scale - 0.5)); c < n && (c + 0.5) * scale < xs[k + 1]; c++) {
            cells[r * n + c] = 1
          }
        }
      }
      return { n, cells }
    },
  }
  // eclevel 是 BWIPP 的選項，型別定義裡沒有
  return qrcode({ bcid: 'qrcode', text, scale: 1, eclevel } as RenderOptions, drawing)
}

/** QR 版本 1–40：每一版多 4 個模組 */
export const qrVersion = (m: Matrix) => (m.n - 17) / 4

export type Style = {
  fg: string
  /** null = 透明 */
  bg: string | null
  /** 四周留白，單位是模組 */
  margin: number
}

/** 畫到指定大小（px）的畫布；每個模組的邊界取整數像素，才不會有細縫 */
export function drawQr(canvas: HTMLCanvasElement, m: Matrix, size: number, style: Style) {
  const total = m.n + style.margin * 2
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, size, size)
  if (style.bg) {
    ctx.fillStyle = style.bg
    ctx.fillRect(0, 0, size, size)
  }
  ctx.fillStyle = style.fg
  const edge = (i: number) => Math.round((i * size) / total)
  for (let r = 0; r < m.n; r++) {
    for (let c = 0; c < m.n; c++) {
      if (!m.cells[r * m.n + c]) continue
      const x0 = edge(c + style.margin)
      const y0 = edge(r + style.margin)
      ctx.fillRect(x0, y0, edge(c + style.margin + 1) - x0, edge(r + style.margin + 1) - y0)
    }
  }
}

/** 向量的 SVG：同一列連續的模組合成一段路徑 */
export function qrSvg(m: Matrix, size: number, style: Style) {
  const total = m.n + style.margin * 2
  let d = ''
  for (let r = 0; r < m.n; r++) {
    for (let c = 0; c < m.n; c++) {
      if (!m.cells[r * m.n + c]) continue
      let len = 1
      while (c + len < m.n && m.cells[r * m.n + c + len]) len++
      d += `M${c + style.margin} ${r + style.margin}h${len}v1h-${len}z`
      c += len - 1
    }
  }
  const bg = style.bg ? `<rect width="${total}" height="${total}" fill="${style.bg}"/>` : ''
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `${bg}<path fill="${style.fg}" d="${d}"/></svg>\n`
  )
}
