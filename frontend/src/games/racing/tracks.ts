// 三條賽道：控制點連成封閉的平滑曲線（Catmull-Rom），其餘的路面、護欄、地形、擺設都從這裡的設定長出來。
// 座標單位是公尺：x 往東、z 往南、高度 y。起跑線在第一個控制點，前兩個控制點之間是直線。
import { Color } from 'three'
import { fbm, lerp, smoothstep } from './noise'

export type PropKind = 'tree' | 'palm' | 'cactus' | 'rock' | 'building'

export type PropSpec = {
  kind: PropKind
  count: number
  /** 離護欄最近、最遠多少公尺 */
  near: number
  far: number
  /** 地面低於這個高度就不放（海邊不種樹） */
  minY?: number
  /** 岩石的顏色 */
  color?: number
  seed: number
}

export type TrackTheme = {
  skyTop: number
  skyHorizon: number
  /** 天空裡太陽（夜裡是月亮）的光暈顏色 */
  skySun: number
  fogNear: number
  fogFar: number
  sunColor: number
  sunIntensity: number
  sunDir: [number, number, number]
  hemiSky: number
  hemiGround: number
  hemiIntensity: number
  road: number
  roadLine: number
  curb: [number, number]
  /** 路面和護欄之間的緩衝區 */
  shoulder: number
  wall: number
  wallHeight: number
  /** 夜間賽道：護欄頂端的霓虹燈條 */
  wallGlow?: number
  water?: { level: number; color: number }
  /** 甩尾、開出路面揚起的煙塵 */
  dust: number
  night?: boolean
}

export type TrackDef = {
  id: string
  name: string
  blurb: string
  /** 路面半寬（公尺） */
  halfWidth: number
  /** 路面邊緣到護欄的距離 */
  runoff: number
  /** 控制點 [x, z, 高度] */
  points: [number, number, number][]
  theme: TrackTheme
  /** 離賽道 `dist` 公尺以外的地形高度；`roadY` 是最近那段路的高度 */
  terrain: (x: number, z: number, dist: number, roadY: number) => number
  /** 地形頂點的顏色 */
  paint: (y: number, dist: number, x: number, z: number, out: Color) => void
  props: PropSpec[]
}

const c = (hex: number) => new Color(hex)

const COAST_SAND = c(0xd8c393)
const COAST_GRASS = c(0x6ea24a)
const COAST_DRY = c(0x9aa45c)
const COAST_ROCK = c(0x8b8676)

const CANYON_FLOOR = c(0xc8875a)
const CANYON_BANDS = [c(0xa24d2b), c(0xc96f3e), c(0xe2a46c), c(0xb85c34)]

const CITY_GROUND = c(0x17181f)
const CITY_PARK = c(0x1d2a22)

export const TRACKS: TrackDef[] = [
  {
    id: 'coast',
    name: '海岸環線',
    blurb: '藍天、海風和長長的高速彎，路面寬，適合第一次上手。',
    halfWidth: 8,
    runoff: 6,
    points: [
      [0, 0, 0],
      [200, 0, 0],
      [330, -40, 4],
      [380, -160, 9],
      [320, -280, 11],
      [180, -300, 7],
      [100, -220, 3],
      [0, -260, 1],
      [-120, -330, 2],
      [-250, -280, 5],
      [-300, -150, 7],
      [-260, -40, 3],
      [-150, 20, 0],
    ],
    theme: {
      skyTop: 0x3f86d8,
      skyHorizon: 0xcfe5f3,
      skySun: 0xfff3d6,
      fogNear: 260,
      fogFar: 1000,
      sunColor: 0xfff1d8,
      sunIntensity: 2.3,
      sunDir: [0.45, 0.8, 0.4],
      hemiSky: 0xe2f0ff,
      hemiGround: 0x5d6b3c,
      hemiIntensity: 1.35,
      road: 0x56585e,
      roadLine: 0xf4f4f0,
      curb: [0xd63a2f, 0xf3f3f3],
      shoulder: 0x7aa951,
      wall: 0xe4e6e8,
      wallHeight: 0.9,
      water: { level: -1.2, color: 0x2b86c4 },
      dust: 0xd9d4c8,
    },
    terrain: (x, z, dist, roadY) => {
      const hills = (fbm(x / 230, z / 230, 7) - 0.35) * 34 + Math.max(0, dist - 90) * 0.1
      // 南邊是海：越往南地面越低，沉到海平面下
      const sea = smoothstep(40, 230, z)
      return lerp(lerp(roadY, hills, smoothstep(0, 120, dist)), -7, sea)
    },
    paint: (y, dist, x, z, out) => {
      // 沙灘只在靠海的低地；賽道旁邊的地形貼著路面所以也很低，但那裡是草地
      if (y < 0.3 && dist > 50) out.copy(COAST_SAND)
      else out.lerpColors(COAST_GRASS, COAST_DRY, fbm(x / 60, z / 60, 3))
      if (y > 16) out.lerp(COAST_ROCK, smoothstep(16, 30, y))
    },
    props: [
      { kind: 'tree', count: 520, near: 5, far: 170, minY: 0.6, seed: 11 },
      { kind: 'palm', count: 90, near: 3, far: 40, minY: 0.2, seed: 12 },
      { kind: 'rock', count: 60, near: 6, far: 120, seed: 13, color: 0x8f8b80 },
    ],
  },
  {
    id: 'canyon',
    name: '紅岩峽谷',
    blurb: '夕陽下的峽谷，上下坡和兩個急彎，甩尾過彎可以集氣加速。',
    halfWidth: 7.5,
    runoff: 4.5,
    points: [
      [0, 0, 0],
      [180, 0, 0],
      [280, -50, 5],
      [300, -160, 12],
      [230, -230, 18],
      [120, -200, 21],
      [60, -280, 17],
      [-60, -300, 12],
      [-130, -220, 8],
      [-70, -150, 6],
      [-160, -95, 4],
      [-225, -35, 2],
      [-140, 22, 0],
    ],
    theme: {
      skyTop: 0x4c69ad,
      skyHorizon: 0xf6b77c,
      skySun: 0xffc58a,
      fogNear: 200,
      fogFar: 880,
      sunColor: 0xffc08a,
      sunIntensity: 2.6,
      sunDir: [-0.65, 0.32, 0.5],
      hemiSky: 0xffd6ae,
      hemiGround: 0x7a3f22,
      hemiIntensity: 1.2,
      road: 0x5c524c,
      roadLine: 0xf2e6c8,
      curb: [0xd63a2f, 0xf3f3f3],
      shoulder: 0xc58a5f,
      wall: 0x4a3c36,
      wallHeight: 1,
      dust: 0xd59a68,
    },
    terrain: (x, z, dist, roadY) => {
      // 路兩旁三十幾公尺外就是陡峭的紅岩壁
      const cliff = 26 + fbm(x / 70, z / 70, 5) * 34
      return roadY + smoothstep(28, 70, dist) * cliff + Math.max(0, dist - 160) * 0.05
    },
    paint: (y, dist, x, z, out) => {
      if (dist < 34) {
        out.copy(CANYON_FLOOR)
        return
      }
      // 岩壁一層一層的條紋
      const band = (y + fbm(x / 40, z / 40, 9) * 6) / 5
      const i = Math.floor(band)
      const t = band - i
      const a = CANYON_BANDS[((i % 4) + 4) % 4]
      const b = CANYON_BANDS[(((i + 1) % 4) + 4) % 4]
      out.lerpColors(a, b, smoothstep(0.7, 1, t))
      out.lerp(CANYON_FLOOR, 1 - smoothstep(34, 46, dist))
    },
    props: [
      { kind: 'cactus', count: 170, near: 3, far: 26, seed: 21 },
      { kind: 'rock', count: 200, near: 3, far: 16, seed: 22, color: 0xa35a3a },
    ],
  },
  {
    id: 'city',
    name: '霓虹夜城',
    blurb: '夜裡的市區街道，九十度彎一個接一個，路窄要早點煞車。',
    halfWidth: 7,
    runoff: 2.5,
    points: [
      [0, 0, 0],
      [130, 0, 0],
      [246, 0, 0],
      [270, -24, 0],
      [270, -136, 0],
      [246, -160, 0],
      [104, -160, 0],
      [80, -184, 0],
      [80, -306, 0],
      [56, -330, 0],
      [-146, -330, 0],
      [-170, -306, 0],
      [-170, -250, 0],
      [-150, -215, 0],
      [-170, -180, 0],
      [-170, -24, 0],
      [-146, 0, 0],
    ],
    theme: {
      skyTop: 0x060818,
      skyHorizon: 0x2c2150,
      skySun: 0x9fb2ff,
      fogNear: 110,
      fogFar: 620,
      sunColor: 0xa9b8ff,
      sunIntensity: 1.1,
      sunDir: [0.3, 0.75, -0.45],
      hemiSky: 0x8a90d8,
      hemiGround: 0x2a2238,
      hemiIntensity: 1.7,
      road: 0x34353d,
      roadLine: 0xd9dbe8,
      curb: [0xff2e88, 0x2ee6ff],
      shoulder: 0x2a2b33,
      wall: 0x3b3e4a,
      wallHeight: 1,
      wallGlow: 0x2ee6ff,
      dust: 0x8e8aa6,
      night: true,
    },
    terrain: () => -0.4,
    paint: (_y, dist, x, z, out) => {
      out.copy(CITY_GROUND)
      if (dist > 40) out.lerp(CITY_PARK, smoothstep(0.55, 0.7, fbm(x / 90, z / 90, 4)))
    },
    props: [{ kind: 'building', count: 230, near: 8, far: 190, seed: 31 }],
  },
]

export function findTrack(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0]
}
