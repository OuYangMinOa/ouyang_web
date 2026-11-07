// 電腦對手：沿著賽道預先算好的行車線開（track.ts），用「追前方一個點」的方式打方向盤，
// 油門煞車照著建議速度。每台車的過彎速度、動力、偏好的車道都不太一樣，前面有車會從旁邊超。
import { clamp, wrapAngle } from './noise'
import type { Car, Controls } from './physics'
import { CAR } from './spec'
import type { TrackPath } from './track'

export type Difficulty = 'easy' | 'normal' | 'hard'

export type AiDriver = {
  /** 過彎速度的倍率（乘在建議速度上） */
  corner: number
  /** 原本的動力倍率（落後或領先太多時會在這附近微調） */
  power: number
  lane: number
  laneTarget: number
  laneTimer: number
  avoid: number
  /** 卡住多久了（秒），太久就放回賽道上 */
  stuck: number
}

const SKILL: Record<Difficulty, { power: [number, number]; corner: [number, number] }> = {
  easy: { power: [0.8, 0.87], corner: [0.82, 0.88] },
  normal: { power: [0.9, 0.96], corner: [0.9, 0.95] },
  hard: { power: [0.97, 1.02], corner: [0.96, 1.0] },
}

/** `rank` 0～1：0 是這個難度裡最強的 */
export function newAi(difficulty: Difficulty, rank: number): AiDriver {
  const { power, corner } = SKILL[difficulty]
  const jitter = (Math.random() - 0.5) * 0.02
  return {
    power: power[1] - (power[1] - power[0]) * rank + jitter,
    corner: corner[1] - (corner[1] - corner[0]) * rank,
    lane: 0,
    laneTarget: 0,
    laneTimer: 0,
    avoid: 0,
    stuck: 0,
  }
}

/** 跑完的玩家交給電腦開回去用的司機 */
export function cruiseAi(): AiDriver {
  return { power: 0.85, corner: 0.85, lane: 0, laneTarget: 0, laneTimer: 99, avoid: 0, stuck: 0 }
}

export function driveAi(car: Car, ai: AiDriver, track: TrackPath, cars: Car[], dt: number, out: Controls) {
  const v = Math.max(0, car.speed)
  const s = car.loc.s
  const half = track.length / 2

  // 偏好的車道偶爾換一下，大家才不會排成一直線
  ai.laneTimer -= dt
  if (ai.laneTimer <= 0) {
    ai.laneTarget = (Math.random() - 0.5) * 2.8
    ai.laneTimer = 4 + Math.random() * 6
  }
  ai.lane += clamp(ai.laneTarget - ai.lane, -dt * 0.8, dt * 0.8)

  // 前面有車擋路：從空間比較大的那一側超過去
  let avoid = 0
  let blocked = Infinity
  for (const other of cars) {
    if (other === car) continue
    let ds = other.loc.s - s
    if (ds > half) ds -= track.length
    else if (ds < -half) ds += track.length
    if (ds < -3 || ds > 22) continue
    const dl = other.loc.lat - car.loc.lat
    if (Math.abs(dl) > 3.4) continue
    if (ds > 5 && v - Math.max(0, other.speed) < 0.5) continue
    const side = dl > 0 ? -1 : 1
    avoid += side * (3.4 - Math.abs(dl)) * (1 - Math.max(0, ds) / 26)
    if (ds > 0 && Math.abs(dl) < 2) blocked = Math.min(blocked, ds)
  }
  ai.avoid += (avoid - ai.avoid) * Math.min(1, dt * 4)

  const look = 6 + v * 0.42
  const ts = s + look
  const p = track.pointAt(ts)
  const lim = track.halfWidth - 1.2
  const lat = clamp(track.sampleArray(track.line, ts) + ai.lane + ai.avoid, -lim, lim)
  const tx = p.x + p.tz * lat
  const tz = p.z - p.tx * lat

  // 追著前方的點打方向盤：要轉的角速度 = 2v·sin(α) / 距離
  const alpha = wrapAngle(Math.atan2(tx - car.x, tz - car.z) - car.heading)
  const dist = Math.max(1, Math.hypot(tx - car.x, tz - car.z))
  const yawWanted = (2 * Math.max(v, 4) * Math.sin(alpha)) / dist
  const yawLimit = Math.min(CAR.maxYaw, CAR.latAcc / Math.max(v, 1))
  out.steer = clamp(-yawWanted / yawLimit, -1, 1)
  out.drift = false

  // 車頭整個朝錯方向（被撞歪、打滑）：先慢慢開，讓方向盤把車頭轉回來
  if (Math.abs(alpha) > 1.6) {
    out.throttle = 0.5
    out.brake = 0
    return
  }

  let target = track.sampleArray(track.speed, s + 3 + v * 0.18) * ai.corner
  // 緊跟著前車又超不過去，就鬆一點油門，不要一直撞屁股
  if (blocked < 7) target = Math.min(target, v - 1)
  if (v < target - 1) {
    out.throttle = 1
    out.brake = 0
  } else if (v > target + 2) {
    out.throttle = 0
    out.brake = clamp((v - target) / 6, 0.2, 1)
  } else {
    out.throttle = 0.45
    out.brake = 0
  }
}
