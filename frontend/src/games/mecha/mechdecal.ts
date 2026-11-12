// 決定機甲的哪些面噴什麼標誌（`mechtex.ts` 的標誌圖）：
//   - 型號（S-07、L-12…）：左右兩側最大的那塊裝甲各噴一個
//   - 隊徽：再下一塊夠大的裝甲
//   - 黃黑警示條：細長的副色板子
//   - 白色的識別帶：又高又窄的裝甲板（大腿、小腿的護甲）
//   - 警告標籤：其他夠大的面，噴在角落
//   - 朝上的面：驚嘆號、箭頭、禁止踩踏
// 只噴在看得到的面上：從面上幾個點沿著法線往外看，幾公尺內沒有被別的零件擋住才算（零件互相插在一起，很多面其實埋在裡面）。
// 同一種機甲每次噴的都一樣（亂數的種子固定）。
import { Matrix4, Vector3 } from 'three'
import { rng } from '../racing/noise'
import { boxFaces, LAYER, type BoxFace, type Decal, type PartSpec } from './mechgeo'
import type { DecalAtlas, DecalCell } from './mechtex'

type Candidate = {
  part: PartSpec
  face: number
  /** 面的寬、高（公尺，扣掉倒角）、面積 */
  w: number
  h: number
  area: number
  /** 法線（站好時的世界座標） */
  nx: number
  ny: number
}

type Blocker = { inverse: Matrix4; half: Vector3 }

const O = new Vector3()
const D = new Vector3()

/** 從 `o` 沿著 `d` 走 `far` 公尺以內會不會撞到這個零件（零件當成方塊） */
function hits(b: Blocker, o: Vector3, d: Vector3, far: number): boolean {
  O.copy(o).applyMatrix4(b.inverse)
  D.copy(d).transformDirection(b.inverse)
  let t0 = 0
  let t1 = far
  for (const k of ['x', 'y', 'z'] as const) {
    const inv = 1 / D[k]
    let a = (-b.half[k] - O[k]) * inv
    let c = (b.half[k] - O[k]) * inv
    if (a > c) [a, c] = [c, a]
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, c)
    if (t0 > t1) return false
  }
  return true
}

/** 一個面要噴的標誌：`size` 是標誌的高（公尺），寬照那一格的比例；(fx, fy) 是中心在面上的位置（-0.5～0.5，照面的寬高） */
function place(c: Candidate, cell: DecalCell, size: number, fx = 0, fy = 0, stretch = 1): Decal {
  return { rect: cell.rect, cx: fx * c.w, cy: fy * c.h, w: size * cell.aspect * stretch, h: size }
}

/**
 * 在 `parts`（同一組、已經換成站好時的世界座標）裡挑面噴標誌，寫進每個零件的 `decals`。
 * `key` 是哪一種機甲（決定型號）
 */
export function planDecals(key: string, parts: PartSpec[], atlas: DecalAtlas, seed: number) {
  const rand = rng(seed * 7919 + 13)
  const blockers: Blocker[] = parts.map((p) => {
    const half = p.shape === 'nozzle' ? new Vector3(0.42 * p.size[0], p.size[1] / 2, 0.42 * p.size[2]) : new Vector3(p.size[0] / 2, p.size[1] / 2, p.size[2] / 2)
    return { inverse: p.world.clone().invert(), half }
  })
  const origin = new Vector3()
  const normal = new Vector3()
  const point = new Vector3()
  const exposed = (index: number, f: BoxFace): boolean => {
    const world = parts[index].world
    normal.set(f.n[0], f.n[1], f.n[2]).transformDirection(world)
    for (const [su, sv] of [
      [0, 0],
      [-0.6, -0.6],
      [0.6, -0.6],
      [0.6, 0.6],
      [-0.6, 0.6],
    ]) {
      point.set(
        f.n[0] * f.hn + f.u[0] * f.hu * su + f.v[0] * f.hv * sv,
        f.n[1] * f.hn + f.u[1] * f.hu * su + f.v[1] * f.hv * sv,
        f.n[2] * f.hn + f.u[2] * f.hu * su + f.v[2] * f.hv * sv,
      )
      origin.copy(point).applyMatrix4(world).addScaledVector(normal, 0.03)
      for (let b = 0; b < blockers.length; b++) {
        if (b !== index && hits(blockers[b], origin, normal, 3.5)) return false
      }
    }
    return true
  }

  const paint: Candidate[] = []
  parts.forEach((part, index) => {
    if (part.shape !== 'box' || (part.layer !== LAYER.armor && part.layer !== LAYER.trim)) return
    boxFaces(part).forEach((f, face) => {
      const w = f.hu * 2 - 0.08
      const h = f.hv * 2 - 0.08
      if (Math.min(w, h) < 0.16 || !exposed(index, f)) return
      normal.set(f.n[0], f.n[1], f.n[2]).transformDirection(part.world)
      paint.push({ part, face, w, h, area: w * h, nx: normal.x, ny: normal.y })
    })
  })
  paint.sort((a, b) => b.area - a.area)
  const used = new Set<Candidate>()
  const put = (c: Candidate, d: Decal) => {
    c.part.decals ??= [null, null, null, null, null, null]
    c.part.decals[c.face] = d
    used.add(c)
  }
  const free = (test: (c: Candidate) => boolean) => paint.filter((c) => !used.has(c) && test(c))
  const upright = (c: Candidate) => Math.abs(c.ny) < 0.5
  const armor = (c: Candidate) => c.part.layer === LAYER.armor

  // 型號：左右各一個（沒有側面就噴在最大的那一面）
  const code = atlas.codes[key]
  if (code) {
    const fits = (c: Candidate) => armor(c) && upright(c) && c.w >= 0.7 && c.h >= 0.36
    const sides = [free((c) => fits(c) && c.nx > 0.6)[0], free((c) => fits(c) && c.nx < -0.6)[0]].filter(Boolean)
    for (const c of sides.length ? sides : free(fits).slice(0, 1)) {
      const size = Math.min(c.h * 0.6, 0.5, (c.w * 0.84) / code.aspect)
      put(c, place(c, code, size, 0, 0.04))
    }
  }
  // 隊徽
  for (const c of free((c) => armor(c) && upright(c) && Math.min(c.w, c.h) >= 0.55).slice(0, 1)) {
    put(c, place(c, atlas.emblems[Math.floor(rand() * atlas.emblems.length)], Math.min(Math.min(c.w, c.h) * 0.6, 0.62)))
  }
  // 警示條：細長的副色板子（橫的直接貼，直的轉 90 度）
  const slim = (c: Candidate) => {
    const long = Math.max(c.w, c.h)
    const short = Math.min(c.w, c.h)
    return c.part.layer === LAYER.trim && upright(c) && long >= 0.85 && short >= 0.16 && short <= 0.5 && long / short >= 2.2
  }
  for (const c of free(slim).slice(0, 4)) {
    const turn = c.h > c.w
    const long = Math.max(c.w, c.h)
    const size = Math.min(c.w, c.h) * 0.62
    const len = Math.min(long * 0.94, size * atlas.hazard.aspect)
    put(c, { rect: atlas.hazard.rect, cx: 0, cy: 0, w: len, h: size, turn })
  }
  // 識別帶：又高又窄的裝甲板，橫著一條
  for (const c of free((c) => armor(c) && upright(c) && c.h >= 0.8 && c.w >= 0.3 && c.w <= 1.1 && c.h / c.w >= 1.25).slice(0, 4)) {
    put(c, { rect: atlas.band.rect, cx: 0, cy: c.h * 0.2, w: c.w + 0.1, h: Math.min(0.2, c.h * 0.16) })
  }
  // 警告標籤：噴在角落
  const corners = free((c) => upright(c) && c.w >= 0.5 && c.h >= 0.3)
  for (let i = 0; i < corners.length && i < 7; i++) {
    const c = corners[i]
    const cell = atlas.labels[Math.floor(rand() * atlas.labels.length)]
    const size = Math.max(0.09, Math.min(0.17, c.h * 0.26, (c.w * 0.5) / cell.aspect))
    const wide = size * cell.aspect
    const side = rand() < 0.5 ? -1 : 1
    put(c, { rect: cell.rect, cx: side * (c.w / 2 - wide / 2 - 0.03), cy: -(c.h / 2 - size / 2 - 0.03), w: wide, h: size })
  }
  // 朝上的面：圖示或「禁止踩踏」
  const tops = free((c) => c.ny > 0.7 && Math.min(c.w, c.h) >= 0.5)
  for (let i = 0; i < tops.length && i < 3; i++) {
    const c = tops[i]
    const cell = i === 0 ? atlas.labels[2] : atlas.icons[Math.floor(rand() * atlas.icons.length)]
    const size = Math.min(i === 0 ? 0.16 : 0.24, Math.min(c.w, c.h) * 0.4, (c.w * 0.6) / cell.aspect)
    put(c, place(c, cell, size, (rand() - 0.5) * 0.4, (rand() - 0.5) * 0.4))
  }
}
