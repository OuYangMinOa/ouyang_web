// 街機式的車輛物理：不算懸吊和輪胎，只有「往前的速度」和「側滑的速度」兩個分量。
// 一般行駛時側滑很快被抓地力吃掉；甩尾時抓地力變小，車尾甩出去滑行，放開時依甩尾時間給加速。
// 甩尾鍵按得越久，車尾甩得越開（車身打得越橫）、彎也轉得越急，像跑跑卡丁車那樣點一下是小甩、按住是大甩。
// 純計算，不碰畫面，電腦對手和玩家用同一套。
import { clamp, wrapAngle } from './noise'
import { CAR, CURB } from './spec'
import { newLoc, type TrackLoc, type TrackPath } from './track'

export type Controls = {
  /** 油門 0～1 */
  throttle: number
  /** 煞車／倒車 0～1 */
  brake: number
  /** 方向盤 -1（左）～1（右） */
  steer: number
  drift: boolean
}


/** 甩尾集氣的門檻（秒）與放開後的加速秒數 */
const DRIFT_LEVELS = [0.9, 2.0]
const DRIFT_BOOST = [0, 0.8, 1.6]
/** 甩尾鍵按住多久（秒）甩到最大 */
const DRIFT_RAMP = 1.1
/** 車身和滑行方向的夾角（弧度）：剛甩出去、按到底 */
const DRIFT_ANGLE = [0.2, 0.72]
/** 放開甩尾後車身回正的時間（秒）：這段時間側滑的速度大多轉回前進方向，不會一放開就掉速 */
const DRIFT_EXIT = 0.45
/** 車尾角度不夠時多轉的力道 */
const DRIFT_SNAP = 3.5

export type Car = {
  x: number
  y: number
  z: number
  heading: number
  vx: number
  vz: number
  /** 前進方向的速度（倒車是負的） */
  speed: number
  /** 側滑速度 */
  slip: number
  yawRate: number
  /** 實際的方向盤角度（輸入會慢慢轉過去） */
  steer: number
  /** 甩尾方向：1 往右、-1 往左、0 沒在甩尾 */
  drift: number
  /** 甩尾集氣（秒），決定放開後加速多久 */
  driftTime: number
  /** 甩尾鍵按住了多久（秒），決定甩多開 */
  driftHold: number
  /** 放開甩尾後還剩多久回正 */
  driftExit: number
  boost: number
  /** 動力倍率：玩家是 1，電腦依難度不同 */
  power: number
  throttle: number
  braking: boolean
  offroad: boolean
  /** 這一步撞牆的力道（公尺／秒），沒撞是 0 */
  impact: number
  loc: TrackLoc
  /** 從起跑線算起跑了多遠，倒退會減少；圈數和名次都靠它 */
  progress: number
}

export function newCar(): Car {
  return {
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    vx: 0,
    vz: 0,
    speed: 0,
    slip: 0,
    yawRate: 0,
    steer: 0,
    drift: 0,
    driftTime: 0,
    driftHold: 0,
    driftExit: 0,
    boost: 0,
    power: 1,
    throttle: 0,
    braking: false,
    offroad: false,
    impact: 0,
    loc: newLoc(),
    progress: 0,
  }
}

/** 把車放到賽道上距離 `s`、偏離中心 `lat` 的位置，車頭朝前、速度歸零 */
export function placeCar(car: Car, track: TrackPath, s: number, lat: number) {
  const p = track.pointAt(s)
  car.x = p.x + p.tz * lat
  car.z = p.z - p.tx * lat
  car.y = p.y
  car.heading = Math.atan2(p.tx, p.tz)
  car.vx = car.vz = car.speed = car.slip = car.yawRate = car.steer = 0
  car.drift = car.driftTime = car.driftHold = car.driftExit = car.boost = 0
  car.loc.i = track.indexAt(s)
  track.locate(car.x, car.z, car.loc)
}

function endDrift(car: Car) {
  car.drift = 0
  car.driftTime = 0
  car.driftHold = 0
}

/** 甩尾集氣到第幾段（0～2） */
export function driftLevel(car: Car): number {
  return car.driftTime >= DRIFT_LEVELS[1] ? 2 : car.driftTime >= DRIFT_LEVELS[0] ? 1 : 0
}

function approach(v: number, target: number, step: number) {
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step)
}

export function stepCar(car: Car, ctl: Controls, track: TrackPath, dt: number) {
  const sinH = Math.sin(car.heading)
  const cosH = Math.cos(car.heading)
  // 前方 (sinH, cosH)、左方 (cosH, -sinH)
  let vf = car.vx * sinH + car.vz * cosH
  let vl = car.vx * cosH - car.vz * sinH

  // 方向盤：回正比轉過去快，鍵盤點一下不會猛打
  const target = clamp(ctl.steer, -1, 1)
  const returning = Math.abs(target) < Math.abs(car.steer) || target * car.steer < 0
  car.steer = approach(car.steer, target, (returning ? 9 : 5) * dt)

  car.offroad = Math.abs(car.loc.lat) > track.halfWidth + CURB
  const boosting = car.boost > 0
  const vmax =
    CAR.maxSpeed * car.power * (boosting ? CAR.boostSpeed : 1) * (car.offroad ? CAR.offroadSpeed : 1)

  // 前後方向
  let a = 0
  car.braking = false
  car.throttle = ctl.throttle
  if (ctl.brake > 0.05) {
    if (vf > 0.5) {
      a -= CAR.brake * ctl.brake
      car.braking = true
    } else if (ctl.throttle < 0.05 && vf > -CAR.maxReverse) {
      a -= CAR.reverse * ctl.brake
    }
  }
  if (ctl.throttle > 0.05) {
    if (vf < -0.5) a += CAR.brake * ctl.throttle
    else {
      const r = Math.max(0, vf) / vmax
      a += CAR.engine * car.power * ctl.throttle * Math.max(0, 1 - r * r)
    }
  }
  if (boosting) {
    a += CAR.boostAccel * Math.max(0, 1 - Math.max(0, vf) / vmax)
    car.boost = Math.max(0, car.boost - dt)
  }
  vf += a * dt
  // 滾動阻力與風阻；超過目前的極速（開出路面、加速結束）時多減一些
  let drag = 1.2 + 0.0006 * vf * vf
  if (vf > vmax) drag += (vf - vmax) * 1.6
  vf = approach(vf, 0, drag * dt)

  // 甩尾的開始與結束
  const absV = Math.abs(vf)
  if (car.drift === 0) {
    if (ctl.drift && Math.abs(ctl.steer) > 0.3 && vf > 12 && !car.offroad) {
      car.drift = Math.sign(ctl.steer)
      car.driftTime = 0
      car.driftHold = 0
    }
  } else if (!ctl.drift || vf < 8) {
    // 放開按鍵才給加速；速度掉光了就白甩
    if (!ctl.drift) {
      car.boost = Math.max(car.boost, DRIFT_BOOST[driftLevel(car)])
      car.driftExit = DRIFT_EXIT
    }
    endDrift(car)
  }
  car.driftExit = Math.max(0, car.driftExit - dt)

  // 轉向：速度越快能轉的角度越小（過彎的最小半徑 = v² / latAcc）
  const lowSpeed = Math.min(1, absV / 5)
  const dir = vf >= 0 ? 1 : -1
  let yaw: number
  let grip = car.offroad ? CAR.offroadGrip : CAR.grip
  if (car.drift !== 0) {
    const into = car.steer * car.drift // 往甩尾方向打是正的
    car.driftHold += dt
    const ramp = Math.min(1, car.driftHold / DRIFT_RAMP)
    // 按越久轉越急
    const k = 0.5 + 0.45 * into
    const turn = CAR.driftTurn * (0.8 + 0.5 * ramp)
    const limit = Math.min(CAR.maxYaw * 1.3, (CAR.latAcc * turn) / Math.max(absV, 1))
    const base = k * limit
    // 按越久車尾甩越開：車身轉的速度固定時，抓地力越小、滑行角越大（穩定時 tan(角度) = 轉速 / 抓地力）。
    // 反打方向盤時角度收小，用來調整走線
    const angle = (DRIFT_ANGLE[0] + (DRIFT_ANGLE[1] - DRIFT_ANGLE[0]) * ramp) * (0.75 + 0.25 * into)
    grip = clamp(base / Math.tan(angle), CAR.driftGrip * 0.4, CAR.driftGrip * 2.2)
    // 車尾還沒甩到該有的角度就多轉一點，一按下去車尾馬上甩出去
    const now = Math.atan2(vl * car.drift, Math.max(vf, 1))
    yaw = -car.drift * Math.max(0, base + DRIFT_SNAP * (angle - now))
    // 甩得越開集氣越快
    car.driftTime += dt * (0.6 + 0.4 * Math.max(0, into)) * (0.8 + 0.4 * ramp)
  } else {
    const limit = Math.min(CAR.maxYaw, CAR.latAcc / Math.max(absV, 1))
    yaw = -car.steer * limit * lowSpeed * dir
  }
  car.yawRate = yaw

  // 先用舊的車頭方向算出世界座標的速度，車頭轉過去之後再拆成前進／側滑
  const wx = sinH * vf + cosH * vl
  const wz = cosH * vf - sinH * vl
  car.heading = wrapAngle(car.heading + yaw * dt)
  const s2 = Math.sin(car.heading)
  const c2 = Math.cos(car.heading)
  vf = wx * s2 + wz * c2
  vl = wx * c2 - wz * s2
  // 甩尾剛放開：抓地力慢慢回來，車身順順地回正
  if (car.drift === 0 && car.driftExit > 0) grip = Math.min(grip, 7)
  const nl = vl * Math.exp(-grip * dt)
  // 甩尾和回正時，側滑的動能大部分轉回前進方向，不會一甩就掉光速度（甩得越開掉越多）
  if ((car.drift !== 0 || car.driftExit > 0) && vf > 0) vf = Math.sqrt(vf * vf + 0.78 * (vl * vl - nl * nl))
  vl = nl
  // 側滑角太大就是打滑失控，結束甩尾
  if (car.drift !== 0 && Math.abs(vl) > Math.abs(vf) * 1.6) endDrift(car)

  car.vx = s2 * vf + c2 * vl
  car.vz = c2 * vf - s2 * vl
  car.x += car.vx * dt
  car.z += car.vz * dt
  car.speed = vf
  car.slip = vl

  // 護欄：推回來、往牆的速度反彈一點，順著牆的速度磨掉一些
  const prevS = car.loc.s
  track.locate(car.x, car.z, car.loc)
  car.impact = 0
  const limit = track.wall - CAR.halfWidth
  const lat = car.loc.lat
  if (Math.abs(lat) > limit) {
    const side = Math.sign(lat)
    const nx = car.loc.tz
    const nz = -car.loc.tx
    const over = Math.abs(lat) - limit
    car.x -= nx * over * side
    car.z -= nz * over * side
    const into = (car.vx * nx + car.vz * nz) * side
    if (into > 0) {
      car.vx -= nx * side * into * 1.3
      car.vz -= nz * side * into * 1.3
      const scrub = Math.min(0.45, into * 0.025)
      car.vx *= 1 - scrub
      car.vz *= 1 - scrub
      car.impact = into
      if (into > 4) {
        endDrift(car)
        car.driftExit = 0
      }
    }
    track.locate(car.x, car.z, car.loc)
  }
  car.y = car.loc.y

  let ds = car.loc.s - prevS
  if (ds > track.length / 2) ds -= track.length
  else if (ds < -track.length / 2) ds += track.length
  car.progress += ds
}

/** 車與車的碰撞：每台車用前後兩個圓近似，互相推開並交換一部分速度；撞擊力道也記在 `impact` */
export function collideCars(cars: Car[]) {
  const r2 = CAR.radius * 2
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i]
      const b = cars[j]
      const dx0 = b.x - a.x
      const dz0 = b.z - a.z
      if (dx0 * dx0 + dz0 * dz0 > 36) continue
      for (let ka = -1; ka <= 1; ka += 2) {
        for (let kb = -1; kb <= 1; kb += 2) {
          const ax = a.x + Math.sin(a.heading) * CAR.axle * ka
          const az = a.z + Math.cos(a.heading) * CAR.axle * ka
          const bx = b.x + Math.sin(b.heading) * CAR.axle * kb
          const bz = b.z + Math.cos(b.heading) * CAR.axle * kb
          const dx = bx - ax
          const dz = bz - az
          const d2 = dx * dx + dz * dz
          if (d2 >= r2 * r2 || d2 < 1e-6) continue
          const d = Math.sqrt(d2)
          const nx = dx / d
          const nz = dz / d
          const push = (r2 - d) / 2
          a.x -= nx * push
          a.z -= nz * push
          b.x += nx * push
          b.z += nz * push
          const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz
          if (rel < 0) {
            a.impact = Math.max(a.impact, -rel)
            b.impact = Math.max(b.impact, -rel)
            const j2 = (-(1 + 0.3) * rel) / 2
            a.vx -= nx * j2
            a.vz -= nz * j2
            b.vx += nx * j2
            b.vz += nz * j2
          }
        }
      }
    }
  }
}
