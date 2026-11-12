// 賽道旁的廣告（全是虛構的品牌）：看板一格 2:1、布條一格 8:1，各畫成一張貼圖，用貼圖座標挑一格。
import { BufferAttribute, BufferGeometry, Mesh, MeshLambertMaterial, type CanvasTexture } from 'three'

type Tex = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => CanvasTexture

export type Ad = { zh: string; en: string; bg: string; fg: string; accent: string }

export const ADS: Ad[] = [
  { zh: '疾風輪胎', en: 'GALE TIRES', bg: '#141414', fg: '#ffd400', accent: '#ffd400' },
  { zh: '雷霆機油', en: 'THUNDER OIL', bg: '#d71f26', fg: '#ffffff', accent: '#151515' },
  { zh: '閃電能量飲', en: 'BOLT ENERGY', bg: '#1647d8', fg: '#c8ff3a', accent: '#c8ff3a' },
  { zh: '流星汽車', en: 'METEOR MOTORS', bg: '#f4f4f4', fg: '#1d3f9a', accent: '#e63030' },
  { zh: '烈焰煞車', en: 'BLAZE BRAKES', bg: '#ff7a1a', fg: '#1a1a1a', accent: '#ffffff' },
  { zh: '追風車隊', en: 'CHASER RACING', bg: '#0e7a4a', fg: '#ffffff', accent: '#ffe14a' },
  { zh: '旋風大獎賽', en: 'WHIRLWIND GP', bg: '#6c2bd9', fg: '#ffffff', accent: '#ff5fd2' },
  { zh: '比賽日', en: 'RACE DAY', bg: 'checker', fg: '#111111', accent: '#ffffff' },
]

export const FONT = '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", "Heiti TC", sans-serif'

/** 一格廣告畫在 (x, y, w, h)；很扁的（布條）中英文排成一行 */
function drawAd(ctx: CanvasRenderingContext2D, ad: Ad, x: number, y: number, w: number, h: number) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  const wide = w / h > 5
  const checker = ad.bg === 'checker'
  if (checker) {
    const sq = h / (wide ? 2 : 4)
    for (let i = 0; i * sq < w; i++) {
      for (let j = 0; j * sq < h; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#111111' : '#f5f5f5'
        ctx.fillRect(x + i * sq, y + j * sq, sq, sq)
      }
    }
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x + w * 0.2, y + h * 0.1, w * 0.6, h * 0.8)
  } else {
    ctx.fillStyle = ad.bg
    ctx.fillRect(x, y, w, h)
    // 右邊三條斜紋
    ctx.fillStyle = ad.accent
    for (let k = 0; k < 3; k++) {
      const sx = x + w - h * (0.95 + k * 0.42)
      ctx.beginPath()
      ctx.moveTo(sx, y + h)
      ctx.lineTo(sx + h * 0.2, y + h)
      ctx.lineTo(sx + h * 0.75, y)
      ctx.lineTo(sx + h * 0.55, y)
      ctx.fill()
    }
  }
  ctx.fillStyle = ad.fg
  ctx.textBaseline = 'middle'
  const cx = checker ? x + w / 2 : x + w * 0.42
  if (wide) {
    ctx.font = `900 ${Math.round(h * 0.6)}px ${FONT}`
    const zw = ctx.measureText(ad.zh).width
    ctx.font = `italic 800 ${Math.round(h * 0.4)}px ${FONT}`
    const ew = ctx.measureText(ad.en).width
    const gap = h * 0.4
    let left = cx - (zw + gap + ew) / 2
    ctx.textAlign = 'left'
    ctx.font = `900 ${Math.round(h * 0.6)}px ${FONT}`
    ctx.fillText(ad.zh, left, y + h * 0.54)
    left += zw + gap
    ctx.font = `italic 800 ${Math.round(h * 0.4)}px ${FONT}`
    ctx.fillText(ad.en, left, y + h * 0.56)
  } else {
    ctx.textAlign = 'center'
    ctx.font = `900 ${Math.round(h * 0.42)}px ${FONT}`
    ctx.fillText(ad.zh, cx, y + h * 0.4, w * (checker ? 0.56 : 0.72))
    ctx.font = `italic 800 ${Math.round(h * 0.19)}px ${FONT}`
    ctx.fillText(ad.en, cx, y + h * 0.77, w * (checker ? 0.56 : 0.72))
  }
  ctx.restore()
}

/** 廣告貼圖：看板一格 2:1（2 欄 4 列）、布條一格 8:1（2 欄 8 列）；回傳每一格的貼圖座標 [u0, v0, u1, v1] */
export type Cell = [number, number, number, number]

export function atlas(tex: Tex, cols: number, rows: number, cw: number, ch: number): { map: CanvasTexture; cells: Cell[] } {
  const W = cols * cw
  const H = rows * ch
  const cells: Cell[] = []
  const map = tex(W, H, (ctx) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ad = ADS[(r * cols + c) % ADS.length]
        drawAd(ctx, ad, c * cw, r * ch, cw, ch)
      }
    }
  })
  // 往內縮兩個像素，縮小貼圖（mipmap）時才不會混到隔壁那格
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push([(c * cw + 2) / W, 1 - ((r + 1) * ch - 2) / H, ((c + 1) * cw - 2) / W, 1 - (r * ch + 2) / H])
    }
  }
  return { map, cells }
}

/** 貼廣告的四邊形，全部合成一個網格 */
export class Quads {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []

  /** 四個角（左下、右下、右上、左上，從正面看），正面朝外 */
  quad(bl: number[], br: number[], tr: number[], tl: number[], cell: Cell) {
    const ex = [br[0] - bl[0], br[1] - bl[1], br[2] - bl[2]]
    const ey = [tl[0] - bl[0], tl[1] - bl[1], tl[2] - bl[2]]
    let nx = ex[1] * ey[2] - ex[2] * ey[1]
    let ny = ex[2] * ey[0] - ex[0] * ey[2]
    let nz = ex[0] * ey[1] - ex[1] * ey[0]
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    const [u0, v0, u1, v1] = cell
    const put = (p: number[], u: number, v: number) => {
      this.pos.push(p[0], p[1], p[2])
      this.nor.push(nx, ny, nz)
      this.uv.push(u, v)
    }
    put(bl, u0, v0)
    put(br, u1, v0)
    put(tr, u1, v1)
    put(bl, u0, v0)
    put(tr, u1, v1)
    put(tl, u0, v1)
  }

  mesh(map: CanvasTexture, night: boolean): Mesh | null {
    if (!this.pos.length) return null
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3))
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3))
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2))
    // 廣告自己會發光一點（夜裡是 LED 看板），遠遠的也看得清楚
    return new Mesh(
      geo,
      new MeshLambertMaterial({ map, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: night ? 0.85 : 0.18 }),
    )
  }
}
