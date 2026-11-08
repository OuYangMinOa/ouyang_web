// 胎痕：甩尾、側滑時後輪在路面留下的黑線，留在路上（不會慢慢消失），很多圈以後最舊的才被新的蓋掉。
// 一條胎痕是一串頭尾相接的四邊形；固定數量的四邊形輪流使用，不會一直配置新的記憶體。
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial } from 'three'

/** 最多幾段（一段一個四邊形，4 個頂點 × 16384 段剛好用得了 16 位元的索引） */
const SEGMENTS = 16384
/** 一段至少多長（公尺）：短的先累積著，一格畫面通常一段 */
const MIN_STEP = 0.9
/** 一次跳太遠（重生、網路延遲一下子跳一大段）就斷開，從新的位置重新起一條 */
const MAX_STEP = 6
/** 胎痕的半寬（公尺） */
const HALF_WIDTH = 0.17
/** 胎痕的顏色（線性色彩，接近黑色；深淺靠每個頂點的透明度） */
const SHADE = 0.012

/** 一個輪子正在畫的那一條：上一個點、上一段尾端的左右兩邊、那裡的深淺 */
type Trail = {
  x: number
  y: number
  z: number
  a: number
  /** 還沒畫第一段（起點的左右兩邊等第一段知道方向再算） */
  fresh: boolean
  lx: number
  lz: number
  rx: number
  rz: number
}

export class SkidMarks {
  readonly mesh: Mesh
  private readonly geometry: BufferGeometry
  private readonly material: MeshBasicMaterial
  private readonly pos: Float32Array
  private readonly color: Float32Array
  private readonly posAttr: BufferAttribute
  private readonly colorAttr: BufferAttribute
  /** 每個輪子（編號由呼叫的人決定）正在畫的那一條；沒在畫是 undefined */
  private trails: (Trail | undefined)[] = []
  /** 下一段寫在哪裡、總共寫過幾段 */
  private next = 0
  private used = 0
  /** 這一格畫面寫了幾段、從哪裡開始寫（上傳時只傳這一塊） */
  private dirtyFrom = 0
  private dirty = 0

  constructor() {
    this.pos = new Float32Array(SEGMENTS * 4 * 3)
    this.color = new Float32Array(SEGMENTS * 4 * 4)
    const index = new Uint16Array(SEGMENTS * 6)
    for (let i = 0; i < SEGMENTS; i++) {
      const v = i * 4
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6)
    }
    this.geometry = new BufferGeometry()
    this.posAttr = new BufferAttribute(this.pos, 3)
    this.colorAttr = new BufferAttribute(this.color, 4)
    this.geometry.setAttribute('position', this.posAttr)
    this.geometry.setAttribute('color', this.colorAttr)
    this.geometry.setIndex(new BufferAttribute(index, 1))
    this.geometry.setDrawRange(0, 0)
    this.material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    })
    this.mesh = new Mesh(this.geometry, this.material)
    // 位置一直在變，不算包圍球；在煙、火花前面畫，煙才蓋得住胎痕
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1
  }

  /**
   * 輪子 `id` 現在在 (x, y, z)（y 已經是路面高度再墊高一點），`strength` 是胎痕的深淺（0 是沒在滑）。
   * 每個輪子每一格畫面呼叫一次；停止滑動時那一條最後一段淡出
   */
  mark(id: number, x: number, y: number, z: number, strength: number) {
    const t = this.trails[id]
    if (strength <= 0) {
      if (t && !t.fresh && Math.hypot(x - t.x, z - t.z) > 0.3) this.segment(t, x, y, z, 0)
      this.trails[id] = undefined
      return
    }
    if (!t || Math.hypot(x - t.x, z - t.z) > MAX_STEP) {
      // 新的一條從透明開始，看起來是慢慢壓出來的
      this.trails[id] = { x, y, z, a: 0, fresh: true, lx: 0, lz: 0, rx: 0, rz: 0 }
      return
    }
    if (Math.hypot(x - t.x, z - t.z) >= MIN_STEP) this.segment(t, x, y, z, strength)
  }

  /** 輪子跳走了（重生、換賽道）：那一條就停在這裡 */
  lift(id: number) {
    this.trails[id] = undefined
  }

  /** 這一格畫面寫過的部分上傳給顯示卡 */
  flush() {
    if (this.dirty === 0) return
    const count = Math.min(this.dirty, SEGMENTS)
    const from = count === SEGMENTS ? 0 : this.dirtyFrom
    for (const attr of [this.posAttr, this.colorAttr]) {
      const size = attr.itemSize * 4
      attr.clearUpdateRanges()
      if (from + count <= SEGMENTS) attr.addUpdateRange(from * size, count * size)
      else {
        attr.addUpdateRange(from * size, (SEGMENTS - from) * size)
        attr.addUpdateRange(0, (from + count - SEGMENTS) * size)
      }
      attr.needsUpdate = true
    }
    this.geometry.setDrawRange(0, Math.min(this.used, SEGMENTS) * 6)
    this.dirty = 0
  }

  clear() {
    this.trails = []
    this.next = this.used = this.dirty = 0
    this.geometry.setDrawRange(0, 0)
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }

  /** 從 `t` 的位置畫一段到 (x, y, z)，尾端的深淺是 `a` */
  private segment(t: Trail, x: number, y: number, z: number, a: number) {
    const dx = x - t.x
    const dz = z - t.z
    const d = Math.hypot(dx, dz)
    // 往左邊的垂直方向
    const nx = (-dz / d) * HALF_WIDTH
    const nz = (dx / d) * HALF_WIDTH
    if (t.fresh) {
      t.lx = t.x + nx
      t.lz = t.z + nz
      t.rx = t.x - nx
      t.rz = t.z - nz
      t.fresh = false
    }
    const i = this.next
    if (this.dirty === 0) this.dirtyFrom = i
    const p = i * 12
    const pos = this.pos
    pos[p] = t.lx
    pos[p + 1] = t.y
    pos[p + 2] = t.lz
    pos[p + 3] = t.rx
    pos[p + 4] = t.y
    pos[p + 5] = t.rz
    pos[p + 6] = x + nx
    pos[p + 7] = y
    pos[p + 8] = z + nz
    pos[p + 9] = x - nx
    pos[p + 10] = y
    pos[p + 11] = z - nz
    const c = i * 16
    const color = this.color
    for (let k = 0; k < 4; k++) {
      color[c + k * 4] = color[c + k * 4 + 1] = color[c + k * 4 + 2] = SHADE
      color[c + k * 4 + 3] = k < 2 ? t.a : a
    }
    this.next = (i + 1) % SEGMENTS
    this.used++
    this.dirty++
    t.x = x
    t.y = y
    t.z = z
    t.a = a
    t.lx = x + nx
    t.lz = z + nz
    t.rx = x - nx
    t.rz = z - nz
  }
}
