import type { RGB } from './color'

export type Loaded = { canvas: HTMLCanvasElement; data: ImageData }

/** 取 (x, y) 周圍 size×size 的平均色 */
export function sampleAt({ data }: Loaded, x: number, y: number, size: number): RGB {
  const half = Math.floor(size / 2)
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const px = x + dx
      const py = y + dy
      if (px < 0 || py < 0 || px >= data.width || py >= data.height) continue
      const i = (py * data.width + px) * 4
      r += data.data[i]
      g += data.data[i + 1]
      b += data.data[i + 2]
      n++
    }
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0]
}
