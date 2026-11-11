// 機甲的移動：街機式的手感。前後左右照瞄準的方向走，Shift 推進衝刺，空白鍵跳躍、按住往上飛，
// 衝刺和飛行共用一條能量。撞到大樓、貨櫃就推出去並去掉往牆裡的速度；矮的東西跳得上去、也站得上去。
// 堡壘型、砲擊型變身時（`deployed`，進度是 `deploy`）腳站死了：前後左右、衝刺、跳都沒用，只能轉向。
import { inBase, WATER, type MapIndex, type Team } from './map'
import { MECH, MECHS, type MechKind } from './spec'

export type MechInput = {
  /** 往右（-1～1） */
  strafe: number
  /** 往前（-1～1） */
  forward: number
  boost: boolean
  /** 按住跳躍／飛行 */
  jump: boolean
}

export type MechBody = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** 腳朝的方向 */
  legs: number
  /** 瞄準的水平角、仰角（往上是正） */
  aimYaw: number
  aimPitch: number
  onGround: boolean
  energy: number
  /** 能量停用多久了（秒），到 `regenDelay` 才開始回 */
  idle: number
  boosting: boolean
  hovering: boolean
  /** 能量用完了：要回到 `minBoost` 才能再用 */
  drained: boolean
  /** 上一步有沒有按著跳（按下去的那一下才跳） */
  jumpHeld: boolean
  /** 走路動畫的相位，和往前（1）或往後（-1）走 */
  stride: number
  walkDir: number
  /** 剛落地的衝擊（0～1），畫面和聲音用 */
  landed: number
  team: Team
  /** 哪一種機甲（數值照 `MECHS`） */
  kind: MechKind
  /** 要變身（堡壘型、砲擊型）；變身的進度 0～1（照 `deploy.time`、`deploy.pack` 慢慢變，1 是變身好了） */
  deployed: boolean
  deploy: number
}

export function newBody(team: Team, kind: MechKind, x: number, z: number, yaw: number): MechBody {
  return {
    x,
    y: 0,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    legs: yaw,
    aimYaw: yaw,
    aimPitch: 0,
    onGround: true,
    energy: MECH.energy,
    idle: 0,
    boosting: false,
    hovering: false,
    drained: false,
    jumpHeld: false,
    stride: 0,
    walkDir: 1,
    landed: 0,
    team,
    kind,
    deployed: false,
    deploy: 0,
  }
}

/** 變身好了（可以用變身後的主武器） */
export const deployedReady = (b: MechBody) => b.deployed && b.deploy >= 1

/** 變身的進度往前走 `h` 秒（變身、收回） */
export function stepDeploy(b: MechBody, h: number) {
  const dep = MECHS[b.kind].deploy
  if (!dep) {
    b.deployed = false
    b.deploy = 0
    return
  }
  b.deploy = clamp(b.deploy + (b.deployed ? h / dep.time : -h / dep.pack), 0, 1)
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

/** 從 a 往 b 轉，最多轉 `max` */
export function turnToward(a: number, b: number, max: number): number {
  const d = wrapAngle(b - a)
  return wrapAngle(a + clamp(d, -max, max))
}

const normal = { x: 0, z: 0 }

/** 往前算一步（`h` 秒） */
export function stepMech(b: MechBody, input: MechInput, h: number, map: MapIndex) {
  const spec = MECHS[b.kind]
  stepDeploy(b, h)
  // 變身中、變身後、收回中：腳站死了
  const planted = b.deployed || b.deploy > 0
  const forward = planted ? 0 : input.forward
  const strafe = planted ? 0 : input.strafe
  const sin = Math.sin(b.aimYaw)
  const cos = Math.cos(b.aimYaw)
  // 前方 (sin, cos)、右方 (-cos, sin)
  let wx = sin * forward - cos * strafe
  let wz = cos * forward + sin * strafe
  let wish = Math.hypot(wx, wz)
  if (wish > 1) {
    wx /= wish
    wz /= wish
    wish = 1
  }

  // 能量：衝刺和飛行共用
  const wantBoost = input.boost && !planted && !b.drained && b.energy > 0
  b.boosting = wantBoost && (b.boosting || b.energy >= MECH.minBoost)
  if (b.boosting && wish < 0.1) {
    // 沒按方向就往前衝
    wx = sin
    wz = cos
    wish = 1
  }

  // 跳躍：在地上按下去那一下；之後按住往上飛（有推進器、有能量、還沒到最高）
  const pressed = input.jump && !b.jumpHeld && !planted
  b.jumpHeld = input.jump
  if (pressed && b.onGround) {
    b.vy = spec.jump
    b.onGround = false
  }
  const jets = spec.jets !== null
  b.hovering = jets && !b.onGround && input.jump && !b.drained && b.energy > 0 && b.vy < 7 && b.y < spec.maxHover

  let use = 0
  if (b.boosting) use += spec.boostDrain
  if (b.hovering) use += spec.hoverDrain
  if (use > 0) {
    b.energy = Math.max(0, b.energy - use * h)
    b.idle = 0
    if (b.energy <= 0) {
      b.drained = true
      b.boosting = false
      b.hovering = false
    }
  } else {
    b.idle += h
    if (b.idle >= MECH.regenDelay) b.energy = Math.min(MECH.energy, b.energy + MECH.regen * h)
  }
  if (b.drained && b.energy >= MECH.minBoost) b.drained = false

  // 水平速度追上想要的速度（在河裡涉水慢一點；變身時很快停下來）
  const top = (b.boosting ? spec.boost : spec.walk) * (b.onGround && b.y < WATER - 0.1 ? 0.8 : 1)
  const accel = planted && b.onGround ? 120 : b.onGround ? (b.boosting ? spec.boostAccel : spec.accel) : b.boosting ? spec.boostAccel * 0.6 : spec.airAccel
  const tx = wx * top * wish
  const tz = wz * top * wish
  const dx = tx - b.vx
  const dz = tz - b.vz
  const dl = Math.hypot(dx, dz)
  const step = accel * h
  if (dl <= step) {
    b.vx = tx
    b.vz = tz
  } else {
    b.vx += (dx / dl) * step
    b.vz += (dz / dl) * step
  }

  // 垂直：重力，飛行時推進器往上推
  b.vy -= MECH.gravity * h
  if (b.hovering) b.vy += spec.hover * h
  if (jets && b.y > spec.maxHover && b.vy > 0) b.vy *= Math.exp(-6 * h)

  const head = b.y + spec.height
  b.x += b.vx * h
  b.z += b.vz * h
  b.y += b.vy * h
  // 往上撞到頭頂的東西（大樓的樓板、高架的底下）：停在下面，不要被當成牆推到旁邊
  if (b.vy > 0) {
    const ceil = map.ceiling(b.x, b.z, spec.radius, head - 0.05)
    if (b.y + spec.height > ceil) {
      b.y = ceil - spec.height
      b.vy = 0
    }
  }

  // 撞到東西：推出去，去掉往牆裡的速度
  if (map.push(b, spec.radius, spec.height, MECH.step, b.team, normal)) {
    const into = b.vx * normal.x + b.vz * normal.z
    if (into < 0) {
      b.vx -= into * normal.x
      b.vz -= into * normal.z
    }
  }

  // 落地、站上矮的東西
  const ground = map.ground(b.x, b.y, b.z, spec.radius, MECH.step)
  b.landed = Math.max(0, b.landed - h * 3)
  if (b.y <= ground) {
    if (!b.onGround && b.vy < -8) b.landed = Math.min(1, -b.vy / 22)
    b.y = ground
    if (b.vy < 0) b.vy = 0
    b.onGround = true
  } else if (b.onGround && b.vy <= 0 && b.y - ground < 0.45) {
    // 走下坡（大橋的引道、下河的坡道）：貼著地面走，不要一路彈跳
    b.y = ground
    b.vy = 0
  } else if (b.y > ground + 0.05) {
    b.onGround = false
  }
  // 在平地上往上一點點的台階（花台邊）：直接踩上去
  if (b.onGround && b.y < ground) b.y = ground

  // 腳的方向：往前走時朝移動的方向，往後退時背對移動的方向，不會和上半身差太多
  const speed = Math.hypot(b.vx, b.vz)
  if (speed > 1.5) {
    const move = Math.atan2(b.vx, b.vz)
    const diff = wrapAngle(move - b.aimYaw)
    const back = Math.abs(diff) > Math.PI * 0.6
    b.walkDir = back ? -1 : 1
    const target = back ? wrapAngle(move + Math.PI) : move
    const limited = wrapAngle(b.aimYaw + clamp(wrapAngle(target - b.aimYaw), -1.2, 1.2))
    b.legs = turnToward(b.legs, limited, 7 * h)
    // 噴火衝刺時腳不動；沒有推進器的快跑一樣在走
    if (b.onGround && (!b.boosting || !jets)) b.stride += (speed / spec.gait) * h * b.walkDir
  } else {
    if (Math.abs(wrapAngle(b.aimYaw - b.legs)) > 0.9) b.legs = turnToward(b.legs, b.aimYaw, 4 * h)
    // 停下來時把腳收回來
    const k = Math.round(b.stride / Math.PI) * Math.PI
    b.stride += clamp(k - b.stride, -6 * h, 6 * h)
  }
}

/** 在自己的重生點裡（不能開火、打不到） */
export function safe(b: MechBody): boolean {
  return inBase(b.team, b.x, b.z)
}
