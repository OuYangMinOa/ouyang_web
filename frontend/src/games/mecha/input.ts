// 把鍵盤滑鼠、手機上的觸控、遊戲手把合成一組操作。
// 電腦：WASD 移動、滑鼠瞄準（鎖定游標）、左鍵開火、右鍵瞄準放大、Shift 推進衝刺、空白鍵跳躍／按住飛行、Q 飛彈、R 換彈、
// E 是特殊能力：放出偵察機、在偵察機和機甲之間切換（偵察型），變身、收回（堡壘型、砲擊型）。
// 沒有滑鼠（觸控板不好按住）也能用方向鍵轉頭。

export type Controls = {
  strafe: number
  forward: number
  boost: boolean
  jump: boolean
  fire: boolean
  zoom: boolean
}

/** 按下去那一刻才算一次的動作；`ability` 是 E（偵察機、變身） */
export type PadAction = 'missile' | 'reload' | 'ability' | 'menu'

export type TouchState = {
  /** 左邊搖桿：往右、往前（-1～1） */
  moveX: number
  moveY: number
  fire: boolean
  boost: boolean
  jump: boolean
  /** 觸控的「瞄準」按鈕（按一下開、再按一下關） */
  zoom: boolean
}

// 用 code 而不是 key：注音輸入法開著時 WASD 一樣能用
const KEYS = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  boost: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  lookLeft: ['ArrowLeft'],
  lookRight: ['ArrowRight'],
  lookUp: ['ArrowUp'],
  lookDown: ['ArrowDown'],
}
const CAPTURE = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'])
/** 方向鍵、手把右搖桿轉頭的速度（弧度／秒） */
const KEY_TURN = 2.2
const PAD_TURN = 2.8

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
}

export class Input {
  readonly touch: TouchState = { moveX: 0, moveY: 0, fire: false, boost: false, jump: false, zoom: false }
  /** 對戰中才攔截按鍵、滑鼠 */
  capture = false
  /** 滑鼠靈敏度（倍數） */
  sensitivity = 1
  /** 這一格累積的轉頭量（弧度），讀完歸零 */
  private lookX = 0
  private lookY = 0
  private readonly keys = new Set<string>()
  private mouseFire = false
  private mouseZoom = false
  private padPrev: boolean[] = []
  private readonly actions: PadAction[] = []
  private target: HTMLElement | null = null

  private readonly down = (e: KeyboardEvent) => {
    if (typing(e.target)) return
    this.keys.add(e.code)
    if (!this.capture) return
    if (CAPTURE.has(e.code)) e.preventDefault()
    if (e.repeat) return
    if (e.code === 'KeyQ') this.actions.push('missile')
    else if (e.code === 'KeyR') this.actions.push('reload')
    else if (e.code === 'KeyE') this.actions.push('ability')
  }
  private readonly up = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }
  private readonly blur = () => this.reset()
  private readonly move = (e: MouseEvent) => {
    if (!this.locked) return
    // 放大瞄準時轉得慢一點由 game.ts 照視角算
    const k = 0.0022 * this.sensitivity
    this.lookX += e.movementX * k
    this.lookY += e.movementY * k
  }
  private readonly mouseDown = (e: MouseEvent) => {
    if (!this.capture) return
    if (!this.locked) {
      if (e.target === this.target) this.lock()
      return
    }
    if (e.button === 0) this.mouseFire = true
    if (e.button === 2) this.mouseZoom = true
  }
  private readonly mouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseFire = false
    if (e.button === 2) this.mouseZoom = false
  }
  private readonly menu = (e: Event) => {
    if (this.capture) e.preventDefault()
  }
  private readonly lockChange = () => {
    if (!this.locked) {
      this.mouseFire = false
      this.mouseZoom = false
    }
  }

  get locked(): boolean {
    return this.target !== null && document.pointerLockElement === this.target
  }

  attach(target: HTMLElement) {
    this.target = target
    window.addEventListener('keydown', this.down)
    window.addEventListener('keyup', this.up)
    window.addEventListener('blur', this.blur)
    window.addEventListener('mousemove', this.move)
    window.addEventListener('mousedown', this.mouseDown)
    window.addEventListener('mouseup', this.mouseUp)
    target.addEventListener('contextmenu', this.menu)
    document.addEventListener('pointerlockchange', this.lockChange)
  }

  detach() {
    window.removeEventListener('keydown', this.down)
    window.removeEventListener('keyup', this.up)
    window.removeEventListener('blur', this.blur)
    window.removeEventListener('mousemove', this.move)
    window.removeEventListener('mousedown', this.mouseDown)
    window.removeEventListener('mouseup', this.mouseUp)
    this.target?.removeEventListener('contextmenu', this.menu)
    document.removeEventListener('pointerlockchange', this.lockChange)
    this.unlock()
    this.target = null
  }

  lock() {
    const t = this.target
    if (!t || this.locked || !t.requestPointerLock) return
    try {
      const p = t.requestPointerLock() as unknown
      if (p instanceof Promise) p.catch(() => {})
    } catch {
      // 不支援就算了，方向鍵也能轉頭
    }
  }

  unlock() {
    if (this.locked) document.exitPointerLock()
  }

  reset() {
    this.keys.clear()
    this.mouseFire = false
    this.mouseZoom = false
    this.lookX = this.lookY = 0
    this.actions.length = 0
    Object.assign(this.touch, { moveX: 0, moveY: 0, fire: false, boost: false, jump: false, zoom: false })
  }

  /** 觸控的右半邊拖曳轉頭（像素） */
  touchLook(dx: number, dy: number) {
    this.lookX += dx * 0.0055 * this.sensitivity
    this.lookY += dy * 0.0055 * this.sensitivity
  }

  /** 觸控按鈕、選單按下去的動作 */
  push(action: PadAction) {
    this.actions.push(action)
  }

  private any(codes: string[]) {
    return codes.some((c) => this.keys.has(c))
  }

  /** 讀出這一刻的操作；轉頭量寫進 `look`（讀完歸零），剛按下的動作放進 `actions` */
  read(out: Controls, look: { x: number; y: number }, actions: PadAction[], dt: number) {
    let strafe = (this.any(KEYS.right) ? 1 : 0) - (this.any(KEYS.left) ? 1 : 0) + this.touch.moveX
    let forward = (this.any(KEYS.forward) ? 1 : 0) - (this.any(KEYS.back) ? 1 : 0) + this.touch.moveY
    let boost = this.any(KEYS.boost) || this.touch.boost
    let jump = this.any(KEYS.jump) || this.touch.jump
    let fire = this.mouseFire || this.touch.fire
    let zoom = this.mouseZoom || this.touch.zoom
    let lx = this.lookX + ((this.any(KEYS.lookRight) ? 1 : 0) - (this.any(KEYS.lookLeft) ? 1 : 0)) * KEY_TURN * dt
    let ly = this.lookY + ((this.any(KEYS.lookDown) ? 1 : 0) - (this.any(KEYS.lookUp) ? 1 : 0)) * KEY_TURN * 0.7 * dt
    this.lookX = this.lookY = 0

    const pad = navigator.getGamepads?.().find((p) => p?.connected && p.mapping === 'standard')
    if (pad) {
      const dead = (v: number) => (Math.abs(v) < 0.15 ? 0 : Math.sign(v) * ((Math.abs(v) - 0.15) / 0.85))
      strafe += dead(pad.axes[0] ?? 0)
      forward -= dead(pad.axes[1] ?? 0)
      const rx = dead(pad.axes[2] ?? 0)
      const ry = dead(pad.axes[3] ?? 0)
      lx += Math.sign(rx) * rx * rx * PAD_TURN * dt * this.sensitivity
      ly += Math.sign(ry) * ry * ry * PAD_TURN * 0.7 * dt * this.sensitivity
      fire ||= (pad.buttons[7]?.value ?? 0) > 0.3
      zoom ||= (pad.buttons[6]?.value ?? 0) > 0.3
      boost ||= !!(pad.buttons[4]?.pressed || pad.buttons[10]?.pressed)
      jump ||= !!pad.buttons[0]?.pressed
      const pressed = pad.buttons.map((b) => b.pressed)
      if (pressed[5] && !this.padPrev[5]) actions.push('missile')
      if (pressed[2] && !this.padPrev[2]) actions.push('reload')
      if (pressed[3] && !this.padPrev[3]) actions.push('ability')
      if (pressed[9] && !this.padPrev[9]) actions.push('menu')
      this.padPrev = pressed
    }
    actions.push(...this.actions)
    this.actions.length = 0

    const len = Math.hypot(strafe, forward)
    out.strafe = len > 1 ? strafe / len : strafe
    out.forward = len > 1 ? forward / len : forward
    out.boost = boost
    out.jump = jump
    out.fire = fire
    out.zoom = zoom
    look.x = lx
    look.y = ly
  }
}
