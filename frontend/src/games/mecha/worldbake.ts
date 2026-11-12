// 載入時把整個場景的環境光遮蔽烘成兩張貼圖（和機甲的 `mechbake.ts` 同一個做法：從很多方向各拍一張深度圖，
// 等於從那個方向打一道平行光，每一點看自己有沒有被擋住，全部在顯示卡上做）：
//   - 地面那一張（`ground`）：整張地圖從上往下看，每一點看得到多少天空。路面、人行道、河床照世界座標取，
//     大樓腳下、高架底下、巷子裡、走得進去的大樓一樓都會暗下來
//   - 貼圖集（`atlas`）：牆、樓板、天花板、橋、柱子…每個面在圖上佔一格（`worldgeo.ts` 的 `uv1`）。紅色版是遮蔽、綠色版是看得到多少天空。
// 光從地平線以上來的（天空）：照得到就算，多遠都算；從地平線以下來的（地面反射上來的光）：幾公尺內有東西擋著才算擋住
// （牆腳、柱腳會暗一圈），再乘上「那附近的地面亮不亮」（地面那一張）：高架底下、室內的天花板跟著底下的地面暗下來。
import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  CustomBlending,
  DepthTexture,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  NearestFilter,
  NoBlending,
  OneFactor,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { BED, MAP_X, MAP_Z, RIVER } from './map'
import { GROUND_PAD } from './worldmat'

export type WorldBakeTargets = { atlas: WebGLRenderTarget; ground: WebGLRenderTarget }

export type WorldBakeOptions = {
  /** 會擋光的東西（世界座標） */
  casters: BufferGeometry[]
  /** 有排進貼圖集的網格（`position`、`normal`、`uv1`） */
  charted: BufferGeometry[]
  /** 從天空那一半、地面那一半各打幾個方向的光 */
  up: number
  down: number
  /** 每個方向那張深度圖的大小 */
  depthSize: number
  /** 地圖上最高的東西多高 */
  top: number
}

/** 地平線以下來的光：這麼多公尺內有東西擋著才算擋住 */
const NEAR = 7

const depthVertex = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * viewMatrix * vec4( position, 1.0 );
  }
`
const depthFragment = /* glsl */ `
  void main() {
    gl_FragColor = vec4( 1.0 );
  }
`

/** 這一點從 uDir 那個方向照不照得到（0～1）；`uMode` 是 1 時只算幾公尺內的遮擋 */
const visibility = /* glsl */ `
  uniform sampler2D uDepth;
  uniform mat4 uLight;
  uniform vec3 uDir;
  uniform float uTexel;
  uniform float uTexelM;
  uniform float uBias;
  uniform float uRange;
  uniform float uMode;
  float visible( vec3 pos, vec3 n, float c ) {
    // 光越斜，沿著法線移開越多再比（不然自己擋到自己）
    float slope = min( sqrt( max( 1.0 - c * c, 0.0 ) ) / max( c, 0.2 ), 4.0 );
    vec4 p = uLight * vec4( pos + n * uTexelM * ( 1.0 + 1.6 * slope ), 1.0 );
    vec3 s = p.xyz * 0.5 + 0.5;
    float lit = 0.0;
    for ( int i = 0; i < 4; i ++ ) {
      vec2 o = vec2( i == 0 || i == 2 ? -0.5 : 0.5, i < 2 ? -0.5 : 0.5 ) * uTexel;
      float gap = ( s.z - texture2D( uDepth, s.xy + o ).r ) * uRange;
      lit += uMode < 0.5 ? step( gap, uBias ) : ( gap < uBias ? 1.0 : smoothstep( ${(NEAR * 0.35).toFixed(2)}, ${NEAR.toFixed(2)}, gap ) );
    }
    return lit * 0.25;
  }
`

const gatherVertex = /* glsl */ `
  attribute vec2 uv1;
  varying vec3 vPos;
  varying vec3 vNrm;
  void main() {
    vPos = position;
    vNrm = normal;
    gl_Position = vec4( uv1 * 2.0 - 1.0, 0.0, 1.0 );
  }
`
const gatherFragment = /* glsl */ `
  ${visibility}
  uniform sampler2D uGround;
  uniform vec2 uGroundScale;
  uniform float uWeight;
  varying vec3 vPos;
  varying vec3 vNrm;
  void main() {
    vec3 n = normalize( vNrm );
    float c = max( dot( n, uDir ), 0.0 );
    vec2 sum = vec2( 0.0 );
    if ( c > 0.0 ) {
      float lit = visible( vPos, n, c ) * c * uWeight;
      if ( uMode < 0.5 ) {
        sum = vec2( lit, lit / max( 0.5 * ( 1.0 + n.y ), 0.08 ) );
      } else {
        // 地面反射上來的光：那附近的地面亮不亮
        vec2 g = ( vPos.xz + n.xz * 1.5 ) * uGroundScale;
        sum.x = lit * mix( 0.1, 1.0, texture2D( uGround, vec2( g.x + 0.5, 0.5 - g.y ) ).r );
      }
    }
    gl_FragColor = vec4( sum, 0.0, 1.0 );
  }
`

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`
/** 地面那一張：每個像素是地圖上的一點（河床比路面低） */
const groundFragment = /* glsl */ `
  ${visibility}
  uniform vec2 uHalf;
  uniform float uWeight;
  varying vec2 vUv;
  void main() {
    vec3 pos = vec3( ( vUv.x - 0.5 ) * 2.0 * uHalf.x, 0.0, ( 0.5 - vUv.y ) * 2.0 * uHalf.y );
    pos.y = abs( pos.x ) < ${RIVER.toFixed(1)} ? ${BED.toFixed(1)} : 0.0;
    float c = max( uDir.y, 0.0 );
    gl_FragColor = vec4( visible( pos, vec3( 0.0, 1.0, 0.0 ), c ) * c * uWeight, 0.0, 0.0, 1.0 );
  }
`
const groundResolve = /* glsl */ `
  uniform sampler2D uSource;
  varying vec2 vUv;
  void main() {
    float ao = clamp( texture2D( uSource, vUv ).r, 0.0, 1.0 );
    gl_FragColor = vec4( ao, ao, ao, 1.0 );
  }
`
/** 累加的結果：紅是遮蔽、綠是看得到多少天空、透明度是這個像素有沒有東西 */
const atlasResolve = /* glsl */ `
  uniform sampler2D uSource;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D( uSource, vUv );
    gl_FragColor = t.a < 0.5 ? vec4( 0.0 ) : vec4( clamp( t.rg, 0.0, 1.0 ), 0.0, 1.0 );
  }
`
/** 沒有東西的像素拿旁邊有東西的補起來（每一格的外面一圈，縮小、內插時才不會吃到黑的） */
const dilateFragment = /* glsl */ `
  uniform sampler2D uSource;
  uniform vec2 uStep;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D( uSource, vUv );
    vec4 sum = vec4( 0.0 );
    float n = 0.0;
    for ( int y = -1; y <= 1; y ++ ) {
      for ( int x = -1; x <= 1; x ++ ) {
        vec4 s = texture2D( uSource, vUv + vec2( float( x ), float( y ) ) * uStep );
        float on = step( 0.5, s.a );
        sum += s * on;
        n += on;
      }
    }
    gl_FragColor = t.a > 0.5 ? t : ( n > 0.0 ? sum / n : vec4( 0.0 ) );
  }
`
const atlasEncode = /* glsl */ `
  uniform sampler2D uSource;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D( uSource, vUv );
    gl_FragColor = t.a > 0.5 ? vec4( t.rg, 0.0, 1.0 ) : vec4( 1.0, 1.0, 0.0, 1.0 );
  }
`
const whiteFragment = /* glsl */ `
  void main() {
    gl_FragColor = vec4( 1.0 );
  }
`

/** 上半球（或下半球）平均分布的 `n` 個方向 */
function hemisphere(n: number, sign: number): Vector3[] {
  const out: Vector3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = (i + 0.5) / n
    const r = Math.sqrt(1 - y * y)
    out.push(new Vector3(Math.cos(i * golden) * r, y * sign, Math.sin(i * golden) * r))
  }
  return out
}

function plane(x0: number, x1: number, z0: number, z1: number, y: number): BufferGeometry {
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1]), 3))
  return geo
}

/** 這台顯示卡能不能烘（要能畫到半精度浮點的貼圖上） */
export function canBakeWorld(renderer: WebGLRenderer): boolean {
  return renderer.capabilities.isWebGL2 !== false && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'))
}

/** 兩張貼圖先做出來（材質建立時就要有），之後 `bakeWorld` 畫進去；不能烘的話用 `blankBake` 塗成全白（沒有遮蔽） */
export function createBakeTargets(atlasSize: number, groundScale: number): WorldBakeTargets {
  const opt = {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
  }
  const atlas = new WebGLRenderTarget(atlasSize, atlasSize, opt)
  atlas.texture.channel = 1
  atlas.texture.anisotropy = 4
  const ground = new WebGLRenderTarget(Math.round((MAP_X + GROUND_PAD) * 2 * groundScale), Math.round((MAP_Z + GROUND_PAD) * 2 * groundScale), opt)
  ground.texture.anisotropy = 4
  return { atlas, ground }
}

function pass(renderer: WebGLRenderer, quad: FullScreenQuad, fragmentShader: string, uniforms: Record<string, { value: unknown }>, to: WebGLRenderTarget, blend = false) {
  const mat = new ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: blend ? CustomBlending : NoBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  })
  quad.material = mat
  renderer.setRenderTarget(to)
  quad.render(renderer)
  return mat
}

/** 不能烘的時候：兩張都塗成全白 */
export function blankBake(renderer: WebGLRenderer, targets: WorldBakeTargets) {
  const before = renderer.getRenderTarget()
  const quad = new FullScreenQuad()
  pass(renderer, quad, whiteFragment, {}, targets.atlas).dispose()
  pass(renderer, quad, whiteFragment, {}, targets.ground).dispose()
  quad.dispose()
  renderer.setRenderTarget(before)
}

export function bakeWorld(renderer: WebGLRenderer, targets: WorldBakeTargets, o: WorldBakeOptions) {
  const size = targets.atlas.width
  const gw = targets.ground.width
  const gh = targets.ground.height
  const float = { format: RGBAFormat, type: HalfFloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false }
  const byte = { format: RGBAFormat, type: UnsignedByteType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false }
  const atlasSum = new WebGLRenderTarget(size, size, float)
  const groundSum = new WebGLRenderTarget(gw, gh, float)
  const work = [new WebGLRenderTarget(size, size, byte), new WebGLRenderTarget(size, size, byte)]
  const depth = new WebGLRenderTarget(o.depthSize, o.depthSize, { depthBuffer: true, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false })
  depth.depthTexture = new DepthTexture(o.depthSize, o.depthSize, UnsignedIntType)

  // 整張地圖包在一顆球裡，每個方向的鏡頭都拍得到整顆球
  const hx = MAP_X + GROUND_PAD
  const hz = MAP_Z + GROUND_PAD
  const center = new Vector3(0, (o.top + BED) / 2, 0)
  const radius = Math.hypot(hx, hz, (o.top - BED) / 2) + 2
  const texel = (radius * 2) / o.depthSize
  const cam = new OrthographicCamera(-radius, radius, radius, -radius, 0.5, radius * 2 + 4)
  cam.updateProjectionMatrix()
  const range = cam.far - cam.near

  const shared = {
    uDepth: { value: depth.depthTexture },
    uLight: { value: new Matrix4() },
    uDir: { value: new Vector3() },
    uTexel: { value: 1 / o.depthSize },
    uTexelM: { value: texel },
    uBias: { value: texel * 0.7 },
    uRange: { value: range },
    uMode: { value: 0 },
    uWeight: { value: 0 },
  }
  const additive = {
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  }
  const depthMat = new ShaderMaterial({ vertexShader: depthVertex, fragmentShader: depthFragment, side: DoubleSide, colorWrite: false })
  const gatherMat = new ShaderMaterial({
    vertexShader: gatherVertex,
    fragmentShader: gatherFragment,
    uniforms: { ...shared, uGround: { value: targets.ground.texture }, uGroundScale: { value: new Vector2(1 / (hx * 2), 1 / (hz * 2)) } },
    ...additive,
  })

  const occluders = new Scene()
  const add = (scene: Scene, geo: BufferGeometry, mat: ShaderMaterial): Mesh => {
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    scene.add(mesh)
    return mesh
  }
  for (const g of o.casters) add(occluders, g, depthMat)
  // 地面（只有從底下打光時才放進去：牆腳離地面幾公尺內算被地面擋住）
  const planes = [plane(-radius, -RIVER, -radius, radius, 0), plane(RIVER, radius, -radius, radius, 0), plane(-RIVER, RIVER, -radius, radius, BED)]
  const floors = planes.map((g) => add(occluders, g, depthMat))
  const surfaces = new Scene()
  for (const g of o.charted) add(surfaces, g, gatherMat)

  const before = {
    target: renderer.getRenderTarget(),
    autoClear: renderer.autoClear,
    color: renderer.getClearColor(new Color()),
    alpha: renderer.getClearAlpha(),
  }
  renderer.autoClear = false
  renderer.setClearColor(0x000000, 0)
  for (const t of [atlasSum, groundSum]) {
    renderer.setRenderTarget(t)
    renderer.clear(true, false, false)
  }

  const quad = new FullScreenQuad()
  const up = new Vector3()
  const aim = (d: Vector3) => {
    cam.position.copy(center).addScaledVector(d, radius + 1)
    up.set(0, 1, 0)
    if (Math.abs(d.y) > 0.99) up.set(1, 0, 0)
    cam.up.copy(up)
    cam.lookAt(center)
    cam.updateMatrixWorld(true)
    renderer.setRenderTarget(depth)
    renderer.clear(false, true, false)
    renderer.render(occluders, cam)
    shared.uLight.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    shared.uDir.value.copy(d)
  }

  // 天空那一半：地面那一張和貼圖集一起累加
  const groundMat = new ShaderMaterial({ vertexShader: quadVertex, fragmentShader: groundFragment, uniforms: { ...shared, uHalf: { value: new Vector2(hx, hz) } }, ...additive })
  for (const f of floors) f.visible = false
  shared.uMode.value = 0
  shared.uWeight.value = 2 / o.up
  for (const d of hemisphere(o.up, 1)) {
    aim(d)
    quad.material = groundMat
    renderer.setRenderTarget(groundSum)
    quad.render(renderer)
    renderer.setRenderTarget(atlasSum)
    renderer.render(surfaces, cam)
  }
  pass(renderer, quad, groundResolve, { uSource: { value: groundSum.texture } }, targets.ground).dispose()

  // 地面那一半：只算幾公尺內的遮擋，乘上那附近的地面亮不亮
  for (const f of floors) f.visible = true
  shared.uMode.value = 1
  shared.uWeight.value = 2 / o.down
  for (const d of hemisphere(o.down, -1)) {
    aim(d)
    renderer.setRenderTarget(atlasSum)
    renderer.render(surfaces, cam)
  }

  // 整理一下、把每一格的外面補一圈，再存成一般的貼圖
  pass(renderer, quad, atlasResolve, { uSource: { value: atlasSum.texture } }, work[0]).dispose()
  let from = 0
  for (let i = 0; i < 4; i++) {
    pass(renderer, quad, dilateFragment, { uSource: { value: work[from].texture }, uStep: { value: new Vector2(1 / size, 1 / size) } }, work[1 - from]).dispose()
    from = 1 - from
  }
  pass(renderer, quad, atlasEncode, { uSource: { value: work[from].texture } }, targets.atlas).dispose()

  renderer.setRenderTarget(before.target)
  renderer.autoClear = before.autoClear
  renderer.setClearColor(before.color, before.alpha)
  quad.dispose()
  for (const g of planes) g.dispose()
  depthMat.dispose()
  gatherMat.dispose()
  groundMat.dispose()
  atlasSum.dispose()
  groundSum.dispose()
  work[0].dispose()
  work[1].dispose()
  depth.depthTexture.dispose()
  depth.dispose()
}
