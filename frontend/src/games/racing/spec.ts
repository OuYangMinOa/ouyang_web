// 車輛與賽道共用的常數，獨立出來免得 physics 和 track 互相 import

export const CAR = {
  /** 極速（公尺／秒），約 209 km/h */
  maxSpeed: 58,
  maxReverse: 12,
  engine: 17,
  brake: 30,
  reverse: 9,
  /** 能承受的側向加速度：決定過彎的最小半徑 */
  latAcc: 24,
  maxYaw: 2.4,
  grip: 10,
  driftGrip: 1.8,
  /** 甩尾時能轉得比平常急多少 */
  driftTurn: 1.5,
  offroadSpeed: 0.55,
  offroadGrip: 5,
  boostSpeed: 1.22,
  boostAccel: 16,
  /** 碰撞用：車身兩個圓的半徑與前後位置 */
  radius: 1.02,
  axle: 1.05,
  halfWidth: 0.95,
}

/** 路緣石的寬度：壓在上面還算在路面上 */
export const CURB = 1.0
