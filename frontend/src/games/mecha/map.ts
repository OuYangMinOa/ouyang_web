// 機甲對戰的地圖「赤鋼河岸」：一大片城區，中間一條南北向的河把兩隊隔開，
// 西邊是紅隊的重生點（機庫）、東邊是藍隊的。
//
// 兩岸長得不一樣（不是點對稱），但兩隊的機庫一樣，從機庫走到每一個過河的地方也差不多遠：
//   - 西岸是老城區：紅磚街屋、圍著中庭的街廓、窄巷；北邊是鐵路調車場，河岸上一條高架快速道路；南邊有一座墊高的公園
//   - 東岸是新市區和港口：玻璃帷幕的高樓、螺旋形的交流道、立體停車場，南邊是貨櫃碼頭，吊車跨在河岸道路上
//
// 過河的路（由北往南）：
//   - 高架快速道路（`EXPRESS` 公尺高）：西岸從河岸邊的坡道往北爬、沿著河岸走到轉角，L 形轉過河；
//     東岸接上交流道：直直往東下到大街，或繞一圈螺旋坡道下到河岸道路
//   - 人行鋼橋（`FOOTBRIDGE_Z`），和路面一樣高
//   - 中間的斜張大橋（`DECK` 公尺高、40 公尺寬的高架橋）：西岸的大道沿著一樣寬的引道爬上去；東岸的橋頭是一塊高架的平台，
//     南北兩條引道往東下去，大道從兩條引道中間穿過橋底下。
//     兩岸各分出一條支線：在河岸上轉彎、沿著河岸走（接上大樓 A 的二樓），再轉進內陸架在街上，最後一條坡道下到地面
//   每座橋都比路寬（20～40 公尺），一大群人過橋也擠得下
//   - 鋼桁架橋（`TRUSS_Z`），和路面一樣高，兩邊是鋼桁架
//   - 公路橋（`AVENUE_Z`），和路面一樣高，從兩岸的大街直接開過河
//   - 河床比路面低 8 公尺，兩岸各有四道下河的坡道（兩岸的位置不一樣），也可以跳下去、用推進器飛上來
//
// 兩岸各有兩棟走得進去的大樓（一模一樣，只有外觀不同）：四層加屋頂，靠河那一面開著可以往對岸狙擊，裡面的坡道一層層折返往上爬。
//
// 每個瀏覽器用同一套程式和同一個種子排出一樣的城市（物理和打中都在用戶端算，大家的大樓一定要在同一個位置）。
// 伺服器只知道重生點的範圍（`backend/src/mecha.rs` 的 `BASE_X`、`BASE_Z`），改了要一起改。
//
// 座標：x 往東、z 往南、y 往上，單位公尺。方向角 θ 的前方是 (sin θ, cos θ)。
import { rng } from '../racing/noise'

export type Team = 0 | 1

/** 地圖範圍：|x| ≤ MAP_X、|z| ≤ MAP_Z */
export const MAP_X = 330
export const MAP_Z = 460
/** 原本的城區（大橋附近）到 |z| ≤ INNER_Z，外面是外環街和更外面的街區 */
const INNER_Z = 220
/** 重生點（機庫）：紅隊 x ≤ -BASE.x、藍隊 x ≥ BASE.x，|z| ≤ BASE.z。敵人進不去，裡面的人打不到也不能開火 */
export const BASE = { x: 286, z: 30 }
/** 機庫的牆和屋頂多高（飛不上去：機甲最高只能飛到 `MechSpec.maxHover`） */
export const HANGAR_H = 22
/** 河道：|x| < RIVER 是河 */
export const RIVER = 36
/** 河床的高度（路面是 0） */
export const BED = -8
/** 水面的高度（水很淺，機甲涉水走） */
export const WATER = BED + 0.7
/** 大橋橋面的高度 */
export const DECK = 8
/** 大橋（高架橋）橋面的半寬：|z| ≤ BRIDGE_W，兩個方向各兩線道，中間一段段的分隔島 */
export const BRIDGE_W = 20
/** 北邊高架快速道路的高度（有推進器的勉強飛得上去） */
export const EXPRESS = 10
/** 快速道路過河那一段的中線、半寬（路寬 20 公尺） */
export const EXPRESS_Z = -385.5
export const EXPRESS_W = 10
/** 人行鋼橋、鋼桁架橋、南邊公路橋的位置和半寬（20、24、28 公尺寬） */
export const FOOTBRIDGE_Z = -186
export const FOOTBRIDGE_W = 10
export const TRUSS_Z = 186
export const TRUSS_W = 12
export const AVENUE_Z = 330
export const AVENUE_W = 14
/** 走得進去的大樓：二樓（和大橋一樣高）、三樓、四樓、屋頂的樓板高度（一樓是地面） */
export const FLOORS = [DECK, DECK + 10, DECK + 20, DECK + 30] as const
/** 東岸那兩棟走得進去的大樓佔的街廓（西岸的照原點轉 180 度）：A 在大橋北邊、二樓接著支線，B 在港口 */
const TOWER_A = { x0: 64, x1: 151, z0: -126, z1: -52 }
const TOWER_B = { x0: 64, x1: 140, z0: 237, z1: 321 }
/** 大橋的支線（東岸的座標）：沿著河岸到 `SPUR_Z` 那條街轉進內陸、架在街上到 `SPUR_X`，再一條坡道下到 `SPUR_END` */
const SPUR_Z = -133
const SPUR_X = 170
const SPUR_END = 216

export type BoxKind =
  | 'building'
  | 'tower'
  | 'house'
  | 'warehouse'
  | 'hangar'
  | 'wall'
  | 'container'
  | 'car'
  | 'bus'
  | 'barrier'
  | 'twall'
  | 'planter'
  | 'monument'
  | 'tree'
  | 'kiosk'
  | 'pillar'
  | 'crate'
  | 'rubble'
  | 'barge'
  /** 河岸的地面（看不到，只是讓河道比路面低） */
  | 'land'
  /** 高架的路面（薄薄一層，底下走得過去） */
  | 'deck'
  /** 實心的坡道、交流道的平台（柏油路面、底下填滿） */
  | 'ramp'
  /** 水泥的斜坡（下河的坡道、公園的步道） */
  | 'slipway'
  | 'parapet'
  | 'pier'
  | 'pylon'
  | 'rail'
  /** 調車場的火車車廂 */
  | 'railcar'
  /** 墊高的公園（石砌的擋土牆、上面是草地） */
  | 'mound'
  /** 走得進去的大樓：樓板（薄薄一層，底下是下一層）、柱子、矮牆、整片的牆 */
  | 'floor'
  | 'column'
  | 'sill'
  | 'facade'

/** 斜的頂面：沿著 `axis`，低的那一邊（x0 或 z0）高 h0，另一邊高 h1 */
export type Slope = { axis: 'x' | 'z'; h0: number; h1: number }

/** 一個擋得住東西的方塊（都和座標軸對齊），坡道的頂面是斜的 */
export type Box = {
  x0: number
  x1: number
  z0: number
  z1: number
  y0: number
  /** 最高的地方（有斜面時是 h0、h1 比較高的那個） */
  y1: number
  kind: BoxKind
  /** 外觀用的亂數（顏色、窗戶） */
  seed: number
  slope?: Slope
  /** 高架的路面：車道線沿著哪個方向畫（沒有就不畫，例如平台、停車場屋頂） */
  lanes?: 'x' | 'z'
}

/** 地面上畫的區塊（不擋東西）：人行道、公園、停車場、廣場、工地、河濱步道、調車場 */
export type Lot = {
  x0: number
  x1: number
  z0: number
  z1: number
  kind: 'block' | 'park' | 'parking' | 'plaza' | 'site' | 'apron' | 'promenade' | 'railyard'
}

/** 一段路的中心線：`axis` 是 x（東西向，z 固定）或 z（南北向，x 固定），從 a 到 b，寬 w */
export type Road = { axis: 'x' | 'z'; at: number; a: number; b: number; w: number }

export type Spawn = { x: number; z: number; yaw: number }

/** 狙擊點：自己這一隊的大樓裡靠河那一邊（三樓以上、屋頂），`yaw` 是面向河的方向 */
export type Perch = { x: number; y: number; z: number; yaw: number; team: Team }

export type MapData = {
  boxes: Box[]
  lots: Lot[]
  roads: Road[]
  /** 調車場的鐵軌（東西向，只是畫在地上） */
  tracks: { x0: number; x1: number; z: number }[]
  /** 每一隊的重生位置（照隊伍裡的順序分） */
  spawns: [Spawn[], Spawn[]]
  perches: Perch[]
  /** 電腦走的路網（y 是那個點的地面高度：同一個位置可能有橋上和橋下兩個點） */
  nodes: { x: number; y: number; z: number }[]
  links: number[][]
}

/** 方塊在 (x, z) 的頂面高度 */
export function topAt(b: Box, x: number, z: number): number {
  const s = b.slope
  if (!s) return b.y1
  const t = s.axis === 'x' ? (x - b.x0) / (b.x1 - b.x0) : (z - b.z0) / (b.z1 - b.z0)
  return s.h0 + (s.h1 - s.h0) * Math.max(0, Math.min(1, t))
}

/** 兩條路有交叉（含 T 字路口） */
export function crosses(r: Road, c: Road): boolean {
  if (r.axis === c.axis) return false
  return c.at >= r.a - c.w / 2 - 1 && c.at <= r.b + c.w / 2 + 1 && r.at >= c.a - r.w / 2 - 1 && r.at <= c.b + r.w / 2 + 1
}

// ---------- 西岸（老城區）的路 ----------

/** 大道：到橋頭（`RAMP_X0` 前面）變寬，接上和橋面一樣寬的引道 */
const W_BOULEVARD: Road = { axis: 'x', at: 0, a: -BASE.x, b: -152, w: 24 }
const W_APRON: Road = { axis: 'z', at: -274, a: -MAP_Z, b: MAP_Z, w: 24 }
const W_RIVERSIDE: Road = { axis: 'z', at: -56, a: -MAP_Z, b: MAP_Z, w: 16 }
const WEST_ROADS: Road[] = [
  W_APRON,
  W_RIVERSIDE,
  W_BOULEVARD,
  // 北邊（z < 0）的南北向街
  { axis: 'z', at: -207, a: -337, b: -12, w: 14 },
  { axis: 'z', at: -146, a: -337, b: -20, w: 12 },
  { axis: 'z', at: -100, a: -138, b: -70, w: 8 },
  // 南邊的南北向街（和北邊的錯開）
  { axis: 'z', at: -223, a: 12, b: MAP_Z, w: 14 },
  { axis: 'z', at: -163, a: 12, b: MAP_Z, w: 14 },
  { axis: 'z', at: -112, a: -SPUR_Z, b: MAP_Z, w: 12 },
  // 東西向的街：每一欄自己的，不會一路通到底
  { axis: 'x', at: -121, a: -MAP_X, b: -286, w: 14 },
  { axis: 'x', at: 111, a: -MAP_X, b: -286, w: 14 },
  { axis: 'x', at: -153, a: -262, b: -214, w: 14 },
  { axis: 'x', at: -79, a: -262, b: -214, w: 14 },
  { axis: 'x', at: -111, a: -200, b: -152, w: 14 },
  { axis: 'x', at: -144, a: -140, b: -64, w: 12 },
  { axis: 'x', at: -64, a: -140, b: -64, w: 12 },
  { axis: 'x', at: 103, a: -262, b: -230, w: 14 },
  { axis: 'x', at: 67, a: -216, b: -170, w: 14 },
  // 大樓 A 的南北兩邊（大橋的支線架在南邊那條街上）
  { axis: 'x', at: 46, a: -163, b: -56, w: 12 },
  { axis: 'x', at: -SPUR_Z, a: -223, b: -56, w: 14 },
  // 外環街：隔開原本的城區和外面的街區
  { axis: 'x', at: -227, a: -MAP_X, b: -64, w: 14 },
  { axis: 'x', at: 227, a: -MAP_X, b: -64, w: 14 },
  // 北邊：調車場前面的街、調車場和河岸街屋中間的街
  { axis: 'x', at: -330, a: -MAP_X, b: -64, w: 14 },
  { axis: 'z', at: -111, a: -MAP_Z, b: -330, w: 14 },
  { axis: 'x', at: -400, a: -MAP_X, b: -286, w: 14 },
  // 南邊：通到公路橋的大街，外面每一欄自己的街
  { axis: 'x', at: AVENUE_Z, a: -MAP_X, b: -64, w: 18 },
  { axis: 'x', at: 398, a: -MAP_X, b: -286, w: 14 },
  { axis: 'x', at: 410, a: -262, b: -230, w: 12 },
  { axis: 'x', at: 392, a: -216, b: -170, w: 14 },
  { axis: 'x', at: 400, a: -156, b: -118, w: 12 },
]

// ---------- 東岸（新市區、港口）的路 ----------

const E_APRON: Road = { axis: 'z', at: 274, a: -MAP_Z, b: MAP_Z, w: 24 }
/** 東岸的河岸道路：北邊到交流道為止（再過去是螺旋坡道） */
const E_RIVERSIDE: Road = { axis: 'z', at: 56, a: -372, b: MAP_Z, w: 16 }
const E_BOULEVARD: Road = { axis: 'x', at: 0, a: 56, b: BASE.x, w: 24 }
/** 東岸一路南北通到底的大道 */
const E_AVENUE: Road = { axis: 'z', at: 160, a: -MAP_Z, b: MAP_Z, w: 18 }
const EAST_ROADS: Road[] = [
  E_APRON,
  E_RIVERSIDE,
  E_BOULEVARD,
  E_AVENUE,
  { axis: 'z', at: 220, a: -MAP_Z, b: MAP_Z, w: 12 },
  { axis: 'z', at: 104, a: -237, b: SPUR_Z, w: 14 },
  { axis: 'z', at: 104, a: 40, b: 237, w: 14 },
  // 東西向
  { axis: 'x', at: -447, a: 92, b: MAP_X, w: 14 },
  { axis: 'x', at: -385, a: 152, b: MAP_X, w: 14 },
  { axis: 'x', at: -300, a: 56, b: MAP_X, w: 14 },
  { axis: 'x', at: -230, a: 56, b: MAP_X, w: 14 },
  { axis: 'x', at: -133, a: 56, b: MAP_X, w: 14 },
  { axis: 'x', at: -46, a: 56, b: 262, w: 12 },
  { axis: 'x', at: 46, a: 56, b: 262, w: 12 },
  { axis: 'x', at: 120, a: 56, b: MAP_X, w: 14 },
  { axis: 'x', at: TRUSS_Z, a: 56, b: 151, w: 12 },
  { axis: 'x', at: 230, a: 56, b: MAP_X, w: 14 },
  { axis: 'x', at: AVENUE_Z, a: 56, b: MAP_X, w: 18 },
  { axis: 'x', at: 400, a: 169, b: MAP_X, w: 14 },
]

const ROADS = [...WEST_ROADS, ...EAST_ROADS]
const RIVERSIDES = [W_RIVERSIDE, E_RIVERSIDE]
/** 過河的地方：[中線, 半寬]（河岸道路上這幾個位置不停車、河濱步道不種樹） */
const CROSSINGS: [number, number][] = [
  [EXPRESS_Z, EXPRESS_W],
  [FOOTBRIDGE_Z, FOOTBRIDGE_W],
  [0, BRIDGE_W],
  [TRUSS_Z, TRUSS_W],
  [AVENUE_Z, AVENUE_W],
]
/** z 在過河的地方（橋的兩邊再多 `pad` 公尺）裡面 */
const atCrossing = (z: number, pad: number) => CROSSINGS.some(([c, w]) => Math.abs(z - c) < w + pad)

/** 大橋西岸的引道從哪裡開始爬、到哪裡接上橋面；東岸的橋頭平台、兩條引道（|z| 在 PAD_IN～PAD_Z 之間） */
const RAMP_X0 = -142
const RAMP_X1 = -80
const PAD_X0 = 64
const PAD_X1 = 80
const PAD_Z = 36
const PAD_IN = 14
const E_RAMP_X1 = 140

type Pt = { x: number; y: number; z: number; gap?: number }

/** 排出整張地圖（每次都一樣） */
export function buildMap(): MapData {
  const rand = rng(20261110)
  const r = (lo: number, hi: number) => lo + (hi - lo) * rand()
  const boxes: Box[] = []
  const lots: Lot[] = []
  const tracks: MapData['tracks'] = []
  /** 電腦也要走得到的點：街廓裡（中庭、穿堂，y 是 0）、高架的路和坡道（照高度） */
  const extra: Pt[] = []
  const inner = {
    push: (...pts: { x: number; z: number }[]) => {
      for (const p of pts) extra.push({ x: p.x, y: 0, z: p.z, gap: 2.5 })
    },
  }
  let seed = 1
  const box = (x0: number, x1: number, z0: number, z1: number, y1: number, kind: BoxKind, y0 = 0, slope?: Slope) => {
    const b: Box = { x0, x1, z0, z1, y0, y1, kind, seed: seed++ }
    if (slope) b.slope = slope
    boxes.push(b)
  }
  /** 街廓的地面（人行道 3 公尺），回傳裡面能蓋房子的範圍 */
  const plot = (x0: number, x1: number, z0: number, z1: number, kind: Lot['kind'] = 'block') => {
    lots.push({ x0, x1, z0, z1, kind })
    return { x0: x0 + 3, x1: x1 - 3, z0: z0 + 3, z1: z1 - 3 }
  }
  /** 從 a 到 b 切成一棟棟連在一起的房子（寬 lo～hi，最後一棟吃掉剩下的） */
  const split = (a: number, b: number, lo: number, hi: number, each: (u0: number, u1: number) => void) => {
    let u = a
    while (b - u > 0.01) {
      let w = r(lo, hi)
      if (b - u - w < lo * 0.75) w = b - u
      each(u, u + w)
      u += w
    }
  }
  /** 電腦走的路：從 a 到 b 每隔大約 `step` 公尺一個點（高度照兩頭內插，之後再貼到地面上） */
  const walk = (ax: number, az: number, ay: number, bx: number, bz: number, by: number, step = 14) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / step))
    for (let k = 0; k <= n; k++) extra.push({ x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n, z: az + ((bz - az) * k) / n })
  }
  /** 高架的路面（薄薄一層，底下走得過去），頂面在 y；`lanes` 是車道線的方向 */
  const deck = (x0: number, x1: number, z0: number, z1: number, y: number, lanes?: 'x' | 'z') => {
    box(x0, x1, z0, z1, y, 'deck', y - 1)
    if (lanes) boxes[boxes.length - 1].lanes = lanes
  }
  /** 實心的坡道（沿著 `axis` 從 h0 到 h1）；一樣高就是平台 */
  const embank = (x0: number, x1: number, z0: number, z1: number, axis: 'x' | 'z', h0: number, h1: number) =>
    box(x0, x1, z0, z1, Math.max(h0, h1), 'ramp', 0, h0 === h1 ? undefined : { axis, h0, h1 })
  /** 護欄：比路面高 1.2 公尺，放在路面的邊上；坡道上的跟著斜（h0、h1 是 x0／z0 和另一頭的路面高度） */
  const guard = (x0: number, x1: number, z0: number, z1: number, h0: number, h1 = h0) => {
    if (h0 === h1) {
      box(x0, x1, z0, z1, h0 + 1.2, 'parapet', h0)
      return
    }
    const axis = x1 - x0 >= z1 - z0 ? 'x' : 'z'
    box(x0, x1, z0, z1, Math.max(h0, h1) + 1.2, 'parapet', 0, { axis, h0: h0 + 1.2, h1: h1 + 1.2 })
  }
  /** 橋墩：從 base 撐到 y 底下 */
  const pier = (x0: number, x1: number, z0: number, z1: number, y: number, base = 0) => box(x0, x1, z0, z1, y, 'pier', base)
  const perches: Perch[] = []

  /**
   * 兩岸一模一樣的東西（大樓、大橋的支線）：照東岸的座標寫，`m` 時照原點轉 180 度放到西岸，
   * 兩隊拿到的大樓、高架完全一樣（只有外觀不同）
   */
  const flip = (m: boolean) => {
    const span = (a: number, b: number): [number, number] => (m ? [-b, -a] : [a, b])
    const slope = (s?: Slope) => (s && m ? { axis: s.axis, h0: s.h1, h1: s.h0 } : s)
    const at = (x: number, z: number) => (m ? { x: -x, z: -z } : { x, z })
    return {
      box: (x0: number, x1: number, z0: number, z1: number, y1: number, kind: BoxKind, y0 = 0, s?: Slope) => {
        const [a0, a1] = span(x0, x1)
        const [c0, c1] = span(z0, z1)
        box(a0, a1, c0, c1, y1, kind, y0, slope(s))
      },
      deck: (x0: number, x1: number, z0: number, z1: number, y: number, lanes?: 'x' | 'z') => {
        const [a0, a1] = span(x0, x1)
        const [c0, c1] = span(z0, z1)
        deck(a0, a1, c0, c1, y, lanes)
      },
      guard: (x0: number, x1: number, z0: number, z1: number, h0: number, h1 = h0) => {
        const [a0, a1] = span(x0, x1)
        const [c0, c1] = span(z0, z1)
        if (m) guard(a0, a1, c0, c1, h1, h0)
        else guard(a0, a1, c0, c1, h0, h1)
      },
      lot: (x0: number, x1: number, z0: number, z1: number, kind: Lot['kind']) => {
        const [a0, a1] = span(x0, x1)
        const [c0, c1] = span(z0, z1)
        lots.push({ x0: a0, x1: a1, z0: c0, z1: c1, kind })
      },
      walk: (ax: number, az: number, ay: number, bx: number, bz: number, by: number, step = 14) => {
        const a = at(ax, az)
        const b = at(bx, bz)
        walk(a.x, a.z, ay, b.x, b.z, by, step)
      },
      /** 大樓裡的點（樓板上，比路網的點密一點） */
      spot: (x: number, y: number, z: number) => extra.push({ ...at(x, z), y, gap: 4 }),
      perch: (x: number, y: number, z: number, yaw: number) => perches.push({ ...at(x, z), y, yaw: m ? yaw + Math.PI : yaw, team: m ? 0 : 1 }),
    }
  }

  /**
   * 走得進去的大樓（東岸的座標；靠河那一面朝西）：一樓挑高 7 公尺，二樓和大橋一樣高，往上每層 10 公尺，屋頂 38 公尺（`FLOORS`）。
   * 靠河那一面每一層都只有矮牆和柱子，可以在裡面往河對岸狙擊；南北兩面一段牆一段窗；離河最遠的那一面是整片牆，
   * 牆裡面兩條並排的坡道（A 在外、B 靠牆）一層一層折返往上爬（A 從南往北爬、B 從北往南爬），
   * 每條坡道上面那一層的樓板挖一個洞讓它穿上去。
   * `west`、`north`：二樓的樓板往外伸到街廓的邊上、那一邊不放矮牆，接上旁邊的高架道路；`crane`：屋頂上一座塔吊（地標）
   */
  const stack = (m: boolean, p: { x0: number; x1: number; z0: number; z1: number }, west = false, north = false, crane = false) => {
    const F = flip(m)
    const T = 0.6
    /** 每一層的地板高度（第 0 層是地面，最後一個是屋頂） */
    const lv = [0, ...FLOORS]
    const top = lv.length - 1
    const roof = lv[top]
    const bx0 = p.x0 + 3
    const bx1 = p.x1 - 3
    const bz0 = p.z0 + 3
    const bz1 = p.z1 - 3
    // 坡道 A、B（各 12 公尺寬）從北邊 rz0 到 rz1，兩頭是轉彎的平台
    const ax0 = bx1 - 24
    const ax1 = bx1 - 12
    const rz0 = bz0 + 14
    const rz1 = rz0 + 36
    /** 第 k 條坡道（從第 k 層爬到 k + 1 層）在哪一條：偶數是 A、奇數是 B */
    const bay = (k: number): [number, number] => (k % 2 === 0 ? [ax0, ax1] : [ax1, bx1])
    F.lot(p.x0, p.x1, p.z0, p.z1, 'plaza')

    // 樓板：第 j - 1 條坡道從洞裡穿上來；洞的旁邊除了坡道上來的那一頭都擋起來（旁邊那條往上的坡道的矮牆也算）
    for (let j = 1; j <= top; j++) {
      const y = lv[j]
      const [h0, h1] = bay(j - 1)
      const sx0 = j === 1 && west ? p.x0 : bx0
      const sz0 = j === 1 && north ? p.z0 : bz0
      F.box(sx0, h0, sz0, bz1, y, 'floor', y - 1)
      F.box(h0, bx1, sz0, rz0, y, 'floor', y - 1)
      F.box(h0, bx1, rz1, bz1, y, 'floor', y - 1)
      if (h1 < bx1) F.box(h1, bx1, rz0, rz1, y, 'floor', y - 1)
      if (j % 2 === 1) {
        F.box(ax0 - T, ax0, rz0, rz1, y + 1.2, 'sill', y)
        F.box(ax0, ax1, rz1, rz1 + T, y + 1.2, 'sill', y)
        if (j === top) F.box(ax1, ax1 + T, rz0, rz1, y + 1.2, 'sill', y)
      } else {
        F.box(ax1, bx1, rz0 - T, rz0, y + 1.2, 'sill', y)
        if (j === top) F.box(ax1 - T, ax1, rz0, rz1, y + 1.2, 'sill', y)
      }
    }
    // 坡道（兩邊是跟著斜的矮牆；B 靠牆那一邊就是牆）；一樓坡道 B 的位置是實心的機房
    const rail = (x0: number, x1: number, h0: number, h1: number, base: number) =>
      F.box(x0, x1, rz0, rz1, Math.max(h0, h1) + 1.2, 'sill', base, { axis: 'z', h0: h0 + 1.2, h1: h1 + 1.2 })
    for (let k = 0; k < top; k++) {
      const [x0, x1] = bay(k)
      const a = k % 2 === 0
      const lo = lv[k]
      const hi = lv[k + 1]
      const h0 = a ? hi : lo
      const h1 = a ? lo : hi
      F.box(x0 + T, a ? x1 - T : x1, rz0, rz1, hi, 'ramp', lo, { axis: 'z', h0, h1 })
      rail(x0, x0 + T, h0, h1, lo)
      if (a) rail(x1 - T, x1, h0, h1, lo)
    }
    F.box(ax1, bx1, rz0, rz1, lv[1] - 1, 'facade')
    // 離河最遠的那一面：整片牆，比屋頂高一截當矮牆
    F.box(bx1, bx1 + 0.8, bz0, bz1, roof + 1.2, 'facade')

    // 柱子：靠河那一面一排，往裡面每隔十幾公尺一排；南北兩面也各一排（都比牆往裡面縮一點）
    const nx = Math.max(2, Math.round((ax0 - bx0) / 13))
    const sx = (ax0 - bx0 - 1.3) / nx
    const cols = Array.from({ length: nx }, (_, i) => bx0 + 1.3 + i * sx)
    const nz = Math.max(2, Math.round((bz1 - bz0) / 13))
    const sz = (bz1 - bz0 - 2 * T - 1.4) / nz
    const rows = Array.from({ length: nz + 1 }, (_, j) => bz0 + T + 0.7 + j * sz)
    const midX = cols.map((x) => x + sx / 2)
    const midZ = rows.slice(1).map((z) => z - sz / 2)
    for (let k = 0; k < top; k++) {
      const y = lv[k]
      const ceil = lv[k + 1] - 1
      const linked = k === 1 && west
      for (const x of cols) for (const z of rows) F.box(x - 0.7, x + 0.7, z - 0.7, z + 0.7, ceil, 'column', y)
      // 靠河那一面：矮牆（一樓開著；接著高架的那一層也開著）
      const riverSill = y > 0 && !linked
      if (riverSill) F.box(bx0, bx0 + T, bz0, bz1, y + 1.2, 'sill', y)
      // 南北兩面：一段牆一段窗（每一層錯開），坡道那一段整片牆（一樓南邊開著，是坡道 A 的入口）
      const edges = [...cols, ax0]
      for (const [z0, z1, isNorth] of [
        [bz0, bz0 + T, true],
        [bz1 - T, bz1, false],
      ] as const) {
        if (k === 1 && isNorth && north) continue
        const sill = (x0: number, x1: number) => {
          if (y > 0) F.box(x0, x1, z0, z1, y + 1.2, 'sill', y)
        }
        if (linked) sill(p.x0, bx0)
        for (let i = 0; i < edges.length - 1; i++) {
          const x0 = i === 0 ? (riverSill ? bx0 + T : bx0) : edges[i] + 0.7
          const x1 = edges[i + 1] - (i === edges.length - 2 ? 0 : 0.7)
          if ((i + k) % 2 === 1) F.box(x0, x1, z0, z1, ceil, 'facade', y)
          else sill(x0, x1)
          if (i > 0) sill(edges[i] - 0.7, edges[i] + 0.7)
        }
        if (k > 0 || isNorth) F.box(ax0, bx1, z0, z1, ceil, 'facade', y)
      }
    }
    // 屋頂：四周的矮牆
    F.box(bx0, bx0 + T, bz0, bz1, roof + 1.2, 'sill', roof)
    F.box(bx0 + T, bx1, bz0, bz0 + T, roof + 1.2, 'sill', roof)
    F.box(bx0 + T, bx1, bz1 - T, bz1, roof + 1.2, 'sill', roof)

    // 掩體：三樓以上靠河那一邊每隔一格一道混凝土牆，中間那幾格是狙擊點；一樓、二樓柱子旁邊幾堆箱子；屋頂一間機房
    for (const y of lv.slice(2)) {
      midZ.forEach((z, j) => {
        if (j % 2 === 0) F.box(bx0 + 2.4, bx0 + 3.6, z - 1.8, z + 1.8, y + 4.2, 'twall', y)
        else F.perch(bx0 + 4.5, y, z, -Math.PI / 2)
      })
    }
    for (const y of lv.slice(0, 2)) {
      for (let i = 1; i < cols.length; i++) {
        const z = rows[1 + ((i + (y > 0 ? 1 : 0)) % (rows.length - 2))]
        F.box(cols[i] + 0.7, cols[i] + 3.4, z - 1.4, z + 1.4, y + 2.4, 'crate', y)
      }
    }
    F.box(cols[2] - 2, cols[2] + 2, rows[2] - 2, rows[2] + 2, roof + 3.2, 'kiosk', roof)
    // 塔吊：塔身在屋頂靠牆的那一角，吊臂往河那邊伸出去、後面一截配重
    if (crane) {
      const cx = bx1 - 6
      const cz = bz0 + 6
      F.box(cx - 1.2, cx + 1.2, cz - 1.2, cz + 1.2, roof + 44, 'pillar', roof)
      F.box(cx - 46, cx + 14, cz - 1, cz + 1, roof + 44, 'pillar', roof + 42)
      F.box(cx + 8, cx + 14, cz - 1.6, cz + 1.6, roof + 42, 'pillar', roof + 38)
    }

    // 電腦走的路：每一層柱子中間的格子、靠河的狙擊點，坡道一路折返上去
    for (const y of lv) for (const x of midX) for (const z of midZ) F.spot(x, y, z)
    for (const z of midZ) for (const y of lv.slice(2)) F.spot(bx0 + 4.5, y, z)
    const ac = (ax0 + ax1) / 2
    const bc = (ax1 + bx1) / 2
    const nl = (bz0 + rz0) / 2
    // 南邊的平台：走在兩排柱子中間
    const sl = midZ.filter((z) => z > rz1 + 3).reduce((a, z) => (Math.abs(z - (rz1 + bz1) / 2) < Math.abs(a - (rz1 + bz1) / 2) ? z : a))
    F.walk(ax0 - 6, sl, 0, ac, sl, 0)
    for (let k = 0; k < top; k++) {
      const a = k % 2 === 0
      const c = a ? ac : bc
      const lo = lv[k]
      const hi = lv[k + 1]
      const from = a ? rz1 : rz0
      const to = a ? rz0 : rz1
      const land = a ? nl : sl
      F.walk(c, a ? sl : nl, lo, c, from, lo)
      F.walk(c, from, lo, c, to, hi, 9)
      F.walk(c, to, hi, c, land, hi)
      F.walk(ax0 - 6, land, hi, bc, land, hi)
    }
  }

  /**
   * 大橋的支線（東岸的座標；西岸的照原點轉 180 度）：從大橋的橋面在河岸上轉 90 度、沿著河岸道路往北（底下的路照樣走），
   * 經過大樓 A（二樓直接接上），到 `SPUR_Z` 那條街再轉往內陸，架在街上越過兩個路口，最後一條坡道下到地面。
   * `pad`：大橋這一頭有橋頭平台（東岸），支線和平台中間不放護欄
   */
  const spur = (m: boolean, pad: boolean) => {
    const F = flip(m)
    const y = DECK
    const T = 0.6
    const x0 = 44
    const x1 = 64
    const z0 = SPUR_Z - 7
    const z1 = SPUR_Z + 7
    F.deck(x0, x1, z1, -BRIDGE_W, y, 'z')
    F.deck(x0, SPUR_X, z0, z1, y, 'x')
    F.box(SPUR_X, SPUR_END, z0 + T, z1 - T, y, 'ramp', 0, { axis: 'x', h0: y, h1: 0 })
    F.guard(x0, x0 + T, z0, -BRIDGE_W, y)
    F.guard(x0 + T, SPUR_X, z0, z0 + T, y)
    F.guard(TOWER_A.x1 - 2.2, SPUR_X, z1 - T, z1, y)
    F.guard(x1 - T, x1, TOWER_A.z1 - 3, pad ? -PAD_Z : -BRIDGE_W, y)
    F.guard(SPUR_X, SPUR_END, z0, z0 + T, y, 0)
    F.guard(SPUR_X, SPUR_END, z1 - T, z1, y, 0)
    // 橋墩：河岸道路的兩邊（路口不放）、街的兩邊
    for (const z of [-30, -60, -78, -96, -114]) {
      F.box(46, 48, z - 1, z + 1, y - 1, 'pier')
      F.box(61.6, 63.6, z - 1, z + 1, y - 1, 'pier')
    }
    F.box(46, 48, SPUR_Z - 1, SPUR_Z + 1, y - 1, 'pier')
    for (const x of [76, 90, 122, 140]) {
      F.box(x - 1, x + 1, z0 + 0.4, z0 + 2, y - 1, 'pier')
      F.box(x - 1, x + 1, z1 - 2, z1 - 0.4, y - 1, 'pier')
    }
    // 路上的掩體（靠護欄放，中線留給人走）
    F.box(x0 + T, x0 + T + 2, -76, -71.4, y + 1.5, 'car', y)
    F.box(x1 - 3.6, x1 - 0.6, -100, -96.4, y + 4.2, 'twall', y)
    F.box(x0 + T + 0.4, x0 + T + 6.5, -112, -109.5, y + 2.6, 'container', y)
    F.box(100, 112, z0 + T, z0 + T + 2.8, y + 3.2, 'bus', y)
    F.box(140, 144.6, z0 + T, z0 + T + 2, y + 1.5, 'car', y)
    F.box(158, 161, z1 - 3.6, z1 - T, y + 4.2, 'twall', y)
    // 電腦走的路
    const xc = (x0 + x1) / 2
    F.walk(xc, -12, y, xc, SPUR_Z, y)
    F.walk(xc, SPUR_Z, y, SPUR_X, SPUR_Z, y)
    F.walk(SPUR_X, SPUR_Z, y, SPUR_END - 3, SPUR_Z, 0.6)
    F.walk(SPUR_END + 5, SPUR_Z, 0, SPUR_END + 5, SPUR_Z, 0)
  }

  // 街屋：沿著長邊連成一整排、每棟高度和退縮不一樣；街廓夠深就前後兩排、中間一條後巷，
  // 每一排中間留一個穿堂
  const terrace = (x0: number, x1: number, z0: number, z1: number, lo: number, hi: number) => {
    const p = plot(x0, x1, z0, z1)
    const alongX = p.x1 - p.x0 >= p.z1 - p.z0
    const U0 = alongX ? p.x0 : p.z0
    const U1 = alongX ? p.x1 : p.z1
    const V0 = alongX ? p.z0 : p.x0
    const V1 = alongX ? p.z1 : p.x1
    const put = (u0: number, u1: number, v0: number, v1: number, h: number) =>
      alongX ? box(u0, u1, v0, v1, h, 'house') : box(v0, v1, u0, u1, h, 'house')
    const at = (u: number, v: number) => (alongX ? { x: u, z: v } : { x: v, z: u })
    const row = (v0: number, v1: number, side: -1 | 0 | 1) => {
      const base = r(lo, hi)
      const gap = U0 + (U1 - U0) * r(0.38, 0.62)
      const fill = (a: number, b: number) =>
        split(a, b, 9, 17, (u0, u1) => {
          const h = Math.round(Math.max(17, base + r(-4, 7)))
          // 有的往後退一點，街面不會是一整片平的
          const back = rand() < 0.3 ? r(1, 2.6) : 0
          put(u0, u1, side < 0 ? v0 + back : v0, side > 0 ? v1 - back : v1, h)
        })
      fill(U0, gap - 3.5)
      fill(gap + 3.5, U1)
      // 穿堂中間和兩頭的出口
      inner.push(at(gap, (v0 + v1) / 2), at(gap, v0 - 5), at(gap, v1 + 5))
    }
    if (V1 - V0 >= 36) {
      const d1 = r(11, 13)
      const d2 = r(11, 13)
      row(V0, V0 + d1, -1)
      row(V1 - d2, V1, 1)
      // 後巷
      const alley = (V0 + d1 + V1 - d2) / 2
      inner.push(at(U0 - 5, alley), at((U0 + U1) / 2, alley), at(U1 + 5, alley))
    } else {
      row(V0, V1, rand() < 0.5 ? -1 : 1)
    }
  }

  // 中庭街廓：四邊的房子連成一圈，兩個穿堂通到中間的中庭
  const courtyard = (x0: number, x1: number, z0: number, z1: number, lo: number, hi: number) => {
    const d = r(11, 13)
    if (x1 - x0 - 6 < d * 2 + 14 || z1 - z0 - 6 < d * 2 + 14) return terrace(x0, x1, z0, z1, lo, hi)
    const p = plot(x0, x1, z0, z1)
    const base = r(lo, hi)
    const p1 = Math.floor(rand() * 4)
    const p2 = (p1 + 1 + Math.floor(rand() * 3)) % 4
    // 北、南兩邊整條（含轉角），西、東兩邊夾在中間
    const sides = [
      { alongX: true, a: p.x0, b: p.x1, v0: p.z0, v1: p.z0 + d, out: -1 },
      { alongX: true, a: p.x0, b: p.x1, v0: p.z1 - d, v1: p.z1, out: 1 },
      { alongX: false, a: p.z0 + d, b: p.z1 - d, v0: p.x0, v1: p.x0 + d, out: -1 },
      { alongX: false, a: p.z0 + d, b: p.z1 - d, v0: p.x1 - d, v1: p.x1, out: 1 },
    ]
    sides.forEach((s, k) => {
      const put = (u0: number, u1: number) => {
        const h = Math.round(Math.max(17, base + r(-5, 6)))
        if (s.alongX) box(u0, u1, s.v0, s.v1, h, 'house')
        else box(s.v0, s.v1, u0, u1, h, 'house')
      }
      if (k !== p1 && k !== p2) {
        split(s.a, s.b, 12, 24, put)
        return
      }
      // 穿堂：不要開在轉角；短的那一邊開在正中間
      const g = s.alongX ? r(s.a + d + 4, s.b - d - 4) : s.b - s.a < 30 ? (s.a + s.b) / 2 : r(s.a + 9, s.b - 9)
      split(s.a, g - 3.5, 10, 22, put)
      split(g + 3.5, s.b, 10, 22, put)
      // 穿堂外面、中間、裡面（中庭那一頭）各一個點
      for (const v of [s.out < 0 ? s.v0 - 6 : s.v1 + 6, (s.v0 + s.v1) / 2, s.out < 0 ? s.v1 + 4 : s.v0 - 4])
        inner.push(s.alongX ? { x: g, z: v } : { x: v, z: g })
    })
    // 中庭：正中間一座花台（可以躲），旁邊各一個點
    const cx = (p.x0 + p.x1) / 2
    const cz = (p.z0 + p.z1) / 2
    box(cx - 3, cx + 3, cz - 0.7, cz + 0.7, 1.3, 'planter')
    inner.push({ x: cx, z: cz - 4 }, { x: cx, z: cz + 4 })
  }

  // 長條大樓：整個街廓一棟，分成幾段不同高度，高的那幾段上面再收一截
  const slab = (x0: number, x1: number, z0: number, z1: number, lo: number, hi: number) => {
    const p = plot(x0, x1, z0, z1)
    const alongX = p.x1 - p.x0 >= p.z1 - p.z0
    const a = alongX ? p.x0 : p.z0
    const b = alongX ? p.x1 : p.z1
    const v0 = alongX ? p.z0 : p.x0
    const v1 = alongX ? p.z1 : p.x1
    const n = Math.max(2, Math.min(4, Math.round((b - a) / 22)))
    const cuts = [a]
    for (let k = 1; k < n; k++) cuts.push(a + ((b - a) * (k + r(-0.2, 0.2))) / n)
    cuts.push(b)
    for (let k = 0; k < n; k++) {
      const h = Math.round(r(lo, hi))
      // 有一段往裡面縮，前面留一塊小廣場
      const front = k === Math.floor(n / 2) && rand() < 0.6 ? r(3, 6) : 0
      const u0 = cuts[k]
      const u1 = cuts[k + 1]
      if (alongX) box(u0, u1, v0 + front, v1, h, h >= 34 ? 'tower' : 'building')
      else box(v0 + front, v1, u0, u1, h, h >= 34 ? 'tower' : 'building')
      if (h >= 30 && v1 - v0 - front > 16) {
        const inset = r(3, 5)
        const top = h + Math.round(r(6, 16))
        if (alongX) box(u0 + 1, u1 - 1, v0 + front + inset, v1 - inset, top, 'tower', h)
        else box(v0 + front + inset, v1 - inset, u0 + 1, u1 - 1, top, 'tower', h)
      }
    }
  }

  // 裙樓加高塔：L 形的裙樓，空出來的那個角是小廣場，裙樓上蓋一到兩棟高塔
  const towers = (x0: number, x1: number, z0: number, z1: number, lo: number, hi: number) => {
    const p = plot(x0, x1, z0, z1)
    const w = p.x1 - p.x0
    const d = p.z1 - p.z0
    const pw = w * r(0.32, 0.42)
    const pd = d * r(0.4, 0.5)
    const podium = Math.round(r(17, 21))
    // 廣場在西北角（往外的那一角另外轉）
    const flipX = rand() < 0.5
    const flipZ = rand() < 0.5
    const X = (u: number) => (flipX ? p.x0 + p.x1 - u : u)
    const Z = (v: number) => (flipZ ? p.z0 + p.z1 - v : v)
    const rect = (a0: number, a1: number, b0: number, b1: number, h: number, kind: BoxKind, y0 = 0) => {
      const xa = X(a0)
      const xb = X(a1)
      const za = Z(b0)
      const zb = Z(b1)
      box(Math.min(xa, xb), Math.max(xa, xb), Math.min(za, zb), Math.max(za, zb), h, kind, y0)
    }
    rect(p.x0 + pw, p.x1, p.z0, p.z1, podium, 'building')
    rect(p.x0, p.x0 + pw, p.z0 + pd, p.z1, podium, 'building')
    // 廣場上的花台和樹
    inner.push({ x: X(p.x0 + pw / 2), z: Z(p.z0 + pd / 2) })
    const px = X(p.x0 + pw - 4)
    const pz = Z(p.z0 + pd - 4)
    box(px - 2, px + 2, pz - 2, pz + 2, 1.3, 'planter')
    // 高塔
    const tw = p.x1 - (p.x0 + pw)
    const count = tw > 44 ? 2 : 1
    for (let k = 0; k < count; k++) {
      const a0 = p.x0 + pw + (tw * k) / count + 4
      const a1 = p.x0 + pw + (tw * (k + 1)) / count - 4
      const size = Math.min(a1 - a0, d - 8, 24)
      const ca = (a0 + a1) / 2 + r(-1, 1) * Math.max(0, (a1 - a0 - size) / 2)
      const cb = p.z0 + d / 2 + r(-1, 1) * Math.max(0, (d - 8 - size) / 2)
      const h = Math.round(r(lo, hi))
      rect(ca - size / 2, ca + size / 2, cb - size / 2, cb + size / 2, h, 'tower', podium)
      if (size > 14) rect(ca - size / 2 + 3, ca + size / 2 - 3, cb - size / 2 + 3, cb + size / 2 - 3, h + Math.round(r(6, 14)), 'tower', h)
    }
  }

  // L 形：沿著兩條街連成一個 L，對角再一棟，中間隔一條巷子
  const corner = (x0: number, x1: number, z0: number, z1: number, lo: number, hi: number) => {
    const p = plot(x0, x1, z0, z1)
    const d = r(12, 15)
    const base = r(lo, hi)
    const flipX = rand() < 0.5
    const flipZ = rand() < 0.5
    const X = (u: number) => (flipX ? p.x0 + p.x1 - u : u)
    const Z = (v: number) => (flipZ ? p.z0 + p.z1 - v : v)
    const rect = (a0: number, a1: number, b0: number, b1: number, h: number) => {
      const xa = X(a0)
      const xb = X(a1)
      const za = Z(b0)
      const zb = Z(b1)
      box(Math.min(xa, xb), Math.max(xa, xb), Math.min(za, zb), Math.max(za, zb), h, h >= 34 ? 'tower' : 'building')
    }
    // L 的兩隻腳：各自切成幾段
    split(p.x0, p.x1, 14, 26, (u0, u1) => rect(u0, u1, p.z0, p.z0 + d, Math.round(Math.max(17, base + r(-4, 8)))))
    split(p.z0 + d, p.z1, 14, 26, (v0, v1) => rect(p.x0, p.x0 + d, v0, v1, Math.round(Math.max(17, base + r(-4, 8)))))
    // 對角那一棟
    const gap = 8
    rect(p.x0 + d + gap, p.x1, p.z0 + d + gap, p.z1, Math.round(r(lo + 6, hi + 12)))
    // L 形的巷子：轉角、兩條巷子的中間和出口
    const ax = p.x0 + d + gap / 2
    const az = p.z0 + d + gap / 2
    for (const [u, v] of [
      [ax, az],
      [ax, (az + p.z1) / 2],
      [ax, p.z1 + 5],
      [(ax + p.x1) / 2, az],
      [p.x1 + 5, az],
    ])
      inner.push({ x: X(u), z: Z(v) })
  }

  // 倉庫：幾棟長長的鐵皮倉庫，中間的通道放貨櫃
  const warehouses = (x0: number, x1: number, z0: number, z1: number) => {
    const p = plot(x0, x1, z0, z1, 'parking')
    const alongX = p.x1 - p.x0 >= p.z1 - p.z0
    const v0 = alongX ? p.z0 : p.x0
    const v1 = alongX ? p.z1 : p.x1
    const a = alongX ? p.x0 : p.z0
    const b = alongX ? p.x1 : p.z1
    let v = v0
    while (v1 - v > 12) {
      const depth = Math.min(v1 - v, r(14, 18))
      const h = Math.round(r(17, 20))
      split(a, b, 30, 50, (u0, u1) => {
        const s = u0 === a ? 0 : 1
        if (alongX) box(u0 + s, u1, v, v + depth, h, 'warehouse')
        else box(v, v + depth, u0 + s, u1, h, 'warehouse')
      })
      v += depth
      if (v1 - v > 12) {
        // 通道：貨櫃靠一邊放，另一邊留給人走
        const mid = v + 6
        for (const u of [a - 5, (a + b) / 2, b + 5]) inner.push(alongX ? { x: u, z: mid } : { x: mid, z: u })
        for (let u = a + 8; u < b - 10; u += r(14, 24)) {
          if (rand() < 0.5) continue
          if (alongX) box(u, u + 6.1, v + 0.5, v + 3, 2.6, 'container')
          else box(v + 0.5, v + 3, u, u + 6.1, 2.6, 'container')
        }
        v += 9
      }
    }
  }

  // 公園：樹、矮樹籬、涼亭
  const park = (x0: number, x1: number, z0: number, z1: number) => {
    lots.push({ x0, x1, z0, z1, kind: 'park' })
    const cx = (x0 + x1) / 2
    const cz = (z0 + z1) / 2
    box(cx - 3, cx + 3, cz - 3, cz + 3, 4, 'kiosk')
    for (let k = 0; k < 22; k++) {
      const tx = r(x0 + 4, x1 - 4)
      const tz = r(z0 + 4, z1 - 4)
      if (Math.abs(tx - cx) < 8 && Math.abs(tz - cz) < 8) continue
      box(tx - 0.6, tx + 0.6, tz - 0.6, tz + 0.6, 9, 'tree')
    }
    box(x0 + 4, x0 + 14, cz + 8, cz + 9, 1.3, 'planter')
    box(x1 - 14, x1 - 4, cz - 9, cz - 8, 1.3, 'planter')
    box(cx - 12, cx - 9, z0 + 10, z0 + 13.6, 4.2, 'twall')
    box(cx + 8, cx + 11, z1 - 13.6, z1 - 10, 4.2, 'twall')
    for (const [dx, dz] of [
      [-12, -12],
      [12, 12],
      [12, -12],
      [-12, 12],
    ])
      inner.push({ x: cx + dx, z: cz + dz })
  }

  // 貨櫃碼頭：一排排貨櫃，有的疊兩層，中間留走道
  const yard = (x0: number, x1: number, z0: number, z1: number) => {
    lots.push({ x0, x1, z0, z1, kind: 'parking' })
    const cx = x1 - 22
    for (let x = x0 + 6; x < x1 - 8; x += 10) {
      // 貨櫃之間的走道
      for (const z of [z0 + 10, (z0 + z1) / 2, z1 - 10]) inner.push({ x: x + 6.25, z })
      for (let z = z0 + 6; z < z1 - 6; z += 9) {
        if (rand() < 0.3 || Math.abs(x + 1.25 - cx) < 4) continue
        box(x, x + 2.5, z, z + 6.1, 2.6, 'container')
        if (rand() < 0.45) box(x, x + 2.5, z, z + 6.1, 5.2, 'container', 2.6)
      }
    }
    // 碼頭的大吊架（兩根腳，中間空的）
    box(cx - 1, cx + 1, z0 + 8, z0 + 10, 26, 'pillar')
    box(cx - 1, cx + 1, z1 - 10, z1 - 8, 26, 'pillar')
    box(cx - 1.4, cx + 1.4, z0 + 8, z1 - 8, 28, 'pillar', 25)
  }

  // 工地：一根根柱子和材料堆
  const site = (x0: number, x1: number, z0: number, z1: number) => {
    lots.push({ x0, x1, z0, z1, kind: 'site' })
    for (let x = x0 + 6; x < x1 - 4; x += 8) {
      for (let z = z0 + 6; z < z1 - 4; z += 9) {
        if (rand() < 0.25) continue
        box(x, x + 1.4, z, z + 1.4, Math.round(r(10, 20)), 'pillar')
      }
    }
    // 柱子之間的空地
    for (let x = x0 + 10.7; x < x1 - 6; x += 16) for (let z = z0 + 11.2; z < z1 - 6; z += 18) inner.push({ x, z })
    for (let k = 0; k < 6; k++) {
      const x = r(x0 + 4, x1 - 8)
      const z = r(z0 + 4, z1 - 8)
      box(x, x + r(2.5, 4), z, z + r(2.5, 4), r(1.2, 3.5), 'crate')
    }
  }

  // 調車場：一條條東西向的鐵軌，上面停著一串串車廂；每三條留一條空的當走道
  const railyard = (x0: number, x1: number, z0: number, z1: number) => {
    lots.push({ x0, x1, z0, z1, kind: 'railyard' })
    const gauge = 8.5
    let k = 0
    for (let z = z0 + 5; z < z1 - 3; z += gauge, k++) {
      tracks.push({ x0: x0 + 2, x1: x1 - 2, z })
      if (k % 3 === 1) continue
      let x = x0 + 4 + r(0, 16)
      while (x < x1 - 24) {
        const cars = 1 + Math.floor(rand() * 3)
        for (let c = 0; c < cars && x + 20 < x1 - 4; c++) {
          box(x, x + 19.4, z - 1.6, z + 1.6, 4.4, 'railcar')
          x += 20
        }
        x += r(12, 28)
      }
    }
    // 車廂之間的走道
    for (let z = z0 + 5 + gauge / 2; z < z1 - 6; z += gauge) for (let x = x0 + 8; x < x1 - 6; x += 22) inner.push({ x, z })
  }

  // 停車場：一排排停好的車，角落一間收費亭
  const carPark = (x0: number, x1: number, z0: number, z1: number) => {
    lots.push({ x0, x1, z0, z1, kind: 'parking' })
    for (let z = z0 + 5; z < z1 - 8; z += 15) {
      for (let x = x0 + 4; x < x1 - 4; x += 3.2) {
        if (rand() < 0.45) continue
        // 收費亭那一角不停車
        if (x + 2 > x1 - 10 && z + 4.6 > z1 - 8) continue
        box(x, x + 2, z, z + 4.6, 1.5, 'car')
      }
      for (let x = x0 + 8; x < x1 - 6; x += 20) inner.push({ x, z: z + 10 })
    }
    box(x1 - 9, x1 - 4, z1 - 7, z1 - 3, 3.2, 'kiosk')
  }

  // 立體停車場：一樓空的（柱子和車），屋頂是停車場，從西邊的坡道開上去
  const garage = (x0: number, x1: number, z0: number, z1: number) => {
    const p = plot(x0, x1, z0, z1, 'parking')
    const top = 8
    const rz0 = p.z0 + 30
    const rx1 = p.x0 + 12
    deck(p.x0, p.x1, rz0, p.z1, top)
    embank(p.x0, rx1, p.z0, rz0, 'z', 0, top)
    guard(p.x0, p.x0 + 0.6, p.z0, rz0, 0, top)
    guard(rx1 - 0.6, rx1, p.z0, rz0, 0, top)
    guard(rx1, p.x1, rz0, rz0 + 0.6, top)
    guard(p.x0, p.x0 + 0.6, rz0, p.z1, top)
    guard(p.x1 - 0.6, p.x1, rz0, p.z1, top)
    guard(p.x0, p.x1, p.z1 - 0.6, p.z1, top)
    // 柱子
    for (let x = rx1 + 2; x < p.x1 - 2; x += 12) for (let z = rz0 + 4; z < p.z1 - 2; z += 13) pier(x - 0.6, x + 0.6, z - 0.6, z + 0.6, top - 1)
    // 樓下、屋頂停的車
    for (let z = rz0 + 7; z < p.z1 - 6; z += 13) {
      if (rand() < 0.6) box(p.x0 + 2, p.x0 + 6.6, z, z + 2, 1.5, 'car')
      if (rand() < 0.5) box(p.x1 - 6.6, p.x1 - 2, z + 3, z + 5, 1.5, 'car')
      if (rand() < 0.55) box(p.x0 + 16, p.x0 + 20.6, z + 2, z + 4, top + 1.5, 'car', top)
      if (rand() < 0.55) box(p.x1 - 8, p.x1 - 3.4, z, z + 2, top + 1.5, 'car', top)
    }
    box(p.x0 + 24, p.x0 + 27, p.z1 - 18, p.z1 - 14.4, top + 4.2, 'twall', top)
    // 坡道、屋頂、樓下
    const mx = (p.x0 + rx1) / 2
    walk(mx, p.z0 - 5, 0, mx, rz0, top)
    walk(mx, rz0, top, mx, p.z1 - 5, top)
    walk(mx, (rz0 + p.z1) / 2, top, p.x1 - 5, (rz0 + p.z1) / 2, top)
    for (let x = rx1 + 8; x < p.x1 - 3; x += 12) for (let z = rz0 + 10.5; z < p.z1 - 3; z += 13) inner.push({ x, z })
  }

  // 墊高的公園：石砌的擋土牆圍著一塊高起來的草地，從北邊的步道走上去，上面有樹、涼亭、可以躲的矮牆
  const mound = (x0: number, x1: number, z0: number, z1: number) => {
    const p = plot(x0, x1, z0, z1)
    const h = 5
    const mz0 = p.z0 + 24
    const mx0 = p.x0 + 2
    const mx1 = p.x1 - 2
    box(mx0, mx1, mz0, p.z1, h, 'mound')
    const rx = (mx0 + mx1) / 2
    box(rx - 6, rx + 6, p.z0, mz0, h, 'slipway', 0, { axis: 'z', h0: 0, h1: h })
    const cz = (mz0 + p.z1) / 2
    box(rx - 3, rx + 3, cz - 3, cz + 3, h + 4, 'kiosk', h)
    for (let k = 0; k < 16; k++) {
      const tx = r(mx0 + 3, mx1 - 3)
      const tz = r(mz0 + 4, p.z1 - 3)
      if (Math.abs(tx - rx) < 9 && (Math.abs(tz - cz) < 8 || tz < mz0 + 10)) continue
      box(tx - 0.6, tx + 0.6, tz - 0.6, tz + 0.6, h + 9, 'tree', h)
    }
    // 面向河那一邊的矮牆、花台
    box(mx1 - 4, mx1 - 1, mz0 + 10, mz0 + 13.6, h + 4.2, 'twall', h)
    box(mx1 - 4, mx1 - 1, p.z1 - 16, p.z1 - 12.4, h + 4.2, 'twall', h)
    box(mx0 + 3, mx0 + 13, cz - 0.5, cz + 0.5, h + 1.3, 'planter', h)
    walk(rx, p.z0 - 5, 0, rx, mz0 + 5, h)
    walk(mx0 + 6, mz0 + 7, h, mx1 - 6, mz0 + 7, h)
    walk(mx0 + 6, p.z1 - 6, h, mx1 - 6, p.z1 - 6, h)
    walk(mx0 + 6, mz0 + 7, h, mx0 + 6, p.z1 - 6, h)
    walk(mx1 - 6, mz0 + 7, h, mx1 - 6, p.z1 - 6, h)
  }

  // 碼頭的吊車：兩對腳跨在河岸道路上（路從中間穿過），上面一根往河上伸出去的長臂
  const crane = (z: number) => {
    for (const x of [44, 66]) {
      box(x, x + 2, z, z + 2, 26, 'pillar')
      box(x, x + 2, z + 14, z + 16, 26, 'pillar')
      box(x, x + 2, z, z + 16, 28, 'pillar', 25.5)
    }
    box(26, 84, z + 6.6, z + 9.4, 31, 'pillar', 28)
  }

  // ======== 兩邊一樣的：機庫 ========
  /** 兩隊一樣的東西：西邊放一個，東邊照原點轉 180 度再放一個 */
  const pair = (x0: number, x1: number, z0: number, z1: number, h: number, kind: BoxKind, y0 = 0) => {
    box(x0, x1, z0, z1, h, kind, y0)
    box(-x1, -x0, -z1, -z0, h, kind, y0)
  }
  // 兩側的廠房當牆、後牆，前面是能量牆（`barrier` 另外處理，只擋敵人）
  pair(-MAP_X, -BASE.x, -46, -BASE.z, HANGAR_H, 'hangar')
  pair(-MAP_X, -BASE.x, BASE.z, 46, HANGAR_H, 'hangar')
  pair(-MAP_X, -MAP_X + 3, -BASE.z, BASE.z, HANGAR_H, 'hangar')
  lots.push({ x0: -286, x1: -262, z0: -46, z1: 46, kind: 'apron' }, { x0: 262, x1: 286, z0: -46, z1: 46, kind: 'apron' })
  // 機庫前的掩體
  pair(-270, -267, -20, -16.4, 4.2, 'twall')
  pair(-270, -267, 16.4, 20, 4.2, 'twall')
  pair(-255, -252.5, -4, 2.1, 2.6, 'container')
  pair(-244, -241.5, 6, 12.1, 2.6, 'container')
  pair(-244, -241.5, 6, 12.1, 5.2, 'container', 2.6)

  // ======== 西岸（老城區）========
  // ---- 原本的城區：北邊 ----
  warehouses(-MAP_X, -286, -INNER_Z, -128)
  terrace(-MAP_X, -286, -114, -46, 18, 24)
  courtyard(-262, -214, -INNER_Z, -160, 18, 28)
  site(-262, -214, -146, -86)
  terrace(-262, -214, -72, -12, 18, 26)
  courtyard(-200, -152, -INNER_Z, -118, 20, 32)
  corner(-200, -152, -104, -12, 20, 34)
  yard(-140, -64, -INNER_Z, -150)
  terrace(-140, -104, -138, -70, 20, 30)
  slab(-96, -64, -138, -70, 28, 48)
  towers(-140, -64, -58, -20, 55, 80)
  // ---- 南邊 ----
  slab(-MAP_X, -286, 46, 104, 18, 26)
  warehouses(-MAP_X, -286, 118, INNER_Z)
  terrace(-262, -230, 12, 96, 18, 26)
  terrace(-262, -230, 110, INNER_Z, 18, 24)
  courtyard(-216, -170, 12, 60, 20, 30)
  park(-216, -170, 74, 126)
  slab(-216, -170, 140, INNER_Z, 20, 34)
  corner(-156, -118, 140, INNER_Z, 22, 34)
  corner(-106, -64, 140, INNER_Z, 22, 38)
  // 大橋引道南邊的小廣場（再過去是大樓 A）
  lots.push({ x0: -156, x1: -64, z0: 20, z1: 40, kind: 'plaza' })
  box(-140, -137, 26, 29.6, 4.2, 'twall')
  box(-120, -114, 31, 33.5, 2.6, 'container')
  box(-97, -94, 24.5, 28.1, 4.2, 'twall')
  box(-84, -74, 34.5, 35.5, 1.3, 'planter')
  for (const x of [-148, -128, -106, -86]) box(x - 0.6, x + 0.6, 36.4, 37.6, 9, 'tree')
  inner.push({ x: -150, z: 30 }, { x: -130, z: 31 }, { x: -108, z: 28 }, { x: -86, z: 28 }, { x: -70, z: 30 })
  // ---- 北邊：外環街和調車場前面的街中間 ----
  slab(-MAP_X, -286, -320, -234, 20, 30)
  courtyard(-262, -214, -320, -234, 18, 28)
  towers(-200, -152, -320, -234, 50, 75)
  // ---- 北邊：調車場、倉庫、河岸的街屋（上面是高架快速道路）----
  warehouses(-MAP_X, -286, -393, -337)
  warehouses(-MAP_X, -286, -MAP_Z, -407)
  railyard(-262, -118, -456, -345)
  terrace(-104, -64, -MAP_Z, -337, 18, 26)
  // ---- 南邊：外環街和大街中間（河岸邊是墊高的公園）----
  terrace(-MAP_X, -286, 234, 321, 18, 24)
  terrace(-262, -230, 234, 321, 18, 26)
  corner(-216, -170, 234, 321, 22, 36)
  slab(-156, -118, 234, 321, 24, 40)
  mound(-106, -64, 234, 321)
  // ---- 南邊：大街外面 ----
  warehouses(-MAP_X, -286, 339, 391)
  slab(-MAP_X, -286, 405, MAP_Z, 18, 26)
  terrace(-262, -230, 339, 404, 18, 24)
  terrace(-262, -230, 416, MAP_Z, 18, 24)
  towers(-216, -170, 339, 385, 45, 65)
  courtyard(-216, -170, 399, MAP_Z, 20, 30)
  corner(-156, -118, 339, 394, 22, 34)
  terrace(-156, -118, 406, MAP_Z, 20, 28)
  yard(-106, -64, 339, MAP_Z)

  // ---- 大道：從機庫一路通到橋頭 ----
  box(-226, -223.5, -9, -2.9, 2.6, 'container')
  box(-190, -187, 3.6, 6.6, 4.2, 'twall')
  box(-178, -172, -8.5, -6, 2.6, 'container')
  box(-178, -172, -8.5, -6, 5.2, 'container', 2.6)
  box(-160, -157, 6, 9, 4.2, 'twall')
  // 調車場前面的街、通到公路橋的大街：路中間的掩體（兩邊交錯放）
  box(-252, -246, -336, -333.5, 2.6, 'container')
  box(-186, -183, -326.4, -322.8, 4.2, 'twall')
  box(-128, -116, -336.5, -333.7, 3.2, 'bus')
  box(-90, -87, -328, -324.4, 4.2, 'twall')
  box(-244, -241, 323.6, 327.2, 4.2, 'twall')
  box(-196, -190, 333, 335.5, 2.6, 'container')
  box(-196, -190, 333, 335.5, 5.2, 'container', 2.6)
  box(-140, -137, 331, 334.6, 4.2, 'twall')
  box(-100, -88, 322.5, 325.3, 3.2, 'bus')

  // ---- 大橋（40 公尺寬的高架橋）：西岸的引道和橋面一樣寬，從大道慢慢爬上去，兩邊是護欄 ----
  const BW = BRIDGE_W
  embank(RAMP_X0, RAMP_X1, -BW + 0.6, BW - 0.6, 'x', 0, DECK)
  guard(RAMP_X0, RAMP_X1, -BW, -BW + 0.6, 0, DECK)
  guard(RAMP_X0, RAMP_X1, BW - 0.6, BW, 0, DECK)
  deck(RAMP_X1, PAD_X0, -BW, BW, DECK, 'x')
  // 護欄在兩條支線轉出去的地方（東岸往北、西岸往南）斷開
  guard(RAMP_X1, 44, -BW, -BW + 0.6, DECK)
  guard(RAMP_X1, -64, BW - 0.6, BW, DECK)
  guard(-44, PAD_X0, BW - 0.6, BW, DECK)
  // 橋墩：西岸的橋頭底下、河濱步道上、河裡
  for (const z of [-15, 0, 15]) {
    pier(-71, -68, z - 1.5, z + 1.5, DECK - 1)
    pier(-46, -43, z - 1.5, z + 1.5, DECK - 1)
    pier(43, 46, z - 1.5, z + 1.5, DECK - 1)
  }
  for (const [z0, z1] of [
    [-17, -9],
    [9, 17],
  ]) {
    pier(-22, -18, z0, z1, DECK - 1, BED)
    pier(18, 22, z0, z1, DECK - 1, BED)
  }
  // 中間一段段的分隔島（紐澤西護欄，中間有缺口可以換車道；橋塔那一段不放）
  for (const [x0, x1] of [
    [-74, -60],
    [-50, -38],
    [6, 18],
    [32, 44],
  ])
    box(x0, x1, -0.5, 0.5, DECK + 1.1, 'barrier', DECK)
  // 橋上的掩體：翻覆的車、公車、紐澤西護欄、掉下來的貨櫃（放在路邊和分隔島旁邊，每個方向的車道中間都留一條路）
  box(-70, -65.4, 15.6, 17.6, DECK + 1.5, 'car', DECK)
  box(-60, -54, -18.6, -16.1, DECK + 2.6, 'container', DECK)
  box(-50, -47, 2.2, 4.6, DECK + 4.2, 'twall', DECK)
  box(-44, -32, -17.4, -14.6, DECK + 3.2, 'bus', DECK)
  box(-20, -14, 13.4, 15.9, DECK + 2.6, 'container', DECK)
  box(-10, -5.4, -17.4, -15.4, DECK + 1.5, 'car', DECK)
  box(8, 14.1, 3.4, 5.9, DECK + 2.6, 'container', DECK)
  box(14.1, 20.2, 2.6, 5.1, DECK + 2.6, 'container', DECK)
  box(24, 27, -18.6, -16.2, DECK + 4.2, 'twall', DECK)
  box(34, 46, 12.6, 15.4, DECK + 3.2, 'bus', DECK)
  box(50, 52, -6.4, -1.8, DECK + 1.5, 'car', DECK)
  // 斜張橋的橋塔：河中間、橋面兩邊外面各一根塔柱，上下兩根橫樑
  const PY = BW + 4.4
  box(-2.5, 2.5, -PY, -BW - 0.4, 58, 'pylon', BED)
  box(-2.5, 2.5, BW + 0.4, PY, 58, 'pylon', BED)
  box(-2, 2, -PY, PY, 53, 'pylon', 50)
  box(-2, 2, -PY, PY, DECK - 1, 'pylon', DECK - 3)
  // 東岸的橋頭：一塊高架的平台，南北兩條引道往東下到大道旁邊（大道從兩條引道中間穿過平台底下）
  deck(PAD_X0, PAD_X1, -PAD_Z, PAD_Z, DECK)
  guard(PAD_X0, PAD_X1, -PAD_Z, -PAD_Z + 0.6, DECK)
  guard(PAD_X0, PAD_X1, PAD_Z - 0.6, PAD_Z, DECK)
  guard(PAD_X0, PAD_X0 + 0.6, BW, PAD_Z, DECK)
  guard(PAD_X1 - 0.6, PAD_X1, -PAD_IN, PAD_IN, DECK)
  for (const s of [-1, 1]) {
    const z0 = s < 0 ? -PAD_Z : PAD_IN
    const z1 = s < 0 ? -PAD_IN : PAD_Z
    embank(PAD_X1, E_RAMP_X1, z0, z1, 'x', DECK, 0)
    guard(PAD_X1, E_RAMP_X1, z0, z0 + 0.6, DECK, 0)
    guard(PAD_X1, E_RAMP_X1, z1 - 0.6, z1, DECK, 0)
    // 平台底下的柱子（在大道和引道中間）
    for (const z of [17, 25, 33]) {
      pier(65, 67, s * z - 1, s * z + 1, DECK - 1)
      pier(77, 79, s * z - 1, s * z + 1, DECK - 1)
    }
  }
  box(150, 153, -26, -22.4, 4.2, 'twall')
  box(160, 166, 7, 9.5, 2.6, 'container')
  box(196, 199, -7, -3.4, 4.2, 'twall')
  box(214, 220, 4, 6.5, 2.6, 'container')
  box(214, 220, 4, 6.5, 5.2, 'container', 2.6)
  box(226, 238, -9, -6.2, 3.2, 'bus')

  // ======== 走得進去的大樓、大橋的支線：兩岸一模一樣（西岸的照原點轉 180 度）========
  for (const m of [false, true]) {
    stack(m, TOWER_A, true, true, true)
    stack(m, TOWER_B)
    spur(m, !m)
  }
  // 東岸大樓 B 和大道中間的空地（西岸那一棟旁邊直接是街）
  lots.push({ x0: TOWER_B.x1, x1: 151, z0: TOWER_B.z0, z1: TOWER_B.z1, kind: 'parking' })
  box(143, 145.5, 252, 258.1, 2.6, 'container')
  box(143, 145.5, 292, 298.1, 2.6, 'container')
  box(143, 145.5, 292, 298.1, 5.2, 'container', 2.6)

  // ======== 北邊的高架快速道路 ========
  {
    const E = EXPRESS
    const zN = EXPRESS_Z - EXPRESS_W
    const zS = EXPRESS_Z + EXPRESS_W
    // 西岸：河岸道路旁（河濱步道上面，佔掉河岸道路靠河的一邊）的坡道往北爬，沿著河岸走到轉角，往東過河
    const w0 = -54
    const w1 = -RIVER
    const wc = (w0 + w1) / 2
    embank(w0, w1, -330, -250, 'z', E, 0)
    guard(w0, w0 + 0.6, -330, -250, E, 0)
    guard(w1 - 0.6, w1, -330, -250, E, 0)
    deck(w0, w1, zS, -330, E, 'z')
    deck(w0, 36, zN, zS, E, 'x')
    guard(w0, w0 + 0.6, zN, -330, E)
    guard(w0, 36, zN, zN + 0.6, E)
    guard(w1 - 0.6, w1, zS, -330, E)
    guard(w1, 36, zS - 0.6, zS, E)
    for (let z = -342; z > zN; z -= 17) pier(wc - 1, wc + 1, z - 1, z + 1, E - 1)
    pier(-20, -17, zN + 2, zS - 2, E - 1, BED)
    pier(10, 13, zN + 2, zS - 2, E - 1, BED)
    // 東岸的交流道：橋接上一塊平台（C1），往東一路下坡（第一段、平台 C2、直直往東下到大街），
    // 或從 C2 往北繞一圈螺旋：C2 → 往北 → C3 → 往西 → C4 → 往南穿過 C1 底下，接到河岸道路
    const a = 36
    const b = 49
    const c = 79
    const d = 92
    const zN2 = -422
    const zN3 = -435
    const h1 = E * 0.75
    const h2 = E * 0.5
    const h3 = E * 0.25
    deck(a, b, zN, zS, E)
    guard(a, b, zN, zN + 0.6, E)
    guard(a, b, zS - 0.6, zS, E)
    embank(b, c, zN, zS, 'x', E, h1)
    guard(b, c, zN, zN + 0.6, E, h1)
    guard(b, c, zS - 0.6, zS, E, h1)
    embank(c, d, zN, zS, 'x', h1, h1)
    guard(c, d, zS - 0.6, zS, h1)
    embank(d, 152, zN, zS, 'x', h1, 0)
    guard(d, 152, zN, zN + 0.6, h1, 0)
    guard(d, 152, zS - 0.6, zS, h1, 0)
    embank(c, d, zN2, zN, 'z', h2, h1)
    guard(c, c + 0.6, zN2, zN, h2, h1)
    guard(d - 0.6, d, zN2, zN, h2, h1)
    embank(c, d, zN3, zN2, 'z', h2, h2)
    guard(c, d, zN3, zN3 + 0.6, h2)
    guard(d - 0.6, d, zN3 + 0.6, zN2, h2)
    embank(b, c, zN3, zN2, 'x', h3, h2)
    guard(b, c, zN3, zN3 + 0.6, h3, h2)
    guard(b, c, zN2 - 0.6, zN2, h3, h2)
    embank(a, b, zN3, zN2, 'z', h3, h3)
    guard(a, b, zN3, zN3 + 0.6, h3)
    guard(a, a + 0.6, zN3 + 0.6, zN2, h3)
    embank(a, b, zN2, zN, 'z', h3, 0)
    // 螺旋中間的小島：草地和樹
    lots.push({ x0: b, x1: c, z0: zN2, z1: zN, kind: 'park' })
    for (let k = 0; k < 7; k++) {
      const tx = r(b + 4, c - 4)
      const tz = r(zN2 + 4, zN - 4)
      box(tx - 0.6, tx + 0.6, tz - 0.6, tz + 0.6, 9, 'tree')
    }
    // 路上的掩體
    // （路上要留一條 8 公尺寬的路給機甲走）
    box(w0 + 0.6, w0 + 3.6, -360, -357, E + 4.2, 'twall', E)
    box(w1 - 2.6, w1 - 0.6, -372, -367.4, E + 1.5, 'car', E)
    box(-33, -30, zS - 3.4, zS - 1, E + 4.2, 'twall', E)
    box(-24, -12, zN + 0.6, zN + 3.4, E + 3.2, 'bus', E)
    box(6, 12.1, zS - 3.6, zS - 1.1, E + 2.6, 'container', E)
    box(20, 24.6, zN + 1, zN + 3, E + 1.5, 'car', E)
    box(60, 63, zS - 3, zS - 0.6, 8.8 + 4.2, 'twall', 8.8)
    box(118, 121, zN + 0.6, zN + 3, 4 + 4.2, 'twall', 4)
    // 電腦走的路
    walk(wc, -244, 0, wc, -330, E)
    walk(wc, -330, E, wc, EXPRESS_Z, E)
    walk(wc, EXPRESS_Z, E, 42.5, EXPRESS_Z, E)
    walk(42.5, EXPRESS_Z, E, 85.5, EXPRESS_Z, h1)
    walk(85.5, EXPRESS_Z, h1, 158, EXPRESS_Z, 0)
    walk(85.5, EXPRESS_Z, h1, 85.5, -428.5, h2)
    walk(85.5, -428.5, h2, 42.5, -428.5, h3)
    walk(42.5, -428.5, h3, 42.5, zN, 0)
    walk(42.5, zN, 0, 42.5, -364, 0)
  }

  // ======== 東岸（新市區、港口）========
  // ---- 北邊：交流道旁邊 ----
  carPark(92, 151, -440, -396)
  warehouses(169, 214, -440, -392)
  terrace(226, 262, -440, -392, 18, 26)
  yard(286, MAP_X, -440, -392)
  towers(64, 151, -372, -307, 50, 72)
  courtyard(169, 214, -378, -307, 20, 30)
  slab(226, 262, -378, -307, 22, 34)
  warehouses(286, MAP_X, -378, -307)
  slab(64, 151, -293, -237, 26, 40)
  corner(169, 214, -293, -237, 22, 36)
  terrace(226, 262, -293, -237, 18, 26)
  slab(286, MAP_X, -293, -237, 20, 28)
  // ---- 新市區：高樓 ----
  terrace(64, 97, -223, -140, 20, 30)
  towers(111, 151, -223, -140, 55, 80)
  towers(169, 214, -223, -140, 60, 88)
  slab(226, 262, -223, -140, 30, 46)
  warehouses(286, MAP_X, -223, -140)
  slab(169, 214, -126, -52, 28, 44)
  terrace(226, 262, -126, -52, 20, 30)
  yard(286, MAP_X, -126, -50)
  terrace(169, 214, -40, -12, 18, 26)
  terrace(226, 262, -40, -12, 18, 24)
  slab(169, 214, 12, 40, 20, 30)
  terrace(226, 262, 12, 40, 18, 26)
  // ---- 南邊：住宅、公園、立體停車場 ----
  terrace(64, 97, 52, 113, 18, 28)
  courtyard(111, 151, 52, 113, 20, 30)
  corner(169, 214, 52, 113, 22, 34)
  slab(226, 262, 52, 113, 20, 32)
  slab(286, MAP_X, 50, 113, 18, 26)
  slab(64, 97, 127, 180, 22, 34)
  park(111, 151, 127, 180)
  terrace(64, 97, 192, 223, 18, 26)
  terrace(111, 151, 192, 223, 18, 26)
  garage(169, 214, 127, 223)
  corner(226, 262, 127, 223, 20, 32)
  warehouses(286, MAP_X, 127, 223)
  // ---- 港口 ----
  warehouses(169, 214, 237, 321)
  site(226, 262, 237, 321)
  terrace(286, MAP_X, 237, 321, 18, 24)
  yard(64, 151, 339, MAP_Z)
  yard(169, 214, 339, 393)
  warehouses(226, 262, 339, 393)
  warehouses(286, MAP_X, 339, 393)
  slab(169, 214, 407, MAP_Z, 18, 26)
  terrace(226, 262, 407, MAP_Z, 18, 24)
  slab(286, MAP_X, 407, MAP_Z, 18, 24)
  crane(362)
  crane(418)
  // 通到公路橋的大街：路中間的掩體
  box(90, 93, 323.6, 327.2, 4.2, 'twall')
  box(128, 134, 333, 335.5, 2.6, 'container')
  box(190, 202, 322.5, 325.3, 3.2, 'bus')
  box(244, 247, 332, 335.6, 4.2, 'twall')

  // ======== 河 ========
  // 河岸的地面：比河床高 8 公尺（看不到，只是讓碰撞、射線知道河道是低的）
  box(-2000, -RIVER, -2000, 2000, 0, 'land', BED)
  box(RIVER, 2000, -2000, 2000, 0, 'land', BED)
  lots.push({ x0: -48, x1: -RIVER, z0: -MAP_Z, z1: MAP_Z, kind: 'promenade' })
  lots.push({ x0: RIVER, x1: 48, z0: EXPRESS_Z + 13, z1: MAP_Z, kind: 'promenade' })
  // 人行鋼橋：和路面一樣高、20 公尺寬，橋下機甲走得過去
  // （和下面兩座橋一樣：掩體放在中線上或靠欄杆，中線兩邊各留一條路）
  {
    const c = FOOTBRIDGE_Z
    const z0 = c - FOOTBRIDGE_W
    const z1 = c + FOOTBRIDGE_W
    box(-RIVER, RIVER, z0, z1, 0.2, 'deck', -0.7)
    box(-RIVER, RIVER, z0, z0 + 0.3, 1.3, 'rail', 0.2)
    box(-RIVER, RIVER, z1 - 0.3, z1, 1.3, 'rail', 0.2)
    pier(-1.5, 1.5, z0 + 1, z0 + 7, -0.7, BED)
    pier(-1.5, 1.5, z1 - 7, z1 - 1, -0.7, BED)
    box(-20, -15.4, z0 + 0.6, z0 + 2.6, 1.7, 'car', 0.2)
    box(10, 13, c - 1.2, c + 1.2, 4.4, 'twall', 0.2)
    box(22, 26.6, z1 - 2.6, z1 - 0.6, 1.7, 'car', 0.2)
  }
  // 鋼桁架橋：和路面一樣高、24 公尺寬，兩邊一根根鋼柱撐著上面的弦桿，頭上每隔一段一根橫樑（機甲過得去）
  {
    const c = TRUSS_Z
    const z0 = c - TRUSS_W
    const z1 = c + TRUSS_W
    box(-RIVER, RIVER, z0, z1, 0.2, 'deck', -0.7)
    for (const [a, b] of [
      [z0, z0 + 0.5],
      [z1 - 0.5, z1],
    ]) {
      box(-RIVER, RIVER, a, b, 1.3, 'rail', 0.2)
      box(-RIVER, RIVER, a, b, 8.2, 'rail', 7.4)
      for (let x = -RIVER; x <= RIVER + 0.01; x += 9) box(x - 0.3, x + 0.3, a, b, 7.4, 'rail', 0.2)
    }
    for (let x = -27; x <= 27; x += 18) box(x - 0.3, x + 0.3, z0, z1, 8, 'rail', 7.4)
    pier(-14, -11, z0 + 2, z0 + 9, -0.7, BED)
    pier(-14, -11, z1 - 9, z1 - 2, -0.7, BED)
    pier(11, 14, z0 + 2, z0 + 9, -0.7, BED)
    pier(11, 14, z1 - 9, z1 - 2, -0.7, BED)
    box(-22, -17.4, z0 + 1.2, z0 + 3.2, 1.7, 'car', 0.2)
    box(-6, 0, c - 1.2, c + 1.2, 2.8, 'container', 0.2)
    box(14, 17, z1 - 3.4, z1 - 1, 4.4, 'twall', 0.2)
  }
  // 公路橋：和路面一樣高、28 公尺寬（比兩岸的大街還寬），橋下機甲走得過去；橋上有掩體
  {
    const c = AVENUE_Z
    const z0 = c - AVENUE_W
    const z1 = c + AVENUE_W
    box(-RIVER, RIVER, z0, z1, 0.2, 'deck', -0.7)
    box(-RIVER, RIVER, z0, z0 + 0.3, 1.3, 'rail', 0.2)
    box(-RIVER, RIVER, z1 - 0.3, z1, 1.3, 'rail', 0.2)
    pier(-14, -11, z0 + 2, z0 + 10, -0.7, BED)
    pier(-14, -11, z1 - 10, z1 - 2, -0.7, BED)
    pier(11, 14, z0 + 2, z0 + 10, -0.7, BED)
    pier(11, 14, z1 - 10, z1 - 2, -0.7, BED)
    box(15.4, 20, z1 - 4, z1 - 2, 1.7, 'car', 0.2)
    box(-12, -6, z0 + 1.5, z0 + 4, 2.8, 'container', 0.2)
    box(1, 4, c - 1.8, c + 1.8, 4.4, 'twall', 0.2)
    box(-28, -16, c - 1.4, c + 1.4, 3.2, 'bus', 0.2)
  }
  // 下河的坡道：西岸、東岸各四道，位置不一樣（下面那一頭是河床）
  const slip = (side: -1 | 1, za: number, zb: number) => {
    const x0 = side < 0 ? -RIVER : RIVER - 7
    const x1 = side < 0 ? -RIVER + 7 : RIVER
    // za 是上面（路面）那一頭
    const z0 = Math.min(za, zb)
    const z1 = Math.max(za, zb)
    box(x0, x1, z0, z1, 0, 'slipway', BED, { axis: 'z', h0: za < zb ? 0 : BED, h1: za < zb ? BED : 0 })
    const x = side * 32.5
    const dir = Math.sign(zb - za)
    extra.push(
      { x, y: -0.6, z: za + dir * 4 },
      { x, y: BED / 2, z: (za + zb) / 2 },
      { x, y: BED + 0.8, z: zb - dir * 4 },
      { x: side * 24, y: BED, z: zb + dir * 2 },
    )
  }
  slip(-1, -170, -130)
  slip(-1, 100, 60)
  slip(-1, 420, 380)
  slip(-1, -400, -440)
  slip(1, -290, -330)
  slip(1, -90, -50)
  slip(1, 160, 120)
  slip(1, 270, 310)
  // 河裡的東西：沉了一半的駁船、掉下來的水泥塊
  box(-24, -12, 118, 150, BED + 3, 'barge', BED)
  box(-22, -14, 140, 147, BED + 6, 'barge', BED + 3)
  box(12, 24, -150, -118, BED + 3, 'barge', BED)
  box(14, 22, -147, -140, BED + 6, 'barge', BED + 3)
  box(-14, -10, -50, -45, BED + 2.2, 'rubble', BED)
  box(6, 10, -74, -69, BED + 1.6, 'rubble', BED)
  box(-28, -23, -160, -155, BED + 2.6, 'rubble', BED)
  box(-8, -3, 40, 46, BED + 2, 'rubble', BED)
  box(-26, -16, -428, -398, BED + 3, 'barge', BED)
  box(-24, -18, -420, -413, BED + 6, 'barge', BED + 3)
  box(8, 12, -292, -287, BED + 1.8, 'rubble', BED)
  box(-20, -15, 262, 267, BED + 2.4, 'rubble', BED)
  box(14, 26, 398, 430, BED + 3, 'barge', BED)
  box(-6, -1, 440, 446, BED + 2, 'rubble', BED)
  box(20, 25, 222, 227, BED + 2.2, 'rubble', BED)
  // 河濱步道的樹（橋頭、坡道口、高架底下、吊車那裡不種）
  const slips = [-170, 100, 420, -400, -290, -90, 160, 270]
  const clearAt = (z: number) => atCrossing(z, 6) || slips.some((s) => Math.abs(z - s) < 10)
  /** 大橋的支線沿著河岸的那一段（東岸 z 是負的） */
  const underSpur = (z: number) => z > SPUR_Z - 11 && z < -BRIDGE_W + 4
  for (let z = -MAP_Z + 8; z < MAP_Z - 4; z += 18) {
    // 選隊畫面的機甲站在這一段（`game.ts` 的 `SHOWROOM`），鏡頭繞著轉，不要被樹擋住
    if (clearAt(z) || underSpur(-z) || (z > -114 && z < -78) || (z > -398 && z < -244)) continue
    box(-41.6, -40.4, z - 0.6, z + 0.6, 9, 'tree')
  }
  for (let z = EXPRESS_Z + 22; z < MAP_Z - 4; z += 18) {
    if (clearAt(z) || underSpur(z) || [362, 418].some((c) => z > c - 4 && z < c + 20)) continue
    box(40.4, 41.6, z - 0.6, z + 0.6, 9, 'tree')
  }

  // ======== 街上的東西：路邊停的車、公車，路口的護欄和混凝土牆 ========
  // 只放在空的地方（不壓到房子、坡道、橋墩，高架底下可以）
  const free = (x0: number, x1: number, z0: number, z1: number) =>
    !boxes.some((b) => b.kind !== 'land' && b.y0 < 3 && b.x0 < x1 + 1 && b.x1 > x0 - 1 && b.z0 < z1 + 1 && b.z1 > z0 - 1)
  const near = (road: Road, v: number) => ROADS.some((c) => c !== road && crosses(road, c) && Math.abs(v - c.at) < c.w / 2 + 7)
  const put = (x0: number, x1: number, z0: number, z1: number, h: number, kind: BoxKind) => {
    if (free(x0, x1, z0, z1)) box(x0, x1, z0, z1, h, kind)
  }
  for (const road of ROADS) {
    if (road.w >= 20 || road.w < 10) continue
    for (let v = road.a + 8; v < road.b - 8; v += r(9, 15)) {
      if (near(road, v)) continue
      if (RIVERSIDES.includes(road) && atCrossing(v, 6)) continue
      const roll = rand()
      const lo = road.at - road.w / 2
      const hi = road.at + road.w / 2
      if (roll < 0.36) {
        const s = rand() < 0.5 ? lo + 0.8 : hi - 2.8
        if (road.axis === 'x') put(v, v + 4.6, s, s + 2, 1.5, 'car')
        else put(s, s + 2, v, v + 4.6, 1.5, 'car')
      } else if (roll < 0.43 && road.w >= 14 && v + 12 < road.b - 8 && !near(road, v + 12)) {
        const s = rand() < 0.5 ? lo + 0.8 : hi - 3.6
        if (road.axis === 'x') put(v, v + 12, s, s + 2.8, 3.2, 'bus')
        else put(s, s + 2.8, v, v + 12, 3.2, 'bus')
        v += 8
      }
    }
  }
  const main = [W_BOULEVARD, E_BOULEVARD, W_APRON, E_APRON, ...RIVERSIDES]
  for (const road of ROADS) {
    if (road.axis !== 'x' || main.includes(road) || road.w < 10) continue
    for (const c of ROADS) {
      if (!crosses(road, c) || main.includes(c) || c.w < 10) continue
      // 放在路口的一角，兩條路的中線都留給人走
      const cx = c.at + (rand() < 0.5 ? -1 : 1) * Math.min(4.6, c.w / 2 - 2)
      const cz = road.at + (rand() < 0.5 ? -1 : 1) * Math.min(4.6, road.w / 2 - 2)
      const kind = rand()
      if (kind < 0.35) put(cx - 1.8, cx + 1.8, cz - 0.4, cz + 0.4, 1.1, 'barrier')
      else if (kind < 0.65) put(cx - 1.5, cx + 1.5, cz - 1.2, cz + 1.2, 4.2, 'twall')
    }
  }

  // ======== 電腦走的路：大橋、橋頭平台和引道、河床、過河的橋 ========
  // 大橋：兩個方向的車道各一條（中間是分隔島），到東岸的平台分成南北兩條引道
  const padX = (PAD_X0 + PAD_X1) / 2
  const rampZ = (PAD_IN + PAD_Z) / 2
  walk(RAMP_X0 - 6, 0, 0, RAMP_X0 - 6, 0, 0)
  for (const s of [-1, 1]) {
    walk(RAMP_X0 + 10, s * 9, (10 / (RAMP_X1 - RAMP_X0)) * DECK, RAMP_X1, s * 9, DECK, 16)
    walk(RAMP_X1, s * 9, DECK, padX, s * 9, DECK, 16)
    walk(padX, s * 9, DECK, padX, s * rampZ, DECK)
    walk(padX, s * rampZ, DECK, E_RAMP_X1 - 4, s * rampZ, 0.5, 15)
    walk(E_RAMP_X1 + 6, s * rampZ, 0, E_RAMP_X1 + 6, s * rampZ, 0)
  }
  for (let z = -MAP_Z + 10; z < MAP_Z - 6; z += 28) {
    extra.push({ x: -42, y: 0, z }, { x: -12, y: BED, z }, { x: 12, y: BED, z })
    if (z > EXPRESS_Z + 16) extra.push({ x: 42, y: 0, z })
  }
  // 和路面一樣高的三座橋：中線兩邊各一條路
  for (const x of [-42, -30, -12, 12, 30, 42]) {
    for (const [z, w] of [
      [FOOTBRIDGE_Z, FOOTBRIDGE_W],
      [TRUSS_Z, TRUSS_W],
      [AVENUE_Z, AVENUE_W],
    ])
      extra.push({ x, y: 0, z: z - w / 2 }, { x, y: 0, z: z + w / 2 })
  }

  const roads = ROADS

  // 重生位置：機庫裡排成 5 × 6 格（30 對 30 也站得下），先排中間那一排、靠中間的
  const spawns: [Spawn[], Spawn[]] = [[], []]
  for (const back of [24, 16.5, 31.5, 9, 39]) {
    for (const z of [-4.75, 4.75, -14.25, 14.25, -23.75, 23.75]) {
      spawns[0].push({ x: -(MAP_X - back), z, yaw: Math.PI / 2 })
      spawns[1].push({ x: MAP_X - back, z: -z, yaw: -Math.PI / 2 })
    }
  }

  const map: MapData = { boxes, lots, roads, tracks, spawns, perches, nodes: [], links: [] }
  buildGraph(map, extra)
  return map
}

// ---------- 碰撞和射線 ----------

/** 能量牆：x 在這兩個值之間、|z| ≤ BASE.z 的地方擋住敵隊 */
const BARRIER_IN = BASE.x - 1
const BARRIER_OUT = BASE.x + 1

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** 均勻的格子：很快找到某個範圍附近的方塊 */
export class MapIndex {
  readonly data: MapData
  private readonly cell = 16
  private readonly cols: number
  private readonly rows: number
  private readonly cells: number[][]
  private readonly stamp: Uint32Array
  private visit = 0

  constructor(data: MapData) {
    this.data = data
    this.cols = Math.ceil((MAP_X * 2) / this.cell) + 1
    this.rows = Math.ceil((MAP_Z * 2) / this.cell) + 1
    this.cells = Array.from({ length: this.cols * this.rows }, () => [])
    this.stamp = new Uint32Array(data.boxes.length)
    data.boxes.forEach((b, i) => {
      const [c0, r0] = this.cellOf(b.x0, b.z0)
      const [c1, r1] = this.cellOf(b.x1, b.z1)
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) this.cells[r * this.cols + c].push(i)
    })
  }

  private cellOf(x: number, z: number): [number, number] {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor((x + MAP_X) / this.cell)))
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor((z + MAP_Z) / this.cell)))
    return [c, r]
  }

  /** 範圍內的方塊（每個只出現一次） */
  near(x0: number, z0: number, x1: number, z1: number, out: number[]): number[] {
    out.length = 0
    this.visit = (this.visit + 1) >>> 0
    if (this.visit === 0) {
      this.stamp.fill(0)
      this.visit = 1
    }
    const [c0, r0] = this.cellOf(x0, z0)
    const [c1, r1] = this.cellOf(x1, z1)
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        for (const i of this.cells[r * this.cols + c]) {
          if (this.stamp[i] === this.visit) continue
          this.stamp[i] = this.visit
          out.push(i)
        }
      }
    }
    return out
  }

  private readonly scratch: number[] = []

  /**
   * 圓柱（腳底在 y、高 h、半徑 radius）推出所有擋住的方塊；回傳推開的方向（沒撞到是 null）。
   * 腳底比方塊頂（斜坡是最靠近的那一點）低不到 `step` 的不算撞（踩得上去）。`team` 是用來判斷能量牆擋不擋
   */
  push(
    p: { x: number; y: number; z: number },
    radius: number,
    h: number,
    step: number,
    team: Team,
    normal: { x: number; z: number },
  ): boolean {
    let hit = false
    normal.x = 0
    normal.z = 0
    for (let pass = 0; pass < 2; pass++) {
      const list = this.near(p.x - radius, p.z - radius, p.x + radius, p.z + radius, this.scratch)
      for (const i of list) {
        const b = this.data.boxes[i]
        if (b.y0 >= p.y + h) continue
        const top = b.slope ? topAt(b, clamp(p.x, b.x0, b.x1), clamp(p.z, b.z0, b.z1)) : b.y1
        if (top <= p.y + step) continue
        if (pushOut(p, radius, b.x0, b.x1, b.z0, b.z1, normal)) hit = true
      }
      // 對方的能量牆（紅隊擋在東邊、藍隊擋在西邊）
      const bx0 = team === 0 ? BARRIER_IN : -BARRIER_OUT
      const bx1 = team === 0 ? BARRIER_OUT : -BARRIER_IN
      if (pushOut(p, radius, bx0, bx1, -BASE.z, BASE.z, normal)) hit = true
    }
    // 地圖邊界
    const mx = MAP_X - radius
    const mz = MAP_Z - radius
    if (p.x < -mx || p.x > mx) {
      normal.x += p.x < 0 ? 1 : -1
      p.x = Math.max(-mx, Math.min(mx, p.x))
      hit = true
    }
    if (p.z < -mz || p.z > mz) {
      normal.z += p.z < 0 ? 1 : -1
      p.z = Math.max(-mz, Math.min(mz, p.z))
      hit = true
    }
    const len = Math.hypot(normal.x, normal.z)
    if (len > 0) {
      normal.x /= len
      normal.z /= len
    }
    return hit
  }

  /** 頭頂上最低的東西（樓板、高架的底下）：腳底在 (x, z)、範圍 radius 裡，底面不比 `above` 低的；沒有是 Infinity */
  ceiling(x: number, z: number, radius: number, above: number): number {
    let low = Infinity
    const r = radius * 0.7
    const list = this.near(x - r, z - r, x + r, z + r, this.scratch)
    for (const i of list) {
      const b = this.data.boxes[i]
      if (x + r <= b.x0 || x - r >= b.x1 || z + r <= b.z0 || z - r >= b.z1) continue
      if (b.y0 >= above && b.y0 < low) low = b.y0
    }
    return low
  }

  /** 腳下最高的東西（路面、橋面、斜坡、貨櫃、車頂）；什麼都沒有就是河床 */
  ground(x: number, y: number, z: number, radius: number, step: number): number {
    let top = BED
    const r = radius * 0.7
    const list = this.near(x - r, z - r, x + r, z + r, this.scratch)
    for (const i of list) {
      const b = this.data.boxes[i]
      if (x + r <= b.x0 || x - r >= b.x1 || z + r <= b.z0 || z - r >= b.z1) continue
      const t = b.slope ? topAt(b, clamp(x, b.x0, b.x1), clamp(z, b.z0, b.z1)) : b.y1
      if (t > y + step || t <= top) continue
      top = t
    }
    return top
  }

  /**
   * 射線打到地圖（方塊、河床）的距離；`max` 以內沒打到回傳 Infinity。
   * 方向 (dx, dy, dz) 要是單位向量
   */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    let best = max
    if (dy < -1e-6) best = Math.min(best, (BED - oy) / dy)
    const ex = ox + dx * best
    const ez = oz + dz * best
    const list = this.near(Math.min(ox, ex), Math.min(oz, ez), Math.max(ox, ex), Math.max(oz, ez), this.scratch)
    for (const i of list) {
      const t = rayHit(this.data.boxes[i], ox, oy, oz, dx, dy, dz)
      if (t < best) best = t
    }
    return best < max ? best : Infinity
  }

  /** 兩點之間有沒有被擋住（看得到） */
  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-3) return true
    return this.ray(ax, ay, az, dx / len, dy / len, dz / len, len) === Infinity
  }
}

/** 圓（xz 平面）推出方塊，推開的方向加進 `normal` */
function pushOut(
  p: { x: number; z: number },
  radius: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  normal: { x: number; z: number },
): boolean {
  const cx = Math.max(x0, Math.min(x1, p.x))
  const cz = Math.max(z0, Math.min(z1, p.z))
  let dx = p.x - cx
  let dz = p.z - cz
  const d2 = dx * dx + dz * dz
  if (d2 >= radius * radius) return false
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2)
    dx /= d
    dz /= d
    p.x = cx + dx * radius
    p.z = cz + dz * radius
  } else {
    // 中心在方塊裡面：往最近的邊推出去
    const left = p.x - x0
    const right = x1 - p.x
    const top = p.z - z0
    const bottom = z1 - p.z
    const m = Math.min(left, right, top, bottom)
    dx = 0
    dz = 0
    if (m === left) {
      p.x = x0 - radius
      dx = -1
    } else if (m === right) {
      p.x = x1 + radius
      dx = 1
    } else if (m === top) {
      p.z = z0 - radius
      dz = -1
    } else {
      p.z = z1 + radius
      dz = 1
    }
  }
  normal.x += dx
  normal.z += dz
  return true
}

// 射線穿過的範圍 [span0, span1]，一個軸一個軸縮小（不配置記憶體）
let span0 = 0
let span1 = Infinity

function clip(o: number, d: number, lo: number, hi: number): boolean {
  if (Math.abs(d) < 1e-9) return o >= lo && o <= hi
  let a = (lo - o) / d
  let b = (hi - o) / d
  if (a > b) {
    const t = a
    a = b
    b = t
  }
  if (a > span0) span0 = a
  if (b < span1) span1 = b
  return span0 <= span1
}

/** 射線和方塊：回傳進入的距離，沒打到是 Infinity（起點在方塊裡面算 0） */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  span0 = 0
  span1 = Infinity
  if (!clip(ox, dx, x0, x1) || !clip(oy, dy, y0, y1) || !clip(oz, dz, z0, z1)) return Infinity
  return span0
}

/** 射線和地圖上的方塊（斜坡的頂面是斜的） */
function rayHit(b: Box, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  span0 = 0
  span1 = Infinity
  if (!clip(ox, dx, b.x0, b.x1) || !clip(oy, dy, b.y0, b.y1) || !clip(oz, dz, b.z0, b.z1)) return Infinity
  const s = b.slope
  if (!s) return span0
  // 頂面：y ≤ h0 + k (c - c0)，也就是 y - k·c ≤ h0 - k·c0
  const along = s.axis === 'x'
  const c0 = along ? b.x0 : b.z0
  const k = (s.h1 - s.h0) / ((along ? b.x1 : b.z1) - c0)
  const num = s.h0 - k * c0 - (oy - k * (along ? ox : oz))
  const den = dy - k * (along ? dx : dz)
  if (Math.abs(den) < 1e-9) return num < 0 ? Infinity : span0
  const t = num / den
  if (den > 0) span1 = Math.min(span1, t)
  else span0 = Math.max(span0, t)
  return span0 <= span1 ? span0 : Infinity
}

/** 位置在 `team` 的重生點裡 */
export function inBase(team: Team, x: number, z: number): boolean {
  const inward = team === 0 ? -x : x
  return inward >= BASE.x && Math.abs(z) <= BASE.z
}

// ---------- 電腦走的路網 ----------

/**
 * 路的中線（每隔一段一個點、路口）、機庫、`extra`（高架的路、坡道、河床、過河的橋，街廓裡的中庭和穿堂）。
 * 兩點之間一路走得過去（沒有東西擋住、沒有跳下去的落差）就連起來
 */
function buildGraph(map: MapData, extra: Pt[]) {
  const index = new MapIndex({ ...map, nodes: [], links: [] })
  const nodes: { x: number; y: number; z: number }[] = []
  const probe = { x: 0, y: 0, z: 0 }
  const normal = { x: 0, z: 0 }
  /** 加一個點：地面高度從 `y` 附近找；壓到東西就推到旁邊 */
  const add = (x: number, z: number, y = 0, gap = 6) => {
    if (Math.abs(x) > MAP_X - 4 || Math.abs(z) > MAP_Z - 4) return
    probe.x = x
    probe.z = z
    probe.y = index.ground(x, y + 0.5, z, 2, 0.7)
    index.push(probe, 2.2, 6, 0.3, x < 0 ? 0 : 1, normal)
    probe.y = index.ground(probe.x, probe.y + 0.5, probe.z, 2, 0.7)
    if (nodes.some((n) => Math.abs(n.y - probe.y) < 3 && Math.hypot(n.x - probe.x, n.z - probe.z) < gap)) return
    nodes.push({ x: probe.x, y: probe.y, z: probe.z })
  }

  for (const road of map.roads) {
    const len = road.b - road.a
    const n = Math.max(1, Math.ceil((len - 12) / 28))
    for (let k = 0; k <= n; k++) {
      const v = road.a + 6 + ((len - 12) * k) / n
      if (road.axis === 'x') add(v, road.at)
      else add(road.at, v)
    }
    for (const c of map.roads) {
      if (!crosses(road, c)) continue
      if (road.axis === 'x') add(c.at, road.at)
      else add(road.at, c.at)
    }
  }
  // 機庫裡面和門口
  for (const s of [-1, 1]) {
    add(s * (MAP_X - 24), 0)
    add(s * (MAP_X - 24), 18)
    add(s * (MAP_X - 24), -18)
    add(s * (BASE.x - 10), 0)
  }
  // 高架的路、坡道、河床、橋（先放，才不會被旁邊的點吃掉）；再來是巷子、穿堂（比較密，出口要對準）
  for (const p of extra) if (p.gap === undefined) add(p.x, p.z, p.y)
  for (const p of extra) if (p.gap !== undefined) add(p.x, p.z, p.y, p.gap)

  const links: number[][] = nodes.map(() => [])
  const p = { x: 0, y: 0, z: 0 }
  const n = { x: 0, z: 0 }
  const clearPath = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    const steps = Math.max(1, Math.ceil(len / 1.5))
    let y = a.y
    for (let k = 0; k <= steps; k++) {
      const ox = a.x + ((b.x - a.x) * k) / steps
      const oz = a.z + ((b.z - a.z) * k) / steps
      const g = index.ground(ox, y, oz, 1.7, 0.7)
      // 會掉下去的地方不走（掉下去就走不回來了）
      if (g < y - 1.2) return false
      y = g
      // 兩隊都走得過（能量牆不算：每一隊只走得進自己的機庫，在 `bot.ts` 擋）；
      // 踩得上去的高度和機甲一樣（坡道接上樓板的地方最後會高一點點）
      for (const team of [0, 1] as Team[]) {
        p.x = ox
        p.y = y
        p.z = oz
        index.push(p, 2.2, 6, 0.7, team, n)
        if (Math.hypot(p.x - ox, p.z - oz) > 0.01 && !(Math.abs(ox) > BASE.x - 3 && Math.abs(oz) <= BASE.z)) return false
      }
    }
    return Math.abs(y - b.y) < 1
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      if (Math.abs(a.x - b.x) > 64 || Math.abs(a.z - b.z) > 64) continue
      if (Math.hypot(a.x - b.x, a.z - b.z) > 64) continue
      if (clearPath(a, b)) {
        links[i].push(j)
        links[j].push(i)
      }
    }
  }
  // 只留最大的那一片（走不到的點留著只會害電腦卡住）
  const group = new Int32Array(nodes.length).fill(-1)
  const sizes: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    if (group[i] >= 0) continue
    const g = sizes.length
    const stack = [i]
    group[i] = g
    let size = 0
    while (stack.length) {
      const k = stack.pop()!
      size++
      for (const j of links[k]) {
        if (group[j] < 0) {
          group[j] = g
          stack.push(j)
        }
      }
    }
    sizes.push(size)
  }
  const main = sizes.indexOf(Math.max(...sizes))
  const keep = nodes.map((_, i) => i).filter((i) => group[i] === main)
  const renum = new Map(keep.map((old, i) => [old, i]))
  map.nodes = keep.map((i) => nodes[i])
  map.links = keep.map((i) => links[i].map((j) => renum.get(j)!))
}

/** 最近的、走得到的路網點（中間沒有東西擋住，高度差不多） */
export function nearestNode(index: MapIndex, x: number, y: number, z: number): number {
  const nodes = index.data.nodes
  const dist = (i: number) => Math.hypot(nodes[i].x - x, (nodes[i].y - y) * 3, nodes[i].z - z)
  // 由近到遠試（地圖大了點很多，不要每個點都算射線）：第一個看得到的就是答案
  const order = nearScratch
  order.length = 0
  for (let i = 0; i < nodes.length; i++) order.push(i)
  const d = distScratch.length >= nodes.length ? distScratch : (distScratch = new Float64Array(nodes.length))
  for (let i = 0; i < nodes.length; i++) d[i] = dist(i)
  order.sort((a, b) => d[a] - d[b])
  // 最近的幾個都被擋住（站在大樓裡、角落）就拿最近的，不要一路試到地圖另一頭
  const tries = Math.min(order.length, 24)
  for (let k = 0; k < tries; k++) {
    const i = order[k]
    if (d[i] < 4 || index.clear(x, y + 2, z, nodes[i].x, nodes[i].y + 2, nodes[i].z)) return i
  }
  return order.length ? order[0] : -1
}
const nearScratch: number[] = []
let distScratch = new Float64Array(0)

/**
 * A*：從 a 走到 b 經過的路網點（含頭尾）；`blocked` 是不能走的點（例如敵人的機庫），
 * `extra` 是走到某個點要多算的距離（不能是負的；電腦用它各自偏好不同的橋）
 */
export function findPath(map: MapData, a: number, b: number, blocked: (i: number) => boolean, extra?: (i: number) => number): number[] {
  const n = map.nodes.length
  const g = new Float64Array(n).fill(Infinity)
  const f = new Float64Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  const open = new Set<number>([a])
  const dist = (i: number, j: number) =>
    Math.hypot(map.nodes[i].x - map.nodes[j].x, map.nodes[i].y - map.nodes[j].y, map.nodes[i].z - map.nodes[j].z)
  g[a] = 0
  f[a] = dist(a, b)
  while (open.size) {
    let cur = -1
    for (const i of open) if (cur < 0 || f[i] < f[cur]) cur = i
    if (cur === b) break
    open.delete(cur)
    for (const nb of map.links[cur]) {
      if (blocked(nb) && nb !== b) continue
      const d = g[cur] + dist(cur, nb) + (extra ? extra(nb) : 0)
      if (d < g[nb]) {
        g[nb] = d
        f[nb] = d + dist(nb, b)
        from[nb] = cur
        open.add(nb)
      }
    }
  }
  if (a !== b && from[b] < 0) return [a]
  const path = [b]
  while (path[path.length - 1] !== a) path.push(from[path[path.length - 1]])
  return path.reverse()
}
