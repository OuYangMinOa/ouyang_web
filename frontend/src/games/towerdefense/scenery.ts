import {
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  OctahedronGeometry,
  SphereGeometry,
  Vector3,
} from 'three'
import { ball, box, merge, tint, tube, type Shape } from './models'
import type { Biome } from './palette'

/**
 * 場地上的擺設：周圍的樹、灌木、草、小花，格子裡的岩石，入口的石柱和出口的水晶座。
 * 和塔、怪物一樣用基本形狀拼、顏色寫在頂點上；同一種的用 InstancedMesh 一次畫完。
 * 每種地貌（草原、森林、秋天、峽谷）長的東西不一樣。
 */

const TRUNK = 0x7a5230
const TRUNK_DARK = 0x5f3f24

const blob = (r: number, x: number, y: number, z: number, color: number, sy = 1, detail = 0) =>
  tint(new IcosahedronGeometry(r, detail).scale(1, sy, 1).translate(x, y, z), color)

const cone = (r: number, h: number, x: number, y: number, z: number, color: number, sides = 6) =>
  tint(new ConeGeometry(r, h, sides).translate(x, y + h / 2, z), color)

/** 樹：每種地貌兩個樣子（`variant` 0 或 1），原點在樹根 */
export function treeGeometry(biome: Biome, variant: number): Shape {
  switch (biome) {
    case 'forest':
      // 松樹：一層一層的圓錐
      return variant === 0
        ? merge([
            tube(0.05, 0.07, 0.22, 0, 0, 0, TRUNK_DARK, 5),
            cone(0.3, 0.42, 0, 0.16, 0, 0x2c6a45, 7),
            cone(0.24, 0.38, 0, 0.4, 0, 0x34794e, 7),
            cone(0.16, 0.34, 0, 0.64, 0, 0x3f8a59, 7),
          ])
        : merge([
            tube(0.045, 0.06, 0.2, 0, 0, 0, TRUNK_DARK, 5),
            cone(0.24, 0.4, 0, 0.14, 0, 0x2a6342, 6),
            cone(0.17, 0.36, 0, 0.38, 0, 0x377f52, 6),
          ])
    case 'autumn':
      // 秋天的樹：橘、黃、紅的樹冠
      return variant === 0
        ? merge([
            tube(0.05, 0.075, 0.34, 0, 0, 0, TRUNK, 5),
            blob(0.3, 0, 0.56, 0, 0xd9822b, 0.9),
            blob(0.2, 0.2, 0.46, 0.06, 0xe8a23a),
            blob(0.18, -0.18, 0.5, -0.08, 0xc4532a),
          ])
        : merge([
            tube(0.045, 0.065, 0.3, 0, 0, 0, TRUNK, 5),
            blob(0.26, 0, 0.5, 0, 0xe3b23c, 0.95),
            blob(0.17, -0.16, 0.42, 0.08, 0xd9822b),
          ])
    case 'canyon':
      // 仙人掌和枯樹
      return variant === 0
        ? merge([
            tube(0.085, 0.095, 0.52, 0, 0, 0, 0x5c9a5a, 7),
            ball(0.085, 0, 0.52, 0, 0x6aa866, 1, 7),
            tint(new CylinderGeometry(0.05, 0.05, 0.16, 6).rotateZ(Math.PI / 2).translate(0.13, 0.26, 0), 0x528b50),
            tube(0.05, 0.05, 0.18, 0.2, 0.25, 0, 0x5c9a5a, 6),
            ball(0.05, 0.2, 0.43, 0, 0x6aa866, 1, 6),
            tint(new CylinderGeometry(0.045, 0.045, 0.13, 6).rotateZ(Math.PI / 2).translate(-0.11, 0.34, 0), 0x528b50),
            tube(0.045, 0.045, 0.13, -0.17, 0.33, 0, 0x5c9a5a, 6),
            ball(0.045, -0.17, 0.46, 0, 0x6aa866, 1, 6),
          ])
        : merge([
            tube(0.035, 0.06, 0.4, 0, 0, 0, 0x8a7358, 5),
            tint(new CylinderGeometry(0.018, 0.03, 0.26, 4).rotateZ(-0.8).translate(0.1, 0.42, 0), 0x8a7358),
            tint(new CylinderGeometry(0.016, 0.028, 0.22, 4).rotateZ(0.9).translate(-0.09, 0.36, 0.02), 0x7a6650),
            tint(new CylinderGeometry(0.014, 0.022, 0.18, 4).rotateX(0.8).translate(0, 0.46, 0.07), 0x7a6650),
          ])
    default:
      // 草原：圓圓的闊葉樹
      return variant === 0
        ? merge([
            tube(0.05, 0.075, 0.36, 0, 0, 0, TRUNK, 5),
            blob(0.3, 0, 0.58, 0, 0x5faa3a, 0.92),
            blob(0.2, 0.19, 0.48, 0.08, 0x74bd48),
            blob(0.18, -0.18, 0.52, -0.06, 0x4f9632),
          ])
        : merge([
            tube(0.045, 0.065, 0.3, 0, 0, 0, TRUNK, 5),
            blob(0.25, 0, 0.5, 0, 0x6bb542, 0.95),
            blob(0.16, 0.14, 0.4, -0.1, 0x57a236),
          ])
  }
}

/** 灌木（峽谷是乾枯的草球） */
export function bushGeometry(biome: Biome): Shape {
  const [a, b, c] =
    biome === 'forest'
      ? [0x2f7248, 0x3a8355, 0x286140]
      : biome === 'autumn'
        ? [0xc98a2e, 0xb5622a, 0xd9a13c]
        : biome === 'canyon'
          ? [0xb59a62, 0xa3884f, 0xc4ab74]
          : [0x4f9c38, 0x63b045, 0x418a2e]
  return merge([
    blob(0.17, 0, 0.11, 0, a, 0.8),
    blob(0.12, 0.14, 0.08, 0.04, b, 0.8),
    blob(0.11, -0.13, 0.08, -0.03, c, 0.8),
  ])
}

/** 一撮草：幾片往外倒的葉子 */
export function tuftGeometry(biome: Biome): Shape {
  const [a, b] =
    biome === 'forest' ? [0x3a8355, 0x2f7248] : biome === 'autumn' ? [0xb9a03a, 0x9c8a30] : biome === 'canyon' ? [0xc4ab74, 0xa89058] : [0x63b045, 0x4f9c38]
  const blade = (lean: number, turn: number, h: number, color: number) =>
    tint(new ConeGeometry(0.022, h, 3).translate(0, h / 2, 0).rotateZ(lean).rotateY(turn), color)
  return merge([blade(0.28, 0, 0.17, a), blade(-0.32, 0.9, 0.14, b), blade(0.36, 2.2, 0.13, a), blade(-0.2, 3.6, 0.16, b), blade(0.05, 4.9, 0.19, a)])
}

/** 點綴：草原是小花、森林是蘑菇、秋天是南瓜、峽谷是開花的圓仙人掌（花和傘的顏色是白的，由每一個的顏色去染） */
export function accentGeometry(biome: Biome): Shape {
  switch (biome) {
    case 'forest':
      return merge([
        tube(0.022, 0.028, 0.08, 0, 0, 0, 0xf2ead8, 5),
        tint(new SphereGeometry(0.07, 7, 5, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.07, 0), 0xffffff),
        tube(0.016, 0.02, 0.05, 0.08, 0, 0.03, 0xf2ead8, 5),
        tint(new SphereGeometry(0.045, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(0.08, 0.045, 0.03), 0xffffff),
      ])
    case 'autumn':
      return merge([
        tint(new SphereGeometry(0.085, 8, 6).scale(1, 0.72, 1).translate(0, 0.06, 0), 0xffffff),
        tube(0.012, 0.018, 0.045, 0, 0.11, 0, 0x5f7a2e, 4),
      ])
    case 'canyon':
      return merge([
        tint(new SphereGeometry(0.075, 8, 6).scale(1, 0.85, 1).translate(0, 0.06, 0), 0x5c9a5a),
        ball(0.026, 0, 0.13, 0, 0xffffff, 1, 5),
      ])
    default:
      return merge([
        tube(0.008, 0.01, 0.1, 0, 0, 0, 0x4f9c38, 3),
        ball(0.03, 0, 0.115, 0, 0xffffff, 0.7, 6),
        ball(0.014, 0, 0.128, 0, 0xffd23f, 0.8, 5),
      ])
  }
}

/** 點綴可以染成哪幾種顏色（每一個隨機挑一種） */
export const ACCENT_TINTS: Record<Biome, number[]> = {
  meadow: [0xffffff, 0xffe27a, 0xffb3d1, 0xc9b8ff],
  forest: [0xd9483b, 0xe8833a, 0xc9a26b],
  autumn: [0xf08a24, 0xe06a1c, 0xf2a93b],
  canyon: [0xff7fb0, 0xffd23f],
}

/**
 * 岩石：`variant` 三種樣子。朝上的面可以長一點青苔（`moss` 是青苔的顏色，沒有就傳 null）。
 * 模型本身是中性的灰色，地貌的色調由每一顆的顏色去乘。
 */
export function rockGeometry(variant: number, moss: number | null): Shape {
  const stone = (r: number, x: number, y: number, z: number, color: number, sx = 1, sy = 1, sz = 1, turn = 0) =>
    tint(new DodecahedronGeometry(r, 0).scale(sx, sy, sz).rotateY(turn).translate(x, y, z), color)
  const parts =
    variant === 0
      ? [stone(0.38, 0, 0.22, 0, 0x9c9992, 1.05, 0.8, 0.95), stone(0.2, 0.26, 0.12, 0.2, 0x86837d), stone(0.16, -0.28, 0.1, -0.18, 0xb0ada6)]
      : variant === 1
        ? [
            stone(0.3, -0.08, 0.2, 0.04, 0x94918a, 1, 0.95, 1, 0.6),
            stone(0.26, 0.2, 0.15, -0.14, 0xa6a39c, 1, 0.8, 1, 1.4),
            stone(0.13, -0.3, 0.08, 0.24, 0x7f7c76),
            stone(0.1, 0.3, 0.06, 0.26, 0xb0ada6),
          ]
        : [stone(0.34, 0.03, 0.3, -0.02, 0x8d8a84, 0.9, 1.25, 0.9, 0.3), stone(0.22, -0.24, 0.13, 0.16, 0xa19e98, 1, 0.85, 1, 2), stone(0.14, 0.28, 0.08, 0.14, 0x77746f)]
  const g = merge(parts)
  if (moss !== null) mossify(g, moss)
  return g
}

/** 朝上的面混一點青苔的顏色（幾何是攤平的，三個頂點一個面） */
function mossify(g: Shape, moss: number) {
  const position = g.getAttribute('position')
  const colors = g.getAttribute('color') as BufferAttribute
  const green = new Color(moss)
  const [a, b, c, n] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]
  for (let i = 0; i + 2 < position.count; i += 3) {
    a.fromBufferAttribute(position, i)
    b.fromBufferAttribute(position, i + 1)
    c.fromBufferAttribute(position, i + 2)
    n.crossVectors(b.sub(a), c.sub(a)).normalize()
    const up = (n.y - 0.45) / 0.55
    if (up <= 0) continue
    const amount = Math.min(1, up) * 0.75
    for (let k = 0; k < 3; k++) {
      colors.setXYZ(
        i + k,
        colors.getX(i + k) + (green.r - colors.getX(i + k)) * amount,
        colors.getY(i + k) + (green.g - colors.getY(i + k)) * amount,
        colors.getZ(i + k) + (green.b - colors.getZ(i + k)) * amount,
      )
    }
  }
  colors.needsUpdate = true
}

/** 小石子（周圍的草地上、池塘邊） */
export function pebbleGeometry(): Shape {
  return merge([
    tint(new DodecahedronGeometry(0.09, 0).scale(1.1, 0.7, 0.9).translate(0, 0.045, 0), 0xa19e98),
    tint(new DodecahedronGeometry(0.055, 0).translate(0.11, 0.03, 0.05), 0x86837d),
  ])
}

/** 池塘邊的蘆葦 */
export function reedGeometry(): Shape {
  const stalk = (x: number, z: number, h: number, lean: number) =>
    tint(new CylinderGeometry(0.008, 0.012, h, 3).translate(0, h / 2, 0).rotateZ(lean).translate(x, 0, z), 0x5f8f3a)
  const head = (x: number, z: number, h: number, lean: number) =>
    tint(
      new CylinderGeometry(0.02, 0.02, 0.07, 5)
        .translate(0, h, 0)
        .rotateZ(lean)
        .translate(x, 0, z),
      0x6f4720,
    )
  return merge([stalk(0, 0, 0.3, 0.08), head(0, 0, 0.3, 0.08), stalk(0.05, 0.03, 0.24, -0.14), head(0.05, 0.03, 0.24, -0.14), stalk(-0.04, 0.04, 0.2, 0.2)])
}

/** 入口旁邊的石柱：往上收的四角柱，原點在柱腳 */
export function obeliskGeometry(): Shape {
  return merge([
    box(0.2, 0.06, 0.2, 0, 0.03, 0, 0x6f6a78),
    tint(new CylinderGeometry(0.055, 0.085, 0.44, 4).rotateY(Math.PI / 4).translate(0, 0.28, 0), 0x837d8f),
    tint(new ConeGeometry(0.078, 0.1, 4).rotateY(Math.PI / 4).translate(0, 0.55, 0), 0x5d586a),
  ])
}

/** 出口的水晶座：兩層八角的石階，四個角各一顆小石墩 */
export function daisGeometry(): Shape {
  const parts = [tube(0.44, 0.47, 0.09, 0, 0, 0, 0x9a948a, 8), tube(0.32, 0.36, 0.1, 0, 0.09, 0, 0x837d74, 8), tube(0.17, 0.22, 0.12, 0, 0.19, 0, 0x9a948a, 6)]
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2
    parts.push(tube(0.05, 0.065, 0.13, Math.cos(angle) * 0.4, 0.09, Math.sin(angle) * 0.4, 0x837d74, 5))
  }
  return merge(parts)
}

/** 出口的大水晶（顏色由材質決定，跟著主題換），原點在水晶中心 */
export function crystalGeometry(): Shape {
  const shard = (r: number, sy: number, x: number, y: number, z: number, lean: number, turn: number) =>
    new OctahedronGeometry(r, 0).scale(0.72, sy, 0.72).rotateZ(lean).rotateY(turn).translate(x, y, z)
  const parts = [shard(0.3, 1.6, 0, 0, 0, 0, 0.4), shard(0.14, 1.5, 0.2, -0.2, 0.06, -0.45, 0), shard(0.12, 1.4, -0.18, -0.24, -0.08, 0.5, 1.2), shard(0.1, 1.3, 0.02, -0.26, 0.2, 0.4, 2.4)]
  const g = merge(parts.map((p) => tint(p, 0xffffff)))
  g.deleteAttribute('color')
  return g
}
