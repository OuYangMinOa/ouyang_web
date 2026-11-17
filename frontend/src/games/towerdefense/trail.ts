import { BufferAttribute, BufferGeometry, CanvasTexture, Color, DoubleSide, Mesh, MeshBasicMaterial, RepeatWrapping, SRGBColorSpace } from 'three'

/**
 * 地上的路線：一條貼著地面、往出口流動的帶子（怪物現在會走的路、飛行怪直飛的路、蓋塔前預覽的新路線）。
 * 轉彎的地方修成圓角，頭尾淡出；花紋是一張會重複的小貼圖，靠移動貼圖的位置讓它流動。
 */

type Point = [number, number]

/** 一個花紋多長（格） */
const PERIOD = 0.66

/** 花紋：`chevron` 是往前的箭頭（地面的路），`dash` 是一段一段的虛線（飛行的路） */
export function trailTexture(kind: 'chevron' | 'dash'): CanvasTexture {
  const [w, h] = [128, 64]
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx) {
    // 底下一條淡淡的帶子，兩邊淡出
    const band = ctx.createLinearGradient(0, 0, 0, h)
    band.addColorStop(0, 'rgba(255,255,255,0)')
    band.addColorStop(0.5, `rgba(255,255,255,${kind === 'chevron' ? 0.3 : 0.16})`)
    band.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = band
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = '#ffffff'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (kind === 'chevron') {
      ctx.lineWidth = 9
      ctx.beginPath()
      ctx.moveTo(w * 0.36, h * 0.24)
      ctx.lineTo(w * 0.62, h * 0.5)
      ctx.lineTo(w * 0.36, h * 0.76)
      ctx.stroke()
    } else {
      ctx.lineWidth = 8
      ctx.beginPath()
      ctx.moveTo(w * 0.3, h * 0.5)
      ctx.lineTo(w * 0.7, h * 0.5)
      ctx.stroke()
    }
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = RepeatWrapping
  return texture
}

/** 把折線的轉角修圓：每個轉角換成一小段弧 */
function rounded(points: Point[], radius: number): Point[] {
  if (points.length < 3) return points
  const out: Point[] = [points[0]]
  for (let i = 1; i + 1 < points.length; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const [ax, az] = [a[0] - b[0], a[1] - b[1]]
    const [cx, cz] = [c[0] - b[0], c[1] - b[1]]
    const [la, lc] = [Math.hypot(ax, az), Math.hypot(cx, cz)]
    // 幾乎是直的就不用修
    if (la < 1e-6 || lc < 1e-6 || Math.abs(ax * cz - az * cx) < 1e-4 * la * lc) {
      out.push(b)
      continue
    }
    const r = Math.min(radius, la / 2, lc / 2)
    const from: Point = [b[0] + (ax / la) * r, b[1] + (az / la) * r]
    const to: Point = [b[0] + (cx / lc) * r, b[1] + (cz / lc) * r]
    const steps = 4
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      const u = 1 - t
      out.push([u * u * from[0] + 2 * u * t * b[0] + t * t * to[0], u * u * from[1] + 2 * u * t * b[1] + t * t * to[1]])
    }
  }
  out.push(points[points.length - 1])
  return out
}

/** 太長的一段切成幾小段：頭尾的淡出是照頂點算的，一段只有兩個頂點的話（飛行怪的直線）會整條都是透明的 */
function dense(points: Point[], step: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i < points.length; i++) {
    if (i) {
      const [a, b] = [points[i - 1], points[i]]
      const pieces = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)
      for (let k = 1; k < pieces; k++) out.push([a[0] + ((b[0] - a[0]) * k) / pieces, a[1] + ((b[1] - a[1]) * k) / pieces])
    }
    out.push(points[i])
  }
  return out
}

export class Trail {
  readonly mesh: Mesh
  private readonly material: MeshBasicMaterial
  private opacity = 1

  constructor(map: CanvasTexture, order: number, y: number) {
    // 帶子貼在地上，正反面都畫（照路線的方向拉出來的三角形，朝上朝下不一定）
    this.material = new MeshBasicMaterial({ map, transparent: true, depthWrite: false, vertexColors: true, side: DoubleSide })
    this.mesh = new Mesh(new BufferGeometry(), this.material)
    this.mesh.position.y = y
    this.mesh.renderOrder = order
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }

  /** 換成這幾條線（世界座標的 x、z）；`width` 是帶子的寬度 */
  set(lines: Point[][], width: number) {
    const position: number[] = []
    const uv: number[] = []
    const color: number[] = []
    const index: number[] = []
    for (const raw of lines) {
      const line = dense(rounded(raw, 0.34), 0.5)
      if (line.length < 2) continue
      const total = line.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]) : 0), 0)
      const base = position.length / 3
      let along = 0
      for (let i = 0; i < line.length; i++) {
        const [prev, here, next] = [line[Math.max(0, i - 1)], line[i], line[Math.min(line.length - 1, i + 1)]]
        if (i) along += Math.hypot(here[0] - prev[0], here[1] - prev[1])
        const [tx, tz] = [next[0] - prev[0], next[1] - prev[1]]
        const len = Math.hypot(tx, tz) || 1
        const [nx, nz] = [(-tz / len) * (width / 2), (tx / len) * (width / 2)]
        position.push(here[0] + nx, 0, here[1] + nz, here[0] - nx, 0, here[1] - nz)
        uv.push(along / PERIOD, 0, along / PERIOD, 1)
        // 頭尾各半格淡出
        const fade = Math.min(1, along / 0.5, (total - along) / 0.5)
        color.push(1, 1, 1, fade, 1, 1, 1, fade)
        if (i) {
          const k = base + i * 2
          index.push(k - 2, k - 1, k, k, k - 1, k + 1)
        }
      }
    }
    this.mesh.geometry.dispose()
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3))
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(color), 4))
    geometry.setIndex(index)
    this.mesh.geometry = geometry
    this.mesh.visible = index.length > 0 && this.opacity > 0.01
  }

  clear() {
    this.set([], 0)
  }

  look(color: Color, opacity: number) {
    this.material.color.copy(color)
    this.material.opacity = opacity
    this.opacity = opacity
    this.mesh.visible = (this.mesh.geometry.index?.count ?? 0) > 0 && opacity > 0.01
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
