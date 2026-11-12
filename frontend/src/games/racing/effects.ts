// 粒子：甩尾的輪胎煙、開出路面的沙塵（一般混色），甩尾火花、加速噴火、撞牆火花（相加混色會發光）。
// 固定數量的粒子輪流使用，不會一直配置新的記憶體。
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  NormalBlending,
  Points,
  ShaderMaterial,
  type Color,
} from 'three'

const vertex = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
    vAlpha = aAlpha;
    vColor = aColor;
  }
`
const fragment = /* glsl */ `
  uniform float uGain;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.1, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * uGain, a);
    #include <colorspace_fragment>
  }
`

export class Particles {
  readonly points: Points
  private readonly count: number
  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly color: Float32Array
  private readonly size: Float32Array
  private readonly alpha: Float32Array
  private readonly life: Float32Array
  private readonly maxLife: Float32Array
  private readonly grow: Float32Array
  private readonly opacity: Float32Array
  private readonly material: ShaderMaterial
  private readonly gravity: number
  private next = 0

  /** `gravity`：每秒往下加速多少（碎塊用；煙和火光是 0） */
  constructor(count: number, additive: boolean, gravity = 0) {
    this.count = count
    this.gravity = gravity
    this.pos = new Float32Array(count * 3)
    this.vel = new Float32Array(count * 3)
    this.color = new Float32Array(count * 3)
    this.size = new Float32Array(count)
    this.alpha = new Float32Array(count)
    this.life = new Float32Array(count)
    this.maxLife = new Float32Array(count).fill(1)
    this.grow = new Float32Array(count)
    this.opacity = new Float32Array(count)
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(this.pos, 3))
    geo.setAttribute('aColor', new BufferAttribute(this.color, 3))
    geo.setAttribute('aSize', new BufferAttribute(this.size, 1))
    geo.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1))
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { uScale: { value: 400 }, uGain: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    })
    this.points = new Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = 2
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    color: Color,
    size: number,
    grow: number,
    life: number,
    opacity: number,
  ) {
    const i = this.next
    this.next = (this.next + 1) % this.count
    this.pos.set([x, y, z], i * 3)
    this.vel.set([vx, vy, vz], i * 3)
    this.color.set([color.r, color.g, color.b], i * 3)
    this.size[i] = size
    this.grow[i] = grow
    this.life[i] = life
    this.maxLife[i] = life
    this.opacity[i] = opacity
    this.alpha[i] = opacity
  }

  /** 顏色乘幾倍：畫面有泛光時，相加混色的粒子調得比 1 亮才暈得開 */
  set gain(v: number) {
    this.material.uniforms.uGain.value = v
  }

  /** `scale`：畫面高度（像素）÷（2·tan(視角/2)），讓粒子大小以公尺為單位 */
  update(dt: number, scale: number) {
    this.material.uniforms.uScale.value = scale
    const drag = Math.exp(-2.5 * dt)
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0
        continue
      }
      this.life[i] -= dt
      const k = i * 3
      this.vel[k + 1] -= this.gravity * dt
      this.vel[k] *= drag
      this.vel[k + 1] *= drag
      this.vel[k + 2] *= drag
      this.pos[k] += this.vel[k] * dt
      this.pos[k + 1] += this.vel[k + 1] * dt
      this.pos[k + 2] += this.vel[k + 2] * dt
      this.size[i] += this.grow[i] * dt
      this.alpha[i] = Math.max(0, this.life[i] / this.maxLife[i]) * this.opacity[i]
    }
    const geo = this.points.geometry
    geo.attributes.position.needsUpdate = true
    geo.attributes.aColor.needsUpdate = true
    geo.attributes.aSize.needsUpdate = true
    geo.attributes.aAlpha.needsUpdate = true
  }

  clear() {
    this.life.fill(0)
    this.alpha.fill(0)
    this.points.geometry.attributes.aAlpha.needsUpdate = true
  }

  dispose() {
    this.points.geometry.dispose()
    this.material.dispose()
  }
}
