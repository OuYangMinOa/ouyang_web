import {
  BoxGeometry,
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { MonsterId, TowerId } from './online'

/**
 * 塔和怪物的模型：全部用基本形狀拼出來、顏色寫在頂點上，一種東西合成一個幾何，
 * 場上同一種的用 InstancedMesh 一次畫完（幾百隻怪也只有十幾個 draw call）。
 * 單位是「格」：一格寬 1，y 往上，怪物和塔的頭都朝 +z。
 *
 * 選單、記分板用的小圖示（表情符號）和名字以外的畫面資訊也放在這裡，用後端規格表的 id 對起來。
 */

export type Shape = BufferGeometry

/** 上色：整個零件同一個顏色；要先擺好位置（translate／rotate）再丟進來 */
export function tint(geometry: Shape, color: number): Shape {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.deleteAttribute('uv')
  const c = new Color(color)
  const count = g.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new BufferAttribute(colors, 3))
  return g
}

export function merge(parts: Shape[]): Shape {
  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  merged.computeVertexNormals()
  return merged
}

export const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: number) =>
  tint(new BoxGeometry(w, h, d).translate(x, y, z), color)

export const ball = (r: number, x: number, y: number, z: number, color: number, sy = 1, detail = 10) =>
  tint(new SphereGeometry(r, detail, Math.max(6, Math.round(detail * 0.7))).scale(1, sy, 1).translate(x, y, z), color)

export const tube = (top: number, bottom: number, h: number, x: number, y: number, z: number, color: number, sides = 10) =>
  tint(new CylinderGeometry(top, bottom, h, sides).translate(x, y + h / 2, z), color)

/** 朝 +z 的圓柱（砲管） */
const barrel = (r: number, length: number, y: number, z: number, color: number, sides = 8, x = 0) =>
  tint(
    new CylinderGeometry(r, r, length, sides)
      .rotateX(Math.PI / 2)
      .translate(x, y, z + length / 2),
    color,
  )

/**
 * 一對眼睛（白底黑瞳），臉朝 +z；`r` 是眼白的半徑。
 * 眼睛很小，球切得很粗就夠了：一大群怪同時在場上時，光是眼睛就佔了一半的三角形
 */
function eyes(r: number, gap: number, y: number, z: number, pupil = 0x1c1a17, white = 0xffffff): Shape[] {
  const out: Shape[] = []
  for (const side of [-1, 1]) {
    out.push(tint(new SphereGeometry(r, 7, 5).translate(side * gap, y, z), white))
    out.push(tint(new SphereGeometry(r * 0.55, 6, 4).translate(side * gap, y, z + r * 0.62), pupil))
  }
  return out
}

// ---------- 怪物 ----------

export type MonsterLook = {
  /** 記分板、下一波預告用的小圖示 */
  icon: string
  /** 被打倒時噴出來的碎片顏色 */
  color: number
  /** 飛行高度（格），走路的是 0 */
  fly: number
  /** 血條畫在頭上多高 */
  top: number
  /** 一上一下跳動的幅度、每秒幾下 */
  bob: number
  hop: number
  /** 半透明（幽魂） */
  ghost?: boolean
}

export const MONSTER_LOOK: Record<MonsterId, MonsterLook> = {
  grunt: { icon: '🍮', color: 0x7ec850, fly: 0, top: 0.62, bob: 0.07, hop: 2.2 },
  runner: { icon: '🐇', color: 0xf2a03d, fly: 0, top: 0.62, bob: 0.1, hop: 4.5 },
  brute: { icon: '🐢', color: 0x5f7387, fly: 0, top: 0.72, bob: 0.03, hop: 1.4 },
  swarm: { icon: '🐜', color: 0x9b3b3b, fly: 0, top: 0.34, bob: 0.05, hop: 5 },
  flyer: { icon: '🦇', color: 0x8562b8, fly: 1.15, top: 0.4, bob: 0.12, hop: 3 },
  regen: { icon: '🌳', color: 0x3f9b4b, fly: 0, top: 0.9, bob: 0.04, hop: 1.8 },
  splitter: { icon: '🟤', color: 0x8b5e3c, fly: 0, top: 0.66, bob: 0.06, hop: 1.6 },
  mudling: { icon: '🟤', color: 0xa0714a, fly: 0, top: 0.4, bob: 0.07, hop: 3.4 },
  ghost: { icon: '👻', color: 0xdfe8ff, fly: 0.25, top: 0.78, bob: 0.1, hop: 1.2, ghost: true },
  boss: { icon: '👹', color: 0xb23a3a, fly: 0, top: 1.25, bob: 0.04, hop: 1.1 },
  wyvern: { icon: '🐉', color: 0x2f8f83, fly: 1.5, top: 0.75, bob: 0.14, hop: 1.6 },
}

export function monsterGeometry(kind: MonsterId): Shape {
  switch (kind) {
    case 'grunt':
      // 果凍：壓扁的球，底下一圈深一點的裙邊
      return merge([
        ball(0.27, 0, 0.24, 0, 0x7ec850, 0.86, 12),
        tint(new CylinderGeometry(0.25, 0.28, 0.1, 12).translate(0, 0.06, 0), 0x5faa3a),
        ball(0.07, -0.1, 0.42, 0.08, 0xb9e88f, 0.6, 6),
        ...eyes(0.06, 0.1, 0.28, 0.21),
      ])
    case 'runner':
      // 飛毛腿：往前傾的蛋形身體、兩隻長耳朵
      return merge([
        tint(new SphereGeometry(0.19, 10, 8).scale(0.85, 1, 1.25).rotateX(0.25).translate(0, 0.24, 0), 0xf2a03d),
        tint(new ConeGeometry(0.045, 0.3, 5).rotateX(-0.5).translate(-0.07, 0.5, -0.08), 0xf7c27a),
        tint(new ConeGeometry(0.045, 0.3, 5).rotateX(-0.5).translate(0.07, 0.5, -0.08), 0xf7c27a),
        ball(0.06, 0, 0.2, -0.24, 0xffffff, 1, 6),
        box(0.07, 0.1, 0.12, -0.1, 0.05, 0.02, 0xc97a1e),
        box(0.07, 0.1, 0.12, 0.1, 0.05, 0.02, 0xc97a1e),
        ...eyes(0.045, 0.075, 0.3, 0.2),
      ])
    case 'brute':
      // 鐵甲龜：半球形的鐵殼、殼上的鉚釘、探出來的頭和四隻短腳
      return merge([
        tint(new SphereGeometry(0.36, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1).translate(0, 0.14, 0), 0x5f7387),
        tint(new CylinderGeometry(0.38, 0.38, 0.07, 12).scale(1, 1, 1.1).translate(0, 0.14, 0), 0x3f4f5f),
        ball(0.05, 0, 0.45, 0, 0xc9d3dc, 1, 6),
        ball(0.045, -0.2, 0.33, 0.12, 0xc9d3dc, 1, 6),
        ball(0.045, 0.2, 0.33, 0.12, 0xc9d3dc, 1, 6),
        ball(0.045, -0.2, 0.33, -0.16, 0xc9d3dc, 1, 6),
        ball(0.045, 0.2, 0.33, -0.16, 0xc9d3dc, 1, 6),
        ball(0.13, 0, 0.2, 0.42, 0x8fbf6a, 1, 8),
        box(0.12, 0.12, 0.12, -0.24, 0.06, 0.22, 0x7aa85a),
        box(0.12, 0.12, 0.12, 0.24, 0.06, 0.22, 0x7aa85a),
        box(0.12, 0.12, 0.12, -0.24, 0.06, -0.24, 0x7aa85a),
        box(0.12, 0.12, 0.12, 0.24, 0.06, -0.24, 0x7aa85a),
        ...eyes(0.04, 0.06, 0.24, 0.51),
      ])
    case 'swarm':
      // 小蟲：三節的身體和兩根觸角
      return merge([
        ball(0.09, 0, 0.1, 0.1, 0x9b3b3b, 1, 8),
        ball(0.11, 0, 0.11, -0.04, 0x7a2a2a, 0.9, 8),
        ball(0.08, 0, 0.09, -0.18, 0x9b3b3b, 0.9, 6),
        tint(new ConeGeometry(0.015, 0.12, 4).rotateX(0.9).translate(-0.04, 0.2, 0.16), 0x2b1414),
        tint(new ConeGeometry(0.015, 0.12, 4).rotateX(0.9).translate(0.04, 0.2, 0.16), 0x2b1414),
        ...eyes(0.03, 0.045, 0.13, 0.17),
      ])
    case 'flyer':
      // 蝙蝠：圓圓的身體、兩片張開的翅膀、尖耳朵
      return merge([
        ball(0.15, 0, 0, 0, 0x8562b8, 1, 10),
        tint(new ConeGeometry(0.045, 0.12, 4).translate(-0.08, 0.16, 0.02), 0x6a4a99),
        tint(new ConeGeometry(0.045, 0.12, 4).translate(0.08, 0.16, 0.02), 0x6a4a99),
        wing(-1, 0.42, 0.3, 0x5b3f85),
        wing(1, 0.42, 0.3, 0x5b3f85),
        ...eyes(0.04, 0.06, 0.03, 0.12, 0xb3122e),
      ])
    case 'regen':
      // 樹精：樹幹上頂著一團樹葉
      return merge([
        tube(0.13, 0.17, 0.4, 0, 0, 0, 0x8a5a2b, 8),
        tint(new IcosahedronGeometry(0.27, 0).translate(0, 0.6, 0), 0x3f9b4b),
        tint(new IcosahedronGeometry(0.16, 0).translate(0.16, 0.5, -0.1), 0x57b862),
        tint(new IcosahedronGeometry(0.14, 0).translate(-0.18, 0.52, 0.04), 0x2f7d3a),
        box(0.06, 0.06, 0.16, -0.19, 0.2, 0, 0x6f4720),
        box(0.06, 0.06, 0.16, 0.19, 0.2, 0, 0x6f4720),
        ...eyes(0.045, 0.07, 0.26, 0.13),
      ])
    case 'splitter':
    case 'mudling': {
      // 泥巴怪：一坨不規則的泥巴（小的就是縮小版）
      const s = kind === 'splitter' ? 1 : 0.58
      const g = merge([
        tint(new IcosahedronGeometry(0.3, 1).scale(1, 0.7, 1).translate(0, 0.2, 0), 0x8b5e3c),
        tint(new IcosahedronGeometry(0.16, 0).translate(0.2, 0.1, -0.12), 0x74492a),
        tint(new IcosahedronGeometry(0.14, 0).translate(-0.22, 0.09, 0.02), 0x9c6f4b),
        tint(new IcosahedronGeometry(0.1, 0).translate(0.02, 0.42, -0.02), 0x9c6f4b),
        ...eyes(0.055, 0.1, 0.27, 0.24),
      ])
      return g.scale(s, s, s)
    }
    case 'ghost':
      // 幽魂：圓頭、往下散開的裙擺
      return merge([
        ball(0.22, 0, 0.42, 0, 0xdfe8ff, 1, 10),
        tint(new CylinderGeometry(0.22, 0.27, 0.34, 10, 1, true).translate(0, 0.25, 0), 0xdfe8ff),
        tint(new ConeGeometry(0.09, 0.16, 5).rotateX(Math.PI).translate(-0.14, 0.02, 0), 0xc3d0f5),
        tint(new ConeGeometry(0.09, 0.16, 5).rotateX(Math.PI).translate(0.14, 0.02, 0), 0xc3d0f5),
        tint(new ConeGeometry(0.09, 0.16, 5).rotateX(Math.PI).translate(0, 0.02, 0.14), 0xc3d0f5),
        tint(new ConeGeometry(0.09, 0.16, 5).rotateX(Math.PI).translate(0, 0.02, -0.14), 0xc3d0f5),
        ball(0.045, -0.08, 0.44, 0.19, 0x2a2f4a, 1.4, 6),
        ball(0.045, 0.08, 0.44, 0.19, 0x2a2f4a, 1.4, 6),
      ])
    case 'boss':
      // 魔王：一大顆紅色的身體、兩支角、金色的頸環和粗壯的手
      return merge([
        ball(0.5, 0, 0.5, 0, 0xb23a3a, 0.95, 14),
        tint(new TorusGeometry(0.44, 0.06, 6, 14).rotateX(Math.PI / 2).translate(0, 0.2, 0), 0xe0b040),
        tint(new ConeGeometry(0.1, 0.36, 6).rotateZ(0.5).translate(-0.3, 0.98, 0.05), 0xf2e6c8),
        tint(new ConeGeometry(0.1, 0.36, 6).rotateZ(-0.5).translate(0.3, 0.98, 0.05), 0xf2e6c8),
        ball(0.17, -0.55, 0.42, 0.08, 0x8e2c2c, 1, 8),
        ball(0.17, 0.55, 0.42, 0.08, 0x8e2c2c, 1, 8),
        box(0.34, 0.07, 0.06, 0, 0.42, 0.45, 0x2b1414),
        box(0.2, 0.05, 0.08, -0.17, 0.75, 0.42, 0x2b1414),
        box(0.2, 0.05, 0.08, 0.17, 0.75, 0.42, 0x2b1414),
        ...eyes(0.085, 0.17, 0.64, 0.4, 0xffd23f),
      ])
    case 'wyvern':
      // 飛龍：長長的身體、一對大翅膀、尾巴和頭上的角
      return merge([
        tint(new SphereGeometry(0.24, 10, 8).scale(0.9, 0.8, 1.9).translate(0, 0, 0), 0x2f8f83),
        ball(0.19, 0, 0.1, 0.5, 0x37a596, 1, 8),
        tint(new ConeGeometry(0.11, 0.5, 6).rotateX(-Math.PI / 2).translate(0, 0, -0.62), 0x24756b),
        tint(new ConeGeometry(0.05, 0.2, 4).rotateX(-0.6).translate(-0.09, 0.3, 0.44), 0xf2e6c8),
        tint(new ConeGeometry(0.05, 0.2, 4).rotateX(-0.6).translate(0.09, 0.3, 0.44), 0xf2e6c8),
        wing(-1, 0.85, 0.6, 0x1f6b62),
        wing(1, 0.85, 0.6, 0x1f6b62),
        box(0.26, 0.05, 0.3, 0, -0.16, 0.1, 0xe8d9a8),
        ...eyes(0.05, 0.1, 0.16, 0.64, 0xb3122e, 0xffd23f),
      ])
  }
}

/** 一片翅膀：從身體往外的三角形，稍微往上翹 */
function wing(side: number, span: number, chord: number, color: number): Shape {
  const g = new ConeGeometry(chord / 2, span, 3, 1)
  // 圓錐躺平變成三角片：尖端朝外
  g.scale(1, 1, 0.12)
  g.rotateZ((-side * Math.PI) / 2)
  g.translate(side * (span / 2 + 0.08), 0.06, 0)
  g.rotateZ(side * 0.25)
  return tint(g, color)
}

// ---------- 塔 ----------

export type TowerLook = {
  icon: string
  /** 選單上的代表色（CSS 變數） */
  accent: string
  /** 頭（會轉的那一截）裝在多高 */
  headY: number
  /** 頭要不要自己發亮（不吃光照）：冰晶、電球、號角上的光 */
  glow: boolean
  /** 頭會轉向目標；不會的是自己慢慢轉或不動 */
  aims: boolean
  /** 不瞄準的頭每秒自轉幾圈 */
  spin: number
  /** 砲口離頭的中心多遠（砲彈從這裡飛出去） */
  muzzle: number
  /** 砲彈、閃電的顏色 */
  shot: number
}

export const TOWER_LOOK: Record<TowerId, TowerLook> = {
  bolt: { icon: '🏹', accent: 'var(--td-bolt)', headY: 0.78, glow: false, aims: true, spin: 0, muzzle: 0.3, shot: 0xf2e6c8 },
  cannon: { icon: '💣', accent: 'var(--td-cannon)', headY: 0.6, glow: false, aims: true, spin: 0, muzzle: 0.5, shot: 0x2b2b2b },
  frost: { icon: '❄️', accent: 'var(--td-frost)', headY: 0.95, glow: true, aims: false, spin: 0.25, muzzle: 0, shot: 0x9fe3ff },
  tesla: { icon: '⚡', accent: 'var(--td-tesla)', headY: 1.12, glow: true, aims: false, spin: 0, muzzle: 0, shot: 0xfff07a },
  poison: { icon: '☠️', accent: 'var(--td-poison)', headY: 0.7, glow: false, aims: false, spin: 0.08, muzzle: 0, shot: 0x9be564 },
  sniper: { icon: '🎯', accent: 'var(--td-sniper)', headY: 1.18, glow: false, aims: true, spin: 0, muzzle: 0.75, shot: 0xffe9a8 },
  beacon: { icon: '📯', accent: 'var(--td-beacon)', headY: 1.2, glow: true, aims: false, spin: 0.12, muzzle: 0, shot: 0xffd23f },
}

const STONE = 0x9a948a
const STONE_DARK = 0x7b756c
const WOOD = 0x8a5a2b
const WOOD_DARK = 0x6f4720
const IRON = 0x4a4f57
const IRON_DARK = 0x33373d
const GOLD = 0xe0b040
const BRONZE = 0xb08d57
const RED = 0xc2410c

/** 平放的一圈（箍、環） */
const hoop = (r: number, thick: number, y: number, color: number) =>
  tint(new TorusGeometry(r, thick, 4, 10).rotateX(Math.PI / 2).translate(0, y, 0), color)

/** 繞著中心擺一圈：`make(角度, 第幾個)` 做一個，做 `count` 個 */
function around(count: number, make: (angle: number, i: number) => Shape, offset = 0): Shape[] {
  return Array.from({ length: count }, (_, i) => make(offset + (i / count) * Math.PI * 2, i))
}

/**
 * 每種塔底下都有的石頭基座，越高級越講究：2 級多一道鐵箍，3 級四個角多了石墩，4 級鐵箍換成金的、石墩戴上金頂。
 * 升級不只是變大，一眼就看得出哪幾座是練過的。
 */
function pedestal(level: number): Shape[] {
  const parts = [tube(0.36, 0.42, 0.16, 0, 0, 0, STONE, 8), tube(0.3, 0.36, 0.1, 0, 0.16, 0, STONE_DARK, 8)]
  if (level >= 2) parts.push(hoop(0.345, 0.028, 0.17, level >= 4 ? GOLD : IRON))
  if (level >= 3) {
    parts.push(...around(4, (a) => box(0.1, 0.22, 0.1, Math.cos(a) * 0.37, 0.11, Math.sin(a) * 0.37, STONE_DARK), Math.PI / 4))
  }
  if (level >= 4) {
    parts.push(
      ...around(
        4,
        (a) => tint(new ConeGeometry(0.075, 0.09, 4).rotateY(Math.PI / 4).translate(Math.cos(a) * 0.37, 0.265, Math.sin(a) * 0.37), GOLD),
        Math.PI / 4,
      ),
    )
  }
  return parts
}

/** 插在後面的小旗子（4 級的弩箭塔、重弩塔） */
function banner(x: number, y: number, z: number, color: number): Shape[] {
  return [box(0.02, 0.36, 0.02, x, y + 0.18, z, WOOD_DARK), box(0.02, 0.14, 0.18, x, y + 0.27, z - 0.1, color), ball(0.025, x, y + 0.37, z, GOLD, 1, 5)]
}

/** 不會動的那一截（基座和塔身），原點在格子中心的地面；`level` 是 1～4 */
export function towerBase(kind: TowerId, level: number): Shape {
  const parts = pedestal(level)
  switch (kind) {
    case 'bolt':
      parts.push(tube(0.12, 0.16, 0.48, 0, 0.26, 0, WOOD, 6), tube(0.2, 0.14, 0.06, 0, 0.7, 0, WOOD_DARK, 6))
      if (level >= 2) parts.push(hoop(0.145, 0.02, 0.38, IRON), hoop(0.13, 0.02, 0.58, IRON))
      if (level >= 3) {
        // 斜撐
        parts.push(...around(4, (a) => tint(new BoxGeometry(0.04, 0.34, 0.04).rotateZ(0.55).translate(0.2, 0.42, 0).rotateY(a), WOOD_DARK)))
      }
      if (level >= 4) parts.push(...banner(0, 0.3, -0.3, RED))
      break
    case 'cannon':
      parts.push(tube(0.3, 0.33, 0.26, 0, 0.26, 0, IRON, 10), hoop(0.31, 0.035, 0.5, level >= 4 ? GOLD : BRONZE))
      if (level >= 2) parts.push(...around(8, (a) => ball(0.032, Math.cos(a) * 0.325, 0.38, Math.sin(a) * 0.325, 0xc9d3dc, 1, 5)))
      if (level >= 3) parts.push(hoop(0.33, 0.03, 0.3, level >= 4 ? GOLD : BRONZE))
      break
    case 'frost':
      parts.push(
        tube(0.1, 0.24, 0.3, 0, 0.26, 0, 0x8fb8de, 6),
        tint(new ConeGeometry(0.07, 0.3, 4).rotateZ(0.5).translate(-0.2, 0.42, 0.05), 0xcdeeff),
        tint(new ConeGeometry(0.06, 0.26, 4).rotateZ(-0.6).translate(0.2, 0.4, -0.08), 0xcdeeff),
        tint(new ConeGeometry(0.06, 0.24, 4).rotateX(0.6).translate(0.02, 0.4, 0.2), 0xb4e2fb),
      )
      if (level >= 2) {
        parts.push(
          tint(new ConeGeometry(0.055, 0.24, 4).rotateX(-0.6).translate(-0.04, 0.4, -0.2), 0xb4e2fb),
          tint(new ConeGeometry(0.05, 0.2, 4).rotateZ(0.9).translate(-0.27, 0.3, -0.12), 0xe8f8ff),
        )
      }
      if (level >= 3) parts.push(tube(0.05, 0.11, 0.26, 0, 0.5, 0, 0xb4e2fb, 5))
      if (level >= 4) {
        parts.push(...around(6, (a) => tint(new ConeGeometry(0.04, 0.18, 4).translate(Math.cos(a) * 0.33, 0.33, Math.sin(a) * 0.33), 0xe8f8ff), 0.3))
      }
      break
    case 'tesla': {
      const copper = level >= 4 ? 0xe0a050 : 0xc77b3b
      parts.push(tube(0.1, 0.2, 0.74, 0, 0.26, 0, IRON, 8), hoop(0.2, 0.035, 0.48, copper), hoop(0.16, 0.035, 0.68, copper), hoop(0.13, 0.03, 0.86, copper))
      if (level >= 2) parts.push(hoop(0.235, 0.035, 0.36, copper))
      if (level >= 3) {
        // 往外伸的電極
        parts.push(
          ...around(level >= 4 ? 4 : 2, (a) =>
            merge([
              tint(new CylinderGeometry(0.018, 0.024, 0.3, 5).rotateZ(-0.9).translate(0.2, 0.74, 0).rotateY(a), IRON_DARK),
              tint(new SphereGeometry(0.04, 6, 5).translate(0.33, 0.84, 0).rotateY(a), copper),
            ]),
          ),
        )
      }
      break
    }
    case 'poison':
      parts.push(
        tube(0.07, 0.1, 0.3, 0, 0.26, 0, 0x4d7a2f, 6),
        tint(new ConeGeometry(0.2, 0.08, 6).translate(0, 0.32, 0), 0x3f9b4b),
        box(0.34, 0.03, 0.1, 0.16, 0.4, 0, 0x57b862),
        box(0.1, 0.03, 0.34, 0, 0.36, -0.16, 0x57b862),
      )
      if (level >= 2) parts.push(box(0.34, 0.03, 0.1, -0.16, 0.34, 0, 0x4aa856), box(0.1, 0.03, 0.34, 0, 0.42, 0.16, 0x4aa856))
      if (level >= 3) {
        // 一圈往外長的刺
        parts.push(...around(6, (a) => tint(new ConeGeometry(0.035, 0.2, 4).rotateZ(-1.1).translate(0.3, 0.3, 0).rotateY(a), 0x2f7d3a), 0.4))
      }
      if (level >= 4) {
        // 兩顆小花苞
        for (const side of [-1, 1]) {
          parts.push(
            tint(new CylinderGeometry(0.02, 0.028, 0.3, 5).rotateZ(-side * 0.5).translate(side * 0.2, 0.5, -0.06), 0x4d7a2f),
            ball(0.07, side * 0.28, 0.66, -0.06, 0xa64ac9, 1.1, 7),
          )
        }
      }
      break
    case 'sniper':
      parts.push(
        box(0.07, 0.9, 0.07, -0.15, 0.7, -0.15, WOOD),
        box(0.07, 0.9, 0.07, 0.15, 0.7, -0.15, WOOD),
        box(0.07, 0.9, 0.07, -0.15, 0.7, 0.15, WOOD),
        box(0.07, 0.9, 0.07, 0.15, 0.7, 0.15, WOOD),
        box(0.44, 0.06, 0.44, 0, 0.62, 0, WOOD_DARK),
        box(0.5, 0.07, 0.5, 0, 1.08, 0, WOOD_DARK),
      )
      if (level >= 2) {
        // 四面的斜撐
        parts.push(...around(4, (a) => tint(new BoxGeometry(0.035, 0.52, 0.035).rotateZ(0.6).translate(0, 0.86, 0.17).rotateY(a), WOOD_DARK)))
      }
      if (level >= 3) {
        const metal = level >= 4 ? GOLD : IRON
        parts.push(...around(4, (a) => box(0.1, 0.1, 0.1, Math.cos(a) * 0.33, 1.09, Math.sin(a) * 0.33, metal), Math.PI / 4))
      }
      if (level >= 4) parts.push(...banner(-0.2, 1.1, -0.2, RED))
      break
    case 'beacon':
      parts.push(tube(0.08, 0.13, 0.86, 0, 0.26, 0, 0xe9e2d0, 8), hoop(0.13, 0.03, 0.6, GOLD), box(0.02, 0.26, 0.3, 0, 0.86, 0.19, RED))
      if (level >= 2) parts.push(hoop(0.15, 0.03, 0.4, GOLD))
      if (level >= 3) {
        // 往兩邊吹的號角
        parts.push(
          ...around(level >= 4 ? 4 : 2, (a) => tint(new ConeGeometry(0.075, 0.24, 7, 1, true).rotateZ(Math.PI / 2).translate(0.2, 0.98, 0).rotateY(a), GOLD)),
        )
      }
      if (level >= 4) parts.push(box(0.02, 0.26, 0.3, 0, 0.56, -0.19, RED), hoop(0.11, 0.025, 1.08, GOLD))
      break
  }
  return merge(parts)
}

/** 會轉的那一截，原點在轉軸上（裝在 `TOWER_LOOK[kind].headY` 的高度）；`level` 是 1～4 */
export function towerHead(kind: TowerId, level: number): Shape {
  switch (kind) {
    case 'bolt': {
      // 弩：弩身、兩片弓臂、搭在上面的箭；3 級變成兩支箭，4 級三支、金箭頭
      const tip = level >= 4 ? GOLD : 0x9aa3ad
      const arm = level >= 2 ? 0.4 : 0.34
      const parts = [
        box(level >= 3 ? 0.16 : 0.1, 0.08, 0.56, 0, 0.02, 0.04, WOOD_DARK),
        box(arm, 0.05, 0.07, -arm / 2, 0.03, 0.22, 0xc9b38a),
        box(arm, 0.05, 0.07, arm / 2, 0.03, 0.22, 0xc9b38a),
        box(0.05, 0.05, 0.14, -arm + 0.01, 0.03, 0.16, level >= 2 ? IRON : 0xc9b38a),
        box(0.05, 0.05, 0.14, arm - 0.01, 0.03, 0.16, level >= 2 ? IRON : 0xc9b38a),
      ]
      const arrows = level >= 4 ? [-0.07, 0, 0.07] : level >= 3 ? [-0.045, 0.045] : [0]
      for (const x of arrows) {
        parts.push(
          tint(new CylinderGeometry(0.018, 0.018, 0.5, 5).rotateX(Math.PI / 2).translate(x, 0.08, 0.11), 0xf2e6c8),
          tint(new ConeGeometry(0.04, 0.1, 5).rotateX(Math.PI / 2).translate(x, 0.08, 0.4), tip),
        )
      }
      if (level >= 2) parts.push(box(0.14, 0.1, 0.1, 0, 0.02, -0.26, IRON))
      if (level >= 4) parts.push(box(0.18, 0.03, 0.2, 0, 0.075, -0.02, GOLD))
      return merge(parts)
    }
    case 'cannon': {
      // 砲：越升級砲管越長、越粗，4 級是雙管
      const length = [0.5, 0.56, 0.6, 0.6][level - 1]
      const bore = [0.1, 0.105, 0.125, 0.095][level - 1]
      const ringColor = level >= 4 ? GOLD : BRONZE
      const parts = [ball(level >= 3 ? 0.27 : 0.24, 0, 0.02, 0, IRON_DARK, 0.9, 10), box(level >= 4 ? 0.3 : 0.12, 0.12, 0.2, 0, 0.06, -0.22, IRON)]
      for (const x of level >= 4 ? [-0.105, 0.105] : [0]) {
        parts.push(barrel(bore, length, 0.06, 0, IRON, 10, x), barrel(bore + 0.025, 0.08, 0.06, length - 0.06, ringColor, 10, x))
        if (level >= 2) parts.push(barrel(bore + 0.02, 0.05, 0.06, length * 0.45, ringColor, 10, x))
      }
      if (level >= 3) {
        // 兩邊的砲耳
        for (const side of [-1, 1]) {
          parts.push(tint(new CylinderGeometry(0.09, 0.09, 0.07, 8).rotateZ(Math.PI / 2).translate(side * (level >= 4 ? 0.26 : 0.2), 0.03, 0.02), IRON))
        }
      }
      return merge(parts)
    }
    case 'frost': {
      // 懸在半空的冰晶：越升級越大顆、旁邊繞的碎冰越多
      const size = [0.22, 0.24, 0.27, 0.3][level - 1]
      const parts = [tint(new OctahedronGeometry(size, 0).scale(0.8, 1.35, 0.8), 0xbfeaff)]
      const shards = [3, 5, 6, 8][level - 1]
      parts.push(
        ...around(shards, (a, i) =>
          tint(new OctahedronGeometry(0.06 + (i % 3) * 0.015, 0).translate(Math.cos(a) * (size + 0.06), ((i % 3) - 1) * 0.11, Math.sin(a) * (size + 0.06)), 0xe8f8ff),
        ),
      )
      if (level >= 4) parts.push(tint(new OctahedronGeometry(0.1, 0).scale(0.8, 1.3, 0.8).translate(0, size * 1.35 + 0.12, 0), 0xffffff))
      return merge(parts)
    }
    case 'tesla': {
      const size = [0.15, 0.165, 0.18, 0.2][level - 1]
      const parts = [ball(size, 0, 0, 0, 0xfff07a, 1, 10), tint(new TorusGeometry(size + 0.05, 0.02, 4, 14).rotateX(Math.PI / 2), 0xffd23f)]
      if (level >= 3) parts.push(tint(new TorusGeometry(size + 0.05, 0.02, 4, 14), 0xffd23f))
      if (level >= 4) {
        parts.push(
          tint(new TorusGeometry(size + 0.05, 0.02, 4, 14).rotateY(Math.PI / 2), 0xffd23f),
          ...around(4, (a) => ball(0.04, Math.cos(a) * (size + 0.14), 0, Math.sin(a) * (size + 0.14), 0xfffbe0, 1, 6), Math.PI / 4),
        )
      }
      return merge(parts)
    }
    case 'poison': {
      // 花苞：中間一顆毒囊，花瓣越升級越多層
      const size = [0.17, 0.185, 0.2, 0.22][level - 1]
      const petals = [4, 4, 6, 8][level - 1]
      const parts = [ball(size, 0, 0.06, 0, 0xa64ac9, 1.1, 10), ball(0.05, 0.06, 0.06 + size * 1.02, 0.04, 0xe3a6ff, 1, 6)]
      parts.push(
        ...around(petals, (a, i) => tint(new ConeGeometry(0.1, 0.3, 4).rotateZ(-0.9).translate(size + 0.03, 0.02, 0).rotateY(a), i % 2 ? 0x3f9b4b : 0x57b862)),
      )
      if (level >= 2) parts.push(ball(0.04, -0.07, 0.06 + size * 0.95, -0.05, 0xe3a6ff, 1, 6))
      if (level >= 4) {
        parts.push(...around(4, (a) => tint(new ConeGeometry(0.07, 0.24, 4).rotateZ(-0.45).translate(size * 0.75, 0.2, 0).rotateY(a), 0x6fcf7a), Math.PI / 4))
      }
      return merge(parts)
    }
    case 'sniper': {
      // 重弩：長長的弩身、寬弓臂、瞄準鏡；3 級加了護盾，4 級雙層弓臂、金箭頭
      const metal = level >= 4 ? GOLD : IRON
      const parts = [
        box(0.1, 0.1, 0.9, 0, 0.02, 0.1, WOOD_DARK),
        box(0.5, 0.05, 0.07, -0.25, 0.03, 0.48, IRON),
        box(0.5, 0.05, 0.07, 0.25, 0.03, 0.48, IRON),
        box(0.06, 0.05, 0.2, -0.49, 0.03, 0.38, IRON),
        box(0.06, 0.05, 0.2, 0.49, 0.03, 0.38, IRON),
        barrel(0.025, 0.86, 0.1, -0.1, 0xf2e6c8, 5),
        tint(new ConeGeometry(0.055, 0.16, 5).rotateX(Math.PI / 2).translate(0, 0.1, 0.8), level >= 4 ? GOLD : 0xc9d3dc),
        barrel(level >= 2 ? 0.05 : 0.04, level >= 2 ? 0.3 : 0.24, 0.17, -0.2, IRON_DARK, 6),
        box(0.16, 0.14, 0.12, 0, 0, -0.36, WOOD),
      ]
      if (level >= 2) parts.push(box(0.14, 0.04, 0.14, 0, 0.09, 0.42, metal))
      if (level >= 3) {
        for (const side of [-1, 1]) parts.push(tint(new BoxGeometry(0.03, 0.22, 0.26).rotateY(side * 0.35).translate(side * 0.16, 0.06, 0.62), metal))
      }
      if (level >= 4) parts.push(box(0.4, 0.04, 0.06, -0.2, 0.11, 0.44, IRON_DARK), box(0.4, 0.04, 0.06, 0.2, 0.11, 0.44, IRON_DARK))
      return merge(parts)
    }
    case 'beacon': {
      // 號角：金環和中間的光球，越升級環越多
      const size = [0.11, 0.125, 0.14, 0.16][level - 1]
      const r = size + 0.09
      const parts = [ball(size, 0, 0, 0, 0xfff2b0, 1, 10), tint(new TorusGeometry(r, 0.03, 5, 14), 0xffd23f), tint(new TorusGeometry(r, 0.03, 5, 14).rotateY(Math.PI / 2), 0xffd23f)]
      if (level >= 3) parts.push(tint(new TorusGeometry(r, 0.03, 5, 14).rotateX(Math.PI / 2), 0xffd23f))
      if (level >= 4) {
        parts.push(...around(4, (a) => tint(new OctahedronGeometry(0.05, 0).translate(Math.cos(a) * (r + 0.1), 0, Math.sin(a) * (r + 0.1)), 0xfffbe0), Math.PI / 4))
      }
      return merge(parts)
    }
  }
}
