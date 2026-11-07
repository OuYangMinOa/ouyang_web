// 把鍵盤、手機上的觸控按鈕、遊戲手把合成一組操作（油門、煞車、方向、甩尾）。
import type { Controls } from './physics'

// 用 code 而不是 key：注音輸入法開著時 WASD 一樣能用
const LEFT = ['ArrowLeft', 'KeyA']
const RIGHT = ['ArrowRight', 'KeyD']
const GAS = ['ArrowUp', 'KeyW']
const BRAKE = ['ArrowDown', 'KeyS']
const DRIFT = ['Space', 'ShiftLeft', 'ShiftRight']
/** 這些鍵在比賽中不要讓瀏覽器拿去捲動頁面 */
const CAPTURE = new Set([...LEFT, ...RIGHT, ...GAS, ...BRAKE, 'Space'])

export type TouchState = { steer: number; gas: boolean; brake: boolean; drift: boolean }

/** 手把上按下去那一刻才算一次的按鈕（暫停、換視角） */
export type PadAction = 'pause' | 'camera'

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

export class Input {
  readonly touch: TouchState = { steer: 0, gas: false, brake: false, drift: false }
  /** 手機上預設自動踩油門，只要管方向和煞車 */
  autoGas = false
  /** 比賽中才攔截方向鍵、空白鍵 */
  capture = false
  private readonly keys = new Set<string>()
  private padPrev: boolean[] = []

  private readonly down = (e: KeyboardEvent) => {
    if (typing(e.target)) return
    this.keys.add(e.code)
    if (this.capture && CAPTURE.has(e.code)) e.preventDefault()
  }
  private readonly up = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }
  private readonly blur = () => {
    this.keys.clear()
  }

  attach() {
    window.addEventListener('keydown', this.down)
    window.addEventListener('keyup', this.up)
    window.addEventListener('blur', this.blur)
  }

  detach() {
    window.removeEventListener('keydown', this.down)
    window.removeEventListener('keyup', this.up)
    window.removeEventListener('blur', this.blur)
  }

  reset() {
    this.keys.clear()
    Object.assign(this.touch, { steer: 0, gas: false, brake: false, drift: false })
  }

  private any(codes: string[]) {
    return codes.some((c) => this.keys.has(c))
  }

  /** 讀出這一刻的操作；手把剛按下的動作放進 `actions` */
  read(out: Controls, actions: PadAction[]) {
    let steer = (this.any(RIGHT) ? 1 : 0) - (this.any(LEFT) ? 1 : 0) + this.touch.steer
    let throttle = this.any(GAS) || this.touch.gas ? 1 : 0
    let brake = this.any(BRAKE) || this.touch.brake ? 1 : 0
    let drift = this.any(DRIFT) || this.touch.drift

    const pad = navigator.getGamepads?.().find((p) => p?.connected && p.mapping === 'standard')
    if (pad) {
      const x = pad.axes[0] ?? 0
      if (Math.abs(x) > 0.15) steer += Math.sign(x) * ((Math.abs(x) - 0.15) / 0.85)
      if (pad.buttons[14]?.pressed) steer -= 1
      if (pad.buttons[15]?.pressed) steer += 1
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0, pad.buttons[0]?.pressed ? 1 : 0)
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0, pad.buttons[2]?.pressed ? 1 : 0)
      drift ||= !!(pad.buttons[1]?.pressed || pad.buttons[5]?.pressed || pad.buttons[4]?.pressed)
      const pressed = pad.buttons.map((b) => b.pressed)
      if (pressed[9] && !this.padPrev[9]) actions.push('pause')
      if (pressed[3] && !this.padPrev[3]) actions.push('camera')
      this.padPrev = pressed
    }

    if (this.autoGas && brake < 0.1) throttle = 1
    out.steer = Math.max(-1, Math.min(1, steer))
    out.throttle = throttle
    out.brake = brake
    out.drift = drift
  }
}
