// 夜城的大樓：方塊、往上退縮的高樓、裙樓加塔樓、圓柱大樓、頂端是尖塔的；外牆有格子窗、橫向帶窗、玻璃帷幕三種，
// 每棟再乘上自己的顏色。屋頂有水塔、冷氣機、天線（頂端的紅色航空障礙燈會閃），
// 一部分大樓有霓虹燈邊、轉角的燈條和朝著賽道的屋頂招牌。
// 同一種外牆的大樓合成一個網格（窗戶照實際尺寸重複，所以不用 instancing），屋頂的東西、霓虹燈各合成一個。
import {
  BoxGeometry,
  BufferAttribute,
  ConeGeometry,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type BufferGeometry,
  type CanvasTexture,
  type Scene,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { atlas, Quads } from './ads'
import { rng } from './noise'
import { Solids } from './solids'
import type { TrackPath } from './track'

type Tex = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => CanvasTexture

/** 大樓的位置：地面高度、朝向、大小（r 大約是半寬） */
export type TowerSpot = { x: number; y: number; z: number; rot: number; r: number }

/** 外牆貼圖一格：12 公尺寬、14 公尺高（四層樓） */
const CELL_W = 12
const CELL_H = 14

type Style = 'grid' | 'bands' | 'glass'
const STYLES: Style[] = ['grid', 'bands', 'glass']

/** 每種外牆乘上的顏色（都偏白，只帶一點色調） */
const TINTS: Record<Style, number[]> = {
  grid: [0xffffff, 0xd9dce8, 0xe8dcd0, 0xc9d6e8, 0xe6e0ff],
  bands: [0xffffff, 0xd0d8e0, 0xe6d6c4, 0xc8e0e0, 0xf0d8d8],
  glass: [0xffffff, 0xc8f0ff, 0xd8c8ff, 0xb8ffe8, 0xffd8f0],
}

const NEON = [0x2ee6ff, 0xff2e88, 0xffb02e, 0xa66bff, 0x4dff9a]

/** 格子窗：四層樓、每層四扇窗；`lit` 只畫亮著的窗 */
function drawGrid(ctx: CanvasRenderingContext2D, lit: boolean) {
  const rand = rng(7)
  ctx.fillStyle = lit ? '#000000' : '#262838'
  ctx.fillRect(0, 0, 128, 128)
  const palette = ['#ffd98a', '#fff1c9', '#9fe8ff', '#ffb3d9']
  for (let floor = 0; floor < 4; floor++) {
    for (let col = 0; col < 4; col++) {
      const on = rand() < 0.55
      const color = palette[Math.floor(rand() * palette.length)]
      if (lit && !on) continue
      ctx.fillStyle = lit ? color : on ? color : '#141621'
      ctx.fillRect(6 + col * 31, 8 + floor * 31, 20, 16)
    }
  }
}

/** 橫向帶窗：每層一整條玻璃，中間細細的竪框；亮燈的是一段一段 */
function drawBands(ctx: CanvasRenderingContext2D, lit: boolean) {
  const rand = rng(13)
  ctx.fillStyle = lit ? '#000000' : '#5a5f6e'
  ctx.fillRect(0, 0, 128, 128)
  const palette = ['#fff4d6', '#d6f0ff', '#ffe0a8', '#bfe3ff']
  for (let floor = 0; floor < 4; floor++) {
    const y = floor * 32 + 8
    if (!lit) {
      ctx.fillStyle = '#1c2433'
      ctx.fillRect(0, y, 128, 18)
      ctx.fillStyle = '#3a4255'
      for (let x = 0; x < 128; x += 21) ctx.fillRect(x, y, 2, 18)
      continue
    }
    for (let seg = 0; seg < 6; seg++) {
      if (rand() < 0.45) continue
      ctx.fillStyle = palette[Math.floor(rand() * palette.length)]
      ctx.fillRect(seg * 21 + 2, y + 1, 19, 16)
    }
  }
}

/** 玻璃帷幕：深藍綠色的玻璃、直條竪框、每層樓的橫線；亮燈的是一整個開間 */
function drawGlass(ctx: CanvasRenderingContext2D, lit: boolean) {
  const rand = rng(29)
  if (lit) {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 128, 128)
    for (let floor = 0; floor < 4; floor++) {
      for (let bay = 0; bay < 8; bay++) {
        if (rand() > 0.3) continue
        ctx.fillStyle = ['#6fb4d8', '#a8cce6', '#5fa0c8', '#d8c49a'][Math.floor(rand() * 4)]
        ctx.fillRect(bay * 16 + 2, floor * 32 + 5, 13, 22)
      }
    }
    return
  }
  const grad = ctx.createLinearGradient(0, 0, 128, 128)
  grad.addColorStop(0, '#2f5272')
  grad.addColorStop(1, '#1b2d44')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  ctx.fillStyle = '#58708a'
  for (let x = 0; x < 128; x += 16) ctx.fillRect(x, 0, 2, 128)
  ctx.fillStyle = '#3c556e'
  for (let y = 0; y < 128; y += 32) ctx.fillRect(0, y + 29, 128, 3)
  // 左下角給屋頂用
  ctx.fillStyle = '#2a3442'
  ctx.fillRect(0, 120, 8, 8)
}

const DRAW: Record<Style, (ctx: CanvasRenderingContext2D, lit: boolean) => void> = {
  grid: drawGrid,
  bands: drawBands,
  glass: drawGlass,
}

/** 外牆的方塊：底在 y0，四面的貼圖座標照實際尺寸重複（窗戶一樣大、樓層對齊），屋頂指到貼圖左下角 */
function facadeBox(w: number, h: number, d: number, y0: number): BufferGeometry {
  const box = new BoxGeometry(w, h, d).translate(0, y0 + h / 2, 0)
  const uv = box.getAttribute('uv') as BufferAttribute
  // 面的順序：+x、-x、+y、-y、+z、-z，每面 4 個頂點
  for (let face = 0; face < 6; face++) {
    const across = face < 2 ? d : w
    for (let v = 0; v < 4; v++) {
      const k = face * 4 + v
      if (face === 2 || face === 3) uv.setXY(k, 0.02, 0.02)
      else uv.setXY(k, uv.getX(k) * Math.max(1, Math.round(across / CELL_W)), (y0 + uv.getY(k) * h) / CELL_H)
    }
  }
  return box
}

/** 圓柱大樓：側面一樣照尺寸重複，上下的蓋子指到屋頂色 */
function facadeCylinder(radius: number, h: number, y0: number): BufferGeometry {
  const g = new CylinderGeometry(radius, radius, h, 16).translate(0, y0 + h / 2, 0)
  const uv = g.getAttribute('uv') as BufferAttribute
  const nor = g.getAttribute('normal')
  const around = Math.max(2, Math.round((2 * Math.PI * radius) / CELL_W))
  for (let k = 0; k < uv.count; k++) {
    if (Math.abs(nor.getY(k)) > 0.5) uv.setXY(k, 0.02, 0.02)
    else uv.setXY(k, uv.getX(k) * around, (y0 + uv.getY(k) * h) / CELL_H)
  }
  return g
}

/**
 * 蓋一整片大樓。回傳每個畫面要呼叫的函式（航空障礙燈一閃一閃）
 */
export function addTowers(
  scene: Scene,
  track: TrackPath,
  spots: TowerSpot[],
  seed: number,
  night: boolean,
  tex: Tex,
): (time: number) => void {
  const rand = rng(seed)
  const walls: Record<Style, BufferGeometry[]> = { grid: [], bands: [], glass: [] }
  const roofs = new Solids()
  const neon = new Solids()
  const red = new Solids()
  const signs = new Quads()
  const ads = atlas(tex, 2, 4, 512, 256)
  const metal = night ? 0x50535e : 0x9aa0a8

  for (const spot of spots) {
    const { x, z, rot } = spot
    const base = spot.y - 0.5
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    /** 本地座標（以大樓中心為原點、沒轉向）放到世界 */
    const put = (g: BufferGeometry) => g.rotateY(rot).translate(x, base, z)
    const wall = (style: Style, g: BufferGeometry, tint: number) => {
      const n = g.getAttribute('position').count
      const col = new Float32Array(n * 3)
      const r = ((tint >> 16) & 255) / 255
      const gg = ((tint >> 8) & 255) / 255
      const b = (tint & 255) / 255
      for (let k = 0; k < n; k++) col.set([r, gg, b], k * 3)
      g.setAttribute('color', new BufferAttribute(col, 3))
      walls[style].push(put(g))
    }
    const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]

    const w = spot.r * 1.3
    const d = spot.r * (0.9 + rand() * 0.5)
    const h = 14 + rand() ** 1.5 * 85
    const style: Style = h > 55 && rand() < 0.5 ? 'glass' : pick(STYLES)
    const tint = pick(TINTS[style])
    const t = rand()
    // 頂端的形狀（屋頂的東西放在這上面）
    let top = h
    let tw = w
    let td = d
    let round = false
    let block = false
    if (t < 0.22 && h > 34) {
      // 往上退縮：兩、三段，一段比一段小
      const tiers = h > 70 ? 3 : 2
      const split = tiers === 3 ? [0.5, 0.3, 0.2] : [0.62, 0.38]
      let y0 = 0
      for (let k = 0; k < tiers; k++) {
        const s = 0.8 ** k
        const th = h * split[k]
        wall(style, facadeBox(w * s, th, d * s, y0), tint)
        y0 += th
        tw = w * s
        td = d * s
      }
    } else if (t < 0.4 && h > 36) {
      // 裙樓加塔樓：矮矮寬寬的底座，上面是玻璃塔
      const p = 10 + rand() * 6
      wall(pick(['grid', 'bands'] as Style[]), facadeBox(w * 1.15, p, d * 1.15, 0), pick(TINTS.grid))
      wall('glass', facadeBox(w * 0.62, h - p, d * 0.62, p), pick(TINTS.glass))
      tw = w * 0.62
      td = d * 0.62
    } else if (t < 0.52) {
      const radius = Math.min(w, d) / 2
      wall(style === 'grid' ? 'glass' : style, facadeCylinder(radius, h, 0), tint)
      tw = td = radius * 2
      round = true
    } else {
      wall(style, facadeBox(w, h, d, 0), tint)
      block = true
    }

    /** 屋頂上的一點（本地座標，-0.5～0.5 乘上屋頂的大小）換成世界座標 */
    const roofAt = (u: number, v: number): [number, number] => {
      const lx = u * tw
      const lz = v * td
      return [x + lx * cos + lz * sin, z - lx * sin + lz * cos]
    }

    // 尖塔頂（高的圓柱、退縮大樓偶爾有）或一般的屋頂設備
    if (h > 50 && (round || t < 0.22) && rand() < 0.45) {
      const sh = 8 + rand() * 10
      const cone = round
        ? new ConeGeometry(tw * 0.5, sh, 16)
        : new ConeGeometry(Math.min(tw, td) * 0.6, sh, 4).rotateY(Math.PI / 4)
      roofs.add(put(cone.translate(0, top + sh / 2, 0)), metal)
      top += sh
    } else {
      if (rand() < 0.65) {
        const [wx, wz] = roofAt((rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5)
        const r = 1.1 + rand() * 0.6
        roofs.add(new CylinderGeometry(r, r, 2.4, 10).translate(wx, base + top + 1.2, wz), metal)
        roofs.add(new ConeGeometry(r, 0.8, 10).translate(wx, base + top + 2.8, wz), metal)
      }
      const units = Math.floor(rand() * 4)
      for (let k = 0; k < units; k++) {
        const [ux, uz] = roofAt((rand() - 0.5) * 0.7, (rand() - 0.5) * 0.7)
        roofs.add(put(new BoxGeometry(1.6, 1.1, 1.6).translate(0, top + 0.55, 0)).translate(ux - x, 0, uz - z), night ? 0x3c3f49 : 0xb8bcc2)
      }
    }
    // 高樓的天線和頂端的紅燈
    if (h > 55 && rand() < 0.7) {
      const ah = 6 + rand() * 12
      roofs.add(new CylinderGeometry(0.12, 0.2, ah, 5).translate(x, base + top + ah / 2, z), metal)
      red.add(new BoxGeometry(0.6, 0.6, 0.6).translate(x, base + top + ah + 0.2, z), 0xff2a2a)
    }
    if (night) {
      // 屋頂的霓虹燈邊
      if (rand() < 0.4) {
        const c = pick(NEON)
        if (round) neon.add(new CylinderGeometry(tw / 2 + 0.08, tw / 2 + 0.08, 0.45, 16, 1, true).translate(x, base + h - 0.3, z), c)
        else {
          for (const e of [-1, 1]) {
            neon.add(put(new BoxGeometry(tw + 0.2, 0.4, 0.14).translate(0, h - 0.3, (e * td) / 2)), c)
            neon.add(put(new BoxGeometry(0.14, 0.4, td + 0.2).translate((e * tw) / 2, h - 0.3, 0)), c)
          }
        }
      }
      // 轉角從下到上的燈條
      if (block && rand() < 0.18) {
        const c = pick(NEON)
        for (const [cx, cz] of [
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ]) {
          neon.add(put(new BoxGeometry(0.18, h, 0.18).translate((cx * w) / 2, h / 2, (cz * d) / 2)), c)
        }
      }
    }
    // 屋頂招牌：朝著最近的那段賽道
    if (!round && h < 60 && rand() < 0.16) {
      const near = track.nearest(x, z)
      const dx = track.px[near.i] - x
      const dz = track.pz[near.i] - z
      const len = Math.hypot(dx, dz) || 1
      const fx = dx / len
      const fz = dz / len
      const sw = Math.min(16, Math.max(tw, td) * 0.85)
      const sh = sw / 2
      const off = Math.min(tw, td) * 0.3
      const cx = x + fx * off
      const cz = z + fz * off
      const y0 = base + h + 1.2
      const heading = Math.atan2(fx, fz)
      roofs.add(new BoxGeometry(sw + 0.3, sh + 0.3, 0.3).rotateY(heading).translate(cx - fx * 0.2, y0 + sh / 2, cz - fz * 0.2), 0x202228)
      for (const e of [-1, 1]) {
        roofs.add(new BoxGeometry(0.25, 1.4, 0.25).translate(cx - fx * 0.2 + fz * e * sw * 0.35, y0 - 0.6, cz - fz * 0.2 - fx * e * sw * 0.35), metal)
      }
      // 從賽道看過去的右手邊是 (fz, -fx)
      const rx = fz
      const rz = -fx
      const p = (s: number, y: number) => [cx + rx * s * (sw / 2), y, cz + rz * s * (sw / 2)]
      signs.quad(p(-1, y0), p(1, y0), p(1, y0 + sh), p(-1, y0 + sh), ads.cells[Math.floor(rand() * ads.cells.length)])
    }
  }

  for (const style of STYLES) {
    const list = walls[style]
    if (!list.length) continue
    const geo = mergeGeometries(list)
    for (const g of list) g.dispose()
    scene.add(
      new Mesh(
        geo,
        new MeshLambertMaterial({
          map: tex(128, 128, (ctx) => DRAW[style](ctx, false)),
          emissiveMap: tex(128, 128, (ctx) => DRAW[style](ctx, true)),
          emissive: 0xffffff,
          emissiveIntensity: night ? 1 : 0.2,
          vertexColors: true,
        }),
      ),
    )
  }
  const roofMesh = roofs.mesh(new MeshLambertMaterial({ vertexColors: true }))
  if (roofMesh) scene.add(roofMesh)
  const neonMesh = neon.mesh(new MeshBasicMaterial({ vertexColors: true }))
  if (neonMesh) scene.add(neonMesh)
  const signMesh = signs.mesh(ads.map, night)
  if (signMesh) scene.add(signMesh)
  const redMesh = red.mesh(new MeshBasicMaterial({ vertexColors: true }))
  if (redMesh) scene.add(redMesh)
  return (time) => {
    // 航空障礙燈：一秒半閃一次
    if (redMesh) redMesh.visible = time % 1.5 < 0.6
  }
}
