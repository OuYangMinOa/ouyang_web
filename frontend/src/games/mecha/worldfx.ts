// 場景裡一直在動的東西（都在著色器裡動，每一格只更新時間和鏡頭的位置）：
//   - 火：燒著的車、樓頂。一片朝著鏡頭的板子，火舌照雜訊往上竄；底下的地面被照亮一圈
//   - 煙柱：從火堆往上冒的黑煙，越高越寬、被風吹歪；地圖外面幾道很大的，整座城市都在燒
//   - 飄在空中的火星（往上飄、一閃一閃）和灰燼（慢慢往下掉）：跟著鏡頭的一團，不管走到哪裡四周都有
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  Points,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Camera,
  type Scene,
} from 'three'
import { hazeFragment, type WorldLook } from './worldmat'

/** 風往哪邊吹（煙往這邊歪、火星和灰燼往這邊飄） */
const WIND = new Vector3(0.82, 0, 0.36)

const noise = /* glsl */ `
  float fxHash( vec2 p ) {
    p = fract( p * vec2( 123.34, 456.21 ) );
    p += dot( p, p + 45.32 );
    return fract( p.x * p.y );
  }
  float fxNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( fxHash( i ), fxHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( fxHash( i + vec2( 0.0, 1.0 ) ), fxHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
  }
  float fxFbm( vec2 p ) {
    float v = 0.0;
    float a = 0.5;
    for ( int i = 0; i < 4; i ++ ) {
      v += a * fxNoise( p );
      p = p * 2.03 + vec2( 17.0, 9.0 );
      a *= 0.5;
    }
    return v / 0.9375;
  }
`

/** 朝著鏡頭的板子（繞著直的軸轉）：`position.x` 是 -0.5～0.5、`position.y` 是 0～1 */
const billboardVertex = /* glsl */ `
  attribute vec3 aBase;
  attribute vec4 aShape;
  uniform float uTime;
  uniform vec3 uWind;
  varying vec2 vUv;
  varying vec3 vWPos;
  varying float vSeed;
  varying float vKind;
  #include <fog_pars_vertex>
  void main() {
    vUv = vec2( position.x * 2.0, position.y );
    vSeed = aShape.z;
    vKind = aShape.w;
    vec3 to = cameraPosition - aBase;
    vec3 right = normalize( vec3( to.z, 0.0, -to.x ) );
    // 越高越寬、被風吹歪（aShape.w 是歪多少）
    float spread = 1.0 + position.y * position.y * LEAN_WIDEN;
    vec3 p = aBase + right * position.x * aShape.x * spread + vec3( 0.0, position.y * aShape.y, 0.0 );
    p += uWind * position.y * position.y * aShape.y * LEAN;
    #if FLAT == 1
      // 照在地上的光：平放的一片
      if ( aShape.w > 0.5 ) p = aBase + vec3( position.x * aShape.x * 2.0, 0.0, ( position.y - 0.5 ) * aShape.y * 2.0 );
    #endif
    vWPos = p;
    vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`

const smokeFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uWSun;
  uniform vec3 uWGlow;
  varying vec2 vUv;
  varying vec3 vWPos;
  varying float vSeed;
  varying float vKind;
  #include <fog_pars_fragment>
  ${noise}
  void main() {
    float y = vUv.y;
    // 往上捲的雜訊（越粗的煙柱捲得越慢）
    float n = fxFbm( vec2( vUv.x * 1.3 + vSeed * 7.0, y * 5.0 - uTime * vKind ) );
    float n2 = fxFbm( vec2( vUv.x * 3.1 - vSeed * 3.0, y * 11.0 - uTime * vKind * 1.7 ) );
    float body = 1.0 - smoothstep( 0.25, 1.0, abs( vUv.x ) + ( n - 0.5 ) * 0.95 + ( n2 - 0.5 ) * 0.3 );
    // 底下一小段從火裡冒出來，頂上散掉
    float alpha = body * smoothstep( 0.0, 0.05, y ) * ( 1.0 - smoothstep( 0.45, 1.0, y + ( n - 0.5 ) * 0.4 ) );
    if ( alpha < 0.01 ) discard;
    // 底下是濃的黑煙，越高越淡；朝太陽那一邊亮一點，最底下被火照紅
    vec3 col = mix( vec3( 0.035, 0.032, 0.03 ), vec3( 0.26, 0.25, 0.245 ), smoothstep( 0.0, 0.9, y ) * ( 0.5 + 0.5 * n2 ) );
    col += uWGlow * 0.16 * smoothstep( -0.4, 1.0, vUv.x * 0.5 + n - 0.5 ) * y;
    col += vec3( 1.0, 0.34, 0.06 ) * 1.6 * exp( - y * 22.0 ) * body;
    gl_FragColor = vec4( col, alpha * 0.78 );
    ${hazeFragment('vWPos', 'uWSun', 'uWGlow')}
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const flameFragment = /* glsl */ `
  uniform float uTime;
  uniform float uGain;
  uniform vec3 uWSun;
  uniform vec3 uWGlow;
  varying vec2 vUv;
  varying vec3 vWPos;
  varying float vSeed;
  varying float vKind;
  #include <fog_pars_fragment>
  ${noise}
  void main() {
    float y = vUv.y;
    if ( vKind > 0.5 ) {
      // 照在地上的光：一圈往外淡掉，跟著火一閃一閃
      float r = length( vec2( vUv.x, y * 2.0 - 1.0 ) );
      float flick = 0.7 + 0.3 * sin( uTime * 9.0 + vSeed * 50.0 ) * sin( uTime * 5.3 + vSeed * 20.0 );
      float a = pow( max( 1.0 - r, 0.0 ), 2.0 ) * flick;
      gl_FragColor = vec4( vec3( 1.0, 0.42, 0.1 ) * a * 0.42 * uGain, 1.0 );
    } else {
      float n = fxFbm( vec2( vUv.x * 1.8 + vSeed * 9.0, y * 2.6 - uTime * 1.9 ) );
      float n2 = fxNoise( vec2( vUv.x * 4.5 + vSeed, y * 6.0 - uTime * 3.4 ) );
      // 火舌：底下寬、往上收尖，邊緣照雜訊一跳一跳
      float w = pow( 1.0 - y, 0.7 );
      float m = smoothstep( 0.0, 0.3, w - abs( vUv.x ) * ( 0.85 + ( n - 0.5 ) * 1.5 ) - ( n2 - 0.5 ) * 0.25 * y ) * smoothstep( 0.0, 0.06, y );
      m *= 1.0 - smoothstep( 0.55, 1.0, y + ( n - 0.5 ) * 0.5 );
      vec3 col = mix( vec3( 0.75, 0.1, 0.01 ), vec3( 1.0, 0.5, 0.1 ), smoothstep( 0.1, 0.6, m ) );
      col = mix( col, vec3( 1.0, 0.8, 0.42 ), smoothstep( 0.75, 1.0, m ) * ( 1.0 - y ) * 0.7 );
      gl_FragColor = vec4( col * m * uGain, 1.0 );
    }
    #ifdef USE_FOG
      float hzD = vFogDepth * fogDensity;
      gl_FragColor.rgb *= exp( - hzD * hzD );
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const moteVertex = /* glsl */ `
  attribute vec3 aSeed;
  uniform float uTime;
  uniform float uScale;
  uniform vec3 uCam;
  uniform vec3 uBox;
  uniform vec3 uWind;
  uniform vec2 uMotion;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    float t = uTime * ( 0.6 + aSeed.x * 0.8 );
    vec3 p = aSeed * uBox;
    p.y += t * uMotion.x;
    p.x += sin( t * 0.7 + aSeed.z * 31.0 ) * uMotion.y + uTime * uWind.x * 1.4;
    p.z += cos( t * 0.5 + aSeed.y * 37.0 ) * uMotion.y + uTime * uWind.z * 1.4;
    // 繞著鏡頭的一個盒子：飄出去的從另一頭接回來
    p = mod( p - uCam + uBox * 0.5, uBox ) - uBox * 0.5 + uCam;
    vec4 mv = viewMatrix * vec4( p, 1.0 );
    gl_Position = projectionMatrix * mv;
    float dist = - mv.z;
    gl_PointSize = clamp( ( 0.03 + aSeed.y * 0.045 ) * SIZE * uScale / max( dist, 0.5 ), 1.0, 6.0 );
    vec3 off = ( p - uCam ) / ( uBox * 0.5 );
    vAlpha = ( 1.0 - smoothstep( 0.7, 1.0, max( abs( off.x ), max( abs( off.y ), abs( off.z ) ) ) ) ) * smoothstep( 1.0, 4.0, dist );
    vSeed = aSeed.z;
  }
`
const moteFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uFlicker;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    float d = length( gl_PointCoord - 0.5 );
    float a = smoothstep( 0.5, 0.15, d ) * vAlpha;
    // 火星一閃一閃
    a *= mix( 1.0, 0.35 + 0.65 * abs( sin( uTime * ( 2.0 + vSeed * 5.0 ) + vSeed * 40.0 ) ), uFlicker );
    if ( a < 0.01 ) discard;
    gl_FragColor = vec4( uColor, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

type Sheet = { base: number[]; shape: number[] }

export class Ambience {
  private readonly hdr: boolean
  private readonly lite: boolean
  private readonly look: WorldLook
  private readonly smoke: Sheet = { base: [], shape: [] }
  private readonly flame: Sheet = { base: [], shape: [] }
  private readonly materials: ShaderMaterial[] = []
  private readonly disposables: { dispose(): void }[] = []
  private readonly motes: ShaderMaterial[] = []

  constructor(look: WorldLook, hdr: boolean, lite: boolean) {
    this.look = look
    this.hdr = hdr
    this.lite = lite
  }

  /** 一堆火（底在 (x, y, z)、大概 `size` 公尺高），照亮底下的地面，上面冒一道煙 */
  fire(x: number, y: number, z: number, size: number, seed: number, smoke = 1) {
    const s = (k: number) => (Math.sin(seed * 91.7 + k * 47.3) * 43758.5453) % 1
    // 兩三片錯開的火舌
    for (let k = 0; k < (this.lite ? 2 : 3); k++) {
      const a = k * 2.1 + seed
      const r = size * 0.22 * k
      this.flame.base.push(x + Math.cos(a) * r, y, z + Math.sin(a) * r)
      this.flame.shape.push(size * (0.75 - k * 0.14), size * (1.25 - k * 0.2), Math.abs(s(k)) + k * 0.31, 0)
    }
    if (smoke > 0) this.plume(x, y + size * 0.5, z, size * 1.5 * smoke, size * 11 * smoke, seed, 0.5)
  }

  /** 地上被火照亮的一圈（平放的一片，`r` 是半徑） */
  glow(x: number, y: number, z: number, r: number, seed: number) {
    this.flame.base.push(x, y, z)
    this.flame.shape.push(r, r, seed, 1)
  }

  /** 一道煙柱：底在 (x, y, z)，`width` 是底下多寬、`height` 多高，`speed` 是往上捲多快 */
  plume(x: number, y: number, z: number, width: number, height: number, seed: number, speed: number) {
    this.smoke.base.push(x, y, z)
    this.smoke.shape.push(width, height, seed, speed)
  }

  private sheet(scene: Scene, data: Sheet, fragmentShader: string, additive: boolean, lean: number, widen: number, order: number) {
    // 火那一組裡有平放在地上的（照亮地面的那一圈）
    const count = data.base.length / 3
    if (!count) return
    const geo = new InstancedBufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    geo.setAttribute('aBase', new InstancedBufferAttribute(new Float32Array(data.base), 3))
    geo.setAttribute('aShape', new InstancedBufferAttribute(new Float32Array(data.shape), 4))
    geo.instanceCount = count
    const mat = new ShaderMaterial({
      vertexShader: billboardVertex,
      fragmentShader,
      defines: { LEAN: lean.toFixed(3), LEAN_WIDEN: widen.toFixed(3), FLAT: additive ? 1 : 0 },
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 }, uGain: { value: this.hdr ? 1.9 : 0.9 }, uWind: { value: WIND } }]),
      fog: true,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: additive ? AdditiveBlending : NormalBlending,
    })
    // 這兩個和場景的材質共用（不能被 merge 複製掉）
    mat.uniforms.uWSun = this.look.uWSun
    mat.uniforms.uWGlow = this.look.uWGlow
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = order
    scene.add(mesh)
    this.materials.push(mat)
    this.disposables.push(geo, mat)
  }

  private cloud(scene: Scene, count: number, box: Vector3, color: [number, number, number], additive: boolean, rise: number, sway: number, size: number) {
    const seeds = new Float32Array(count * 3)
    // 固定的亂數：每次進來都一樣
    let h = 12345
    for (let i = 0; i < seeds.length; i++) {
      h = Math.imul(h ^ (h >>> 15), 2246822519) + 0x9e3779b9
      seeds[i] = ((h ^ (h >>> 13)) >>> 0) / 4294967296
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
    geo.setAttribute('aSeed', new BufferAttribute(seeds, 3))
    const mat = new ShaderMaterial({
      vertexShader: moteVertex,
      fragmentShader: moteFragment,
      defines: { SIZE: size.toFixed(2) },
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 400 },
        uCam: { value: new Vector3() },
        uBox: { value: box },
        uWind: { value: WIND },
        uMotion: { value: [rise, sway] },
        uColor: { value: color },
        uFlicker: { value: additive ? 1 : 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    })
    const points = new Points(geo, mat)
    points.frustumCulled = false
    points.renderOrder = 3
    scene.add(points)
    this.motes.push(mat)
    this.disposables.push(geo, mat)
  }

  /** 全部加完之後呼叫一次 */
  build(scene: Scene) {
    this.sheet(scene, this.smoke, smokeFragment, false, 0.34, 2.6, 1)
    this.sheet(scene, this.flame, flameFragment, true, 0.03, 0, 2)
    const gain = this.hdr ? 2.2 : 1
    // 火星：往上飄、一閃一閃；灰燼：慢慢往下掉
    this.cloud(scene, this.lite ? 110 : 260, new Vector3(64, 30, 64), [1 * gain, 0.42 * gain, 0.1 * gain], true, 1.6, 1.8, 1)
    this.cloud(scene, this.lite ? 160 : 420, new Vector3(46, 24, 46), [0.12, 0.115, 0.11], false, -0.7, 1.3, 1.2)
  }

  /** 每一格：`scale` 是畫面高度（像素）÷（2·tan(視角/2)），粒子的大小才是以公尺為單位 */
  update(time: number, camera: Camera, scale: number) {
    for (const m of this.materials) m.uniforms.uTime.value = time
    for (const m of this.motes) {
      m.uniforms.uTime.value = time
      m.uniforms.uScale.value = scale
      ;(m.uniforms.uCam.value as Vector3).copy(camera.position)
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
  }
}
