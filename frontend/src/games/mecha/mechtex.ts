// 機甲材質用的細節貼圖：全部在瀏覽器裡算，不下載圖檔，上下左右都接得起來（每個面取不同的一塊，看不出重複）。
//   - `masks`：四種遮罩各一個色版。紅：一片一片的髒污；綠：刮痕；藍：零零碎碎的斑塊（決定邊上的漆掉成什麼形狀）；透明度：往下流的水漬
//   - `micro`：很細的法線貼圖。漆面的橘皮、鑄件的小坑、細刮痕
//   - `panels`：面板分割。紅綠：分割線、螺栓、檢修蓋、散熱槽的法線；藍：凹下去的地方（卡灰塵）；透明度：每一塊面板自己的深淺
//   - `decals`：噴在裝甲上的標誌（型號、隊徽、警示條、警告標籤），一張圖很多格，哪一個面貼哪一格由 `mechdecal.ts` 決定
import { CanvasTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three'
import { rng } from '../racing/noise'

/** 三張貼圖各自一格代表幾公尺 */
export const MASK_TILE = 1.6
export const MICRO_TILE = 0.9
export const PANEL_TILE = 4

/** 標誌圖上的一格：在圖上的範圍（貼圖座標，左下到右上）、寬 ÷ 高 */
export type DecalCell = { rect: [number, number, number, number]; aspect: number }

/** 標誌圖和每一格的位置；`codes` 是每一種機甲的型號、`labels` 是警告標籤、`icons` 是小圖示 */
export type DecalAtlas = {
  texture: CanvasTexture
  codes: Record<string, DecalCell>
  emblems: DecalCell[]
  hazard: DecalCell
  band: DecalCell
  labels: DecalCell[]
  icons: DecalCell[]
}

export type MechTextures = { masks: DataTexture; micro: DataTexture; panels: DataTexture; decals: DecalAtlas }

function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 接得起來的平滑雜訊：格點每 `period` 格重複一次，0～1 */
export function tile(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const x0 = ((ix % period) + period) % period
  const y0 = ((iy % period) + period) % period
  const x1 = (x0 + 1) % period
  const y1 = (y0 + 1) % period
  const a = hash(x0, y0, seed)
  const b = hash(x1, y0, seed)
  const c = hash(x0, y1, seed)
  const d = hash(x1, y1, seed)
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/** 疊幾層：(u, v) 是 0～1，最粗的一層一格有 `freq` 個起伏 */
export function layered(u: number, v: number, freq: number, seed: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  let f = freq
  for (let o = 0; o < octaves; o++) {
    sum += tile(u * f, v * f, f, seed + o * 17) * amp
    norm += amp
    amp *= 0.5
    f *= 2
  }
  return sum / norm
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const smooth = (lo: number, hi: number, v: number) => {
  const t = clamp01((v - lo) / (hi - lo))
  return t * t * (3 - 2 * t)
}

type Ctx = CanvasRenderingContext2D

export function gray(size: number, fill: number): Ctx {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = `rgb(${fill},${fill},${fill})`
  ctx.fillRect(0, 0, size, size)
  return ctx
}

/** 畫的東西跨過邊界的話在對面也畫一次 */
export function wrapped(ctx: Ctx, size: number, draw: () => void) {
  for (const ox of [-size, 0, size]) {
    for (const oy of [-size, 0, size]) {
      ctx.save()
      ctx.translate(ox, oy)
      draw()
      ctx.restore()
    }
  }
}

/** 畫布的紅色版（0～1） */
export function read(ctx: Ctx): Float32Array {
  const { width: w, height: h } = ctx.canvas
  const px = ctx.getImageData(0, 0, w, h).data
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] / 255
  return out
}

export function texture(data: Uint8Array, size: number, anisotropy: number): DataTexture {
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = anisotropy
  tex.needsUpdate = true
  return tex
}

/** 高低圖（0～1）算成法線的 x、y（-1～1），上下左右接得起來；`strength` 是凹凸的強度 */
export function slopes(height: Float32Array, size: number, strength: number): { nx: Float32Array; ny: Float32Array } {
  const nx = new Float32Array(size * size)
  const ny = new Float32Array(size * size)
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
      const dy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
      const ax = -dx * strength
      const ay = -dy * strength
      const l = 1 / Math.hypot(ax, ay, 1)
      const i = y * size + x
      nx[i] = ax * l
      ny[i] = ay * l
    }
  }
  return { nx, ny }
}

/** 遮罩：髒污、刮痕、斑塊、水漬 */
function makeMasks(size: number, anisotropy: number): DataTexture {
  const rand = rng(4107)
  const k = size / 512

  // 刮痕：大多順著兩個方向，長短粗細不一
  const scratch = gray(size, 0)
  scratch.lineCap = 'round'
  const main = rand() * Math.PI
  for (let i = 0; i < 420; i++) {
    const x = rand() * size
    const y = rand() * size
    const a = rand() < 0.7 ? main + (rand() - 0.5) * 0.5 + (rand() < 0.3 ? Math.PI / 2 : 0) : rand() * Math.PI
    const len = (6 + rand() * rand() * 150) * k
    const alpha = 0.25 + rand() * 0.75
    const bend = (rand() - 0.5) * 0.25
    scratch.strokeStyle = `rgba(255,255,255,${alpha})`
    scratch.lineWidth = (0.6 + rand() * rand() * 1.6) * k
    wrapped(scratch, size, () => {
      scratch.beginPath()
      scratch.moveTo(x, y)
      scratch.quadraticCurveTo(x + Math.cos(a + bend) * len * 0.5, y + Math.sin(a + bend) * len * 0.5, x + Math.cos(a) * len, y + Math.sin(a) * len)
      scratch.stroke()
    })
  }
  // 撞到的小凹痕：一小撮短刮痕擠在一起
  for (let i = 0; i < 26; i++) {
    const cx = rand() * size
    const cy = rand() * size
    for (let j = 0; j < 7; j++) {
      const a = rand() * Math.PI * 2
      const len = (3 + rand() * 10) * k
      const x = cx + (rand() - 0.5) * 14 * k
      const y = cy + (rand() - 0.5) * 14 * k
      scratch.strokeStyle = `rgba(255,255,255,${0.5 + rand() * 0.5})`
      scratch.lineWidth = (0.8 + rand() * 1.4) * k
      wrapped(scratch, size, () => {
        scratch.beginPath()
        scratch.moveTo(x, y)
        scratch.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
        scratch.stroke()
      })
    }
  }

  // 水漬：畫布的下面對應貼圖的上面，所以濃的那一頭在畫布的下面、往畫布的上面淡掉（貼到直立的面上是往下流）
  const drip = gray(size, 0)
  for (let i = 0; i < 90; i++) {
    const x = rand() * size
    const y = rand() * size
    const w = (1.5 + rand() * rand() * 16) * k
    const len = (30 + rand() * 230) * k
    const alpha = 0.3 + rand() * 0.6
    wrapped(drip, size, () => {
      const g = drip.createLinearGradient(0, y, 0, y - len)
      g.addColorStop(0, `rgba(255,255,255,${alpha})`)
      g.addColorStop(0.25, `rgba(255,255,255,${alpha * 0.6})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      drip.fillStyle = g
      drip.fillRect(x - w / 2, y - len, w, len)
    })
  }

  const sc = read(scratch)
  const dr = read(drip)
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const i = y * size + x
      // 髒污：大片的雲加上細的顆粒
      const cloud = layered(u, v, 4, 11, 5)
      const grain = layered(u, v, 48, 23, 2)
      const grunge = clamp01((cloud * 0.72 + grain * 0.28 - 0.3) * 2.1)
      // 斑塊：邊界清楚的碎片，大的裡面還有小的
      const big = layered(u, v, 14, 31, 3)
      const small = layered(u, v, 56, 47, 2)
      const chips = smooth(0.34, 0.66, big * 0.62 + small * 0.38)
      data[i * 4] = grunge * 255
      data[i * 4 + 1] = clamp01(sc[i]) * 255
      data[i * 4 + 2] = chips * 255
      data[i * 4 + 3] = clamp01(dr[i] * (0.6 + grain * 0.8)) * 255
    }
  }
  return texture(data, size, anisotropy)
}

/** 細的法線：橘皮、小坑、細刮痕 */
function makeMicro(size: number, anisotropy: number): DataTexture {
  const rand = rng(977)
  const k = size / 512
  const marks = gray(size, 0)
  // 小坑
  for (let i = 0; i < 900; i++) {
    const x = rand() * size
    const y = rand() * size
    const r = (0.6 + rand() * rand() * 2.4) * k
    marks.fillStyle = `rgba(255,255,255,${0.3 + rand() * 0.7})`
    wrapped(marks, size, () => {
      marks.beginPath()
      marks.arc(x, y, r, 0, Math.PI * 2)
      marks.fill()
    })
  }
  // 細刮痕
  marks.lineCap = 'round'
  for (let i = 0; i < 160; i++) {
    const x = rand() * size
    const y = rand() * size
    const a = rand() * Math.PI
    const len = (10 + rand() * 90) * k
    marks.strokeStyle = `rgba(255,255,255,${0.2 + rand() * 0.5})`
    marks.lineWidth = (0.5 + rand() * 0.8) * k
    wrapped(marks, size, () => {
      marks.beginPath()
      marks.moveTo(x, y)
      marks.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
      marks.stroke()
    })
  }
  const dents = read(marks)
  const height = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const peel = layered(u, v, 72, 5, 2)
      const lump = layered(u, v, 9, 71, 3)
      height[y * size + x] = 0.5 + (peel - 0.5) * 0.3 + (lump - 0.5) * 0.16 - dents[y * size + x] * 0.35
    }
  }
  const { nx, ny } = slopes(height, size, 1.5)
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const z = Math.sqrt(Math.max(0, 1 - nx[i] * nx[i] - ny[i] * ny[i]))
    data[i * 4] = (nx[i] * 0.5 + 0.5) * 255
    data[i * 4 + 1] = (ny[i] * 0.5 + 0.5) * 255
    data[i * 4 + 2] = (z * 0.5 + 0.5) * 255
    data[i * 4 + 3] = 255
  }
  return texture(data, size, anisotropy)
}

type Rect = { x: number; y: number; w: number; h: number }

/** 面板分割：一塊一塊切開，有些加上螺栓、檢修蓋、散熱槽、圓蓋 */
function makePanels(size: number, anisotropy: number): DataTexture {
  const rand = rng(2291)
  /** 一公尺幾個像素 */
  const px = size / PANEL_TILE
  const min = 0.34 * px
  const max = 1.25 * px
  const snap = (v: number) => Math.round(v / 4) * 4
  const rects: Rect[] = []
  const split = (r: Rect, depth: number) => {
    const wide = r.w >= r.h
    const long = wide ? r.w : r.h
    if (long <= max && (long < min * 2 || rand() < 0.3 + depth * 0.06)) {
      rects.push(r)
      return
    }
    if (long < min * 2) {
      rects.push(r)
      return
    }
    const cut = snap(Math.max(min, Math.min(long - min, long * (0.3 + rand() * 0.4))))
    if (wide) {
      split({ x: r.x, y: r.y, w: cut, h: r.h }, depth + 1)
      split({ x: r.x + cut, y: r.y, w: r.w - cut, h: r.h }, depth + 1)
    } else {
      split({ x: r.x, y: r.y, w: r.w, h: cut }, depth + 1)
      split({ x: r.x, y: r.y + cut, w: r.w, h: r.h - cut }, depth + 1)
    }
  }
  split({ x: 0, y: 0, w: size, h: size }, 0)

  const high = gray(size, 128)
  const tint = gray(size, 128)
  const k = size / 1024
  const groove = (draw: () => void, width: number) => {
    // 外面一圈淺的、中間一條深的：算成法線時溝的兩邊是斜的
    high.strokeStyle = 'rgb(92,92,92)'
    high.lineWidth = width * 1.9 * k
    draw()
    high.strokeStyle = 'rgb(28,28,28)'
    high.lineWidth = width * k
    draw()
  }
  const bolt = (x: number, y: number, r: number) => {
    high.fillStyle = 'rgb(70,70,70)'
    high.beginPath()
    high.arc(x, y, r * 1.55 * k, 0, Math.PI * 2)
    high.fill()
    high.fillStyle = 'rgb(196,196,196)'
    high.beginPath()
    high.arc(x, y, r * k, 0, Math.PI * 2)
    high.fill()
    // 螺絲頭的一字槽
    const a = rand() * Math.PI
    high.strokeStyle = 'rgb(110,110,110)'
    high.lineWidth = 1.2 * k
    high.beginPath()
    high.moveTo(x - Math.cos(a) * r * 0.8 * k, y - Math.sin(a) * r * 0.8 * k)
    high.lineTo(x + Math.cos(a) * r * 0.8 * k, y + Math.sin(a) * r * 0.8 * k)
    high.stroke()
  }

  for (const r of rects) {
    const t = Math.floor(rand() * 256)
    tint.fillStyle = `rgb(${t},${t},${t})`
    tint.fillRect(r.x, r.y, r.w, r.h)
    const roll = rand()
    const small = Math.min(r.w, r.h)
    // 稍微墊高的補強板
    if (roll < 0.16 && small > 70 * k) {
      const m = 9 * k
      high.fillStyle = 'rgb(150,150,150)'
      high.fillRect(r.x + m, r.y + m, r.w - m * 2, r.h - m * 2)
    }
    // 四個角的螺栓
    if (small > 90 * k && rand() < 0.62) {
      const m = 13 * k
      for (const [bx, by] of [
        [r.x + m, r.y + m],
        [r.x + r.w - m, r.y + m],
        [r.x + m, r.y + r.h - m],
        [r.x + r.w - m, r.y + r.h - m],
      ]) {
        bolt(bx, by, 3.4)
      }
      // 長邊中間再補幾顆
      if (r.w > 210 * k) {
        bolt(r.x + r.w / 2, r.y + m, 3.4)
        bolt(r.x + r.w / 2, r.y + r.h - m, 3.4)
      }
    }
    if (roll > 0.86 && small > 96 * k) {
      // 散熱槽：一排平行的溝
      const horizontal = r.w >= r.h
      const span = (horizontal ? r.w : r.h) * 0.56
      const depth = (horizontal ? r.h : r.w) * 0.5
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      const n = Math.max(3, Math.floor(depth / (9 * k)))
      for (let i = 0; i < n; i++) {
        const o = (i - (n - 1) / 2) * 9 * k
        groove(() => {
          high.beginPath()
          if (horizontal) {
            high.moveTo(cx - span / 2, cy + o)
            high.lineTo(cx + span / 2, cy + o)
          } else {
            high.moveTo(cx + o, cy - span / 2)
            high.lineTo(cx + o, cy + span / 2)
          }
          high.stroke()
        }, 3.2)
      }
    } else if (roll > 0.74 && small > 120 * k) {
      // 檢修蓋：圓角的溝、兩個鉸鍊、一個把手
      const m = 24 * k
      const rr = 10 * k
      groove(() => {
        high.beginPath()
        high.roundRect(r.x + m, r.y + m, r.w - m * 2, r.h - m * 2, rr)
        high.stroke()
      }, 2.6)
      high.fillStyle = 'rgb(176,176,176)'
      for (const f of [0.28, 0.72]) high.fillRect(r.x + m - 5 * k, r.y + m + (r.h - m * 2) * f - 7 * k, 10 * k, 14 * k)
      high.fillStyle = 'rgb(60,60,60)'
      high.fillRect(r.x + r.w - m - 16 * k, r.y + r.h / 2 - 10 * k, 7 * k, 20 * k)
    } else if (roll > 0.66 && small > 110 * k) {
      // 圓蓋：一圈溝、六顆螺栓
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      const rad = small * 0.24
      groove(() => {
        high.beginPath()
        high.arc(cx, cy, rad, 0, Math.PI * 2)
        high.stroke()
      }, 2.6)
      for (let i = 0; i < 6; i++) bolt(cx + Math.cos((i / 6) * Math.PI * 2) * rad * 0.74, cy + Math.sin((i / 6) * Math.PI * 2) * rad * 0.74, 2.6)
    }
  }
  // 面板之間的分割線（最後畫，蓋過其他的）
  for (const r of rects) {
    wrapped(high, size, () =>
      groove(() => {
        high.beginPath()
        high.rect(r.x, r.y, r.w, r.h)
        high.stroke()
      }, 3),
    )
  }

  const height = read(high)
  const tints = read(tint)
  const { nx, ny } = slopes(height, size, 2.4)
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = (nx[i] * 0.5 + 0.5) * 255
    data[i * 4 + 1] = (ny[i] * 0.5 + 0.5) * 255
    data[i * 4 + 2] = clamp01((0.5 - height[i]) * 2.6) * 255
    data[i * 4 + 3] = tints[i] * 255
  }
  return texture(data, size, anisotropy)
}

/** 每一種機甲噴在身上的型號 */
const CODES: Record<string, string> = { speed: 'S-07', sniper: 'L-12', recon: 'R-03', fortress: 'F-21', mortar: 'M-36', drone: 'D-5' }
const STENCIL = '"Arial Black", "Arial Narrow Bold", Impact, "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif'
const LABEL = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Heiti TC", Arial, sans-serif'
const WHITE = '#e9e6dc'
const YELLOW = '#e0a81c'
const BLACK = '#17181a'
const RED = '#b3261e'

/** 標誌：一格一格畫在同一張圖上（一排一排往下排），每一格四周留白，縮小時才不會吃到隔壁 */
function makeDecals(size: number, anisotropy: number): DecalAtlas {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const k = size / 1024
  const pad = 8 * k
  let x = pad
  let y = pad
  let row = 0
  /** 排一格（寬高是 1024 那張圖上的像素），在裡面畫（原點移到這一格的左上角） */
  const cell = (w: number, h: number, draw: (w: number, h: number) => void): DecalCell => {
    w *= k
    h *= k
    if (x + w + pad > size) {
      x = pad
      y += row + pad * 2
      row = 0
    }
    ctx.save()
    ctx.translate(x, y)
    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    ctx.clip()
    draw(w, h)
    ctx.restore()
    const out: DecalCell = { rect: [x / size, 1 - (y + h) / size, (x + w) / size, 1 - y / size], aspect: w / h }
    x += w + pad * 2
    row = Math.max(row, h)
    return out
  }
  /** 把一行字塞進寬 `w`、高 `h` 的範圍裡（照量到的寬度縮字） */
  const text = (str: string, font: string, weight: number, cx: number, cy: number, w: number, h: number, color: string) => {
    let px = h
    ctx.font = `${weight} ${px}px ${font}`
    const m = ctx.measureText(str).width
    if (m > w) px *= w / m
    ctx.font = `${weight} ${px}px ${font}`
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(str, cx, cy)
  }

  // 型號：模板噴漆的粗體字，筆畫中間斷幾道（模板的連接橋）
  const codes: Record<string, DecalCell> = {}
  for (const [kind, code] of Object.entries(CODES)) {
    codes[kind] = cell(300, 132, (w, h) => {
      text(code, STENCIL, 900, w / 2, h * 0.54, w * 0.94, h * 0.92, WHITE)
      ctx.globalCompositeOperation = 'destination-out'
      for (const f of [0.18, 0.41, 0.62, 0.84]) ctx.fillRect(w * f, 0, 3.2 * k, h)
      ctx.fillRect(0, h * 0.5, w, 2.6 * k)
      ctx.globalCompositeOperation = 'source-over'
    })
  }

  // 隊徽：圓環裡三道箭頭、六角形裡一顆星
  const emblems = [
    cell(176, 176, (w, h) => {
      const r = w * 0.44
      ctx.strokeStyle = WHITE
      ctx.lineWidth = w * 0.07
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.lineJoin = 'miter'
      ctx.lineWidth = w * 0.085
      for (let i = 0; i < 3; i++) {
        const oy = h * (0.36 + i * 0.15)
        ctx.beginPath()
        ctx.moveTo(w * 0.3, oy + h * 0.09)
        ctx.lineTo(w * 0.5, oy - h * 0.05)
        ctx.lineTo(w * 0.7, oy + h * 0.09)
        ctx.stroke()
      }
    }),
    cell(176, 176, (w, h) => {
      ctx.strokeStyle = WHITE
      ctx.lineWidth = w * 0.06
      ctx.beginPath()
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6
        const px = w / 2 + Math.cos(a) * w * 0.44
        const py = h / 2 + Math.sin(a) * h * 0.44
        if (i) ctx.lineTo(px, py)
        else ctx.moveTo(px, py)
      }
      ctx.closePath()
      ctx.stroke()
      ctx.fillStyle = WHITE
      ctx.beginPath()
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2
        const r = (i % 2 ? 0.13 : 0.3) * w
        const px = w / 2 + Math.cos(a) * r
        const py = h / 2 + Math.sin(a) * r
        if (i) ctx.lineTo(px, py)
        else ctx.moveTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
    }),
  ]

  // 黃黑相間的警示條
  const hazard = cell(560, 96, (w, h) => {
    ctx.fillStyle = YELLOW
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = BLACK
    const step = h * 0.9
    for (let sx = -h; sx < w + h; sx += step * 2) {
      ctx.beginPath()
      ctx.moveTo(sx, h)
      ctx.lineTo(sx + step, h)
      ctx.lineTo(sx + step + h, 0)
      ctx.lineTo(sx + h, 0)
      ctx.fill()
    }
  })
  // 識別帶：一條白的，旁邊一條細的
  const band = cell(560, 72, (w, h) => {
    ctx.fillStyle = WHITE
    ctx.fillRect(0, h * 0.08, w, h * 0.5)
    ctx.fillRect(0, h * 0.72, w, h * 0.16)
  })

  // 警告標籤：底色、外框、兩行字（中文在上、英文在下）
  const tag = (bg: string, fg: string, zh: string, en: string) =>
    cell(232, 100, (w, h) => {
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = fg
      ctx.lineWidth = 4 * k
      ctx.strokeRect(5 * k, 5 * k, w - 10 * k, h - 10 * k)
      text(zh, LABEL, 900, w / 2, h * 0.36, w * 0.8, h * 0.4, fg)
      text(en, STENCIL, 900, w / 2, h * 0.74, w * 0.8, h * 0.22, fg)
    })
  const labels = [
    tag(YELLOW, BLACK, '危險', 'DANGER'),
    tag(RED, WHITE, '高壓電', 'HIGH VOLTAGE'),
    tag(BLACK, WHITE, '禁止踩踏', 'NO STEP'),
    tag(YELLOW, BLACK, '注意排氣', 'HOT EXHAUST'),
    tag(BLACK, YELLOW, '吊掛點', 'LIFT POINT'),
    tag(WHITE, BLACK, '赤鋼重工', 'RIVERBANK ARMS'),
  ]

  // 小圖示：驚嘆號三角形、箭頭
  const icons = [
    cell(120, 108, (w, h) => {
      ctx.fillStyle = YELLOW
      ctx.strokeStyle = BLACK
      ctx.lineWidth = 7 * k
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(w / 2, h * 0.08)
      ctx.lineTo(w * 0.94, h * 0.9)
      ctx.lineTo(w * 0.06, h * 0.9)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      text('!', STENCIL, 900, w / 2, h * 0.6, w * 0.3, h * 0.5, BLACK)
    }),
    cell(120, 108, (w, h) => {
      ctx.fillStyle = WHITE
      ctx.beginPath()
      ctx.moveTo(w * 0.5, h * 0.06)
      ctx.lineTo(w * 0.92, h * 0.5)
      ctx.lineTo(w * 0.66, h * 0.5)
      ctx.lineTo(w * 0.66, h * 0.94)
      ctx.lineTo(w * 0.34, h * 0.94)
      ctx.lineTo(w * 0.34, h * 0.5)
      ctx.lineTo(w * 0.08, h * 0.5)
      ctx.closePath()
      ctx.fill()
    }),
  ]

  const tex = new CanvasTexture(canvas)
  // 顏色先乘上透明度再上傳：邊緣內插時才不會混到「透明的黑色」，標誌四周不會有一圈黑邊。
  // 乘過透明度的顏色不能讓顯示卡自動轉成線性的（會轉錯），所以當成一般的數字上傳，著色器裡自己轉
  tex.premultiplyAlpha = true
  tex.anisotropy = anisotropy
  return { texture: tex, codes, emblems, hazard, band, labels, icons }
}

/** `small` 是手機：解析度砍半 */
export function createMechTextures(small: boolean, anisotropy: number): MechTextures {
  const k = small ? 0.5 : 1
  return {
    masks: makeMasks(512 * k, anisotropy),
    micro: makeMicro(512 * k, anisotropy),
    panels: makePanels(1024 * k, anisotropy),
    decals: makeDecals(1024 * k, anisotropy),
  }
}

export function disposeMechTextures(t: MechTextures) {
  t.masks.dispose()
  t.micro.dispose()
  t.panels.dispose()
  t.decals.texture.dispose()
}
