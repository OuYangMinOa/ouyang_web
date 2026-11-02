import { fromOklab, toOklab, type RGB } from './color'

export type Swatch = { rgb: RGB; /** 佔全圖的比例 0–1 */ share: number }

/** 固定種子的亂數，同一張圖每次萃取的結果都一樣 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dist2 = (p: Float32Array, i: number, c: number[]) => {
  const d0 = p[i] - c[0]
  const d1 = p[i + 1] - c[1]
  const d2 = p[i + 2] - c[2]
  return d0 * d0 + d1 * d1 + d2 * d2
}

/**
 * 在 OKLab 空間做 k-means（k-means++ 選起點），回傳依面積排序的主要顏色。
 * data 是縮小過的 RGBA；幾乎透明的像素不算。
 */
export function extractPalette(data: Uint8ClampedArray, k: number): Swatch[] {
  // 相同顏色先合併，點數少很多、也不會因為大片同色背景而全部擠在一起算
  const counts = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    // 每個通道取 6 bit，近似的顏色合成一個
    const key = ((data[i] >> 2) << 12) | ((data[i + 1] >> 2) << 6) | (data[i + 2] >> 2)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const n = counts.size
  if (n === 0) return []
  const pts = new Float32Array(n * 3)
  const weights = new Float32Array(n)
  let total = 0
  let j = 0
  for (const [key, count] of counts) {
    const rgb: RGB = [((key >> 12) << 2) | 2, (((key >> 6) & 63) << 2) | 2, ((key & 63) << 2) | 2]
    pts.set(toOklab(rgb), j * 3)
    weights[j] = count
    total += count
    j++
  }
  k = Math.min(k, n)

  // k-means++：離已選中心越遠、面積越大的越容易被選為下一個中心
  const rand = mulberry32(42)
  const centers: number[][] = []
  let best = 0
  for (let i = 1; i < n; i++) if (weights[i] > weights[best]) best = i
  centers.push([pts[best * 3], pts[best * 3 + 1], pts[best * 3 + 2]])
  const near = new Float32Array(n).fill(Infinity)
  while (centers.length < k) {
    const c = centers[centers.length - 1]
    let sum = 0
    for (let i = 0; i < n; i++) {
      near[i] = Math.min(near[i], dist2(pts, i * 3, c))
      sum += near[i] * weights[i]
    }
    if (sum === 0) break
    let r = rand() * sum
    let pick = n - 1
    for (let i = 0; i < n; i++) {
      r -= near[i] * weights[i]
      if (r <= 0) {
        pick = i
        break
      }
    }
    centers.push([pts[pick * 3], pts[pick * 3 + 1], pts[pick * 3 + 2]])
  }

  const assign = new Uint16Array(n)
  for (let iter = 0; iter < 24; iter++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      let bi = 0
      let bd = Infinity
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(pts, i * 3, centers[c])
        if (d < bd) {
          bd = d
          bi = c
        }
      }
      if (assign[i] !== bi) {
        assign[i] = bi
        moved = true
      }
    }
    const sums = centers.map(() => [0, 0, 0, 0])
    for (let i = 0; i < n; i++) {
      const s = sums[assign[i]]
      const w = weights[i]
      s[0] += pts[i * 3] * w
      s[1] += pts[i * 3 + 1] * w
      s[2] += pts[i * 3 + 2] * w
      s[3] += w
    }
    sums.forEach((s, c) => {
      if (s[3] > 0) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]
    })
    if (!moved && iter > 0) break
  }

  const share = new Float64Array(centers.length)
  for (let i = 0; i < n; i++) share[assign[i]] += weights[i]
  return centers
    .map((c, i) => ({ rgb: fromOklab(c as [number, number, number]), share: share[i] / total }))
    .filter((s) => s.share > 0)
    .sort((a, b) => b.share - a.share)
}
