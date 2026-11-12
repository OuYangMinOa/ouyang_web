// 機甲專用的光：陰影和反射都另外算，不用場景那一套（場景的串接陰影在機甲附近一格有 20 公分，零件之間的影子糊成一團）。
//   - 自陰影（`hero`）：鏡頭附近的機甲另外拍一張很密的陰影貼圖（幾公分一格），只有機甲的零件，每一格重畫。
//     槍管落在機身上、上半身落在腿上的影子才清楚
//   - 建築的陰影（`city`）：整張地圖從太陽的方向拍一張，載入時畫一次（大樓不會動）。機甲走進大樓的影子裡會暗下來
//   - 反射探針（`probe`）：從鏡頭跟著的機甲那裡把四周的城市拍成立方體貼圖（每一格輪流重畫一個面，六個面都畫完再算一次模糊），
//     機甲的反射和環境光照這張貼圖取：裝甲上映得到旁邊的大樓、被太陽照亮的路面從下面打上來的光，鑽到橋下、機庫裡會暗下來。
//     離探針遠的機甲慢慢換回只有天空的環境貼圖（探針是照鏡頭那裡拍的，拿去照 200 公尺外的機甲不對）
// 機甲的材質（`mechmat.ts`）照這裡的 `uniforms` 取樣。
import {
  Color,
  CubeCamera,
  DepthTexture,
  HalfFloatType,
  LessEqualCompare,
  LinearFilter,
  Matrix4,
  MeshDepthMaterial,
  OrthographicCamera,
  PMREMGenerator,
  type PerspectiveCamera,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { GLOW, SUN_DIR } from './sky'
import type { World } from './world'

/** 機甲的網格在這一層（自陰影只畫這一層的東西） */
export const MECH_LAYER = 1

/** 探針的立方體貼圖一面多大；天空的環境貼圖也要做成一樣大（著色器裡兩張用同一組常數取樣） */
export const PROBE_SIZE = 128
/** 探針的鏡頭看多遠：要比天空那顆球（半徑 2500）遠，不然天空被切掉 */
const PROBE_FAR = 3000
/** 離探針這麼遠以內的機甲用探針，之後慢慢換回天空（到 `PROBE_RANGE` 的 1.6 倍完全換掉） */
const PROBE_RANGE = 70
/** 鏡頭跟的地方一下子跳這麼遠（換場景、重生）就整個重拍，不然一格一個面慢慢換 */
const PROBE_JUMP = 25

const HERO_SIZE = 2048
const CITY_SIZE = 2048

export type LightUniforms = {
  uHeroMap: { value: DepthTexture }
  uHeroMatrix: { value: Matrix4 }
  /** 一格多大（貼圖座標）、一格多大（公尺）、開關、深度的偏移 */
  uHeroInfo: { value: Vector4 }
  uCityMap: { value: DepthTexture }
  uCityMatrix: { value: Matrix4 }
  uCityInfo: { value: Vector4 }
  uSunDir: { value: Vector3 }
  uSkyEnv: { value: Texture }
  /** 探針的位置、用到多遠（0 是沒有探針，全部用天空） */
  uProbe: { value: Vector4 }
  /** 環境光、反射各乘多少 */
  uEnvGain: { value: Vector2 }
  /** 朝太陽那一邊的霧被照成的顏色（和場景的霧同一條式子，`worldmat.ts` 的 `hazeFragment`） */
  uFogGlow: { value: Color }
}

function shadowTarget(size: number): WebGLRenderTarget {
  const target = new WebGLRenderTarget(size, size, { depthBuffer: true, generateMipmaps: false })
  const depth = new DepthTexture(size, size, UnsignedIntType)
  // 讓顯示卡自己比深度、把旁邊四格內插起來（一次取樣就是 2×2 的柔邊）
  depth.compareFunction = LessEqualCompare
  depth.minFilter = depth.magFilter = LinearFilter
  target.depthTexture = depth
  return target
}

/** 把 [-1, 1] 的投影座標換成 [0, 1] 的貼圖座標和深度 */
const BIAS = new Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)

export class MechLighting {
  readonly uniforms: LightUniforms
  /** 探針的環境貼圖（機甲材質的 `envMap`） */
  readonly envMap: Texture
  private readonly renderer: WebGLRenderer
  private readonly world: World
  private readonly hero: WebGLRenderTarget
  private readonly heroCam = new OrthographicCamera(-1, 1, 1, -1, 1, 100)
  private readonly city: WebGLRenderTarget
  private readonly depthMat = new MeshDepthMaterial()
  private readonly cube: WebGLCubeRenderTarget
  private readonly cubeCam: CubeCamera
  private readonly pmrem: PMREMGenerator
  private readonly probeTarget: WebGLRenderTarget
  private readonly sky: WebGLRenderTarget
  private readonly probeAt = new Vector3(1e9, 0, 0)
  private face = 0
  private probeOn = true
  private heroOn = true
  /** 太陽看過來的三個軸（x、y 是陰影貼圖的橫直，z 朝太陽） */
  private readonly ax = new Vector3()
  private readonly ay = new Vector3()
  private readonly az = SUN_DIR.clone()
  private readonly tmp = new Vector3()

  constructor(renderer: WebGLRenderer, world: World) {
    this.renderer = renderer
    this.world = world
    this.ax.set(0, 1, 0).cross(this.az).normalize()
    this.ay.copy(this.az).cross(this.ax)
    this.heroCam.layers.set(MECH_LAYER)

    this.hero = shadowTarget(HERO_SIZE)
    this.city = shadowTarget(CITY_SIZE)
    const cityCam = world.sunCamera()
    world.renderStatics(cityCam, this.city, { castersOnly: true, material: this.depthMat })
    const cityTexel = (cityCam.right - cityCam.left) / CITY_SIZE

    this.cube = new WebGLCubeRenderTarget(PROBE_SIZE, { type: HalfFloatType, generateMipmaps: false })
    this.cubeCam = new CubeCamera(0.5, PROBE_FAR, this.cube)
    this.cubeCam.coordinateSystem = renderer.coordinateSystem
    this.cubeCam.updateCoordinateSystem()
    this.pmrem = new PMREMGenerator(renderer)
    this.sky = world.skyEnvironment(PROBE_SIZE)
    // 第一次不給貼圖：讓它照這個大小配一張（之後每次都畫回同一張）
    world.prime()
    this.cubeCam.position.set(0, 30, 0)
    this.capture(6)
    this.probeTarget = this.pmrem.fromCubemap(this.cube.texture)
    this.envMap = this.probeTarget.texture

    this.uniforms = {
      uHeroMap: { value: this.hero.depthTexture! },
      uHeroMatrix: { value: new Matrix4() },
      uHeroInfo: { value: new Vector4(1 / HERO_SIZE, 0.02, 0, 0.0005) },
      uCityMap: { value: this.city.depthTexture! },
      uCityMatrix: { value: new Matrix4().multiplyMatrices(cityCam.projectionMatrix, cityCam.matrixWorldInverse).premultiply(BIAS) },
      uCityInfo: { value: new Vector4(1 / CITY_SIZE, cityTexel, 1, (cityTexel * 1.2) / (cityCam.far - cityCam.near)) },
      uSunDir: { value: SUN_DIR },
      uSkyEnv: { value: this.sky.texture },
      uProbe: { value: new Vector4(0, 0, 0, 0) },
      uEnvGain: { value: new Vector2(1, 1) },
      uFogGlow: { value: new Color(GLOW) },
    }
  }

  /** 探針的立方體重畫 `faces` 個面（從上次畫到的那一面接下去） */
  private capture(faces: number) {
    const cam = this.cubeCam
    cam.updateMatrixWorld(true)
    for (let i = 0; i < faces; i++) {
      this.world.renderStatics(cam.children[this.face] as PerspectiveCamera, this.cube, { face: this.face, sunDisc: false })
      this.face = (this.face + 1) % 6
    }
  }

  /** 探針關掉：機甲的反射和環境光只用天空 */
  setProbe(on: boolean) {
    this.probeOn = on
    if (!on) this.uniforms.uProbe.value.w = 0
  }

  /**
   * 畫面跟不上時叫這個：不再每一格重畫機甲的自陰影和反射探針（大樓的陰影是載入時畫好的，留著）。
   * 回傳有沒有省到東西（已經關了就回傳 false）
   */
  cheaper(): boolean {
    if (!this.probeOn && !this.heroOn) return false
    this.setProbe(false)
    this.heroOn = false
    this.uniforms.uHeroInfo.value.z = 0
    return true
  }

  /**
   * 每一格、畫主畫面之前呼叫。`focus` 是鏡頭跟著的地方（自己的機甲、展示的機甲），`radius` 是它四周多大的範圍要有清楚的自陰影
   * （範圍越小影子越細）
   */
  update(focus: Vector3, radius: number) {
    const { renderer, uniforms } = this
    if (this.heroOn) this.updateHero(focus, radius)
    // 探針：跟著 focus，每一格重畫一個面；六個面都畫過一輪就重新算一次模糊
    if (this.probeOn) {
      const jumped = focus.distanceTo(this.probeAt) > PROBE_JUMP
      this.cubeCam.position.copy(focus)
      this.probeAt.copy(focus)
      this.capture(jumped ? 6 : 1)
      if (jumped || this.face === 0) this.pmrem.fromCubemap(this.cube.texture, this.probeTarget)
      uniforms.uProbe.value.set(focus.x, focus.y, focus.z, PROBE_RANGE)
    }
    renderer.setRenderTarget(null)
  }

  /** 自陰影：正交的鏡頭從太陽那邊對準 focus，位置貼齊格子（鏡頭移動時影子的邊才不會抖） */
  private updateHero(focus: Vector3, radius: number) {
    const { uniforms } = this
    const texel = (radius * 2) / HERO_SIZE
    const cam = this.heroCam
    const cx = Math.round(focus.dot(this.ax) / texel) * texel
    const cy = Math.round(focus.dot(this.ay) / texel) * texel
    const cz = focus.dot(this.az)
    const depth = radius + 40
    cam.position.set(0, 0, 0).addScaledVector(this.ax, cx).addScaledVector(this.ay, cy).addScaledVector(this.az, cz + depth)
    cam.up.copy(this.ay)
    cam.lookAt(this.tmp.copy(cam.position).sub(this.az))
    cam.left = cam.bottom = -radius
    cam.right = cam.top = radius
    cam.near = 1
    cam.far = depth * 2
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)
    this.world.renderLayer(cam, this.hero, this.depthMat)
    uniforms.uHeroMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).premultiply(BIAS)
    uniforms.uHeroInfo.value.set(1 / HERO_SIZE, texel, 1, (texel * 0.9 + 0.004) / (cam.far - cam.near))
  }

  dispose() {
    this.hero.depthTexture?.dispose()
    this.hero.dispose()
    this.city.depthTexture?.dispose()
    this.city.dispose()
    this.depthMat.dispose()
    this.cube.dispose()
    this.probeTarget.dispose()
    this.sky.dispose()
    this.pmrem.dispose()
  }
}
