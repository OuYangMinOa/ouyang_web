// 機甲對戰場景的貼圖：全部用 canvas 畫，不下載圖檔。這裡畫的是每一種材質「原本的樣子」加上不會變的舊損
// （褪色的招牌、拉下來的鐵捲門、釘上木板的店面）；整座城市各處不一樣的風化和破壞（彈孔、剝落、煤煙、破掉的窗戶）
// 是著色器照世界座標另外疊上去的（`worldmat.ts`）。
// 每一種材質除了顏色，還可以多畫三層：
//   - 高低（灰階，128 是平的）→ 算成法線貼圖，斜射的陽光照上去才看得出磚縫、浪板、石塊的凹凸
//   - 發光（窗戶、招牌）
//   - 粗糙度／金屬度（綠色是粗糙度、藍色是金屬度）：玻璃亮、牆面霧
// 畫的時候用「邏輯座標」（例如外牆是 1 公尺 100 單位），各層照自己的解析度縮放。
import { CanvasTexture, ClampToEdgeWrapping, RepeatWrapping, SRGBColorSpace, type Texture } from 'three'
import { rng } from '../racing/noise'

type Ctx = CanvasRenderingContext2D

/** 一種材質的各層畫布（沒有要的那一層是 null） */
type Layers = { c: Ctx; h: Ctx | null; e: Ctx | null; o: Ctx | null; w: number; ht: number }

type Paint = (l: Layers, rand: () => number) => void

export type Surface = { map: CanvasTexture; normalMap: CanvasTexture | null; emissiveMap: CanvasTexture | null; ormMap: CanvasTexture | null }

type SurfaceOptions = {
  /** 邏輯座標的大小（沒給就和畫布一樣） */
  logical?: [number, number]
  /** 法線的強度（0 是不要法線貼圖） */
  normal?: number
  emissive?: boolean
  orm?: boolean
  /** 顏色以外那幾層的解析度是顏色的幾倍 */
  aux?: number
  /** 一開始的粗糙度、金屬度 */
  rough?: number
  metal?: number
}

let anisotropy = 8

/** 各向異性過濾開到多少（照顯示卡支援的上限） */
export function setAnisotropy(n: number) {
  anisotropy = Math.max(1, Math.min(8, n))
}

function makeCanvas(w: number, h: number, lw: number, lh: number, fill: string): Ctx {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!
  ctx.scale(w / lw, h / lh)
  ctx.fillStyle = fill
  ctx.fillRect(0, 0, lw, lh)
  return ctx
}

function finish(ctx: Ctx, srgb: boolean): CanvasTexture {
  const tex = new CanvasTexture(ctx.canvas)
  if (srgb) tex.colorSpace = SRGBColorSpace
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.anisotropy = anisotropy
  return tex
}

const gray = (v: number) => {
  const g = Math.max(0, Math.min(255, Math.round(v * 255)))
  return `rgb(${g},${g},${g})`
}
const ormStyle = (rough: number, metal: number) => `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`

/** 在某一層畫一個方塊（那一層沒有就略過） */
function fill(ctx: Ctx | null, style: string, x: number, y: number, w: number, h: number) {
  if (!ctx) return
  ctx.fillStyle = style
  ctx.fillRect(x, y, w, h)
}

/** 高低圖算成法線貼圖（左右、上下都接得起來） */
function normalFromHeight(src: Ctx, strength: number): CanvasTexture {
  const { width: w, height: h } = src.canvas
  const data = src.getImageData(0, 0, w, h).data
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const octx = out.getContext('2d')!
  const img = octx.createImageData(w, h)
  const px = img.data
  const at = (x: number, y: number) => data[(((y + h) % h) * w + ((x + w) % w)) * 4]
  const k = strength / 255
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sobel：順便把雜點抹掉一點
      const dx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
      const dy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
      // 貼圖的 v 往上、畫布的 y 往下，所以 y 的那一項反過來
      const nx = -dx * k
      const ny = dy * k
      const l = 1 / Math.hypot(nx, ny, 1)
      const i = (y * w + x) * 4
      px[i] = (nx * l * 0.5 + 0.5) * 255
      px[i + 1] = (ny * l * 0.5 + 0.5) * 255
      px[i + 2] = (l * 0.5 + 0.5) * 255
      px[i + 3] = 255
    }
  }
  octx.putImageData(img, 0, 0)
  const tex = new CanvasTexture(out)
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.anisotropy = anisotropy
  return tex
}

function surface(pw: number, ph: number, seed: number, paint: Paint, opt: SurfaceOptions = {}): Surface {
  const [lw, lh] = opt.logical ?? [pw, ph]
  const aux = opt.aux ?? 1
  const aw = Math.round(pw * aux)
  const ah = Math.round(ph * aux)
  const l: Layers = {
    c: makeCanvas(pw, ph, lw, lh, '#808080'),
    h: opt.normal ? makeCanvas(aw, ah, lw, lh, gray(0.5)) : null,
    e: opt.emissive ? makeCanvas(aw, ah, lw, lh, '#000') : null,
    o: opt.orm ? makeCanvas(aw, ah, lw, lh, ormStyle(opt.rough ?? 0.9, opt.metal ?? 0)) : null,
    w: lw,
    ht: lh,
  }
  paint(l, rng(seed))
  return {
    map: finish(l.c, true),
    normalMap: l.h ? normalFromHeight(l.h, opt.normal!) : null,
    emissiveMap: l.e ? finish(l.e, true) : null,
    ormMap: l.o ? finish(l.o, false) : null,
  }
}

/** 一點一點的雜訊，讓平面不要太乾淨；`h` 有給的話高低圖也跟著凹凸 */
function speckle(l: Layers, rand: () => number, n: number, lo: number, hi: number, a: number, size = 3, bump = 0) {
  for (let i = 0; i < n; i++) {
    const v = Math.floor(lo + (hi - lo) * rand())
    const x = rand() * l.w
    const y = rand() * l.ht
    const s = 1 + rand() * size
    fill(l.c, `rgba(${v},${v},${v},${a})`, x, y, s, s)
    if (bump && l.h) fill(l.h, v > (lo + hi) / 2 ? `rgba(255,255,255,${bump})` : `rgba(0,0,0,${bump})`, x, y, s, s)
  }
}

/** 一片一片不規則的髒污（很淡的大色塊） */
function blotches(ctx: Ctx, w: number, h: number, rand: () => number, n: number, r0: number, r1: number, style: (a: number) => string, alpha: number) {
  for (let i = 0; i < n; i++) {
    const x = rand() * w
    const y = rand() * h
    const r = r0 + (r1 - r0) * rand()
    // 跨過邊界的那幾片在對面再畫一次，貼圖才接得起來
    for (const ox of [-w, 0, w]) {
      for (const oy of [-h, 0, h]) {
        if (x + ox + r < 0 || x + ox - r > w || y + oy + r < 0 || y + oy - r > h) continue
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r)
        g.addColorStop(0, style(alpha))
        g.addColorStop(1, style(0))
        ctx.fillStyle = g
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2)
      }
    }
  }
}

/** 往下流的水漬：從 (x, y) 往下拖一條越來越淡的痕跡 */
function streak(ctx: Ctx, x: number, y: number, w: number, len: number, color: string) {
  const g = ctx.createLinearGradient(0, y, 0, y + len)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(x, y, w, len)
}

// ---------- 地面 ----------

/** 柏油：細碎的骨材、幾道裂縫和補過的瀝青線（大片的深淺另外用整張地圖的那一層做，這裡不畫會重複的大色塊） */
const paintAsphalt: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#4b4d51', 0, 0, w, h)
  blotches(l.c, w, h, rand, 14, 60, 150, (a) => `rgba(30,31,34,${a})`, 0.22)
  blotches(l.c, w, h, rand, 10, 50, 120, (a) => `rgba(120,118,112,${a})`, 0.12)
  speckle(l, rand, 26000, 40, 130, 0.42, 1.6, 0.35)
  speckle(l, rand, 1800, 150, 200, 0.3, 1.2, 0.5)
  // 裂縫
  for (let i = 0; i < 9; i++) {
    let x = rand() * w
    let y = rand() * h
    for (const ctx of [l.c, l.h]) {
      if (!ctx) continue
      ctx.strokeStyle = ctx === l.c ? 'rgba(18,18,20,0.55)' : gray(0.1)
      ctx.lineWidth = ctx === l.c ? 1.3 : 2
    }
    const pts: [number, number][] = [[x, y]]
    for (let k = 0; k < 7; k++) {
      x += (rand() - 0.5) * 60
      y += (rand() - 0.5) * 60
      pts.push([x, y])
    }
    for (const ctx of [l.c, l.h]) {
      if (!ctx) continue
      ctx.beginPath()
      pts.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py)))
      ctx.stroke()
    }
  }
  // 補過的瀝青線：亮亮黑黑的一條
  l.c.strokeStyle = 'rgba(14,14,16,0.5)'
  l.c.lineWidth = 3
  for (let i = 0; i < 3; i++) {
    l.c.beginPath()
    let x = rand() * w
    let y = rand() * h
    l.c.moveTo(x, y)
    for (let k = 0; k < 4; k++) {
      x += (rand() - 0.5) * 140
      y += (rand() - 0.5) * 140
      l.c.lineTo(x, y)
    }
    l.c.stroke()
  }
}

/** 人行道：錯開排的地磚，磚縫凹下去 */
const paintPavers: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#6f6b64', 0, 0, w, h)
  fill(l.h, gray(0.25), 0, 0, w, h)
  const cols = 4
  const rows = 8
  const bw = w / cols
  const bh = h / rows
  for (let y = 0; y < rows; y++) {
    for (let x = -1; x < cols; x++) {
      const px = x * bw + (y % 2 ? bw / 2 : 0)
      const v = 142 + Math.floor(rand() * 34)
      const warm = rand() < 0.25 ? 10 : 0
      fill(l.c, `rgb(${v + warm},${v - 3},${v - 11 - warm})`, px + 1.5, y * bh + 1.5, bw - 3, bh - 3)
      fill(l.h, gray(0.62 + rand() * 0.1), px + 2.5, y * bh + 2.5, bw - 5, bh - 5)
    }
  }
  speckle(l, rand, 5000, 80, 200, 0.2, 2, 0.12)
  blotches(l.c, w, h, rand, 8, 30, 80, (a) => `rgba(40,38,34,${a})`, 0.16)
}

/** 草地：枯黃的草、露出來的泥土 */
const paintGrass: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#5a5238', 0, 0, w, h)
  blotches(l.c, w, h, rand, 26, 40, 110, (a) => `rgba(122,108,62,${a})`, 0.4)
  blotches(l.c, w, h, rand, 20, 30, 90, (a) => `rgba(54,46,32,${a})`, 0.45)
  blotches(l.c, w, h, rand, 10, 20, 60, (a) => `rgba(78,84,46,${a})`, 0.3)
  for (let i = 0; i < 22000; i++) {
    const g = 84 + Math.floor(rand() * 70)
    const x = rand() * w
    const y = rand() * h
    fill(l.c, `rgba(${g + 6},${g - 6},${g - 46},0.45)`, x, y, 1, 2 + rand() * 4)
    if (i % 3 === 0) fill(l.h, gray(0.3 + rand() * 0.5), x, y, 1.5, 3)
  }
}

/** 混凝土：模板的分割線、拉桿的孔、往下流的水漬 */
const paintConcrete: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#a19f99', 0, 0, w, h)
  blotches(l.c, w, h, rand, 16, 50, 140, (a) => `rgba(70,68,64,${a})`, 0.16)
  blotches(l.c, w, h, rand, 12, 40, 120, (a) => `rgba(205,202,194,${a})`, 0.18)
  speckle(l, rand, 9000, 96, 190, 0.22, 2.2)
  for (let i = 0; i < 14; i++) streak(l.c, rand() * w, rand() * h * 0.6, 3 + rand() * 9, 60 + rand() * 160, `rgba(52,50,46,${0.1 + rand() * 0.14})`)
  // 模板的分割線：一格 w/2
  for (const ctx of [l.c, l.h]) {
    if (!ctx) continue
    ctx.strokeStyle = ctx === l.c ? 'rgba(48,47,45,0.5)' : gray(0.12)
    ctx.lineWidth = ctx === l.c ? 2 : 3
    ctx.beginPath()
    for (const p of [0, 0.5, 1]) {
      ctx.moveTo(w * p, 0)
      ctx.lineTo(w * p, h)
      ctx.moveTo(0, h * p)
      ctx.lineTo(w, h * p)
    }
    ctx.stroke()
  }
  // 拉桿孔
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x = (gx + 0.5) * (w / 4)
      const y = (gy + 0.5) * (h / 4)
      for (const ctx of [l.c, l.h]) {
        if (!ctx) continue
        ctx.fillStyle = ctx === l.c ? 'rgba(40,40,38,0.6)' : gray(0.05)
        ctx.beginPath()
        ctx.arc(x, y, w / 110, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}

/** 廣場：深淺相間的大石板 */
const paintPlaza: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#5d5952', 0, 0, w, h)
  fill(l.h, gray(0.2), 0, 0, w, h)
  const n = 8
  const s = w / n
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 168 + Math.floor(rand() * 26)
      const dark = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0
      fill(l.c, dark ? `rgb(${v - 44},${v - 46},${v - 50})` : `rgb(${v},${v - 6},${v - 16})`, x * s + 1.5, y * s + 1.5, s - 3, s - 3)
      fill(l.h, gray(0.6 + rand() * 0.08), x * s + 3, y * s + 3, s - 6, s - 6)
    }
  }
  speckle(l, rand, 6000, 110, 220, 0.2, 2, 0.08)
  blotches(l.c, w, h, rand, 8, 40, 110, (a) => `rgba(50,46,40,${a})`, 0.14)
}

/** 泥土、碎石（工地、調車場的道碴、河床） */
const paintDirt: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#84705a', 0, 0, w, h)
  blotches(l.c, w, h, rand, 18, 30, 90, (a) => `rgba(60,48,36,${a})`, 0.3)
  blotches(l.c, w, h, rand, 14, 30, 80, (a) => `rgba(170,150,120,${a})`, 0.25)
  speckle(l, rand, 14000, 60, 190, 0.45, 3, 0.5)
  // 小石頭
  for (let i = 0; i < 260; i++) {
    const x = rand() * w
    const y = rand() * h
    const r = 1.5 + rand() * 3.5
    const v = 110 + Math.floor(rand() * 70)
    for (const ctx of [l.c, l.h]) {
      if (!ctx) continue
      ctx.fillStyle = ctx === l.c ? `rgb(${v},${v - 6},${v - 16})` : gray(0.9)
      ctx.beginPath()
      ctx.ellipse(x, y, r, r * (0.6 + rand() * 0.4), rand() * 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/** 屋頂：一捲一捲的防水毯、接縫和補丁 */
const paintRoof: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#5d5c59', 0, 0, w, h)
  blotches(l.c, w, h, rand, 12, 30, 90, (a) => `rgba(30,30,30,${a})`, 0.25)
  blotches(l.c, w, h, rand, 10, 30, 80, (a) => `rgba(150,146,138,${a})`, 0.2)
  speckle(l, rand, 9000, 50, 150, 0.4, 2, 0.4)
  for (let x = 0; x < w; x += w / 4) {
    fill(l.c, 'rgba(22,22,22,0.5)', x, 0, 2, h)
    fill(l.h, gray(0.8), x - 2, 0, 6, h)
  }
  for (let i = 0; i < 4; i++) {
    const x = rand() * w * 0.8
    const y = rand() * h * 0.8
    fill(l.c, 'rgba(34,34,36,0.55)', x, y, 20 + rand() * 40, 16 + rand() * 30)
  }
}

/** 浪板（貨櫃、鐵皮倉庫、機庫、車廂）：一條條凸起來的直稜、鏽斑往下流 */
const paintCorrugated: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#d2d2d0', 0, 0, w, h)
  const pitch = w / 24
  for (let x = 0; x < w; x += pitch) {
    fill(l.c, 'rgba(0,0,0,0.2)', x, 0, pitch * 0.34, h)
    fill(l.c, 'rgba(255,255,255,0.16)', x + pitch * 0.55, 0, pitch * 0.25, h)
    if (l.h) {
      const g = l.h.createLinearGradient(x, 0, x + pitch, 0)
      g.addColorStop(0, gray(0.15))
      g.addColorStop(0.5, gray(0.9))
      g.addColorStop(1, gray(0.15))
      l.h.fillStyle = g
      l.h.fillRect(x, 0, pitch, h)
    }
  }
  speckle(l, rand, 2600, 70, 170, 0.22, 3)
  for (let i = 0; i < 22; i++) streak(l.c, rand() * w, rand() * h, 3 + rand() * 9, 20 + rand() * 90, `rgba(112,58,26,${0.16 + rand() * 0.22})`)
  blotches(l.c, w, h, rand, 6, 14, 40, (a) => `rgba(96,52,26,${a})`, 0.3)
  // 上下的框
  fill(l.c, 'rgba(0,0,0,0.25)', 0, 0, w, 5)
  fill(l.c, 'rgba(0,0,0,0.3)', 0, h - 6, w, 6)
  fill(l.h, gray(0.95), 0, 0, w, 6)
  fill(l.h, gray(0.95), 0, h - 6, w, 6)
}

/** 混凝土牆（防爆牆）：一片一片的牆板，底下一段黃黑相間的警示條 */
const paintBlast: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#a9a7a1', 0, 0, w, h)
  blotches(l.c, w, h, rand, 12, 40, 110, (a) => `rgba(66,64,60,${a})`, 0.18)
  speckle(l, rand, 7000, 100, 195, 0.3, 2.4, 0.1)
  for (let i = 0; i < 10; i++) streak(l.c, rand() * w, rand() * h * 0.3, 4 + rand() * 10, 80 + rand() * 200, `rgba(48,46,42,${0.1 + rand() * 0.12})`)
  // 牆板的接縫、吊掛孔
  for (const x of [0, w / 2]) {
    fill(l.c, 'rgba(40,40,38,0.55)', x - 1.5, 0, 3, h)
    fill(l.h, gray(0.1), x - 3, 0, 6, h)
    for (const ctx of [l.c, l.h]) {
      if (!ctx) continue
      ctx.fillStyle = ctx === l.c ? 'rgba(30,30,30,0.7)' : gray(0.05)
      ctx.beginPath()
      ctx.arc(x + w / 4, h * 0.12, w / 60, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const band = h * 0.12
  for (let x = -h; x < w + h; x += w / 10) {
    l.c.fillStyle = '#d9a91c'
    l.c.beginPath()
    l.c.moveTo(x, h)
    l.c.lineTo(x + w / 20, h)
    l.c.lineTo(x + w / 20 + band, h - band)
    l.c.lineTo(x + band, h - band)
    l.c.fill()
    l.c.fillStyle = '#26262a'
    l.c.beginPath()
    l.c.moveTo(x + w / 20, h)
    l.c.lineTo(x + w / 10, h)
    l.c.lineTo(x + w / 10 + band, h - band)
    l.c.lineTo(x + w / 20 + band, h - band)
    l.c.fill()
  }
  fill(l.c, 'rgba(30,30,30,0.6)', 0, h - band - 3, w, 3)
}

/** 河岸、擋土牆：大小不一的石塊，縫凹進去，越下面水漬和青苔越重 */
const paintStone: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#4c4a44', 0, 0, w, h)
  fill(l.h, gray(0.12), 0, 0, w, h)
  const rows = 8
  const rh = h / rows
  for (let y = 0; y < rows; y++) {
    const widths: number[] = []
    let sum = 0
    while (sum < w - 40) {
      const bw = 44 + rand() * 60
      widths.push(bw)
      sum += bw
    }
    widths.push(w - sum)
    let x = 0
    for (const bw of widths) {
      const v = 112 + Math.floor(rand() * 46)
      const warm = rand() * 10
      fill(l.c, `rgb(${v + warm},${v - 3},${v - 12})`, x + 2, y * rh + 2, bw - 4, rh - 4)
      fill(l.c, 'rgba(255,255,255,0.1)', x + 2, y * rh + 2, bw - 4, 2)
      fill(l.h, gray(0.6 + rand() * 0.3), x + 3.5, y * rh + 3.5, bw - 7, rh - 7)
      x += bw
    }
  }
  speckle(l, rand, 7000, 70, 180, 0.28, 2.4, 0.14)
  const g = l.c.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(0.55, 'rgba(36,48,30,0.12)')
  g.addColorStop(0.85, 'rgba(30,48,28,0.5)')
  g.addColorStop(1, 'rgba(20,34,24,0.72)')
  l.c.fillStyle = g
  l.c.fillRect(0, 0, w, h)
  for (let i = 0; i < 18; i++) streak(l.c, rand() * w, rand() * h * 0.5, 4 + rand() * 12, 80 + rand() * 180, `rgba(28,34,24,${0.12 + rand() * 0.16})`)
}

// ---------- 外牆（邏輯座標 1 公尺 100 單位，一格 12 × 13.2 公尺：四個開間、四層樓） ----------

const BAYS = 4
const FLOORS = 4

/** 一扇窗：凹進去的玻璃（亮的、會反光），發光那一層畫成白色（哪幾扇開燈由著色器照格子決定） */
function windowPane(l: Layers, x: number, y: number, w: number, h: number, glass: string, rough = 0.12, metal = 0.55) {
  fill(l.c, glass, x, y, w, h)
  // 玻璃上半反射著天空
  const g = l.c.createLinearGradient(0, y, 0, y + h)
  g.addColorStop(0, 'rgba(190,214,236,0.3)')
  g.addColorStop(0.6, 'rgba(190,214,236,0.04)')
  g.addColorStop(1, 'rgba(0,0,0,0.12)')
  l.c.fillStyle = g
  l.c.fillRect(x, y, w, h)
  fill(l.h, gray(0.18), x, y, w, h)
  fill(l.o, ormStyle(rough, metal), x, y, w, h)
  interior(l.e, x, y, w, h)
}

/**
 * 開著燈的窗戶裡面看起來的樣子（畫在發光那一層）：天花板的燈最亮，往下暗下來，窗邊一截窗簾、底下一排家具的影子。
 * 現在整座城市停電，沒有任何材質開發光那一層（`emissive`），`e` 都是 null，這裡不會畫東西
 */
function interior(e: Ctx | null, x: number, y: number, w: number, h: number) {
  if (!e) return
  const g = e.createLinearGradient(0, y, 0, y + h)
  g.addColorStop(0, '#ffffff')
  g.addColorStop(0.16, '#d8d8d8')
  g.addColorStop(0.2, '#8f8f8f')
  g.addColorStop(1, '#4c4c4c')
  e.fillStyle = g
  e.fillRect(x, y, w, h)
  // 窗簾、柱子的影子
  fill(e, 'rgba(0,0,0,0.45)', x, y, w * 0.12, h)
  fill(e, 'rgba(0,0,0,0.3)', x + w * 0.62, y + h * 0.2, w * 0.06, h * 0.8)
  // 桌子、櫃子
  fill(e, 'rgba(0,0,0,0.55)', x + w * 0.2, y + h * 0.72, w * 0.3, h * 0.28)
  fill(e, 'rgba(0,0,0,0.4)', x + w * 0.72, y + h * 0.6, w * 0.2, h * 0.4)
}

/** 紅磚：一塊塊的磚、凹下去的灰縫 */
function brickWall(l: Layers, rand: () => number, x0: number, y0: number, w: number, h: number) {
  fill(l.c, '#8f887c', x0, y0, w, h)
  fill(l.h, gray(0.3), x0, y0, w, h)
  const bh = 11
  const bw = 30
  for (let y = y0, row = 0; y < y0 + h; y += bh, row++) {
    for (let x = x0 + (row % 2 ? -bw / 2 : 0); x < x0 + w; x += bw) {
      const v = rand()
      const dark = rand() < 0.08 ? 0.72 : 1
      fill(l.c, `rgb(${Math.floor((126 + v * 44) * dark)},${Math.floor((58 + v * 22) * dark)},${Math.floor((42 + v * 16) * dark)})`, x + 1.2, y + 1.2, bw - 2.4, bh - 2.4)
      fill(l.h, gray(0.6 + v * 0.14), x + 2, y + 2, bw - 4, bh - 4)
    }
  }
}

/** 紅磚街屋：磚牆、白色的石窗框和窗台，每層一條腰帶 */
const paintBrick: Paint = (l, rand) => {
  const { w, ht: h } = l
  brickWall(l, rand, 0, 0, w, h)
  blotches(l.c, w, h, rand, 14, 80, 240, (a) => `rgba(40,24,18,${a})`, 0.2)
  const bw = w / BAYS
  const fh = h / FLOORS
  for (let f = 0; f < FLOORS; f++) {
    for (let b = 0; b < BAYS; b++) {
      const x = b * bw + bw * 0.25
      const y = f * fh + fh * 0.2
      const ww = bw * 0.5
      const wh = fh * 0.56
      // 石窗框（凸出來）
      fill(l.c, '#d9d2c4', x - 9, y - 12, ww + 18, wh + 21)
      fill(l.h, gray(0.82), x - 9, y - 12, ww + 18, wh + 21)
      fill(l.o, ormStyle(0.8, 0), x - 9, y - 12, ww + 18, wh + 21)
      windowPane(l, x, y, ww, wh, rand() < 0.2 ? '#59636d' : '#2c353e')
      // 窗櫺
      fill(l.c, '#e6e0d4', x + ww / 2 - 2.5, y, 5, wh)
      fill(l.c, '#e6e0d4', x, y + wh * 0.38, ww, 4)
      fill(l.h, gray(0.7), x + ww / 2 - 2.5, y, 5, wh)
      fill(l.e, '#000', x + ww / 2 - 2.5, y, 5, wh)
      fill(l.e, '#000', x, y + wh * 0.38, ww, 4)
      // 窗台和底下的水漬
      fill(l.c, '#cfc7b8', x - 14, y + wh + 9, ww + 28, 9)
      fill(l.h, gray(0.95), x - 14, y + wh + 9, ww + 28, 9)
      fill(l.c, 'rgba(0,0,0,0.3)', x - 14, y + wh + 18, ww + 28, 5)
      for (let k = 0; k < 3; k++) streak(l.c, x - 10 + rand() * (ww + 10), y + wh + 20, 4 + rand() * 6, 30 + rand() * 50, `rgba(30,18,14,${0.15 + rand() * 0.15})`)
    }
    // 腰帶
    fill(l.c, '#c9bfae', 0, f * fh + fh - 9, w, 9)
    fill(l.h, gray(0.9), 0, f * fh + fh - 9, w, 9)
    fill(l.c, 'rgba(0,0,0,0.25)', 0, f * fh, w, 4)
  }
}

/** 辦公大樓：預鑄的外牆板，橫向的帶狀窗 */
const paintOffice: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#d8d4cb', 0, 0, w, h)
  blotches(l.c, w, h, rand, 12, 80, 260, (a) => `rgba(90,86,78,${a})`, 0.12)
  speckle(l, rand, 5000, 150, 235, 0.25, 4)
  const bw = w / BAYS
  const fh = h / FLOORS
  for (let f = 0; f < FLOORS; f++) {
    const y = f * fh + fh * 0.2
    const wh = fh * 0.52
    // 窗帶的深色框
    fill(l.c, '#3f444a', 0, y - 6, w, wh + 12)
    fill(l.h, gray(0.3), 0, y - 6, w, wh + 12)
    for (let b = 0; b < BAYS; b++) {
      const x = b * bw + 14
      const ww = bw - 28
      const roll = rand()
      windowPane(l, x, y, ww, wh, roll < 0.22 ? '#7d868d' : '#2b3742')
      // 百葉窗拉下來一半
      if (roll > 0.7) {
        const bl = wh * (0.25 + rand() * 0.5)
        fill(l.c, 'rgba(206,202,190,0.75)', x, y, ww, bl)
        for (let s = 0; s < bl; s += 6) fill(l.c, 'rgba(0,0,0,0.12)', x, y + s, ww, 1.5)
        fill(l.o, ormStyle(0.7, 0), x, y, ww, bl)
      }
      fill(l.c, '#3f444a', x + ww / 2 - 3, y, 6, wh)
      fill(l.e, '#000', x + ww / 2 - 3, y, 6, wh)
      fill(l.h, gray(0.4), x + ww / 2 - 3, y, 6, wh)
    }
    // 牆板的接縫和水漬
    fill(l.c, 'rgba(60,58,54,0.5)', 0, f * fh, w, 3)
    fill(l.h, gray(0.1), 0, f * fh - 2, w, 5)
    for (let b = 0; b < BAYS; b++) {
      fill(l.c, 'rgba(60,58,54,0.4)', b * bw - 1.5, f * fh, 3, fh * 0.2 - 6)
      fill(l.c, 'rgba(60,58,54,0.4)', b * bw - 1.5, y + wh + 6, 3, fh - (fh * 0.72 + 6))
      for (let k = 0; k < 2; k++) streak(l.c, b * bw + rand() * bw, y + wh + 6, 5 + rand() * 10, 20 + rand() * 50, `rgba(70,66,58,${0.1 + rand() * 0.12})`)
    }
  }
}

/** 公寓：磁磚牆、鐵窗、陽台、冷氣機和曬的衣服 */
const paintApartment: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#cfc7b8', 0, 0, w, h)
  // 小磁磚
  for (let y = 0; y < h; y += 12) fill(l.c, `rgba(0,0,0,${0.04 + rand() * 0.05})`, 0, y, w, 1.5)
  for (let x = 0; x < w; x += 24) fill(l.c, 'rgba(0,0,0,0.04)', x, 0, 1.5, h)
  blotches(l.c, w, h, rand, 14, 80, 240, (a) => `rgba(80,72,60,${a})`, 0.14)
  const bw = w / BAYS
  const fh = h / FLOORS
  for (let f = 0; f < FLOORS; f++) {
    for (let b = 0; b < BAYS; b++) {
      const x = b * bw + bw * 0.12
      const y = f * fh + fh * 0.16
      const ww = bw * 0.76
      const wh = fh * 0.5
      fill(l.c, '#5b5f63', x - 5, y - 5, ww + 10, wh + 10)
      fill(l.h, gray(0.4), x - 5, y - 5, ww + 10, wh + 10)
      windowPane(l, x, y, ww, wh, rand() < 0.3 ? '#6e7068' : '#2f373f', 0.2, 0.4)
      // 窗簾
      if (rand() < 0.4) fill(l.c, `rgba(${180 + Math.floor(rand() * 50)},${170 + Math.floor(rand() * 40)},${150 + Math.floor(rand() * 40)},0.7)`, x, y, ww * (0.25 + rand() * 0.3), wh)
      // 鐵窗
      l.c.strokeStyle = 'rgba(58,60,62,0.9)'
      l.c.lineWidth = 2.5
      for (let k = 1; k < 7; k++) {
        l.c.beginPath()
        l.c.moveTo(x + (ww * k) / 7, y)
        l.c.lineTo(x + (ww * k) / 7, y + wh)
        l.c.stroke()
      }
      fill(l.c, 'rgba(58,60,62,0.9)', x, y + wh * 0.5, ww, 3)
      for (let k = 1; k < 7; k++) fill(l.e, 'rgba(0,0,0,0.6)', x + (ww * k) / 7 - 1.5, y, 3, wh)
      // 陽台的欄杆牆（凸出來）
      fill(l.c, '#b9b1a2', x - 14, y + wh + 12, ww + 28, fh * 0.2)
      fill(l.h, gray(0.9), x - 14, y + wh + 12, ww + 28, fh * 0.2)
      fill(l.c, 'rgba(0,0,0,0.3)', x - 14, y + wh + 12 + fh * 0.2, ww + 28, 6)
      // 冷氣機
      if (rand() < 0.55) {
        const ax = x + ww * (rand() < 0.5 ? 0.04 : 0.66)
        fill(l.c, '#e4e2dc', ax, y + wh + 16, ww * 0.3, fh * 0.14)
        fill(l.c, '#8f9296', ax + 5, y + wh + 21, ww * 0.3 - 10, fh * 0.14 - 10)
        fill(l.h, gray(1), ax, y + wh + 16, ww * 0.3, fh * 0.14)
        streak(l.c, ax + ww * 0.1, y + wh + 16 + fh * 0.14, 6, 50 + rand() * 40, 'rgba(60,50,40,0.3)')
      }
      // 曬衣服
      if (rand() < 0.1) {
        for (let k = 0; k < 3; k++) {
          fill(l.c, ['#7d5a54', '#55606e', '#8f8c84', '#857a5a', '#5a6a5c'][Math.floor(rand() * 5)], x + 10 + k * ww * 0.28, y + 6, ww * 0.2, wh * (0.2 + rand() * 0.2))
        }
      }
    }
    fill(l.c, 'rgba(0,0,0,0.22)', 0, f * fh + fh - 5, w, 5)
  }
}

/** 玻璃帷幕：整片深色的玻璃、鋁框，每層樓一條層間板 */
const paintGlass: Paint = (l, rand) => {
  const { w, ht: h } = l
  const bw = w / BAYS
  const fh = h / FLOORS
  for (let f = 0; f < FLOORS; f++) {
    for (let b = 0; b < BAYS; b++) {
      const v = 30 + Math.floor(rand() * 26)
      fill(l.c, `rgb(${v},${v + 14},${v + 28})`, b * bw, f * fh, bw, fh)
      const g = l.c.createLinearGradient(0, f * fh, 0, (f + 1) * fh)
      g.addColorStop(0, 'rgba(150,186,220,0.26)')
      g.addColorStop(1, 'rgba(0,0,0,0.1)')
      l.c.fillStyle = g
      l.c.fillRect(b * bw, f * fh, bw, fh)
      interior(l.e, b * bw, f * fh + fh * 0.24, bw, fh * 0.76)
      // 每片玻璃角度差一點點，反光才不會整面一樣
      fill(l.h, gray(0.46 + rand() * 0.08), b * bw, f * fh, bw, fh)
    }
    // 層間板（不透明）
    fill(l.c, 'rgba(26,34,44,0.75)', 0, f * fh, w, fh * 0.22)
    fill(l.o, ormStyle(0.3, 0.7), 0, f * fh, w, fh * 0.22)
  }
  for (let b = 0; b <= BAYS; b++) {
    fill(l.c, '#262a30', b * bw - 4, 0, 8, h)
    fill(l.h, gray(0.95), b * bw - 4, 0, 8, h)
    fill(l.e, '#000', b * bw - 4, 0, 8, h)
    fill(l.o, ormStyle(0.55, 0.6), b * bw - 4, 0, 8, h)
  }
  for (let f = 0; f <= FLOORS; f++) {
    fill(l.c, '#3a4048', 0, f * fh - 5, w, 10)
    fill(l.h, gray(0.95), 0, f * fh - 5, w, 10)
    fill(l.e, '#000', 0, f * fh - 5, w, 10)
    fill(l.o, ormStyle(0.55, 0.6), 0, f * fh - 5, w, 10)
  }
}

/** 招牌上寫的字（一樓店面） */
const SHOP_NAMES = ['牛肉麵', '珍珠奶茶', '機車行', '五金行', '藥局', '早餐店', '便當', '水果', '眼鏡', '鎖印', '自助餐', '書局', '理髮', '洗衣', '手機配件', '滷味', '檳榔', '彩券', '豆漿', '鹹酥雞', '鐘錶', '茶行']
const SIGN_COLORS: [string, string][] = [
  ['#b3261e', '#fff4d6'],
  ['#1f5fa8', '#ffffff'],
  ['#1f7a3d', '#fff9c4'],
  ['#e8b021', '#3a1d0a'],
  ['#f2efe6', '#b3261e'],
  ['#5b2a86', '#ffe9a8'],
  ['#0f6e6a', '#ffffff'],
  ['#d9541e', '#fff4d6'],
  ['#22262b', '#f5c542'],
]
const SIGN_FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", sans-serif'

/** 把顏色洗舊：往灰的靠（`keep` 是留下多少彩度）、再暗一點 */
function faded(hex: string, keep: number, dark: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const m = (ch[0] + ch[1] + ch[2]) / 3
  const [r, g, b] = ch.map((v) => Math.round((m + (v - m) * keep) * dark))
  return `rgb(${r},${g},${b})`
}

/** 噴在鐵捲門、木板上的字 */
const SPRAY = ['禁入', '有人嗎', 'SOS', '撤', '危', '✕', '快逃', '封鎖', '07', '→ 避難所', '此路不通']

/** 在 (x, y) 開始、寬 w 高 h 的範圍裡噴一個字：歪歪的、顏色不勻 */
function spray(ctx: Ctx, rand: () => number, x: number, y: number, w: number, h: number) {
  const word = SPRAY[Math.floor(rand() * SPRAY.length)]
  const size = Math.min(h * 0.55, (w / Math.max(2, word.length)) * 1.1)
  ctx.save()
  ctx.translate(x + w / 2, y + h * (0.35 + rand() * 0.3))
  ctx.rotate((rand() - 0.5) * 0.24)
  ctx.font = `900 ${size}px ${SIGN_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const color = ['214,208,196', '150,32,26', '18,18,20', '214,208,196'][Math.floor(rand() * 4)]
  // 先噴一層淡的暈開，再噴實的
  ctx.fillStyle = `rgba(${color},0.22)`
  for (const [ox, oy] of [
    [-2, 0],
    [2, 0],
    [0, -2],
    [0, 3],
  ]) {
    ctx.fillText(word, ox, oy, w)
  }
  ctx.fillStyle = `rgba(${color},${0.6 + rand() * 0.25})`
  ctx.fillText(word, 0, 0, w)
  ctx.restore()
}

/**
 * 一樓店面（一格 24 × 5 公尺、八間）：停電很久了。招牌褪色、積灰，有幾塊面板掉了；
 * 一半拉下鐵捲門（生鏽、被撞凹、噴了字），其他的玻璃被砸破、裡面一片黑，或是釘上木板
 */
const paintShops: Paint = (l, rand) => {
  const { w, ht: h } = l
  fill(l.c, '#8f887d', 0, 0, w, h)
  speckle(l, rand, 4000, 90, 170, 0.22, 5)
  blotches(l.c, w, h, rand, 18, 60, 200, (a) => `rgba(40,34,28,${a})`, 0.22)
  const bays = 8
  const bw = w / bays
  const top = h * 0.3
  for (let b = 0; b < bays; b++) {
    const x = b * bw
    const [bg, fg] = SIGN_COLORS[Math.floor(rand() * SIGN_COLORS.length)]
    // 招牌燈箱
    fill(l.c, '#232527', x + 10, h * 0.045, bw - 20, h * 0.215)
    fill(l.h, gray(1), x + 10, h * 0.045, bw - 20, h * 0.215)
    if (rand() < 0.7) {
      fill(l.c, faded(bg, 0.45, 0.6), x + 14, h * 0.055, bw - 28, h * 0.195)
      fill(l.o, ormStyle(0.6, 0), x + 14, h * 0.055, bw - 28, h * 0.195)
      const name = SHOP_NAMES[Math.floor(rand() * SHOP_NAMES.length)]
      const size = Math.min(h * 0.14, (bw - 50) / name.length)
      l.c.fillStyle = faded(fg, 0.5, 0.68)
      l.c.font = `900 ${size}px ${SIGN_FONT}`
      l.c.textAlign = 'center'
      l.c.textBaseline = 'middle'
      l.c.fillText(name, x + bw / 2, h * 0.155, bw - 40)
      // 往下流的髒水
      for (let k = 0; k < 5; k++) streak(l.c, x + 16 + rand() * (bw - 44), h * 0.055, 4 + rand() * 12, 30 + rand() * 60, `rgba(30,26,22,${0.2 + rand() * 0.25})`)
    } else {
      // 面板掉了：裡面黑黑的，看得到幾根燈管，還掛著的一角
      fill(l.c, '#0e0f10', x + 14, h * 0.055, bw - 28, h * 0.195)
      fill(l.h, gray(0.25), x + 14, h * 0.055, bw - 28, h * 0.195)
      for (let k = 0; k < 3; k++) fill(l.c, 'rgba(150,150,140,0.5)', x + 22, h * (0.085 + k * 0.06), bw - 44, 3)
      l.c.fillStyle = faded(bg, 0.45, 0.58)
      l.c.beginPath()
      l.c.moveTo(x + 14, h * 0.055)
      l.c.lineTo(x + 14 + (bw - 28) * (0.25 + rand() * 0.3), h * 0.055)
      l.c.lineTo(x + 14 + (bw - 28) * 0.1, h * 0.25)
      l.c.lineTo(x + 14, h * 0.25)
      l.c.fill()
    }
    const roll = rand()
    const y0 = top + 14
    const sx = x + 16
    const sw = bw - 32
    if (roll < 0.5) {
      // 鐵捲門拉下來：生鏽、被撞凹，有的噴了字
      fill(l.c, '#6c6e72', sx, y0, sw, h - y0)
      for (let y = y0; y < h; y += 9) {
        fill(l.c, 'rgba(0,0,0,0.3)', sx, y, sw, 2.5)
        fill(l.h, gray(0.25), sx, y, sw, 3)
      }
      fill(l.o, ormStyle(0.6, 0.5), sx, y0, sw, h - y0)
      for (let k = 0; k < 7; k++) streak(l.c, sx + 4 + rand() * (sw - 20), y0 + rand() * 120, 6 + rand() * 18, 60 + rand() * 160, `rgba(96,50,22,${0.25 + rand() * 0.3})`)
      for (let k = 0; k < 3; k++) {
        const dx = sx + 20 + rand() * (sw - 40)
        const dy = y0 + 30 + rand() * (h - y0 - 60)
        const dr = 14 + rand() * 26
        for (const ctx of [l.c, l.h]) {
          if (!ctx) continue
          const g = ctx.createRadialGradient(dx, dy, 0, dx, dy, dr)
          g.addColorStop(0, ctx === l.c ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.6)')
          g.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.fillStyle = g
          ctx.fillRect(dx - dr, dy - dr, dr * 2, dr * 2)
        }
      }
      if (rand() < 0.55) spray(l.c, rand, sx + 10, y0 + 30, sw - 20, h - y0 - 70)
    } else if (roll < 0.8) {
      // 玻璃被砸破的店面：裡面一片黑，地上翻倒的貨架，框上還剩幾片碎玻璃
      const g = l.c.createLinearGradient(0, y0, 0, h)
      g.addColorStop(0, '#15171a')
      g.addColorStop(1, '#060707')
      l.c.fillStyle = g
      l.c.fillRect(sx, y0, sw, h - y0)
      fill(l.o, ormStyle(1, 0), sx, y0, sw, h - y0)
      fill(l.h, gray(0.12), sx, y0, sw, h - y0)
      for (let k = 0; k < 7; k++) {
        const v = 34 + Math.floor(rand() * 34)
        fill(l.c, `rgba(${v + 8},${v + 2},${v - 6},0.85)`, sx + 6 + rand() * (sw - 80), h - 14 - rand() * 80, 20 + rand() * 60, 8 + rand() * 36)
      }
      for (let k = 0; k < 12; k++) {
        // 從框邊往裡面伸的一片尖尖的玻璃
        const side = Math.floor(rand() * 3)
        const t = rand()
        const len = 14 + rand() * 46
        const half = 5 + rand() * 14
        const bx = side === 0 ? sx : side === 1 ? sx + sw : sx + t * sw
        const by = side === 2 ? y0 : y0 + t * (h - y0)
        const tx = side === 0 ? bx + len : side === 1 ? bx - len : bx + (rand() - 0.5) * 20
        const ty = side === 2 ? by + len : by + (rand() - 0.5) * 20
        for (const ctx of [l.c, l.o]) {
          if (!ctx) continue
          ctx.fillStyle = ctx === l.c ? 'rgba(126,146,156,0.4)' : ormStyle(0.12, 0.4)
          ctx.beginPath()
          ctx.moveTo(side === 2 ? bx - half : bx, side === 2 ? by : by - half)
          ctx.lineTo(side === 2 ? bx + half : bx, side === 2 ? by : by + half)
          ctx.lineTo(tx, ty)
          ctx.fill()
        }
      }
      for (const fx of [sx, x + bw / 2 - 3, sx + sw - 6]) {
        fill(l.c, '#2a2c2f', fx, y0, 6, h - y0)
        fill(l.h, gray(0.7), fx, y0, 6, h - y0)
      }
    } else {
      // 釘上木板：一片一片長短不齊，縫裡黑黑的
      fill(l.c, '#0c0c0c', sx, y0, sw, h - y0)
      fill(l.o, ormStyle(0.9, 0), sx, y0, sw, h - y0)
      const ph = 34
      for (let y = y0; y < h; y += ph) {
        const v = 0.7 + rand() * 0.5
        const inset = rand() * 10
        fill(l.c, `rgb(${Math.round(84 * v)},${Math.round(66 * v)},${Math.round(44 * v)})`, sx + inset, y + 1.5, sw - inset - rand() * 10, ph - 3)
        fill(l.h, gray(0.75), sx + inset, y + 2.5, sw - 20, ph - 5)
        for (let k = 0; k < 6; k++) fill(l.c, 'rgba(30,22,14,0.3)', sx + rand() * sw, y + 3 + rand() * (ph - 8), 20 + rand() * 60, 1.5)
        for (const nx of [sx + 12, sx + sw - 16]) fill(l.c, 'rgba(20,20,20,0.8)', nx, y + ph / 2 - 2, 4, 4)
      }
      if (rand() < 0.5) spray(l.c, rand, sx + 10, y0 + 30, sw - 20, h - y0 - 70)
    }
    // 雨遮：褪色、下緣破破爛爛
    if (rand() < 0.45) {
      const col = faded(['#a8322a', '#2f5d8f', '#2f7d4f', '#c98a1e'][Math.floor(rand() * 4)], 0.5, 0.7)
      for (let k = 0; k < bw - 20; k += 20) {
        if (rand() < 0.15) continue
        fill(l.c, k % 40 ? '#a39d90' : col, x + 10 + k, top - 4, 20, 10 + rand() * 16)
      }
      fill(l.h, gray(1), x + 10, top - 4, bw - 20, 10)
    }
    // 兩間中間的柱子
    fill(l.c, '#7f786d', x - 8, top, 16, h - top)
    fill(l.h, gray(0.85), x - 8, top, 16, h - top)
  }
  fill(l.c, '#7f786d', w - 8, top, 8, h - top)
  // 牆腳的髒污
  const g = l.c.createLinearGradient(0, h * 0.72, 0, h)
  g.addColorStop(0, 'rgba(30,26,22,0)')
  g.addColorStop(1, 'rgba(30,26,22,0.6)')
  l.c.fillStyle = g
  l.c.fillRect(0, h * 0.72, w, h * 0.28)
}

/** 掛在外牆上的直式招牌（一張圖八塊，一塊 1.2 × 4.8 公尺） */
const SIGN_WORDS = ['牛肉麵', '當舖', '旅社', '卡拉OK', '藥局', '診所', '補習班', '網咖', '按摩', '麻辣鍋', '機車行', '燒烤', '茶行', '火鍋', '銀樓', '撞球']
export const SIGN_COUNT = 8
const paintSigns: Paint = (l, rand) => {
  const { w, ht: h } = l
  const sw = w / SIGN_COUNT
  for (let i = 0; i < SIGN_COUNT; i++) {
    const [bg, fg] = SIGN_COLORS[(i * 4 + Math.floor(rand() * 3)) % SIGN_COLORS.length]
    fill(l.c, '#1f2124', i * sw, 0, sw, h)
    fill(l.c, faded(bg, 0.5, 0.62), i * sw + 6, 6, sw - 12, h - 12)
    const word = SIGN_WORDS[(i * 5 + Math.floor(rand() * SIGN_WORDS.length)) % SIGN_WORDS.length]
    const chars = [...word.replace('OK', 'Ｋ')]
    const size = Math.min(sw - 26, (h - 40) / chars.length - 6)
    l.c.fillStyle = faded(fg, 0.55, 0.72)
    l.c.font = `900 ${size}px ${SIGN_FONT}`
    l.c.textAlign = 'center'
    l.c.textBaseline = 'middle'
    const step = (h - 30) / chars.length
    chars.forEach((ch, k) => l.c.fillText(ch, i * sw + sw / 2, 15 + step * (k + 0.5), sw - 20))
    // 往下流的髒水、破掉的一角
    for (let k = 0; k < 4; k++) streak(l.c, i * sw + 8 + rand() * (sw - 24), 6 + rand() * h * 0.5, 4 + rand() * 9, 50 + rand() * 140, `rgba(26,22,18,${0.22 + rand() * 0.25})`)
    if (rand() < 0.5) {
      const y = rand() < 0.5 ? 6 : h - 6 - h * 0.22
      fill(l.c, '#0d0e0f', i * sw + 6, y, sw - 12, h * (0.1 + rand() * 0.12))
    }
  }
}

/** 水面的高低：幾層接得起來的波紋，算成法線貼圖 */
function waterNormal(size: number, seed: number): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const rand = rng(seed)
  // 一堆方向、波長不同的正弦波（波數都是整數，上下左右才接得起來）
  const waves = Array.from({ length: 22 }, (_, i) => {
    const k = 2 + Math.floor(rand() * (3 + i * 0.9))
    const a = rand() * Math.PI * 2
    return { kx: Math.round(Math.cos(a) * k), ky: Math.round(Math.sin(a) * k) || 1, ph: rand() * Math.PI * 2, amp: 1 / (1 + k * 0.35) }
  })
  const total = waves.reduce((s, v) => s + v.amp, 0)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0
      for (const wv of waves) v += Math.sin(((x * wv.kx + y * wv.ky) / size) * Math.PI * 2 + wv.ph) * wv.amp
      const g = (v / total) * 0.5 + 0.5
      const i = (y * size + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g * 255
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return normalFromHeight(ctx, 9)
}

export type WorldTextures = {
  asphalt: Surface
  pavers: Surface
  grass: Surface
  concrete: Surface
  plaza: Surface
  dirt: Surface
  roof: Surface
  corrugated: Surface
  blast: Surface
  stone: Surface
  brick: Surface
  office: Surface
  apartment: Surface
  glass: Surface
  shops: Surface
  signs: Surface
  waterNormal: CanvasTexture
}

/** 畫出所有貼圖；`small` 是手機：解析度砍半 */
export function createTextures(small: boolean): WorldTextures {
  const k = small ? 0.5 : 1
  const s = (n: number) => Math.round(n * k)
  const facade = (seed: number, paint: Paint, normal: number): Surface =>
    surface(s(1024), s(1024), seed, paint, { logical: [1200, 1320], normal, orm: true, aux: 0.5, rough: 0.88 })
  return {
    asphalt: surface(s(512), s(512), 1, paintAsphalt, { logical: [512, 512], normal: 1.6 }),
    pavers: surface(s(256), s(256), 2, paintPavers, { logical: [256, 256], normal: 2.2 }),
    grass: surface(s(512), s(512), 3, paintGrass, { logical: [512, 512], normal: 1.4 }),
    concrete: surface(s(512), s(512), 4, paintConcrete, { logical: [512, 512], normal: 1.2 }),
    plaza: surface(s(512), s(512), 5, paintPlaza, { logical: [512, 512], normal: 2 }),
    dirt: surface(s(256), s(256), 6, paintDirt, { logical: [256, 256], normal: 2.4 }),
    roof: surface(s(256), s(256), 11, paintRoof, { logical: [256, 256], normal: 1.6 }),
    corrugated: surface(s(256), s(256), 12, paintCorrugated, { logical: [256, 256], normal: 3 }),
    blast: surface(s(512), s(512), 13, paintBlast, { logical: [512, 512], normal: 1.8 }),
    stone: surface(s(512), s(512), 14, paintStone, { logical: [512, 512], normal: 2.6 }),
    brick: facade(15, paintBrick, 2.2),
    office: facade(8, paintOffice, 1.8),
    apartment: facade(9, paintApartment, 1.8),
    glass: facade(7, paintGlass, 0.5),
    shops: surface(s(2048), s(512), 10, paintShops, { logical: [2400, 500], normal: 1.6, orm: true, aux: 0.5, rough: 0.9 }),
    signs: surface(s(1024), s(512), 21, paintSigns, { logical: [960, 480] }),
    waterNormal: waterNormal(small ? 128 : 256, 16),
  }
}

export function disposeTextures(t: WorldTextures) {
  for (const v of Object.values(t)) {
    if ('isTexture' in v) (v as Texture).dispose()
    else for (const m of Object.values(v as Surface)) m?.dispose()
  }
}

/** 整張地圖一張、不重複的貼圖（地面的深淺、牆腳的陰影、焦痕）：邊緣夾住、不做色彩轉換 */
export function dataTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const tex = new CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping
  tex.anisotropy = Math.min(4, anisotropy)
  return tex
}
