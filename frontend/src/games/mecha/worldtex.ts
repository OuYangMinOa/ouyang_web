// 場景材質用的遮罩貼圖：全部在瀏覽器裡算，上下左右都接得起來。照世界座標貼（不是照每個面自己的貼圖座標），
// 所以整座城市的髒污、裂縫、彈孔不會跟著磚牆、柏油的貼圖一格一格重複。
//   - `mask`（一格 `WMASK_TILE` 公尺）：紅：大片的髒污、煤煙；綠：裂縫；藍：零零碎碎的斑塊（剝落、生鏽、掉漆）；透明度：往下流的水漬
//   - `detail`（一格 `WDETAIL_TILE` 公尺）：紅：彈孔、砲彈打出來的坑（中間 1、往外淡掉）；綠：碎石、瓦礫的碎屑；
//     藍：一灘一灘的漬；透明度：很大片、很平滑的起伏（放大來用：哪一區燒過、哪裡積水）
import type { DataTexture } from 'three'
import { rng } from '../racing/noise'
import { clamp01, gray, layered, read, texture, wrapped } from './mechtex'

export const WMASK_TILE = 24
export const WDETAIL_TILE = 8

export type WorldMasks = { mask: DataTexture; detail: DataTexture }

/** 在 n × n 的格點上算一次 `fn`（0～1 的貼圖座標），再放大成 size × size（內插，邊界接得起來）：平滑的雜訊不用每個像素都算 */
function field(n: number, size: number, fn: (u: number, v: number) => number): Float32Array {
  const src = new Float32Array(n * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) src[y * n + x] = fn(x / n, y / n)
  if (n === size) return src
  const out = new Float32Array(size * size)
  const k = n / size
  for (let y = 0; y < size; y++) {
    const fy = y * k
    const y0 = Math.floor(fy)
    const ty = fy - y0
    const r0 = (y0 % n) * n
    const r1 = ((y0 + 1) % n) * n
    for (let x = 0; x < size; x++) {
      const fx = x * k
      const x0 = Math.floor(fx)
      const tx = fx - x0
      const c0 = x0 % n
      const c1 = (x0 + 1) % n
      const a = src[r0 + c0] + (src[r0 + c1] - src[r0 + c0]) * tx
      const b = src[r1 + c0] + (src[r1 + c1] - src[r1 + c0]) * tx
      out[y * size + x] = a + (b - a) * ty
    }
  }
  return out
}

type Line = { pts: [number, number][]; width: number; alpha: number }

function makeMask(size: number, anisotropy: number): DataTexture {
  const rand = rng(8831)
  const k = size / 1024

  // 裂縫：鋸齒狀的長條，偶爾分岔；另外一些很細的短裂紋
  const lines: Line[] = []
  const crack = (x: number, y: number, dir: number, len: number, width: number, alpha: number, depth: number) => {
    const pts: [number, number][] = [[x, y]]
    let left = len
    while (left > 0) {
      const st = (6 + rand() * 10) * k
      dir += (rand() - 0.5) * 0.95
      x += Math.cos(dir) * st
      y += Math.sin(dir) * st
      pts.push([x, y])
      left -= st
      if (depth < 2 && rand() < 0.1) crack(x, y, dir + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.8), len * 0.45, width * 0.72, alpha * 0.85, depth + 1)
    }
    lines.push({ pts, width, alpha })
  }
  for (let i = 0; i < 34; i++) crack(rand() * size, rand() * size, rand() * Math.PI * 2, (160 + rand() * 520) * k, (1.5 + rand() * 1.8) * k, 0.75 + rand() * 0.25, 0)
  for (let i = 0; i < 130; i++) crack(rand() * size, rand() * size, rand() * Math.PI * 2, (24 + rand() * 90) * k, (0.7 + rand() * 0.5) * k, 0.3 + rand() * 0.4, 2)
  const cracks = gray(size, 0)
  cracks.lineCap = 'round'
  cracks.lineJoin = 'round'
  for (const l of lines) {
    cracks.strokeStyle = `rgba(255,255,255,${l.alpha})`
    cracks.lineWidth = l.width
    wrapped(cracks, size, () => {
      cracks.beginPath()
      l.pts.forEach(([px, py], i) => (i ? cracks.lineTo(px, py) : cracks.moveTo(px, py)))
      cracks.stroke()
    })
  }

  // 水漬：濃的那一頭在畫布的下面（貼圖的上面），往畫布的上面淡掉，貼到直立的面上是往下流
  const drip = gray(size, 0)
  for (let i = 0; i < 150; i++) {
    const x = rand() * size
    const y = rand() * size
    const w = (2 + rand() * rand() * 26) * k
    const len = (60 + rand() * 460) * k
    const alpha = 0.3 + rand() * 0.6
    wrapped(drip, size, () => {
      const g = drip.createLinearGradient(0, y, 0, y - len)
      g.addColorStop(0, `rgba(255,255,255,${alpha})`)
      g.addColorStop(0.3, `rgba(255,255,255,${alpha * 0.55})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      drip.fillStyle = g
      drip.fillRect(x - w / 2, y - len, w, len)
    })
  }

  const cr = read(cracks)
  const dr = read(drip)
  const cloud = field(Math.min(size, 256), size, (u, v) => layered(u, v, 3, 11, 5))
  const grain = field(Math.min(size, 512), size, (u, v) => layered(u, v, 40, 23, 2))
  const big = field(Math.min(size, 512), size, (u, v) => layered(u, v, 7, 31, 4))
  const small = field(Math.min(size, 512), size, (u, v) => layered(u, v, 44, 47, 2))
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = clamp01((cloud[i] * 0.74 + grain[i] * 0.26 - 0.28) * 2.2) * 255
    data[i * 4 + 1] = clamp01(cr[i]) * 255
    data[i * 4 + 2] = clamp01((big[i] * 0.64 + small[i] * 0.36 - 0.22) * 1.8) * 255
    data[i * 4 + 3] = clamp01(dr[i] * (0.6 + grain[i] * 0.8)) * 255
  }
  return texture(data, size, anisotropy)
}

function makeDetail(size: number, anisotropy: number): DataTexture {
  const rand = rng(5179)
  const k = size / 1024

  // 彈孔：中間最深、往外淡掉（著色器照數值分成洞和洞口崩掉的那一圈）
  const holes = gray(size, 0)
  holes.globalCompositeOperation = 'lighter'
  const pit = (x: number, y: number, r: number) => {
    wrapped(holes, size, () => {
      const g = holes.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.42, 'rgba(255,255,255,0.62)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      holes.fillStyle = g
      holes.fillRect(x - r, y - r, r * 2, r * 2)
    })
  }
  // 一梭子打過去的一排、零星的幾發
  for (let i = 0; i < 12; i++) {
    const cx = rand() * size
    const cy = rand() * size
    const dir = rand() * Math.PI
    const n = 5 + Math.floor(rand() * 14)
    const gap = (22 + rand() * 30) * k
    for (let j = 0; j < n; j++) {
      const t = (j - n / 2) * gap
      pit(cx + Math.cos(dir) * t + (rand() - 0.5) * 26 * k, cy + Math.sin(dir) * t + (rand() - 0.5) * 26 * k, (3 + rand() * 4.5) * k)
    }
  }
  for (let i = 0; i < 40; i++) pit(rand() * size, rand() * size, (3 + rand() * 4.5) * k)
  // 砲彈打的大坑：幾個圓疊在一起，邊緣不規則
  for (let i = 0; i < 2; i++) {
    const cx = rand() * size
    const cy = rand() * size
    const r = (20 + rand() * 18) * k
    for (let j = 0; j < 7; j++) pit(cx + (rand() - 0.5) * r * 0.9, cy + (rand() - 0.5) * r * 0.9, r * (0.45 + rand() * 0.5))
  }

  // 碎石：大大小小的顆粒，幾塊有稜角的碎塊
  const gravel = gray(size, 0)
  for (let i = 0; i < 2600; i++) {
    const x = rand() * size
    const y = rand() * size
    const r = (0.8 + rand() * rand() * 3.4) * k
    const v = Math.floor(70 + rand() * 185)
    const turn = rand() * 3
    const squash = 0.55 + rand() * 0.45
    gravel.fillStyle = `rgb(${v},${v},${v})`
    wrapped(gravel, size, () => {
      gravel.beginPath()
      gravel.ellipse(x, y, r, r * squash, turn, 0, Math.PI * 2)
      gravel.fill()
    })
  }
  for (let i = 0; i < 70; i++) {
    const x = rand() * size
    const y = rand() * size
    const r = (4 + rand() * 8) * k
    const v = Math.floor(120 + rand() * 135)
    const n = 4 + Math.floor(rand() * 3)
    const pts: [number, number][] = []
    const a0 = rand() * 6
    for (let j = 0; j < n; j++) {
      const a = a0 + (j / n) * Math.PI * 2 + (rand() - 0.5) * 0.6
      const rr = r * (0.6 + rand() * 0.5)
      pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr])
    }
    gravel.fillStyle = `rgb(${v},${v},${v})`
    wrapped(gravel, size, () => {
      gravel.beginPath()
      pts.forEach(([px, py], j) => (j ? gravel.lineTo(px, py) : gravel.moveTo(px, py)))
      gravel.closePath()
      gravel.fill()
    })
  }

  const ho = read(holes)
  const gr = read(gravel)
  const stain = field(Math.min(size, 512), size, (u, v) => layered(u, v, 5, 61, 4))
  const blob = field(Math.min(size, 128), size, (u, v) => layered(u, v, 2, 73, 3))
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = clamp01(ho[i]) * 255
    data[i * 4 + 1] = clamp01(gr[i]) * 255
    data[i * 4 + 2] = clamp01((stain[i] - 0.25) * 2) * 255
    data[i * 4 + 3] = clamp01((blob[i] - 0.2) * 1.67) * 255
  }
  return texture(data, size, anisotropy)
}

/** `small` 是手機：解析度砍半 */
export function createWorldMasks(small: boolean, anisotropy: number): WorldMasks {
  const size = small ? 512 : 1024
  return { mask: makeMask(size, anisotropy), detail: makeDetail(size, anisotropy) }
}

export function disposeWorldMasks(t: WorldMasks) {
  t.mask.dispose()
  t.detail.dispose()
}
