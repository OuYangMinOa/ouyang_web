// 貼在地面和牆上的痕跡（和機甲身上的標誌一樣，一張圖很多格）：彈坑、焦痕、裂開的路面、油漬、散落的磚塊，
// 牆上被砲彈打出來的洞、噴漆的警告字。全部用 canvas 畫，一片一片貼在面的上面一點點（半透明，不擋東西）。
import { CanvasTexture, Color, SRGBColorSpace } from 'three'
import { rng } from '../racing/noise'
import type { Corner, Mesher } from './worldgeo'

type Ctx = CanvasRenderingContext2D
type Rand = () => number

/** 一格在圖上的範圍（貼圖座標：左、下、右、上） */
export type DecalRect = [number, number, number, number]

export type WorldDecals = {
  texture: CanvasTexture
  craters: DecalRect[]
  scorch: DecalRect
  cracks: DecalRect[]
  stains: DecalRect[]
  debris: DecalRect[]
  impacts: DecalRect[]
  signs: DecalRect[]
}

const GRID = 4
const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Heiti TC", "Arial Black", sans-serif'

/** 彈坑：中間一個燒黑的坑、坑口翻起來一圈土、往外噴的一道道、四周裂開 */
function crater(g: Ctx, rand: Rand, s: number) {
  const c = s / 2
  const soot = g.createRadialGradient(c, c, s * 0.05, c, c, s * 0.48)
  soot.addColorStop(0, 'rgba(8,7,6,0.9)')
  soot.addColorStop(0.45, 'rgba(14,12,10,0.62)')
  soot.addColorStop(1, 'rgba(20,17,14,0)')
  g.fillStyle = soot
  g.fillRect(0, 0, s, s)
  g.lineCap = 'round'
  // 往外噴的土
  for (let i = 0; i < 70; i++) {
    const a = rand() * Math.PI * 2
    const r0 = s * (0.14 + rand() * 0.06)
    const r1 = s * (0.26 + rand() * 0.2)
    const light = rand() < 0.45
    g.strokeStyle = light ? `rgba(150,138,120,${0.12 + rand() * 0.2})` : `rgba(6,5,4,${0.15 + rand() * 0.3})`
    g.lineWidth = s * (0.004 + rand() * 0.014)
    g.beginPath()
    g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0)
    g.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1)
    g.stroke()
  }
  // 坑口翻起來的一圈
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rand() * 0.2
    const r = s * (0.15 + rand() * 0.035)
    g.fillStyle = `rgba(${120 + Math.floor(rand() * 50)},${110 + Math.floor(rand() * 40)},${94 + Math.floor(rand() * 30)},${0.35 + rand() * 0.35})`
    g.beginPath()
    g.ellipse(c + Math.cos(a) * r, c + Math.sin(a) * r, s * (0.012 + rand() * 0.02), s * (0.008 + rand() * 0.012), a, 0, Math.PI * 2)
    g.fill()
  }
  const pit = g.createRadialGradient(c, c, 0, c, c, s * 0.15)
  pit.addColorStop(0, 'rgba(4,4,4,0.95)')
  pit.addColorStop(0.7, 'rgba(10,9,8,0.9)')
  pit.addColorStop(1, 'rgba(16,14,12,0.4)')
  g.fillStyle = pit
  g.beginPath()
  g.arc(c, c, s * 0.155, 0, Math.PI * 2)
  g.fill()
  // 四周的裂縫
  for (let i = 0; i < 9; i++) {
    let a = rand() * Math.PI * 2
    let x = c + Math.cos(a) * s * 0.16
    let y = c + Math.sin(a) * s * 0.16
    g.strokeStyle = `rgba(6,6,6,${0.5 + rand() * 0.3})`
    g.lineWidth = s * 0.006
    g.beginPath()
    g.moveTo(x, y)
    for (let k = 0; k < 6; k++) {
      a += (rand() - 0.5) * 0.9
      x += Math.cos(a) * s * 0.045
      y += Math.sin(a) * s * 0.045
      g.lineTo(x, y)
    }
    g.stroke()
  }
}

/** 焦痕：燒黑的一片，邊上一道道往外 */
function scorch(g: Ctx, rand: Rand, s: number) {
  const c = s / 2
  const grad = g.createRadialGradient(c, c, s * 0.02, c, c, s * 0.48)
  grad.addColorStop(0, 'rgba(8,7,6,0.88)')
  grad.addColorStop(0.5, 'rgba(14,12,10,0.6)')
  grad.addColorStop(1, 'rgba(20,16,12,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, s, s)
  g.lineCap = 'round'
  for (let i = 0; i < 50; i++) {
    const a = rand() * Math.PI * 2
    g.strokeStyle = `rgba(6,5,4,${0.15 + rand() * 0.25})`
    g.lineWidth = s * (0.006 + rand() * 0.02)
    g.beginPath()
    g.moveTo(c + Math.cos(a) * s * 0.1, c + Math.sin(a) * s * 0.1)
    g.lineTo(c + Math.cos(a) * s * (0.25 + rand() * 0.2), c + Math.sin(a) * s * (0.25 + rand() * 0.2))
    g.stroke()
  }
}

/** 裂開的路面：從中間往外裂的幾道，會分岔 */
function cracks(g: Ctx, rand: Rand, s: number) {
  const c = s / 2
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const branch = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    g.strokeStyle = `rgba(8,8,8,${0.55 - depth * 0.1})`
    g.lineWidth = w
    g.beginPath()
    g.moveTo(x, y)
    let left = len
    while (left > 0) {
      const st = s * 0.035
      a += (rand() - 0.5) * 0.8
      x += Math.cos(a) * st
      y += Math.sin(a) * st
      if (Math.hypot(x - c, y - c) > s * 0.46) break
      g.lineTo(x, y)
      left -= st
      if (depth < 2 && rand() < 0.2) {
        g.stroke()
        branch(x, y, a + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.7), len * 0.5, w * 0.7, depth + 1)
        g.strokeStyle = `rgba(8,8,8,${0.55 - depth * 0.1})`
        g.lineWidth = w
        g.beginPath()
        g.moveTo(x, y)
      }
    }
    g.stroke()
  }
  for (let i = 0; i < 6; i++) branch(c + (rand() - 0.5) * s * 0.1, c + (rand() - 0.5) * s * 0.1, (i / 6) * Math.PI * 2 + rand() * 0.6, s * 0.5, s * 0.0055, 0)
}

/** 一灘漬（油、髒水）：幾個圓疊在一起，邊緣深一點 */
function stain(g: Ctx, rand: Rand, s: number, color: string) {
  const c = s / 2
  for (let i = 0; i < 12; i++) {
    const x = c + (rand() - 0.5) * s * 0.42
    const y = c + (rand() - 0.5) * s * 0.42
    const r = s * (0.08 + rand() * 0.16)
    const grad = g.createRadialGradient(x, y, r * 0.2, x, y, r)
    grad.addColorStop(0, `rgba(${color},0.34)`)
    grad.addColorStop(0.8, `rgba(${color},0.42)`)
    grad.addColorStop(1, `rgba(${color},0)`)
    g.fillStyle = grad
    g.fillRect(x - r, y - r, r * 2, r * 2)
  }
}

/** 散在地上的磚塊、水泥碎塊（畫成平的，旁邊一點影子） */
function debris(g: Ctx, rand: Rand, s: number, brick: boolean) {
  const c = s / 2
  const dust = g.createRadialGradient(c, c, 0, c, c, s * 0.46)
  dust.addColorStop(0, brick ? 'rgba(120,84,66,0.4)' : 'rgba(132,126,114,0.4)')
  dust.addColorStop(1, 'rgba(120,110,96,0)')
  g.fillStyle = dust
  g.fillRect(0, 0, s, s)
  for (let i = 0; i < 90; i++) {
    const r = s * 0.42 * Math.sqrt(rand())
    const a = rand() * Math.PI * 2
    const x = c + Math.cos(a) * r
    const y = c + Math.sin(a) * r
    const w = s * (0.012 + rand() * 0.034)
    const h = w * (0.45 + rand() * 0.5)
    const v = 0.6 + rand() * 0.5
    g.save()
    g.translate(x, y)
    g.rotate(rand() * Math.PI)
    g.fillStyle = 'rgba(0,0,0,0.45)'
    g.fillRect(-w / 2 + s * 0.004, -h / 2 + s * 0.006, w, h)
    g.fillStyle = brick && rand() < 0.7 ? `rgb(${Math.round(128 * v)},${Math.round(62 * v)},${Math.round(46 * v)})` : `rgb(${Math.round(138 * v)},${Math.round(132 * v)},${Math.round(120 * v)})`
    g.fillRect(-w / 2, -h / 2, w, h)
    g.restore()
  }
}

/** 牆上被砲彈打出來的洞：不規則的黑洞、洞口崩掉一圈（露出淺色的斷面）、四周的裂縫、往上燻黑的一道 */
function impact(g: Ctx, rand: Rand, s: number) {
  const c = s / 2
  // 往上的煤煙（畫布的上面是貼圖的上面）
  const soot = g.createLinearGradient(0, c, 0, s * 0.02)
  soot.addColorStop(0, 'rgba(10,9,8,0.7)')
  soot.addColorStop(1, 'rgba(10,9,8,0)')
  g.fillStyle = soot
  g.beginPath()
  g.moveTo(c - s * 0.16, c)
  g.quadraticCurveTo(c - s * 0.24, s * 0.2, c - s * 0.1, s * 0.03)
  g.lineTo(c + s * 0.12, s * 0.03)
  g.quadraticCurveTo(c + s * 0.25, s * 0.2, c + s * 0.16, c)
  g.fill()
  const blob = (r0: number, jitter: number, fill: string) => {
    g.fillStyle = fill
    g.beginPath()
    const n = 18
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2
      const r = s * r0 * (1 + (rand() - 0.5) * jitter)
      const x = c + Math.cos(a) * r
      const y = c + Math.sin(a) * r * 0.9
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    }
    g.closePath()
    g.fill()
  }
  blob(0.3, 0.3, 'rgba(24,21,18,0.5)')
  blob(0.24, 0.35, 'rgba(150,142,128,0.85)')
  blob(0.2, 0.4, 'rgba(96,88,78,0.92)')
  blob(0.14, 0.45, 'rgba(6,6,6,0.97)')
  g.lineCap = 'round'
  for (let i = 0; i < 8; i++) {
    let a = rand() * Math.PI * 2
    let x = c + Math.cos(a) * s * 0.24
    let y = c + Math.sin(a) * s * 0.22
    g.strokeStyle = `rgba(8,8,8,${0.5 + rand() * 0.3})`
    g.lineWidth = s * 0.006
    g.beginPath()
    g.moveTo(x, y)
    for (let k = 0; k < 5; k++) {
      a += (rand() - 0.5) * 0.9
      x += Math.cos(a) * s * 0.04
      y += Math.sin(a) * s * 0.04
      g.lineTo(x, y)
    }
    g.stroke()
  }
}

/** 噴漆的字：顏色不勻、邊上暈開 */
function sprayed(g: Ctx, rand: Rand, s: number, lines: string[], color: string, mark = false) {
  const c = s / 2
  g.save()
  g.translate(c, c)
  g.rotate((rand() - 0.5) * 0.14)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  if (mark) {
    // 搜救隊留下的記號：一個圈、一個叉
    g.strokeStyle = `rgba(${color},0.8)`
    g.lineWidth = s * 0.045
    g.lineCap = 'round'
    g.beginPath()
    g.arc(0, 0, s * 0.34, 0.2, Math.PI * 2 - 0.1)
    g.stroke()
    g.beginPath()
    g.moveTo(-s * 0.22, -s * 0.22)
    g.lineTo(s * 0.2, s * 0.22)
    g.moveTo(s * 0.22, -s * 0.2)
    g.lineTo(-s * 0.2, s * 0.22)
    g.stroke()
  }
  const size = Math.min((s * 0.8) / Math.max(...lines.map((l) => l.length)), (s * 0.62) / lines.length)
  g.font = `900 ${size}px ${FONT}`
  lines.forEach((line, i) => {
    const y = (i - (lines.length - 1) / 2) * size * 1.12
    g.fillStyle = `rgba(${color},0.2)`
    for (const [ox, oy] of [
      [-3, 0],
      [3, 0],
      [0, -3],
      [0, 4],
    ]) {
      g.fillText(line, ox, y + oy, s * 0.86)
    }
    g.fillStyle = `rgba(${color},0.82)`
    g.fillText(line, 0, y, s * 0.86)
  })
  // 往下流的漆
  for (let i = 0; i < 5; i++) {
    const x = (rand() - 0.5) * s * 0.6
    g.fillStyle = `rgba(${color},0.5)`
    g.fillRect(x, size * 0.3, s * 0.008, s * (0.04 + rand() * 0.1))
  }
  g.restore()
}

/** 畫出那張圖（`small` 是手機：解析度砍半） */
export function createWorldDecals(small: boolean, anisotropy: number): WorldDecals {
  const size = small ? 1024 : 2048
  const cell = size / GRID
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const rand = rng(31337)
  let next = 0
  /** 畫下一格（每一格四周留一圈空的，縮小時才不會吃到隔壁），回傳它在圖上的範圍 */
  const draw = (paint: (s: number) => void): DecalRect => {
    const col = next % GRID
    const row = Math.floor(next / GRID)
    next++
    const pad = cell * 0.03
    g.save()
    g.beginPath()
    g.rect(col * cell + pad, row * cell + pad, cell - pad * 2, cell - pad * 2)
    g.clip()
    g.translate(col * cell + pad, row * cell + pad)
    paint(cell - pad * 2)
    g.restore()
    // 畫布的 y 往下、貼圖的 v 往上
    return [(col * cell + pad) / size, 1 - ((row + 1) * cell - pad) / size, ((col + 1) * cell - pad) / size, 1 - (row * cell + pad) / size]
  }
  const white = '214,208,196'
  const red = '150,30,24'
  const orange = '214,112,20'
  const out: WorldDecals = {
    texture: null as unknown as CanvasTexture,
    craters: [draw((s) => crater(g, rand, s)), draw((s) => crater(g, rand, s)), draw((s) => crater(g, rand, s))],
    scorch: draw((s) => scorch(g, rand, s)),
    cracks: [draw((s) => cracks(g, rand, s)), draw((s) => cracks(g, rand, s))],
    stains: [draw((s) => stain(g, rand, s, '8,8,9')), draw((s) => stain(g, rand, s, '58,30,14'))],
    debris: [draw((s) => debris(g, rand, s, true)), draw((s) => debris(g, rand, s, false))],
    impacts: [draw((s) => impact(g, rand, s)), draw((s) => impact(g, rand, s))],
    signs: [
      draw((s) => sprayed(g, rand, s, ['禁區', '勿入'], red)),
      draw((s) => sprayed(g, rand, s, ['避難所', '→'], white)),
      draw((s) => sprayed(g, rand, s, ['危險'], white)),
      draw((s) => sprayed(g, rand, s, [], orange, true)),
    ],
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = Math.min(4, anisotropy)
  out.texture = texture
  return out
}

const tint = new Color(0xffffff)

/** 平貼在地上（高度 y）的一片：中心 (x, z)、邊長 `size`、轉 `turn` */
export function groundDecal(m: Mesher, rect: DecalRect, x: number, y: number, z: number, size: number, turn: number) {
  const h = size / 2
  const cs = Math.cos(turn) * h
  const sn = Math.sin(turn) * h
  const at = (u: number, v: number, tu: number, tv: number): Corner => [x + u * cs - v * sn, y, z + u * sn + v * cs, tu, tv]
  m.face(at(-1, 1, rect[0], rect[1]), at(1, 1, rect[2], rect[1]), at(1, -1, rect[2], rect[3]), at(-1, -1, rect[0], rect[3]), tint)
}

/**
 * 貼在牆上的一片：牆面上的點 (x, y, z) 是它的中心、(nx, nz) 是牆朝外的方向，寬 w、高 h（貼圖的上面朝上）。
 * 從外面看，牆的右手邊是 (nz, -nx)
 */
export function wallDecal(m: Mesher, rect: DecalRect, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number) {
  const rx = (nz * w) / 2
  const rz = (-nx * w) / 2
  const ox = x + nx * 0.05
  const oz = z + nz * 0.05
  m.face([ox - rx, y - h / 2, oz - rz, rect[0], rect[1]], [ox + rx, y - h / 2, oz + rz, rect[2], rect[1]], [ox + rx, y + h / 2, oz + rz, rect[2], rect[3]], [ox - rx, y + h / 2, oz - rz, rect[0], rect[3]], tint)
}
