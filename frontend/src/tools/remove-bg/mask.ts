// 遮罩運算：全部是純函式，在編輯解析度（W×H）上操作一維陣列

/** 手動修改圖層的值：0 = 沒動過（跟著模型），1 = 保留，2 = 擦除 */
export const UNTOUCHED = 0
export const KEEP = 1
export const ERASE = 2

/** 半開區間 [x0, x1) × [y0, y1) */
export type Rect = { x0: number; y0: number; x1: number; y1: number }

/** 復原用：某個區塊被改之前的內容 */
export type Patch = { x: number; y: number; w: number; h: number; data: Uint8Array }

/** 透顯原圖時，被去掉的地方保留原本不透明度的比例（/256） */
const GHOST = 80

export function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }
}

/**
 * 「去除強度」與「邊緣」→ 模型遮罩（0–255）的查表。
 * 強度是切點：越高去掉越多；邊緣是切點附近的過渡寬度：0 是硬邊，100 接近模型原本的柔和度。
 */
export function buildLut(strength: number, edge: number): Uint8Array {
  const t = 0.02 + (strength / 100) * 0.96
  const w = Math.max(0.01, edge / 100)
  // 過渡區夾在 0–1 之內，模型很有把握的像素（0 或 1）不會變成半透明
  let lo = Math.max(0, t - w / 2)
  let hi = Math.min(1, t + w / 2)
  if (hi - lo < 0.004) {
    lo = Math.max(0, t - 0.002)
    hi = lo + 0.004
  }
  const lut = new Uint8Array(256)
  for (let v = 0; v < 256; v++) {
    const c = Math.min(1, Math.max(0, (v / 255 - lo) / (hi - lo)))
    lut[v] = Math.round(c * c * (3 - 2 * c) * 255)
  }
  return lut
}

/** 某個像素最後的不透明度（不含原圖本身的透明度） */
function alphaAt(soft: Uint8Array, ovr: Uint8Array, lut: Uint8Array, i: number): number {
  const o = ovr[i]
  return o === KEEP ? 255 : o === ERASE ? 0 : lut[soft[i]]
}

/**
 * 把一塊區域的不透明度寫進預覽用的 RGBA（RGB 已經是原圖）。
 * src 是原圖的 RGBA，用來乘上原圖本身的透明度。
 */
export function composite(
  out: Uint8ClampedArray,
  src: Uint8ClampedArray,
  soft: Uint8Array,
  ovr: Uint8Array,
  lut: Uint8Array,
  ghost: boolean,
  W: number,
  r: Rect,
) {
  for (let y = r.y0; y < r.y1; y++) {
    for (let i = y * W + r.x0, end = y * W + r.x1; i < end; i++) {
      const sa = src[i * 4 + 3]
      let a = (alphaAt(soft, ovr, lut, i) * sa + 127) / 255
      if (ghost) a += ((sa - a) * GHOST) >> 8
      out[i * 4 + 3] = a
    }
  }
}

/** 整張的遮罩不透明度（匯出用；原圖本身的透明度在匯出時另外乘） */
export function maskAlpha(soft: Uint8Array, ovr: Uint8Array, lut: Uint8Array): Uint8Array {
  const out = new Uint8Array(soft.length)
  for (let i = 0; i < soft.length; i++) out[i] = alphaAt(soft, ovr, lut, i)
  return out
}

/** 在 (cx, cy) 蓋一個半徑 r 的實心圓，回傳實際動到的範圍 */
function stamp(buf: Uint8Array, W: number, H: number, cx: number, cy: number, r: number, value: number): Rect | null {
  const y0 = Math.max(0, Math.ceil(cy - r))
  const y1 = Math.min(H - 1, Math.floor(cy + r))
  let rect: Rect | null = null
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy
    const half = Math.sqrt(Math.max(0, r * r - dy * dy))
    const x0 = Math.max(0, Math.round(cx - half))
    const x1 = Math.min(W, Math.round(cx + half))
    if (x1 <= x0) continue
    buf.fill(value, y * W + x0, y * W + x1)
    rect = union(rect, { x0, y0: y, x1, y1: y + 1 })
  }
  return rect
}

/** 從 (ax, ay) 畫到 (bx, by)：沿線每隔一小段蓋一個圓，線條才會連續 */
export function strokeLine(
  buf: Uint8Array,
  W: number,
  H: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
  value: number,
): Rect | null {
  const dist = Math.hypot(bx - ax, by - ay)
  const step = Math.max(0.5, r / 4)
  const n = Math.max(1, Math.ceil(dist / step))
  let rect: Rect | null = null
  for (let k = 0; k <= n; k++) {
    const t = k / n
    rect = union(rect, stamp(buf, W, H, ax + (bx - ax) * t, ay + (by - ay) * t, r, value))
  }
  return rect
}

/** 把點選得到的遮罩（非 0 = 選到）寫進修改圖層 */
export function applyMask(ovr: Uint8Array, mask: Uint8Array, value: number) {
  for (let i = 0; i < mask.length; i++) if (mask[i]) ovr[i] = value
}

/** 遮罩往外長 r 像素（先橫後直的方形膨脹）。SAM 的遮罩是低解析度放大的，邊緣常留一圈沒選到 */
export function dilate(mask: Uint8Array, W: number, r: number): Uint8Array {
  if (r <= 0) return mask
  const H = mask.length / W
  const tmp = new Uint8Array(mask.length)
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < H; y++) {
    const row = y * W
    let last = -Infinity
    // 由左往右記住最近的選取點，再由右往左補上另一側
    for (let x = 0; x < W; x++) {
      if (mask[row + x]) last = x
      if (x - last <= r) tmp[row + x] = 1
    }
    last = Infinity
    for (let x = W - 1; x >= 0; x--) {
      if (mask[row + x]) last = x
      if (last - x <= r) tmp[row + x] = 1
    }
  }
  for (let x = 0; x < W; x++) {
    let last = -Infinity
    for (let y = 0; y < H; y++) {
      if (tmp[y * W + x]) last = y
      if (y - last <= r) out[y * W + x] = 1
    }
    last = Infinity
    for (let y = H - 1; y >= 0; y--) {
      if (tmp[y * W + x]) last = y
      if (last - y <= r) out[y * W + x] = 1
    }
  }
  return out
}

/** 遮罩的外框（先算範圍才能在套用前存復原資料） */
export function maskBounds(mask: Uint8Array, W: number): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const x = i % W
    const y = (i - x) / W
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

/** 複製 buf 裡的一塊區域 */
export function crop(buf: Uint8Array, W: number, r: Rect): Patch {
  const w = r.x1 - r.x0
  const h = r.y1 - r.y0
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) data.set(buf.subarray((r.y0 + y) * W + r.x0, (r.y0 + y) * W + r.x1), y * w)
  return { x: r.x0, y: r.y0, w, h, data }
}

/** 把 patch 寫回 buf，回傳它的範圍 */
export function restore(buf: Uint8Array, W: number, p: Patch): Rect {
  for (let y = 0; y < p.h; y++) buf.set(p.data.subarray(y * p.w, (y + 1) * p.w), (p.y + y) * W + p.x)
  return { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h }
}
