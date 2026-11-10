// 很多小方塊、圓柱合成一個網格：每塊自己的顏色寫在頂點上，整批一次畫完（看台、屋頂上的水塔、看板的柱子…）。
import { BufferAttribute, BufferGeometry, Color, Mesh, type Material } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const tmp = new Color()

export class Solids {
  private readonly list: BufferGeometry[] = []

  get size() {
    return this.list.length
  }

  /** 加一塊（會被改掉：拿掉貼圖座標、加上顏色），回傳自己方便串著寫 */
  add(geo: BufferGeometry, color: Color | number): this {
    const g = geo.index ? geo.toNonIndexed() : geo
    if (g !== geo) geo.dispose()
    g.deleteAttribute('uv')
    const c = typeof color === 'number' ? tmp.setHex(color) : color
    const n = g.getAttribute('position').count
    const col = new Float32Array(n * 3)
    for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3)
    g.setAttribute('color', new BufferAttribute(col, 3))
    this.list.push(g)
    return this
  }

  /** 全部合成一個網格（材質要開 vertexColors）；沒東西是 null */
  mesh(material: Material): Mesh | null {
    if (!this.list.length) {
      material.dispose()
      return null
    }
    const geo = mergeGeometries(this.list)
    for (const g of this.list) g.dispose()
    this.list.length = 0
    return new Mesh(geo, material)
  }
}

/**
 * 沿著賽道擺東西用的座標：原點在賽道第 i 個取樣點旁邊 `out` 公尺（往 `side` 那邊，1 是左邊），
 * 本地的 +z 朝外（離開賽道），+x 沿著賽道（左邊是往回、右邊是往前，模型才不會左右顛倒）
 */
export type Frame = { x: number; z: number; rot: number; nx: number; nz: number; ax: number; az: number }

export function frameAt(px: number, pz: number, tx: number, tz: number, side: number, out: number): Frame {
  const nx = tz * side
  const nz = -tx * side
  return { x: px + nx * out, z: pz + nz * out, rot: Math.atan2(nx, nz), nx, nz, ax: nz, az: -nx }
}

/** 本地座標 (u 沿著、v 往外) 換成世界的 x、z */
export function place(f: Frame, u: number, v: number): [number, number] {
  return [f.x + f.ax * u + f.nx * v, f.z + f.az * u + f.nz * v]
}
