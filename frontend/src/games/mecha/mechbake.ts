// 載入時把每一種機甲的環境光遮蔽（零件之間的縫、互相擋住的地方有多暗）烘成一張貼圖：真的照光線算的，不是螢幕空間的近似。
// 做法：把站好的機甲從幾百個方向各拍一張深度圖（等於從那個方向打一道平行光），再把機甲的每個面攤平到貼圖上（`uv1`），
// 每一點看自己在那一張深度圖裡有沒有被擋住，照「這個方向離法線多近」加權累加起來。全部在顯示卡上做，一種機甲幾十毫秒。
// 烘出來的貼圖：紅色版是遮蔽（1 完全沒被擋）；綠、藍、透明度是「沒被擋住的方向的平均」（關節自己的座標，彎曲法線），
// 環境光照這個方向取，凹下去的地方只吃得到開口那一邊的光。
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
  Quaternion,
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

/** 一起烘的一組零件：互相擋、也只被這一組擋（主體一組、變身時大搬家的另一組） */
export type BakePiece = {
  /** 關節座標的幾何（`position`、`normal`、`uv1`） */
  geo: BufferGeometry
  /** 關節座標 → 站好時的世界座標 */
  world: Matrix4
}

/** 每畫一個方向在透明度多加這麼多：烘完看得出這個像素有沒有東西（完全被擋住的地方累加起來也是 0） */
const COVER = 1 / 64

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

const gatherVertex = /* glsl */ `
  attribute vec2 uv1;
  attribute vec4 aQuat;
  uniform vec3 uDir;
  varying vec3 vPos;
  varying vec3 vNrm;
  varying vec3 vLocalDir;
  void main() {
    vPos = position;
    vNrm = normal;
    // 光的方向轉回這個關節自己的座標（aQuat 是關節世界旋轉的反轉）
    vLocalDir = uDir + 2.0 * cross( aQuat.xyz, cross( aQuat.xyz, uDir ) + aQuat.w * uDir );
    gl_Position = vec4( uv1 * 2.0 - 1.0, 0.0, 1.0 );
  }
`
const gatherFragment = /* glsl */ `
  uniform sampler2D uDepth;
  uniform mat4 uLight;
  uniform vec3 uDir;
  uniform float uTexel;
  uniform float uOffset;
  uniform float uBias;
  varying vec3 vPos;
  varying vec3 vNrm;
  varying vec3 vLocalDir;
  void main() {
    vec3 n = normalize( vNrm );
    float c = max( dot( n, uDir ), 0.0 );
    float lit = 0.0;
    if ( c > 0.0 ) {
      vec4 p = uLight * vec4( vPos + n * uOffset, 1.0 );
      vec3 s = p.xyz * 0.5 + 0.5;
      float z = s.z - uBias;
      lit += step( z, texture2D( uDepth, s.xy + vec2( -0.5, -0.5 ) * uTexel ).r );
      lit += step( z, texture2D( uDepth, s.xy + vec2( 0.5, -0.5 ) * uTexel ).r );
      lit += step( z, texture2D( uDepth, s.xy + vec2( -0.5, 0.5 ) * uTexel ).r );
      lit += step( z, texture2D( uDepth, s.xy + vec2( 0.5, 0.5 ) * uTexel ).r );
      lit *= 0.25 * c;
    }
    gl_FragColor = vec4( normalize( vLocalDir ) * lit, lit + ${COVER.toFixed(8)} );
  }
`

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`
/** 累加的結果換成：rgb 是沒被擋住的方向的平均、a 是 0.5 + 遮蔽 / 2（0 是這個像素沒有東西） */
const resolveFragment = /* glsl */ `
  uniform sampler2D uSource;
  uniform float uCount;
  uniform float uPower;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D( uSource, vUv );
    if ( t.a < ${(COVER * 0.5).toFixed(8)} ) {
      gl_FragColor = vec4( 0.0 );
      return;
    }
    float ao = clamp( ( t.a - uCount * ${COVER.toFixed(8)} ) * 4.0 / uCount, 0.0, 1.0 );
    float l = length( t.rgb );
    gl_FragColor = vec4( l > 1e-4 ? t.rgb / l : vec3( 0.0 ), 0.5 + 0.5 * pow( ao, uPower ) );
  }
`
/** 沒有東西的像素拿旁邊有東西的補起來（每個面在貼圖上那一格的外面一圈，縮小、內插時才不會吃到黑的） */
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
        float on = step( 0.0001, s.a );
        sum += s * on;
        n += on;
      }
    }
    gl_FragColor = t.a > 0.0 ? t : ( n > 0.0 ? sum / n : vec4( 0.0 ) );
  }
`
const encodeFragment = /* glsl */ `
  uniform sampler2D uSource;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D( uSource, vUv );
    float ao = t.a > 0.0 ? ( t.a - 0.5 ) * 2.0 : 1.0;
    float l = length( t.rgb );
    gl_FragColor = vec4( ao, ( l > 1e-4 ? t.rgb / l : vec3( 0.0 ) ) * 0.5 + 0.5 );
  }
`

/** 球面上平均分布的 `n` 個方向 */
function sphere(n: number): Vector3[] {
  const out: Vector3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n
    const r = Math.sqrt(1 - y * y)
    out.push(new Vector3(Math.cos(i * golden) * r, y, Math.sin(i * golden) * r))
  }
  return out
}

/** 一組零件合成一個世界座標的幾何（位置、法線、`uv1`，加上每個頂點所屬關節的反向旋轉） */
function merge(pieces: BakePiece[]): BufferGeometry {
  let count = 0
  let indices = 0
  for (const p of pieces) {
    count += p.geo.attributes.position.count
    indices += p.geo.index!.count
  }
  const pos = new Float32Array(count * 3)
  const nor = new Float32Array(count * 3)
  const uv1 = new Float32Array(count * 2)
  const quat = new Float32Array(count * 4)
  const index = new Uint32Array(indices)
  const v = new Vector3()
  const q = new Quaternion()
  const scale = new Vector3()
  let at = 0
  let it = 0
  for (const p of pieces) {
    const gp = p.geo.attributes.position
    const gn = p.geo.attributes.normal
    const gu = p.geo.attributes.uv1
    p.world.decompose(v, q, scale)
    q.invert()
    const qx = q.x
    const qy = q.y
    const qz = q.z
    const qw = q.w
    for (let i = 0; i < gp.count; i++) {
      v.fromBufferAttribute(gp, i).applyMatrix4(p.world)
      pos[(at + i) * 3] = v.x
      pos[(at + i) * 3 + 1] = v.y
      pos[(at + i) * 3 + 2] = v.z
      v.fromBufferAttribute(gn, i).transformDirection(p.world)
      nor[(at + i) * 3] = v.x
      nor[(at + i) * 3 + 1] = v.y
      nor[(at + i) * 3 + 2] = v.z
      uv1[(at + i) * 2] = gu.getX(i)
      uv1[(at + i) * 2 + 1] = gu.getY(i)
      quat[(at + i) * 4] = qx
      quat[(at + i) * 4 + 1] = qy
      quat[(at + i) * 4 + 2] = qz
      quat[(at + i) * 4 + 3] = qw
    }
    const gi = p.geo.index!
    for (let i = 0; i < gi.count; i++) index[it + i] = gi.getX(i) + at
    at += gp.count
    it += gi.count
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('normal', new BufferAttribute(nor, 3))
  geo.setAttribute('uv1', new BufferAttribute(uv1, 2))
  geo.setAttribute('aQuat', new BufferAttribute(quat, 4))
  geo.setIndex(new BufferAttribute(index, 1))
  geo.computeBoundingSphere()
  return geo
}

/** 這台顯示卡能不能烘（要能畫到半精度浮點的貼圖上） */
export function canBake(renderer: WebGLRenderer): boolean {
  return renderer.capabilities.isWebGL2 !== false && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'))
}

/**
 * 烘遮蔽貼圖：`sets` 的每一組各自算（組裡的零件互相擋），全部畫在同一張 `size` × `size` 的貼圖上。
 * `directions` 是從幾個方向打光（越多越平滑），`depthSize` 是每個方向那張深度圖的大小
 */
export function bakeOcclusion(renderer: WebGLRenderer, sets: BakePiece[][], size: number, directions: number, depthSize: number): WebGLRenderTarget {
  const target = new WebGLRenderTarget(size, size, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
  })
  target.texture.channel = 1
  target.texture.anisotropy = 4

  const float = { format: RGBAFormat, type: HalfFloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false }
  const gather = new WebGLRenderTarget(size, size, float)
  const work = [new WebGLRenderTarget(size, size, float), new WebGLRenderTarget(size, size, float)]
  const depth = new WebGLRenderTarget(depthSize, depthSize, { depthBuffer: true, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false })
  depth.depthTexture = new DepthTexture(depthSize, depthSize, UnsignedIntType)

  const depthMat = new ShaderMaterial({ vertexShader: depthVertex, fragmentShader: depthFragment, side: DoubleSide, colorWrite: false })
  const gatherMat = new ShaderMaterial({
    vertexShader: gatherVertex,
    fragmentShader: gatherFragment,
    uniforms: {
      uDepth: { value: depth.depthTexture },
      uLight: { value: new Matrix4() },
      uDir: { value: new Vector3() },
      uTexel: { value: 1 / depthSize },
      uOffset: { value: 0.02 },
      uBias: { value: 0.001 },
    },
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  })

  const before = {
    target: renderer.getRenderTarget(),
    autoClear: renderer.autoClear,
    color: renderer.getClearColor(new Color()),
    alpha: renderer.getClearAlpha(),
  }
  renderer.autoClear = false
  renderer.setClearColor(0x000000, 0)
  renderer.setRenderTarget(gather)
  renderer.clear(true, false, false)

  const dirs = sphere(directions)
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  const up = new Vector3()
  const scene = new Scene()
  const mesh = new Mesh<BufferGeometry, ShaderMaterial>(undefined, depthMat)
  mesh.frustumCulled = false
  scene.add(mesh)
  const merged: BufferGeometry[] = []
  for (const set of sets) {
    if (!set.length) continue
    const geo = merge(set)
    merged.push(geo)
    mesh.geometry = geo
    const { center, radius } = geo.boundingSphere!
    const r = radius * 1.02 + 0.05
    cam.left = cam.bottom = -r
    cam.right = cam.top = r
    cam.near = 0.1
    cam.far = r * 2 + 0.2
    cam.updateProjectionMatrix()
    // 深度圖一格多大（公尺）：沿著法線移開這麼多再比，才不會自己擋到自己
    const texel = (r * 2) / depthSize
    gatherMat.uniforms.uOffset.value = texel * 1.6 + 0.004
    gatherMat.uniforms.uBias.value = (texel * 1.5) / (cam.far - cam.near)
    for (const d of dirs) {
      cam.position.copy(center).addScaledVector(d, r + 0.1)
      up.set(0, 1, 0)
      if (Math.abs(d.y) > 0.99) up.set(1, 0, 0)
      cam.up.copy(up)
      cam.lookAt(center)
      cam.updateMatrixWorld(true)
      mesh.material = depthMat
      renderer.setRenderTarget(depth)
      renderer.clear(false, true, false)
      renderer.render(scene, cam)
      gatherMat.uniforms.uLight.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      gatherMat.uniforms.uDir.value.copy(d)
      mesh.material = gatherMat
      renderer.setRenderTarget(gather)
      renderer.render(scene, cam)
    }
  }

  // 累加的結果整理一下、把每一格的外面補一圈，再存成一般的貼圖
  const quad = new FullScreenQuad()
  const pass = (fragmentShader: string, uniforms: Record<string, { value: unknown }>, to: WebGLRenderTarget) => {
    const mat = new ShaderMaterial({ vertexShader: quadVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: NoBlending })
    quad.material = mat
    renderer.setRenderTarget(to)
    quad.render(renderer)
    mat.dispose()
  }
  pass(resolveFragment, { uSource: { value: gather.texture }, uCount: { value: directions }, uPower: { value: 1 } }, work[0])
  let from = 0
  for (let i = 0; i < 6; i++) {
    pass(dilateFragment, { uSource: { value: work[from].texture }, uStep: { value: new Vector2(1 / size, 1 / size) } }, work[1 - from])
    from = 1 - from
  }
  pass(encodeFragment, { uSource: { value: work[from].texture } }, target)

  renderer.setRenderTarget(before.target)
  renderer.autoClear = before.autoClear
  renderer.setClearColor(before.color, before.alpha)
  quad.dispose()
  for (const g of merged) g.dispose()
  depthMat.dispose()
  gatherMat.dispose()
  gather.dispose()
  work[0].dispose()
  work[1].dispose()
  depth.depthTexture.dispose()
  depth.dispose()
  return target
}
