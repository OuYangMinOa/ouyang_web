// 車輛與賽道共用的常數，獨立出來免得 physics 和 track 互相 import

/** 所有車共用的數值；各車種不同的在 `CARS` */
export const CAR = {
  /** 綜合型的極速（公尺／秒），約 209 km/h；高速效果和電腦的建議速度都以它為準 */
  maxSpeed: 58,
  maxReverse: 12,
  brake: 30,
  reverse: 9,
  /** 綜合型能承受的側向加速度：決定過彎的最小半徑 */
  latAcc: 24,
  grip: 10,
  driftGrip: 1.8,
  /** 甩尾時能轉得比平常急多少 */
  driftTurn: 1.5,
  offroadSpeed: 0.55,
  offroadGrip: 5,
  boostSpeed: 1.22,
  boostAccel: 16,
}

export type CarKind = 'all' | 'speed' | 'accel' | 'grip' | 'drift'

export type CarSpec = {
  kind: CarKind
  name: string
  blurb: string
  /** 極速（公尺／秒） */
  maxSpeed: number
  /** 起步的加速度（公尺／秒²），越接近極速越小 */
  engine: number
  /** 能承受的側向加速度：越大過彎越快 */
  latAcc: number
  /** 低速時最多能轉多快（弧度／秒） */
  maxYaw: number
  /** 甩尾放開後加速秒數的倍率 */
  driftBoost: number
  /** 甩尾集氣速度的倍率 */
  driftCharge: number
  /** 重量：撞車時重的推得動輕的（綜合型是 1） */
  mass: number
  /** 車身長、寬（公尺）：模型和碰撞都照這個 */
  length: number
  width: number
  /** 選單上的評分（1～5），照上面的數值估的 */
  stats: { speed: number; accel: number; handling: number; drift: number; weight: number }
}

/** 各車種：每種都有長處和短處，重的車撞人有利，但加速或過彎比較吃虧 */
export const CARS: CarSpec[] = [
  {
    kind: 'all',
    name: '綜合',
    blurb: '各方面都不錯，沒有明顯的弱點',
    maxSpeed: 58,
    engine: 17,
    latAcc: 24,
    maxYaw: 2.4,
    driftBoost: 1,
    driftCharge: 1,
    mass: 1,
    length: 4.36,
    width: 1.86,
    stats: { speed: 3, accel: 3, handling: 3, drift: 3, weight: 3 },
  },
  {
    kind: 'speed',
    name: '極速',
    blurb: '直線最快、又重又長，起步和過彎比較吃力',
    maxSpeed: 62.5,
    engine: 15,
    latAcc: 22.5,
    maxYaw: 2.25,
    driftBoost: 0.9,
    driftCharge: 0.95,
    mass: 1.3,
    length: 4.72,
    width: 1.98,
    stats: { speed: 5, accel: 2, handling: 2, drift: 2, weight: 5 },
  },
  {
    kind: 'accel',
    name: '加速',
    blurb: '起步最猛、出彎馬上衝出去，極速比較低',
    maxSpeed: 55,
    engine: 21.5,
    latAcc: 23.5,
    maxYaw: 2.5,
    driftBoost: 1,
    driftCharge: 1,
    mass: 0.85,
    length: 3.9,
    width: 1.78,
    stats: { speed: 2, accel: 5, handling: 3, drift: 3, weight: 2 },
  },
  {
    kind: 'grip',
    name: '操控',
    blurb: '又小又輕，彎道可以壓得很快，被撞容易被推開',
    maxSpeed: 56,
    engine: 16.5,
    latAcc: 27,
    maxYaw: 2.8,
    driftBoost: 0.95,
    driftCharge: 1,
    mass: 0.8,
    length: 3.96,
    width: 1.8,
    stats: { speed: 2, accel: 3, handling: 5, drift: 3, weight: 1 },
  },
  {
    kind: 'drift',
    name: '甩尾',
    blurb: '甩尾集氣快、放開後加速更久，抓地力稍差',
    maxSpeed: 57,
    engine: 16.5,
    latAcc: 23,
    maxYaw: 2.4,
    driftBoost: 1.4,
    driftCharge: 1.25,
    mass: 0.95,
    length: 4.4,
    width: 1.92,
    stats: { speed: 3, accel: 3, handling: 2, drift: 5, weight: 3 },
  },
]

export const STAT_NAMES: { key: keyof CarSpec['stats']; label: string }[] = [
  { key: 'speed', label: '極速' },
  { key: 'accel', label: '加速' },
  { key: 'handling', label: '操控' },
  { key: 'drift', label: '甩尾' },
  { key: 'weight', label: '重量' },
]

export function carSpec(kind: string | null | undefined): CarSpec {
  return CARS.find((c) => c.kind === kind) ?? CARS[0]
}

/** 碰撞用：車身用前後兩個圓近似（圓的半徑、圓心離車身中心多遠）；撞牆用車寬的一半 */
export function carShape(spec: CarSpec) {
  return { radius: spec.width * 0.55, axle: spec.length / 2 - 1.13, halfWidth: spec.width / 2 + 0.02 }
}

/** 車色：線上的順序和 `racing.rs` 的 `COLORS` 對應（伺服器只記第幾個） */
export const CAR_COLORS = [
  { name: '紅', hex: 0xe0393e },
  { name: '藍', hex: 0x2f6fe0 },
  { name: '黃', hex: 0xf2b705 },
  { name: '綠', hex: 0x1f9d55 },
  { name: '紫', hex: 0x8b46d8 },
  { name: '橘', hex: 0xf26b1d },
  { name: '白', hex: 0xe8e8e8 },
  { name: '黑', hex: 0x2b2b30 },
  { name: '粉紅', hex: 0xf06aa8 },
  { name: '青', hex: 0x14b3b8 },
]

/** 路緣石的寬度：壓在上面還算在路面上 */
export const CURB = 1.0
