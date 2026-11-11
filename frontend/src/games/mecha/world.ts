// 把地圖（map.ts）畫成 3D 場景：傍晚前的斜陽、有雲的天空、柏油路和標線、人行道、一棟棟有窗戶和店面的大樓、紅磚街屋、
// 鐵皮倉庫、貨櫃、路邊的車、混凝土牆、公園的樹，中間一條河（石砌的河岸、河床、會流動的水面）、
// 斜張大橋（引道、橋面、護欄、橋墩、橋塔和鋼纜）、高架快速道路和交流道、人行鋼橋、鋼桁架橋、調車場的車廂和鐵軌、墊高的公園，
// 兩邊的機庫和只擋敵人的能量牆，地圖外面還有一圈遠景大樓。
//
// 貼圖全部用 canvas 畫（textures.ts），天空是著色器（sky.ts）。同一種材質的東西合成一個網格，一次畫完。
// 這裡加的東西（屋頂的設備、招牌、雨遮、紅綠燈、路燈）都只是畫面，不擋東西：碰撞、打中只看 map.ts 的方塊。
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type MeshStandardMaterialParameters,
  type Texture,
  type WebGLRenderer,
} from 'three'
import { SunLight } from 'three/addons/lights/SunLight.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { fbm, rng } from '../racing/noise'
import {
  AVENUE_Z,
  BASE,
  BED,
  BRIDGE_W,
  crosses,
  HANGAR_H,
  MAP_X,
  MAP_Z,
  RIVER,
  topAt,
  WATER,
  type Box,
  type MapData,
  type Spawn,
  type Team,
} from './map'
import { HORIZON, Sky, SUN_COLOR, SUN_DIR } from './sky'
import { TEAMS } from './spec'
import { createTextures, dataTexture, disposeTextures, setAnisotropy, SIGN_COUNT, type Surface, type WorldTextures } from './textures'

/** 店面那一層有多高 */
const SHOP_H = 5
/** 外牆貼圖一格：四個開間、四層樓 */
const CELL_W = 12
const CELL_H = 13.2
/** 店面貼圖一格：八間 */
const SHOP_W = 24
/** 太陽多亮（陰影有兩種做法，兩盞燈要一樣亮） */
const SUN_POWER = 3.3
/** 整張地圖那一層貼圖（`macroCanvas`）比地圖多畫出去多少、一公尺幾個像素 */
const MACRO_PAD = 20
const MACRO_PX = 2

/**
 * 陰影怎麼做：
 *   - `dynamic`：跟著鏡頭的兩層串接陰影，每一格重畫，機甲也有真的影子（近的很清楚）
 *   - `static`：整張地圖的陰影只在一開始畫一次（大樓不會動），之後不花時間；機甲用腳下的圓影子
 */
export type ShadowMode = 'dynamic' | 'static'

/** 一個角：位置和 UV */
type Corner = [x: number, y: number, z: number, u: number, v: number]

/** 一直往裡面塞四邊形的網格（不共用頂點，每個面自己的法線、UV、顏色） */
class Mesher {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []
  col: number[] = []

  /**
   * 從 p 沿著 r（往右）和 u（往上）展開的四邊形，r × u 是法線方向。
   * UV 照公尺算：(u0, v0) 起，橫的每 `us` 公尺一格、直的每 `vs` 公尺一格。`c0` 是下面兩點的顏色、`c1` 是上面的
   */
  quad(
    px: number,
    py: number,
    pz: number,
    rx: number,
    ry: number,
    rz: number,
    ux: number,
    uy: number,
    uz: number,
    us: number,
    vs: number,
    u0: number,
    v0: number,
    c0: Color,
    c1: Color = c0,
  ) {
    const ul = Math.hypot(rx, ry, rz) / us
    const vl = Math.hypot(ux, uy, uz) / vs
    this.face(
      [px, py, pz, u0, v0],
      [px + rx, py + ry, pz + rz, u0 + ul, v0],
      [px + rx + ux, py + ry + uy, pz + rz + uz, u0 + ul, v0 + vl],
      [px + ux, py + uy, pz + uz, u0, v0 + vl],
      c0,
      c1,
    )
  }

  /** 任意平的四邊形（可以是梯形、退化成三角形）：四個角照逆時針的順序，`c0` 給前兩個角、`c1` 給後兩個 */
  face(p0: Corner, p1: Corner, p2: Corner, p3: Corner, c0: Color, c1: Color = c0) {
    // 法線用兩條對角線的外積：有一個邊長是 0 也算得出來
    const ax = p2[0] - p0[0]
    const ay = p2[1] - p0[1]
    const az = p2[2] - p0[2]
    const bx = p3[0] - p1[0]
    const by = p3[1] - p1[1]
    const bz = p3[2] - p1[2]
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    const nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-9) return
    nx /= nl
    ny /= nl
    nz /= nl
    const corners = [p0, p1, p2, p3]
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const c = corners[k]
      this.pos.push(c[0], c[1], c[2])
      this.nor.push(nx, ny, nz)
      this.uv.push(c[3], c[4])
      const color = k < 2 ? c0 : c1
      this.col.push(color.r, color.g, color.b)
    }
  }

  /** 方塊的四面牆（y0 到 y1），UV 沿著外圍接起來 */
  walls(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, us: number, vs: number, v0: number, c0: Color, c1: Color = c0) {
    const w = x1 - x0
    const d = z1 - z0
    const h = y1 - y0
    let u = 0
    this.quad(x0, y0, z1, w, 0, 0, 0, h, 0, us, vs, u, v0, c0, c1)
    u += w / us
    this.quad(x1, y0, z1, 0, 0, -d, 0, h, 0, us, vs, u, v0, c0, c1)
    u += d / us
    this.quad(x1, y0, z0, -w, 0, 0, 0, h, 0, us, vs, u, v0, c0, c1)
    u += w / us
    this.quad(x0, y0, z0, 0, 0, d, 0, h, 0, us, vs, u, v0, c0, c1)
  }

  /** 朝上的面 */
  top(x0: number, x1: number, z0: number, z1: number, y: number, s: number, c: Color) {
    this.quad(x0, y, z1, x1 - x0, 0, 0, 0, 0, z0 - z1, s, s, x0 / s, -z1 / s, c)
  }

  /** 朝下的面（橋面底下） */
  bottom(x0: number, x1: number, z0: number, z1: number, y: number, s: number, c: Color) {
    this.quad(x0, y, z0, x1 - x0, 0, 0, 0, 0, z1 - z0, s, s, x0 / s, z0 / s, c)
  }

  /** 整個方塊（四面牆加頂），UV 每 `s` 公尺一格 */
  box(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, s: number, c: Color, cTop: Color = c) {
    this.walls(x0, x1, z0, z1, y0, y1, s, s, y0 / s, c, cTop)
    this.top(x0, x1, z0, z1, y1, s, cTop)
  }

  /** 地圖上的方塊（頂面可以是斜的）：四面牆，`withTop` 時加上頂面 */
  solid(b: Box, s: number, c: Color, cTop: Color = c, withTop = true) {
    const pts: [number, number][] = [
      [b.x0, b.z1],
      [b.x1, b.z1],
      [b.x1, b.z0],
      [b.x0, b.z0],
    ]
    let u = 0
    for (let k = 0; k < 4; k++) {
      const [ax, az] = pts[k]
      const [bx, bz] = pts[(k + 1) % 4]
      const len = Math.hypot(bx - ax, bz - az) / s
      const ta = topAt(b, ax, az)
      const tb = topAt(b, bx, bz)
      this.face([ax, b.y0, az, u, b.y0 / s], [bx, b.y0, bz, u + len, b.y0 / s], [bx, tb, bz, u + len, tb / s], [ax, ta, az, u, ta / s], c, cTop)
      u += len
    }
    if (withTop) this.slopeTop(b, s, cTop)
  }

  /** 方塊的頂面（斜坡是斜的） */
  slopeTop(b: Box, s: number, c: Color) {
    const corner = (x: number, z: number): Corner => [x, topAt(b, x, z), z, x / s, -z / s]
    this.face(corner(b.x0, b.z1), corner(b.x1, b.z1), corner(b.x1, b.z0), corner(b.x0, b.z0), c)
  }

  /** 細長的鋼纜：兩片交叉的長條，從 a 拉到 b */
  cable(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, c: Color) {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.hypot(dx, dy, dz)
    // 一片和地面平行（d × 上）、一片和它垂直
    let px = -dz
    let pz = dx
    const pl = Math.hypot(px, pz) || 1
    px = (px / pl) * w
    pz = (pz / pl) * w
    this.quad(ax - px / 2, ay, az - pz / 2, dx, dy, dz, px, 0, pz, len, 1, 0, 0, c)
    let qx = dy * pz
    let qy = dz * px - dx * pz
    let qz = -dy * px
    const ql = Math.hypot(qx, qy, qz) || 1
    qx = (qx / ql) * w
    qy = (qy / ql) * w
    qz = (qz / ql) * w
    this.quad(ax - qx / 2, ay - qy / 2, az - qz / 2, dx, dy, dz, qx, qy, qz, len, 1, 0, 0, c)
  }

  /** 直立的多邊形柱（水塔）：`n` 邊，頂上封起來 */
  prism(cx: number, cz: number, r: number, y0: number, y1: number, n: number, c: Color, cTop: Color = c) {
    const at = (k: number): [number, number] => [cx + Math.cos((k / n) * Math.PI * 2) * r, cz + Math.sin((k / n) * Math.PI * 2) * r]
    for (let k = 0; k < n; k++) {
      const [ax, az] = at(k + 1)
      const [bx, bz] = at(k)
      const u = k / n
      this.face([ax, y0, az, u, 0], [bx, y0, bz, u + 1 / n, 0], [bx, y1, bz, u + 1 / n, 1], [ax, y1, az, u, 1], c, cTop)
      this.face([cx, y1, cz, 0.5, 0.5], [ax, y1, az, 0, 0], [bx, y1, bz, 1, 0], [bx, y1, bz, 1, 0], cTop)
    }
  }

  /** 掛在牆上的直式招牌：從牆面上的 (x, z) 往 (nx, nz) 伸出去 `w` 公尺、高 `h`，兩面都貼第 `i` 塊招牌 */
  sign(x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, i: number) {
    const us = w * SIGN_COUNT
    this.quad(x, y, z, nx * w, 0, nz * w, 0, h, 0, us, h, i / SIGN_COUNT, 0, white)
    this.quad(x + nx * w, y, z + nz * w, -nx * w, 0, -nz * w, 0, h, 0, us, h, i / SIGN_COUNT, 0, white)
  }

  get empty() {
    return this.pos.length === 0
  }

  geometry(): BufferGeometry {
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3))
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3))
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2))
    geo.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3))
    geo.computeBoundingSphere()
    return geo
  }
}

const white = new Color(0xffffff)
const hex = (h: number) => new Color(h)
/** 看不到的地方延伸到多遠（河、地面一路通到地平線） */
const FAR = 2000

/** 能量牆：往上流動的六角形網格，只擋敵人 */
const barrierVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const barrierFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 p = vec2(vUv.x * 28.0, vUv.y * 11.0 - uTime * 0.6);
    vec2 q = vec2(p.x + 0.5 * mod(floor(p.y), 2.0), p.y);
    vec2 f = abs(fract(q) - 0.5);
    float edge = smoothstep(0.42, 0.5, max(f.x, f.y));
    float scan = 0.5 + 0.5 * sin(vUv.y * 40.0 - uTime * 3.0);
    float fade = smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y));
    float a = (0.08 + edge * 0.45 + scan * 0.05) * fade;
    gl_FragColor = vec4(uColor, a);
  }
`

/** 整張地圖一張的貼圖乘到地面的顏色上（0.5 是不變）：位置照世界座標算，不用另外的 UV */
function withMacro(mat: MeshStandardMaterial, macro: Texture): MeshStandardMaterial {
  const sx = (1 / (2 * (MAP_X + MACRO_PAD))).toFixed(8)
  const sz = (1 / (2 * (MAP_Z + MACRO_PAD))).toFixed(8)
  mat.onBeforeCompile = (s) => {
    s.uniforms.uMacro = { value: macro }
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMacro;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvMacro = vec2(position.x * ${sx} + 0.5, 0.5 - position.z * ${sz});`)
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMacro;\nuniform sampler2D uMacro;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= texture2D(uMacro, vMacro).rgb * 2.0;')
  }
  mat.customProgramCacheKey = () => 'macro'
  return mat
}

/**
 * 外牆的窗戶哪幾扇開著燈：發光貼圖只標出玻璃的位置，照「第幾個開間、第幾層樓」算一個亂數決定亮不亮、偏暖還是偏冷，
 * 整座城市每一扇窗各自決定，不會照貼圖一格一格重複
 */
function litWindows(mat: MeshStandardMaterial, share: number): MeshStandardMaterial {
  mat.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      /* glsl */ `
      #ifdef USE_EMISSIVEMAP
        vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
        vec2 cell = floor( vEmissiveMapUv * 4.0 );
        float hsh = fract( sin( dot( cell, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
        float lit = step( ${(1 - share).toFixed(3)}, hsh );
        vec3 tint = mix( vec3( 1.0, 0.78, 0.5 ), vec3( 0.76, 0.9, 1.0 ), step( 0.72, fract( hsh * 13.7 ) ) );
        totalEmissiveRadiance *= emissiveColor.rgb * tint * lit * ( 0.55 + 0.45 * fract( hsh * 5.3 ) );
      #endif`,
    )
  }
  mat.customProgramCacheKey = () => `lit${share}`
  return mat
}

/** 水面：兩層不同方向、速度的波紋疊在一起，靠岸的地方有一圈白沫 */
function flowing(mat: MeshStandardMaterial, time: { value: number }): MeshStandardMaterial {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uTime = time
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWater;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWater = position;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWater;\nuniform float uTime;')
      .replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        /* glsl */ `
        vec2 wuv = vWater.xz / 15.0;
        // 第二層轉個角度、換個大小，兩層疊起來才看不出貼圖在重複
        vec2 wuv2 = vec2( wuv.x * 0.8 - wuv.y * 0.6, wuv.x * 0.6 + wuv.y * 0.8 ) * 2.37;
        vec3 mapN = texture2D( normalMap, wuv + vec2( uTime * 0.004, -uTime * 0.026 ) ).xyz * 2.0 - 1.0;
        mapN += texture2D( normalMap, wuv2 + vec2( -uTime * 0.012, -uTime * 0.05 ) ).xyz * 2.0 - 1.0;
        // 遠的地方波紋收掉，不然會閃
        mapN.xy *= 1.0 - smoothstep( 60.0, 420.0, vViewPosition.z );
        mapN = normalize( mapN );`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        float shore = smoothstep( ${(RIVER - 3.2).toFixed(1)}, ${(RIVER - 0.2).toFixed(1)}, abs( vWater.x ) );
        float ripple = texture2D( normalMap, vWater.xz / 9.0 + vec2( 0.0, -uTime * 0.05 ) ).x;
        float foam = shore * smoothstep( 0.42, 0.62, ripple + shore * 0.25 );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.9, 0.88 ), foam * 0.7 );
        diffuseColor.a = mix( diffuseColor.a, 0.96, foam );`,
      )
  }
  mat.customProgramCacheKey = () => 'water'
  return mat
}

/** 整張地圖一張的貼圖：柏油深深淺淺的大色塊、車輪壓出來的痕跡、牆腳和高架底下的陰影、爆炸燒過的焦痕 */
function macroCanvas(map: MapData): HTMLCanvasElement {
  const wx = MAP_X + MACRO_PAD
  const wz = MAP_Z + MACRO_PAD
  const canvas = document.createElement('canvas')
  canvas.width = wx * 2 * MACRO_PX
  canvas.height = wz * 2 * MACRO_PX
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // 大色塊：小張的雜訊放大
  const nw = Math.round(wx / 4)
  const nh = Math.round(wz / 4)
  const noise = document.createElement('canvas')
  noise.width = nw
  noise.height = nh
  const nctx = noise.getContext('2d')!
  const img = nctx.createImageData(nw, nh)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const v = 128 + (fbm(x * 0.05, y * 0.05, 5, 4) - 0.5) * 84 + (fbm(x * 0.22, y * 0.22, 9, 3) - 0.5) * 44
      const i = (y * nw + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  nctx.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(noise, 0, 0, canvas.width, canvas.height)

  // 之後都用世界座標畫（x 往右、z 往下）
  ctx.setTransform(MACRO_PX, 0, 0, MACRO_PX, wx * MACRO_PX, wz * MACRO_PX)
  const rect = (x0: number, x1: number, z0: number, z1: number) => ctx.fillRect(x0, z0, x1 - x0, z1 - z0)

  // 路：每個方向車輪壓得比較黑的兩道、路邊積灰比較淺
  for (const r of map.roads) {
    const lanes = Math.max(1, Math.round(r.w / 7))
    const lw = r.w / (lanes * 2)
    for (let k = 0; k < lanes * 2; k++) {
      const c = r.at - r.w / 2 + lw * (k + 0.5)
      for (const off of [-0.9, 0.9]) {
        ctx.fillStyle = 'rgba(0,0,0,0.07)'
        if (r.axis === 'x') rect(r.a, r.b, c + off - 0.45, c + off + 0.45)
        else rect(c + off - 0.45, c + off + 0.45, r.a, r.b)
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    for (const side of [-1, 1]) {
      const e = r.at + side * (r.w / 2 - 0.6)
      if (r.axis === 'x') rect(r.a, r.b, e - 0.6, e + 0.6)
      else rect(e - 0.6, e + 0.6, r.a, r.b)
    }
  }

  // 焦痕：打過仗的地方，路上、廣場上一圈圈燒黑的痕跡
  const rand = rng(90210)
  for (let i = 0; i < 150; i++) {
    const x = (rand() * 2 - 1) * (MAP_X - 30)
    const z = (rand() * 2 - 1) * (MAP_Z - 20)
    if (Math.abs(x) < RIVER + 2) continue
    const r = 2.5 + rand() * 5.5
    const g = ctx.createRadialGradient(x, z, 0, x, z, r)
    const a = 0.3 + rand() * 0.4
    g.addColorStop(0, `rgba(0,0,0,${a})`)
    g.addColorStop(0.35, `rgba(0,0,0,${a * 0.6})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(x - r, z - r, r * 2, r * 2)
    // 往外噴的幾道
    ctx.strokeStyle = `rgba(0,0,0,${a * 0.35})`
    for (let k = 0; k < 7; k++) {
      const t = rand() * Math.PI * 2
      const len = r * (0.8 + rand() * 0.9)
      ctx.lineWidth = 0.3 + rand() * 0.5
      ctx.beginPath()
      ctx.moveTo(x + Math.cos(t) * r * 0.2, z + Math.sin(t) * r * 0.2)
      ctx.lineTo(x + Math.cos(t) * len, z + Math.sin(t) * len)
      ctx.stroke()
    }
  }

  // 牆腳、高架底下的陰影：先畫在小張的畫布上（一公尺半個像素），放大後邊緣自然糊開
  const ao = document.createElement('canvas')
  ao.width = wx
  ao.height = wz
  const actx = ao.getContext('2d')!
  actx.fillStyle = '#fff'
  actx.fillRect(0, 0, wx, wz)
  actx.setTransform(0.5, 0, 0, 0.5, wx / 2, wz / 2)
  const shade = (b: Box, grow: number, a: number) => {
    actx.fillStyle = `rgba(0,0,0,${a})`
    actx.fillRect(b.x0 - grow, b.z0 - grow, b.x1 - b.x0 + grow * 2, b.z1 - b.z0 + grow * 2)
  }
  const floor1 = Math.min(...map.boxes.filter((b) => b.kind === 'floor').map((b) => b.y1), Infinity)
  for (const b of map.boxes) {
    switch (b.kind) {
      case 'building':
      case 'tower':
      case 'house':
      case 'warehouse':
      case 'hangar':
      case 'facade':
      case 'mound':
        if (b.y0 <= 0.5) shade(b, 2.4, 0.5)
        break
      case 'container':
      case 'railcar':
      case 'bus':
      case 'twall':
      case 'pillar':
      case 'pier':
      case 'pylon':
      case 'monument':
      case 'kiosk':
      case 'column':
      case 'barge':
        if (b.y0 <= 0.5) shade(b, 1.4, 0.42)
        break
      case 'ramp':
      case 'slipway':
        shade(b, 1.2, 0.3)
        break
      case 'deck':
        if (b.y0 > 1.5) shade(b, 0, 0.36)
        break
      case 'floor':
        if (b.y1 === floor1) shade(b, 0, 0.4)
        break
      default:
        break
    }
  }
  ctx.globalCompositeOperation = 'multiply'
  ctx.drawImage(ao, -wx, -wz, wx * 2, wz * 2)
  // 小東西的影子直接畫（糊開的範圍小）
  ctx.fillStyle = 'rgba(0,0,0,0.3)'
  for (const b of map.boxes) {
    if (b.y0 > 0.5) continue
    if (b.kind === 'car' || b.kind === 'crate' || b.kind === 'barrier' || b.kind === 'planter' || b.kind === 'rubble') rect(b.x0 - 0.5, b.x1 + 0.5, b.z0 - 0.5, b.z1 + 0.5)
  }
  ctx.globalCompositeOperation = 'source-over'

  // 邊緣收回中間值：地圖外面是夾住邊緣那一排像素，不收的話會拉出一條條的色帶
  const edge = 24
  const fade = (x0: number, z0: number, x1: number, z1: number, gx0: number, gz0: number, gx1: number, gz1: number) => {
    const g = ctx.createLinearGradient(gx0, gz0, gx1, gz1)
    g.addColorStop(0, 'rgba(128,128,128,1)')
    g.addColorStop(1, 'rgba(128,128,128,0)')
    ctx.fillStyle = g
    ctx.fillRect(x0, z0, x1 - x0, z1 - z0)
  }
  fade(-wx, -wz, -wx + edge, wz, -wx + 2, 0, -wx + edge, 0)
  fade(wx - edge, -wz, wx, wz, wx - 2, 0, wx - edge, 0)
  fade(-wx, -wz, wx, -wz + edge, 0, -wz + 2, 0, -wz + edge)
  fade(-wx, wz - edge, wx, wz, 0, wz - 2, 0, wz - edge)
  return canvas
}

type Options = {
  /** 手機、平板：貼圖解析度砍半、陰影只畫一次 */
  mobile: boolean
}

export class World {
  readonly scene = new Scene()
  private readonly renderer: WebGLRenderer
  private readonly disposables: { dispose(): void }[] = []
  private readonly barriers: ShaderMaterial[] = []
  private readonly sky = new Sky()
  private readonly tex: WorldTextures
  private readonly env: WebGLRenderTarget
  private readonly macro: Texture
  private readonly clock = { value: 0 }
  private readonly beacon: MeshBasicMaterial
  /** 這個場景自己的東西（大樓、地面…）：只畫一次的陰影只算它們，不算之後加進來的機甲 */
  private readonly statics = new Set<Object3D>()
  private readonly mobile: boolean
  private sunDynamic: SunLight | null = null
  private sunStatic: DirectionalLight | null = null
  private mode: ShadowMode

  constructor(map: MapData, renderer: WebGLRenderer, opt: Options) {
    this.renderer = renderer
    this.mobile = opt.mobile
    this.mode = opt.mobile ? 'static' : 'dynamic'
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = PCFShadowMap
    setAnisotropy(renderer.capabilities.getMaxAnisotropy())

    const scene = this.scene
    scene.background = new Color(HORIZON)
    scene.fog = new FogExp2(HORIZON, 0.00155)
    scene.add(this.sky.mesh)
    this.env = this.sky.environment(renderer)
    scene.environment = this.env.texture
    scene.environmentIntensity = 0.6

    // 天空和地面反射上來的補光（陰影裡不會全黑）
    const hemi = new HemisphereLight(0xc6d8ee, 0x6f6a62, 0.95)
    scene.add(hemi)

    this.tex = createTextures(opt.mobile)
    this.macro = dataTexture(macroCanvas(map))
    this.beacon = new MeshBasicMaterial({ color: 0xff3b30 })
    this.disposables.push(this.macro, this.beacon)

    this.addGround(map)
    this.addRiver()
    this.addMarkings(map)
    this.addBuildings(map)
    this.addProps(map)
    this.addBridges(map)
    this.addTrees(map)
    this.addLights(map)
    for (const team of [0, 1] as Team[]) this.addBase(team, map.spawns[team])
    for (const o of scene.children) this.statics.add(o)
    this.applyShadows(map)
  }

  /** 機甲有沒有真的影子（有的話腳下的圓影子就不用畫） */
  get realShadows(): boolean {
    return this.mode === 'dynamic'
  }

  /** 用貼圖的各層做一個材質 */
  private mat(s: Surface, o: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    const m = new MeshStandardMaterial({
      map: s.map,
      normalMap: s.normalMap,
      roughnessMap: s.ormMap,
      metalnessMap: s.ormMap,
      emissiveMap: s.emissiveMap,
      vertexColors: true,
      roughness: s.ormMap ? 1 : 0.9,
      metalness: s.ormMap ? 1 : 0,
      ...o,
    })
    if (s.emissiveMap && !o.emissive) m.emissive.setHex(0xffffff)
    return m
  }

  private add(geo: BufferGeometry, mat: Material, cast = true, receive = true): Mesh {
    const mesh = new Mesh(geo, mat)
    mesh.castShadow = cast
    mesh.receiveShadow = receive
    this.scene.add(mesh)
    this.disposables.push(geo, mat)
    return mesh
  }

  /** 照現在的模式放太陽：會動的串接陰影，或整張地圖只畫一次的陰影 */
  private applyShadows(map?: MapData) {
    if (this.mode === 'dynamic') {
      if (this.sunStatic) this.scene.remove(this.sunStatic)
      if (!this.sunDynamic) {
        const sun = new SunLight(SUN_COLOR, SUN_POWER)
        sun.position.copy(SUN_DIR)
        sun.castShadow = true
        sun.shadow.mapSize.set(2048, 2048)
        // 鏡頭前面多遠以內有陰影（再遠的被霧蓋掉大半了）
        sun.shadow.camera.far = 560
        sun.shadow.bias = -0.0004
        sun.shadow.normalBias = 0.32
        sun.shadow.radius = 2
        this.sunDynamic = sun
        this.disposables.push(sun)
      }
      this.scene.add(this.sunDynamic)
      this.statics.add(this.sunDynamic)
      return
    }
    if (this.sunDynamic) this.scene.remove(this.sunDynamic)
    if (!this.sunStatic) {
      const sun = new DirectionalLight(SUN_COLOR, SUN_POWER)
      sun.position.copy(SUN_DIR).multiplyScalar(1200)
      sun.castShadow = true
      // 影子的鏡頭對準整張地圖：把地圖的八個角投到太陽看過來的平面上
      const z = SUN_DIR.clone()
      const x = new Vector3(0, 1, 0).cross(z).normalize()
      const y = z.clone().cross(x)
      const top = map ? Math.max(...map.boxes.map((b) => b.y1)) : 160
      const lo = new Vector3(Infinity, Infinity, Infinity)
      const hi = new Vector3(-Infinity, -Infinity, -Infinity)
      const p = new Vector3()
      for (const px of [-MAP_X - 6, MAP_X + 6]) {
        for (const py of [BED - 1, top + 2]) {
          for (const pz of [-MAP_Z - 6, MAP_Z + 6]) {
            p.set(px, py, pz)
            const q = new Vector3(p.dot(x), p.dot(y), p.dot(z))
            lo.min(q)
            hi.max(q)
          }
        }
      }
      const cam = sun.shadow.camera
      cam.left = lo.x
      cam.right = hi.x
      cam.bottom = lo.y
      cam.top = hi.y
      cam.near = 1200 - hi.z - 4
      cam.far = 1200 - lo.z + 4
      cam.updateProjectionMatrix()
      const size = this.mobile ? 2048 : 4096
      sun.shadow.mapSize.set(size, size)
      sun.shadow.bias = -0.0005
      sun.shadow.normalBias = this.mobile ? 0.8 : 0.45
      sun.shadow.radius = 2
      sun.shadow.autoUpdate = false
      this.sunStatic = sun
      this.disposables.push(sun)
    }
    this.scene.add(this.sunStatic, this.sunStatic.target)
    this.statics.add(this.sunStatic)
    this.statics.add(this.sunStatic.target)
    this.bake()
  }

  /** 整張地圖的陰影畫一次：先把不是場景自己的東西（機甲、特效）藏起來，免得它們的影子留在地上 */
  private bake() {
    const sun = this.sunStatic
    if (!sun) return
    const hidden: Object3D[] = []
    for (const o of this.scene.children) {
      if (this.statics.has(o) || !o.visible) continue
      o.visible = false
      hidden.push(o)
    }
    sun.shadow.needsUpdate = true
    const target = new WebGLRenderTarget(1, 1)
    const cam = new PerspectiveCamera(50, 1, 1, 10)
    cam.position.set(0, -500, 0)
    cam.updateMatrixWorld()
    const before = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, cam)
    this.renderer.setRenderTarget(before)
    target.dispose()
    for (const o of hidden) o.visible = true
  }

  /**
   * 畫面跟不上時叫這個：把會動的陰影換成只畫一次的。
   * 回傳有沒有省到東西（已經是最省的就回傳 false，呼叫的人再去降解析度）
   */
  cheaper(): boolean {
    if (this.mode !== 'dynamic') return false
    this.mode = 'static'
    this.applyShadows()
    return true
  }

  /** 河兩岸的柏油地面、各區塊的地面（人行道墊高一點，有路緣） */
  private addGround(map: MapData) {
    const t = this.tex
    const land = new Mesher()
    land.top(-FAR, -RIVER, -FAR, FAR, 0, 16, white)
    land.top(RIVER, FAR, -FAR, FAR, 0, 16, white)
    this.add(land.geometry(), withMacro(this.mat(t.asphalt, { roughness: 0.86 }), this.macro), false)

    const groups: Record<string, Mesher> = {}
    const get = (k: string) => (groups[k] ??= new Mesher())
    const curb = new Color(0x9c9890)
    const promenade = new Color(0xe8e0d0)
    for (const lot of map.lots) {
      const key =
        lot.kind === 'block' || lot.kind === 'promenade'
          ? 'pavers'
          : lot.kind === 'park'
            ? 'grass'
            : lot.kind === 'plaza'
              ? 'plaza'
              : lot.kind === 'site' || lot.kind === 'railyard'
                ? 'dirt'
                : 'concrete'
      const h = lot.kind === 'apron' || lot.kind === 'parking' || lot.kind === 'railyard' ? 0.06 : 0.18
      const m = get(key)
      const s = key === 'pavers' ? 4 : key === 'dirt' ? 6 : 8
      m.top(lot.x0, lot.x1, lot.z0, lot.z1, h, s, lot.kind === 'promenade' ? promenade : white)
      get('curb').walls(lot.x0, lot.x1, lot.z0, lot.z1, 0, h, 1, 1, 0, curb)
    }
    // 機庫裡的地板
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -MAP_X : BASE.x
      const x1 = s < 0 ? -BASE.x : MAP_X
      get('concrete').top(x0, x1, -BASE.z, BASE.z, 0.05, 8, hex(0xcfcfcf))
    }
    const mats: Record<string, Material> = {
      pavers: withMacro(this.mat(t.pavers, { roughness: 0.9 }), this.macro),
      grass: withMacro(this.mat(t.grass, { roughness: 1 }), this.macro),
      plaza: withMacro(this.mat(t.plaza, { roughness: 0.7 }), this.macro),
      dirt: withMacro(this.mat(t.dirt, { roughness: 1 }), this.macro),
      concrete: withMacro(this.mat(t.concrete, { roughness: 0.85 }), this.macro),
      curb: new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    }
    for (const [k, m] of Object.entries(groups)) this.add(m.geometry(), mats[k], false)
  }

  /** 河：泥巴河床、兩岸的石牆、半透明會流動的水面（一路延伸到地平線） */
  private addRiver() {
    const t = this.tex
    const bed = new Mesher()
    bed.top(-RIVER, RIVER, -FAR, FAR, BED, 8, hex(0x7d7668))
    this.add(bed.geometry(), withMacro(this.mat(t.dirt, { roughness: 1 }), this.macro), false)

    const wall = new Mesher()
    const h = -BED
    const len = (FAR * 2) / h
    // 西岸的牆面向東、東岸的面向西
    wall.face([-RIVER, BED, FAR, 0, 0], [-RIVER, BED, -FAR, len, 0], [-RIVER, 0, -FAR, len, 1], [-RIVER, 0, FAR, 0, 1], white)
    wall.face([RIVER, BED, -FAR, 0, 0], [RIVER, BED, FAR, len, 0], [RIVER, 0, FAR, len, 1], [RIVER, 0, -FAR, 0, 1], white)
    this.add(wall.geometry(), this.mat(t.stone, { roughness: 0.92 }))

    const water = new Mesher()
    water.top(-RIVER, RIVER, -FAR, FAR, WATER, 40, white)
    const mat = flowing(
      new MeshStandardMaterial({
        color: 0x40605c,
        normalMap: t.waterNormal,
        normalScale: new Vector2(0.14, 0.14),
        roughness: 0.08,
        metalness: 0.35,
        transparent: true,
        opacity: 0.84,
        depthWrite: false,
        envMap: this.env.texture,
        envMapIntensity: 1.1,
      }),
      this.clock,
    )
    const mesh = this.add(water.geometry(), mat, false)
    mesh.renderOrder = 1
  }

  /** 路面的標線：中間的線、路口前的停止線和斑馬線；大橋橋面的分隔線和邊線 */
  private addMarkings(map: MapData) {
    // 地面上的（跟著地面那一層髒污、焦痕變暗）和高架上的分開
    const m = new Mesher()
    const high = new Mesher()
    const yellow = new Color(0xd9b43a)
    const paint = new Color(0xdcdcd6)
    const y = 0.03
    const crossing = (road: MapData['roads'][number], v: number) =>
      map.roads.some((c) => crosses(road, c) && Math.abs(v - c.at) < c.w / 2 + 5.5)
    const flat = (x0: number, x1: number, z0: number, z1: number, c: Color, h = y) => (h > 1 ? high : m).top(x0, x1, z0, z1, h, 100, c)
    for (const road of map.roads) {
      const wide = road.w >= 18
      for (let a = road.a + 2; a < road.b - 2; a += 9) {
        // 大路是雙黃線（不斷），其他是白色虛線
        const b = wide ? Math.min(a + 9, road.b - 2) : a + 4.5
        if (crossing(road, a) || crossing(road, b)) continue
        if (wide) {
          for (const off of [-0.3, 0.3]) {
            if (road.axis === 'x') flat(a, b, road.at + off - 0.1, road.at + off + 0.1, yellow)
            else flat(road.at + off - 0.1, road.at + off + 0.1, a, b, yellow)
          }
        } else if (road.axis === 'x') flat(a, b, road.at - 0.12, road.at + 0.12, paint)
        else flat(road.at - 0.12, road.at + 0.12, a, b, paint)
      }
      // 大路每個方向再分兩線
      if (wide) {
        for (const off of [-road.w / 4, road.w / 4]) {
          for (let a = road.a + 2; a < road.b - 6; a += 12) {
            if (crossing(road, a) || crossing(road, a + 4)) continue
            if (road.axis === 'x') flat(a, a + 4, road.at + off - 0.1, road.at + off + 0.1, paint)
            else flat(road.at + off - 0.1, road.at + off + 0.1, a, a + 4, paint)
          }
        }
      }
    }
    // 斑馬線和停止線：路口有路的那幾邊
    for (const r of map.roads.filter((r) => r.axis === 'x')) {
      for (const c of map.roads.filter((c) => c.axis === 'z')) {
        if (!crosses(r, c)) continue
        const hw = c.w / 2
        const hz = r.w / 2
        for (const side of [-1, 1]) {
          // 南北向的街上、靠大道的那一邊
          const z = r.at + side * (hz + 2.5)
          if (z > c.a + 2 && z < c.b - 2) {
            for (let x = c.at - hw + 1; x < c.at + hw - 1; x += 1.4) flat(x, x + 0.7, z - 1.5, z + 1.5, paint)
            flat(c.at - hw + 0.6, c.at + hw - 0.6, z + side * 2.4 - 0.2, z + side * 2.4 + 0.2, paint)
          }
          // 大道上、靠街的那一邊
          const x = c.at + side * (hw + 2.5)
          if (x > r.a + 2 && x < r.b - 2) {
            for (let zz = r.at - hz + 1; zz < r.at + hz - 1; zz += 1.4) flat(x - 1.5, x + 1.5, zz, zz + 0.7, paint)
            flat(x + side * 2.4 - 0.2, x + side * 2.4 + 0.2, r.at - hz + 0.6, r.at + hz - 0.6, paint)
          }
        }
      }
    }
    // 高架的路面（大橋、快速道路）：兩邊的白線；只有一線道是中間的黃色虛線，多線道是雙黃線、車道中間的白色虛線
    for (const b of map.boxes) {
      if (b.kind !== 'deck' || !b.lanes) continue
      const top = b.y1 + 0.03
      const along = b.lanes === 'x'
      const c = along ? (b.z0 + b.z1) / 2 : (b.x0 + b.x1) / 2
      const half = (along ? b.z1 - b.z0 : b.x1 - b.x0) / 2
      const u0 = along ? b.x0 : b.z0
      const u1 = along ? b.x1 : b.z1
      /** 沿著路的一條線：v0～v1 是離中線多遠（橫向） */
      const line = (v0: number, v1: number, color: Color, dash: boolean) => {
        const seg = (a: number, e: number) => (along ? flat(a, e, c + v0, c + v1, color, top) : flat(c + v0, c + v1, a, e, color, top))
        if (!dash) seg(u0, u1)
        else for (let u = u0 + 1; u < u1 - 1; u += 9) seg(u, Math.min(u + 4.5, u1 - 1))
      }
      const per = Math.max(1, Math.floor((half - 1.7) / 4.5))
      if (per === 1) line(-0.15, 0.15, yellow, true)
      else {
        line(-0.45, -0.15, yellow, false)
        line(0.15, 0.45, yellow, false)
      }
      for (let k = 1; k < per; k++) {
        const v = 0.45 + ((half - 1.7 - 0.45) * k) / per
        line(v - 0.12, v + 0.12, paint, true)
        line(-v - 0.12, -v + 0.12, paint, true)
      }
      line(-half + 1.4, -half + 1.7, paint, false)
      line(half - 1.7, half - 1.4, paint, false)
    }
    // 調車場的鐵軌：兩條鋼軌、一根根枕木
    const steel = new Color(0x8b8f95)
    const sleeper = new Color(0x4a3a2a)
    for (const t of map.tracks) {
      for (let x = t.x0; x < t.x1 - 0.3; x += 1.6) flat(x, x + 0.35, t.z - 1.25, t.z + 1.25, sleeper, 0.07)
      flat(t.x0, t.x1, t.z - 0.82, t.z - 0.68, steel, 0.1)
      flat(t.x0, t.x1, t.z + 0.68, t.z + 0.82, steel, 0.1)
    }
    const offset = { vertexColors: true, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }
    this.add(m.geometry(), withMacro(new MeshStandardMaterial(offset), this.macro), false)
    if (!high.empty) this.add(high.geometry(), new MeshStandardMaterial(offset), false)
  }

  /**
   * 大樓：一樓是店面，上面照種類貼玻璃帷幕、辦公室、公寓或紅磚的外牆；店面上面一圈雨遮、屋頂上的水塔和冷氣、牆上的直式招牌；
   * 地圖外面再圍一圈遠景
   */
  private addBuildings(map: MapData) {
    const t = this.tex
    const shops = new Mesher()
    const styles = { glass: new Mesher(), office: new Mesher(), apartment: new Mesher(), brick: new Mesher() }
    const roof = new Mesher()
    const trim = new Mesher()
    const gear = new Mesher()
    const signs = new Mesher()
    const beacons = new Mesher()
    const ao = new Color()
    /** 這個點上面有沒有別的東西（大樓、高架）：招牌不要插進隔壁 */
    const tall = map.boxes.filter((b) => b.y1 > 5 && b.kind !== 'land' && b.kind !== 'tree')
    const taken = (x: number, z: number, self: Box) => tall.some((b) => b !== self && x > b.x0 - 0.4 && x < b.x1 + 0.4 && z > b.z0 - 0.4 && z < b.z1 + 0.4)

    for (const b of map.boxes) {
      if (b.kind === 'facade') {
        // 走得進去的大樓的牆：西岸的是紅磚廠房，東岸的是玻璃帷幕（窗戶照樓層高度對齊）
        const west = b.x1 <= 0
        const tint = west ? new Color().setHSL(0.03, 0.18, 0.86) : new Color().setHSL(0.57, 0.1, 0.9)
        ;(west ? styles.brick : styles.glass).walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, CELL_W, CELL_H, b.y0 / CELL_H, tint)
        roof.top(b.x0, b.x1, b.z0, b.z1, b.y1, 8, tint.clone().multiplyScalar(0.85))
        continue
      }
      if (b.kind !== 'building' && b.kind !== 'tower' && b.kind !== 'house') continue
      const r = rng(b.seed * 7919)
      const style =
        b.kind === 'tower'
          ? r() < 0.75
            ? 'glass'
            : 'office'
          : b.kind === 'house'
            ? r() < 0.55
              ? 'brick'
              : 'apartment'
            : r() < 0.55
              ? 'apartment'
              : 'office'
      const tint =
        style === 'brick' ? new Color().setHSL(r() * 0.08, r() * 0.25, 0.78 + r() * 0.22) : new Color().setHSL(r() * 0.12 + 0.05, r() * 0.15, 0.82 + r() * 0.18)
      const m = styles[style]
      // 貼圖位移整數格：看起來一樣，但每棟樓的窗戶各有各的開燈
      const shift = Math.floor(r() * 64)
      const w = b.x1 - b.x0
      const d = b.z1 - b.z0
      const h = b.y1 - b.y0
      if (b.y0 === 0) {
        // 一樓店面，底下暗一點
        ao.copy(tint).multiplyScalar(0.55)
        shops.walls(b.x0, b.x1, b.z0, b.z1, 0, SHOP_H, SHOP_W, SHOP_H, 0, ao.clone(), tint)
        m.walls(b.x0, b.x1, b.z0, b.z1, SHOP_H, b.y1, CELL_W, CELL_H, shift, tint)
        // 店面上面一圈雨遮
        const c = tint.clone().multiplyScalar(0.7)
        trim.box(b.x0 - 0.5, b.x1 + 0.5, b.z0 - 0.5, b.z1 + 0.5, SHOP_H - 0.1, SHOP_H + 0.3, 4, c)
        trim.bottom(b.x0 - 0.5, b.x1 + 0.5, b.z0 - 0.5, b.z1 + 0.5, SHOP_H - 0.1, 4, c.clone().multiplyScalar(0.7))
      } else {
        m.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, CELL_W, CELL_H, shift, tint)
      }
      roof.top(b.x0, b.x1, b.z0, b.z1, b.y1, 8, white)
      // 屋頂邊緣的女兒牆（牆頂是壓頂的水泥）
      const cap = tint.clone().multiplyScalar(0.8)
      trim.walls(b.x0, b.x1, b.z0, b.z1, b.y1, b.y1 + 1.2, 4, 4, 0, cap)
      trim.walls(b.x1 - 0.4, b.x0 + 0.4, b.z1 - 0.4, b.z0 + 0.4, b.y1, b.y1 + 1.2, 4, 4, 0, cap.clone().multiplyScalar(0.8))
      for (const [x0, x1, z0, z1] of [
        [b.x0, b.x1, b.z0, b.z0 + 0.4],
        [b.x0, b.x1, b.z1 - 0.4, b.z1],
        [b.x0, b.x0 + 0.4, b.z0, b.z1],
        [b.x1 - 0.4, b.x1, b.z0, b.z1],
      ]) {
        trim.top(x0, x1, z0, z1, b.y1 + 1.2, 4, cap)
      }

      // 屋頂的設備：機甲跳不上去的高樓才放（只是畫面，不擋東西）
      if (b.y1 >= 16 && w >= 9 && d >= 9) {
        const n = 1 + Math.floor(r() * Math.min(5, (w * d) / 90))
        for (let k = 0; k < n; k++) {
          const px = b.x0 + 2.5 + r() * (w - 5)
          const pz = b.z0 + 2.5 + r() * (d - 5)
          const roll = r()
          if (roll < 0.3) {
            // 樓梯間
            const sw = Math.min(2.2, w / 4)
            trim.box(px - sw, px + sw, pz - 1.6, pz + 1.6, b.y1, b.y1 + 3, 4, tint.clone().multiplyScalar(0.9), tint)
          } else if (roll < 0.62) {
            // 不鏽鋼水塔：四支腳、一個桶
            for (const [ox, oz] of [
              [-0.8, -0.8],
              [0.8, -0.8],
              [-0.8, 0.8],
              [0.8, 0.8],
            ]) {
              gear.box(px + ox - 0.08, px + ox + 0.08, pz + oz - 0.08, pz + oz + 0.08, b.y1, b.y1 + 1.1, 2, hex(0x4a4d52))
            }
            gear.prism(px, pz, 1.05, b.y1 + 1.1, b.y1 + 3.2, 8, hex(0xc9ced4), hex(0xe6eaee))
          } else if (roll < 0.9) {
            // 冷氣主機
            const aw = 1 + r() * 1.2
            gear.box(px - aw, px + aw, pz - 0.7, pz + 0.7, b.y1 + 0.2, b.y1 + 1.5, 2.6, hex(0xa9adb1), hex(0xc2c5c8))
          } else {
            // 天線
            gear.box(px - 0.09, px + 0.09, pz - 0.09, pz + 0.09, b.y1, b.y1 + 6 + r() * 5, 2, hex(0x5b5f64))
          }
        }
      }
      // 高樓頂上的機房和航空警示燈
      if (b.kind === 'tower' && h > 40 && w > 14 && d > 14) {
        const ix = w * 0.22
        const iz = d * 0.22
        gear.box(b.x0 + ix, b.x1 - ix, b.z0 + iz, b.z1 - iz, b.y1, b.y1 + 4.5, 3, hex(0x565b61), hex(0x70757b))
        const cx = (b.x0 + b.x1) / 2
        const cz = (b.z0 + b.z1) / 2
        gear.box(cx - 0.12, cx + 0.12, cz - 0.12, cz + 0.12, b.y1 + 4.5, b.y1 + 9, 2, hex(0x5b5f64))
        beacons.box(cx - 0.3, cx + 0.3, cz - 0.3, cz + 0.3, b.y1 + 9, b.y1 + 9.6, 1, white)
      }

      // 直式招牌：老街屋、公寓的牆上，掛在機甲頭頂以上
      if (b.y0 === 0 && b.kind !== 'tower' && b.y1 >= 13) {
        const faces: [number, number, number, number, number, number][] = [
          // [起點 x, z, 沿著牆的方向 x, z, 往外的方向 x, z]
          [b.x0, b.z1, 1, 0, 0, 1],
          [b.x1, b.z0, -1, 0, 0, -1],
          [b.x1, b.z1, 0, -1, 1, 0],
          [b.x0, b.z0, 0, 1, -1, 0],
        ]
        for (const [sx, sz, ax, az, nx, nz] of faces) {
          const len = ax !== 0 ? w : d
          for (let u = 3 + r() * 8; u < len - 2; u += 9 + r() * 12) {
            const px = sx + ax * u
            const pz = sz + az * u
            if (r() < 0.35 || taken(px + nx * 1.1, pz + nz * 1.1, b) || taken(px + nx * 2, pz + nz * 2, b)) continue
            const y0 = 6.9 + r() * 1.5
            const sh = Math.min(4.8, b.y1 - y0 - 0.5)
            signs.sign(px + nx * 0.15, y0, pz + nz * 0.15, nx, nz, 1.2, sh, Math.floor(r() * SIGN_COUNT))
          }
        }
      }
    }

    // 遠景：地圖外面一圈大樓，不會走到那裡（河道留著）。用便宜的材質、不算陰影
    const far = { glass: new Mesher(), office: new Mesher() }
    const farRoof = new Mesher()
    const r = rng(777)
    for (let k = 0; k < 160; k++) {
      const a = (k / 160) * Math.PI * 2 + r() * 0.03
      const dist = 330 + r() * 280
      const cx = Math.cos(a) * dist * 1.35
      const cz = Math.sin(a) * dist
      if (Math.abs(cx) < MAP_X + 30 && Math.abs(cz) < MAP_Z + 30) continue
      const w = 20 + r() * 30
      const d = 20 + r() * 30
      if (Math.abs(cx) < RIVER + w / 2 + 20) continue
      const h = 30 + r() * (dist < 450 ? 90 : 160)
      const tint = new Color().setHSL(0.58, 0.05, 0.75 + r() * 0.2)
      const style = r() < 0.5 ? far.glass : far.office
      style.walls(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, 0, h, CELL_W, CELL_H, Math.floor(r() * 64), tint.clone().multiplyScalar(0.6), tint)
      farRoof.top(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, h, 8, tint)
      if (h > 110) beacons.box(cx - 0.6, cx + 0.6, cz - 0.6, cz + 0.6, h, h + 1.2, 1, white)
    }

    const facade = (s: Surface, share: number, o: MeshStandardMaterialParameters = {}) => litWindows(this.mat(s, { emissiveIntensity: 0.8, ...o }), share)
    this.add(shops.geometry(), this.mat(t.shops, { emissiveIntensity: 0.5 }))
    this.add(styles.glass.geometry(), facade(t.glass, 0.1, { envMap: this.env.texture, envMapIntensity: 1.25, normalScale: new Vector2(0.6, 0.6) }))
    this.add(styles.office.geometry(), facade(t.office, 0.16))
    this.add(styles.apartment.geometry(), facade(t.apartment, 0.2))
    if (!styles.brick.empty) this.add(styles.brick.geometry(), facade(t.brick, 0.16))
    this.add(roof.geometry(), this.mat(t.roof, { roughness: 0.95 }))
    this.add(trim.geometry(), this.mat(t.concrete, { roughness: 0.9 }))
    this.add(gear.geometry(), this.mat(t.corrugated, { roughness: 0.45, metalness: 0.7 }))
    if (!signs.empty) {
      this.add(signs.geometry(), new MeshStandardMaterial({ map: t.signs.map, emissive: 0xffffff, emissiveMap: t.signs.emissiveMap, emissiveIntensity: 0.55, roughness: 0.5 }))
    }
    this.add(beacons.geometry(), this.beacon, false, false)
    // 遠景的窗戶貼圖直接用（不用法線、反光），燈光也照貼圖發亮
    const farMat = (s: Surface) => litWindows(new MeshLambertMaterial({ map: s.map, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.3, emissiveMap: s.emissiveMap }) as unknown as MeshStandardMaterial, 0.14)
    this.add(far.glass.geometry(), farMat(t.glass), false, false)
    this.add(far.office.geometry(), farMat(t.office), false, false)
    this.add(farRoof.geometry(), new MeshLambertMaterial({ vertexColors: true, color: 0x8a8a88 }), false, false)
  }

  /** 貨櫃、倉庫、車、公車、混凝土牆、花台、噴水池、工地的柱子、碼頭吊架、河裡的駁船和水泥塊、機庫的牆 */
  private addProps(map: MapData) {
    const t = this.tex
    const metal = new Mesher()
    const blast = new Mesher()
    const plain = new Mesher()
    const paint = new Mesher()
    const glass = new Mesher()
    const green = new Mesher()
    const stone = new Mesher()
    const lamps = new Mesher()
    const containerColors = [0xb4412f, 0x2f5f8f, 0x2f7d4f, 0xc97a1e, 0x8b8f94, 0x6b3f8f, 0xd9c23a]
    const carColors = [0xe8e8e8, 0x2b2b2e, 0xb91c1c, 0x2563eb, 0x9aa1a8, 0x6b7280, 0x0f766e, 0xd6c7a1]
    const shedColors = [0xa9adb1, 0x8d969a, 0xa7765a, 0x7b8f84]
    const railColors = [0x7a3b2e, 0x3f5f4a, 0x2f4f7a, 0x8a8f94, 0xb8862f, 0x5b4636]
    const tyre = hex(0x17181a)
    const window = hex(0x1c2630)
    for (const b of map.boxes) {
      const r = rng(b.seed * 104729)
      const y = b.y0
      const long = b.x1 - b.x0 > b.z1 - b.z0
      switch (b.kind) {
        case 'container': {
          const c = hex(containerColors[Math.floor(r() * containerColors.length)])
          metal.box(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 2.6, c.clone().multiplyScalar(0.82), c)
          break
        }
        case 'railcar': {
          // 車廂：下面黑色的底盤和輪子，上面照顏色的車身，頂上亮一點
          const c = hex(railColors[Math.floor(r() * railColors.length)])
          plain.box(b.x0 + 1.2, b.x1 - 1.2, b.z0 + 0.3, b.z1 - 0.3, y, y + 1.1, 4, hex(0x26282b))
          metal.box(b.x0, b.x1, b.z0, b.z1, y + 1.1, b.y1, 4.4, c.clone().multiplyScalar(0.8), c.clone().multiplyScalar(1.15))
          break
        }
        case 'mound':
          // 墊高的公園：石砌的擋土牆、上面是草地
          stone.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 8, 8, 0, white)
          green.top(b.x0, b.x1, b.z0, b.z1, b.y1, 8, white)
          break
        case 'warehouse': {
          const c = hex(shedColors[Math.floor(r() * shedColors.length)])
          metal.walls(b.x0, b.x1, b.z0, b.z1, 0, b.y1, 6, 6, 0, c.clone().multiplyScalar(0.7), c)
          metal.top(b.x0, b.x1, b.z0, b.z1, b.y1, 6, c.clone().multiplyScalar(0.75))
          // 屋脊的通風器
          const cx = (b.x0 + b.x1) / 2
          const cz = (b.z0 + b.z1) / 2
          if (long) metal.box(b.x0 + 2, b.x1 - 2, cz - 0.8, cz + 0.8, b.y1, b.y1 + 0.9, 3, c.clone().multiplyScalar(0.6))
          else metal.box(cx - 0.8, cx + 0.8, b.z0 + 2, b.z1 - 2, b.y1, b.y1 + 0.9, 3, c.clone().multiplyScalar(0.6))
          break
        }
        case 'hangar': {
          // 機庫的牆：灰色浪板，上面一條隊伍顏色的帶子
          const team: Team = b.x0 < 0 ? 0 : 1
          metal.box(b.x0, b.x1, b.z0, b.z1, 0, b.y1 - 3, 6, hex(0x7d8389), hex(0x9aa0a6))
          metal.box(b.x0, b.x1, b.z0, b.z1, b.y1 - 3, b.y1, 6, hex(TEAMS[team].armor))
          break
        }
        case 'car': {
          const body = hex(carColors[Math.floor(r() * carColors.length)])
          paint.box(b.x0, b.x1, b.z0, b.z1, y + 0.3, y + 0.98, 4, body.clone().multiplyScalar(0.85), body)
          const ix = long ? (b.x1 - b.x0) * 0.22 : 0.15
          const iz = long ? 0.15 : (b.z1 - b.z0) * 0.22
          glass.walls(b.x0 + ix, b.x1 - ix, b.z0 + iz, b.z1 - iz, y + 0.98, b.y1 - 0.06, 4, 4, 0, window)
          paint.box(b.x0 + ix - 0.02, b.x1 - ix + 0.02, b.z0 + iz - 0.02, b.z1 - iz + 0.02, b.y1 - 0.06, b.y1, 4, body)
          // 四個輪子
          for (const fu of [0.2, 0.8]) {
            for (const side of [0, 1]) {
              const wx = long ? b.x0 + (b.x1 - b.x0) * fu : side ? b.x1 - 0.22 : b.x0 - 0.03
              const wz = long ? (side ? b.z1 - 0.22 : b.z0 - 0.03) : b.z0 + (b.z1 - b.z0) * fu
              if (long) plain.box(wx - 0.34, wx + 0.34, wz, wz + 0.25, y, y + 0.68, 2, tyre)
              else plain.box(wx, wx + 0.25, wz - 0.34, wz + 0.34, y, y + 0.68, 2, tyre)
            }
          }
          // 車燈
          const fy = y + 0.62
          if (long) {
            lamps.box(b.x1 - 0.02, b.x1 + 0.03, b.z0 + 0.15, b.z0 + 0.5, fy, fy + 0.18, 1, hex(0xfff2cc))
            lamps.box(b.x1 - 0.02, b.x1 + 0.03, b.z1 - 0.5, b.z1 - 0.15, fy, fy + 0.18, 1, hex(0xfff2cc))
            lamps.box(b.x0 - 0.03, b.x0 + 0.02, b.z0 + 0.15, b.z0 + 0.5, fy, fy + 0.18, 1, hex(0xd0201a))
            lamps.box(b.x0 - 0.03, b.x0 + 0.02, b.z1 - 0.5, b.z1 - 0.15, fy, fy + 0.18, 1, hex(0xd0201a))
          } else {
            lamps.box(b.x0 + 0.15, b.x0 + 0.5, b.z1 - 0.02, b.z1 + 0.03, fy, fy + 0.18, 1, hex(0xfff2cc))
            lamps.box(b.x1 - 0.5, b.x1 - 0.15, b.z1 - 0.02, b.z1 + 0.03, fy, fy + 0.18, 1, hex(0xfff2cc))
            lamps.box(b.x0 + 0.15, b.x0 + 0.5, b.z0 - 0.03, b.z0 + 0.02, fy, fy + 0.18, 1, hex(0xd0201a))
            lamps.box(b.x1 - 0.5, b.x1 - 0.15, b.z0 - 0.03, b.z0 + 0.02, fy, fy + 0.18, 1, hex(0xd0201a))
          }
          break
        }
        case 'bus': {
          const body = hex(r() < 0.5 ? 0x2f7d4f : 0xd97706)
          paint.box(b.x0, b.x1, b.z0, b.z1, y + 0.35, y + 1.4, 4, body.clone().multiplyScalar(0.85), body)
          glass.walls(b.x0 + 0.03, b.x1 - 0.03, b.z0 + 0.03, b.z1 - 0.03, y + 1.4, y + 2.6, 4, 4, 0, window)
          paint.box(b.x0, b.x1, b.z0, b.z1, y + 2.6, b.y1, 4, body, hex(0xe6e6e2))
          plain.box(b.x0 + 0.4, b.x1 - 0.4, b.z0 + 0.2, b.z1 - 0.2, y, y + 0.35, 4, tyre)
          break
        }
        case 'barrier':
          plain.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 2, hex(0xa9a69f), hex(0xc9c6bf))
          break
        case 'twall':
          blast.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 4.2, white)
          break
        case 'pillar':
          // 高的是碼頭的吊架（黃色鋼架），矮的是工地的柱子
          if (b.y1 >= 26) paint.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 4, hex(0xb8861a), hex(0xd9a521))
          else plain.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 6, hex(0xb8b4ac), hex(0xd8d4cc))
          break
        case 'planter':
          plain.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 2, hex(0xb9b4a8), hex(0xd9d4c8))
          green.top(b.x0 + 0.3, b.x1 - 0.3, b.z0 + 0.3, b.z1 - 0.3, b.y1 + 0.02, 3, white)
          break
        case 'monument':
          plain.box(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 4, hex(b.y0 === 0 ? 0xb8ad98 : 0xcfc6b4))
          break
        case 'kiosk':
          plain.box(b.x0 + 0.6, b.x1 - 0.6, b.z0 + 0.6, b.z1 - 0.6, y, b.y1 - 0.4, 3, hex(0x8b6b4a))
          paint.box(b.x0, b.x1, b.z0, b.z1, b.y1 - 0.4, b.y1, 3, hex(0x7a2e22))
          paint.bottom(b.x0, b.x1, b.z0, b.z1, b.y1 - 0.4, 3, hex(0x5a2018))
          break
        case 'crate':
          plain.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 2, hex(r() < 0.5 ? 0x9a7b4f : 0x6b7280))
          break
        case 'rubble':
          plain.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 3, hex(0x6f6c66), hex(0x8d8a83))
          break
        case 'barge':
          // 船身生鏽的紅褐色、上面的駕駛艙灰白色
          metal.box(b.x0, b.x1, b.z0, b.z1, y, b.y1, 4, hex(y <= BED ? 0x6e3524 : 0xd6d1c7))
          break
        default:
          break
      }
    }
    this.add(metal.geometry(), this.mat(t.corrugated, { roughness: 0.55, metalness: 0.55 }))
    this.add(blast.geometry(), this.mat(t.blast, { roughness: 0.9 }))
    this.add(plain.geometry(), this.mat(t.concrete, { roughness: 0.85 }))
    if (!paint.empty) this.add(paint.geometry(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.45 }))
    if (!glass.empty) {
      this.add(glass.geometry(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.9, envMap: this.env.texture, envMapIntensity: 1.4 }))
    }
    if (!lamps.empty) this.add(lamps.geometry(), new MeshBasicMaterial({ vertexColors: true }), false, false)
    if (!green.empty) this.add(green.geometry(), this.mat(t.grass, { roughness: 1 }))
    if (!stone.empty) this.add(stone.geometry(), this.mat(t.stone, { roughness: 0.92 }))
  }

  /**
   * 橋：大橋、快速道路的橋面、坡道和交流道、護欄、橋墩、橋塔和斜張的鋼纜；人行鋼橋、鋼桁架；下河的坡道。
   * 走得進去的大樓的樓板、柱子、矮牆也在這裡（和橋一樣是水泥）
   */
  private addBridges(map: MapData) {
    const t = this.tex
    const road = new Mesher()
    const concrete = new Mesher()
    const steel = new Mesher()
    const slab = new Mesher()
    const beacons = new Mesher()
    const warm = new Color(0xe4dccd)
    const cool = new Color(0xd4d8dc)
    /** 樓板底下（天花板）：朝下的面只照得到地面反射的光，另外給一點自己的亮度（像開著燈）才不會一片黑 */
    const under = new Mesher()
    const light = new Color(0xc9c5bd)
    const dark = new Color(0x8f8b83)
    const steelC = new Color(0x4d6a80)
    const plate = new Color(0x8a8e93)
    for (const b of map.boxes) {
      switch (b.kind) {
        case 'deck':
          // 高架的路面（大橋、快速道路、橋頭平台、停車場屋頂）、南邊的公路橋：水泥橋身、柏油路面
          if (b.y1 > 2 || Math.abs((b.z0 + b.z1) / 2 - AVENUE_Z) < 0.5) {
            concrete.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 4, 4, 0, dark, light)
            concrete.bottom(b.x0, b.x1, b.z0, b.z1, b.y0, 4, dark)
            road.top(b.x0, b.x1, b.z0, b.z1, b.y1, 16, white)
          } else {
            // 人行鋼橋：藍灰色的鋼樑、灰色的鋪板
            steel.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 4, 4, 0, steelC)
            steel.bottom(b.x0, b.x1, b.z0, b.z1, b.y0, 4, steelC)
            steel.top(b.x0, b.x1, b.z0, b.z1, b.y1, 3, plate)
          }
          break
        case 'ramp':
          // 坡道、交流道的平台：水泥的側面、柏油路面
          concrete.solid(b, 4, dark, light, false)
          road.slopeTop(b, 16, white)
          break
        case 'slipway':
          // 下河的坡道、公園的步道：整塊水泥
          concrete.solid(b, 4, dark, light)
          break
        case 'parapet':
          concrete.solid(b, 3, light)
          break
        case 'pier':
          concrete.solid(b, 4, dark, light)
          break
        case 'pylon':
          concrete.solid(b, 6, hex(0xb9b5ad), hex(0xd8d4cc))
          if (b.y0 > BED) concrete.bottom(b.x0, b.x1, b.z0, b.z1, b.y0, 6, dark)
          // 橋塔頂上的航空警示燈
          if (b.y1 > 40 && b.x1 - b.x0 < 8 && b.z1 - b.z0 < 8) {
            const cx = (b.x0 + b.x1) / 2
            const cz = (b.z0 + b.z1) / 2
            beacons.box(cx - 0.35, cx + 0.35, cz - 0.35, cz + 0.35, b.y1, b.y1 + 0.7, 1, white)
          }
          break
        case 'rail':
          steel.solid(b, 2, steelC)
          break
        case 'floor':
          // 大樓的樓板：水泥的邊和底，上面是打磨過的水泥地（西岸的偏暖、東岸的偏冷）
          concrete.walls(b.x0, b.x1, b.z0, b.z1, b.y0, b.y1, 4, 4, 0, dark, light)
          under.bottom(b.x0, b.x1, b.z0, b.z1, b.y0, 4, white)
          slab.top(b.x0, b.x1, b.z0, b.z1, b.y1, 8, b.x1 <= 0 ? warm : cool)
          break
        case 'column':
          concrete.solid(b, 4, dark, light)
          break
        case 'sill':
          concrete.solid(b, 3, light)
          break
        default:
          break
      }
    }
    // 斜張橋的鋼纜：從橋面兩邊外面的兩根塔柱拉到東西兩邊的橋面護欄（大橋的橋塔在正中間）
    const cables = new Mesher()
    const cableC = new Color(0x3d434a)
    const deckY = map.boxes.find((b) => b.kind === 'deck' && b.lanes && b.x0 < 0 && b.x1 > 0 && b.z0 < 0 && b.z1 > 0)?.y1 ?? 8
    for (const side of [-1, 1]) {
      for (const dir of [-1, 1]) {
        for (let k = 0; k < 9; k++) {
          cables.cable(dir * 2.5, 32 + k * 2.4, side * (BRIDGE_W + 2.4), dir * (12 + k * 6.2), deckY + 1.2, side * (BRIDGE_W - 0.3), 0.24, cableC)
        }
      }
    }
    this.add(road.geometry(), this.mat(t.asphalt, { roughness: 0.86 }))
    this.add(concrete.geometry(), this.mat(t.concrete, { roughness: 0.85 }))
    this.add(steel.geometry(), this.mat(t.corrugated, { roughness: 0.45, metalness: 0.65 }))
    if (!slab.empty) this.add(slab.geometry(), this.mat(t.concrete, { roughness: 0.55 }))
    if (!under.empty) {
      this.add(under.geometry(), new MeshStandardMaterial({ color: 0xb4b0a8, normalMap: t.concrete.normalMap, roughness: 0.9, emissive: 0x3d3b36 }), false)
    }
    this.add(cables.geometry(), new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.5, metalness: 0.6 }), false, false)
    if (!beacons.empty) this.add(beacons.geometry(), this.beacon, false, false)
  }

  /** 樹：樹幹加上幾團高高低低的樹葉（底下暗、頂上亮） */
  private addTrees(map: MapData) {
    const trees = map.boxes.filter((b) => b.kind === 'tree')
    // 大馬路兩旁的行道樹（只是裝飾，不擋東西）
    const deco: { x: number; y: number; z: number; s: number }[] = []
    for (const lot of map.lots) {
      if (lot.kind !== 'block') continue
      for (let x = lot.x0 + 6; x < lot.x1 - 4; x += 14) {
        deco.push({ x, y: 0, z: lot.z0 + 1.4, s: 0.8 }, { x, y: 0, z: lot.z1 - 1.4, s: 0.8 })
      }
    }
    const all = [...trees.map((b) => ({ x: (b.x0 + b.x1) / 2, y: b.y0, z: (b.z0 + b.z1) / 2, s: 1 })), ...deco]
    const trunkGeo = new CylinderGeometry(0.2, 0.36, 4.4, 6)
    trunkGeo.translate(0, 2.2, 0)
    // 樹葉：三團錯開的球，頂點照高度上色
    const r = rng(4242)
    const blobs = [
      [0, 5.6, 0, 2.5],
      [1.3, 4.9, 0.5, 1.7],
      [-1.1, 5.1, -0.9, 1.8],
      [0.2, 7, -0.3, 1.5],
    ].map(([x, y, z, s]) => {
      const g = new IcosahedronGeometry(s, 1)
      const p = g.attributes.position
      for (let i = 0; i < p.count; i++) {
        // 同一個位置的頂點（每個三角形各有一份）要推一樣遠，不然面和面中間會裂開
        const h = Math.sin(p.getX(i) * 12.9898 + p.getY(i) * 78.233 + p.getZ(i) * 37.719) * 43758.5453
        const k = 0.84 + (h - Math.floor(h)) * 0.32
        p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.86, p.getZ(i) * k)
      }
      g.translate(x, y, z)
      return g
    })
    const leafGeo = mergeGeometries(blobs)
    for (const g of blobs) g.dispose()
    leafGeo.computeVertexNormals()
    const lp = leafGeo.attributes.position
    const shade = new Float32Array(lp.count * 3)
    for (let i = 0; i < lp.count; i++) {
      const v = 0.5 + 0.5 * Math.min(1, Math.max(0, (lp.getY(i) - 3.6) / 4.4))
      shade[i * 3] = shade[i * 3 + 1] = shade[i * 3 + 2] = v
    }
    leafGeo.setAttribute('color', new BufferAttribute(shade, 3))
    const trunkMat = new MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 })
    const leafMat = new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, roughness: 0.95 })
    const trunks = new InstancedMesh(trunkGeo, trunkMat, all.length)
    const leaves = new InstancedMesh(leafGeo, leafMat, all.length)
    const o = new Object3D()
    const c = new Color()
    all.forEach((t, i) => {
      o.position.set(t.x, t.y, t.z)
      o.rotation.y = r() * Math.PI * 2
      const s = t.s * (0.85 + r() * 0.35)
      o.scale.set(s, s * (0.9 + r() * 0.25), s)
      o.updateMatrix()
      trunks.setMatrixAt(i, o.matrix)
      leaves.setMatrixAt(i, o.matrix)
      leaves.setColorAt(i, c.setHSL(0.22 + r() * 0.08, 0.38 + r() * 0.18, 0.3 + r() * 0.12))
    })
    for (const m of [trunks, leaves]) {
      m.castShadow = true
      m.receiveShadow = true
      // 一棵棵散在整張地圖上，照整張地圖算要不要畫
      m.frustumCulled = false
    }
    this.scene.add(trunks, leaves)
    this.disposables.push(trunkGeo, leafGeo, trunkMat, leafMat, trunks, leaves)
  }

  /** 路燈和紅綠燈（只是裝飾）：人行道、河濱步道、高架路面的護欄上；大路口的轉角 */
  private addLights(map: MapData) {
    const spots: { x: number; y: number; z: number; a: number }[] = []
    for (const lot of map.lots) {
      if (lot.kind === 'block') {
        for (let x = lot.x0 + 3; x < lot.x1 - 2; x += 24) {
          spots.push({ x, y: 0, z: lot.z0 + 0.6, a: Math.PI }, { x, y: 0, z: lot.z1 - 0.6, a: 0 })
        }
      } else if (lot.kind === 'promenade') {
        const west = lot.x0 < 0
        for (let z = lot.z0 + 12; z < lot.z1 - 4; z += 24) {
          spots.push({ x: west ? lot.x0 + 0.6 : lot.x1 - 0.6, y: 0, z, a: west ? Math.PI / 2 : -Math.PI / 2 })
        }
      }
    }
    // 高架的路（大橋、快速道路、停車場屋頂）：長的護欄上每隔一段一盞，燈頭朝路面那一邊（橋塔旁邊不放）
    const decks = map.boxes.filter((b) => b.kind === 'deck' && b.y1 > 2)
    const pylons = map.boxes.filter((b) => b.kind === 'pylon')
    const onDeck = (x: number, z: number, y: number) => decks.some((d) => x > d.x0 && x < d.x1 && z > d.z0 && z < d.z1 && Math.abs(d.y1 - y) < 0.5)
    for (const b of map.boxes) {
      if (b.kind !== 'parapet' || b.slope || b.y0 < 2) continue
      const alongX = b.x1 - b.x0 >= b.z1 - b.z0
      const len = alongX ? b.x1 - b.x0 : b.z1 - b.z0
      if (len < 24) continue
      const cx = (b.x0 + b.x1) / 2
      const cz = (b.z0 + b.z1) / 2
      for (let u = 9; u < len - 4; u += 18.5) {
        const x = alongX ? b.x0 + u : cx
        const z = alongX ? cz : b.z0 + u
        if (pylons.some((p) => x > p.x0 - 5 && x < p.x1 + 5 && z > p.z0 - 5 && z < p.z1 + 5)) continue
        const a = alongX ? (onDeck(x, z + 3, b.y0) ? 0 : Math.PI) : onDeck(x + 3, z, b.y0) ? Math.PI / 2 : -Math.PI / 2
        spots.push({ x, y: b.y1, z, a })
      }
    }
    const pole = new CylinderGeometry(0.1, 0.16, 8, 6)
    pole.translate(0, 4, 0)
    const arm = new CylinderGeometry(0.07, 0.07, 2.2, 5)
    arm.rotateX(Math.PI / 2)
    arm.translate(0, 7.9, 1)
    const head = new CylinderGeometry(0.22, 0.3, 0.18, 6)
    head.translate(0, 7.84, 2)
    const poleGeo = mergeGeometries([pole, arm, head])
    for (const g of [pole, arm, head]) g.dispose()
    // 燈罩底下亮著的那一面
    const bulbGeo = new CylinderGeometry(0.24, 0.24, 0.05, 6)
    bulbGeo.translate(0, 7.73, 2)
    const mat = new MeshStandardMaterial({ color: 0x3f444b, roughness: 0.5, metalness: 0.6 })
    const bulbMat = new MeshBasicMaterial({ color: 0xfff0c8 })
    const poles = new InstancedMesh(poleGeo, mat, spots.length)
    const bulbs = new InstancedMesh(bulbGeo, bulbMat, spots.length)
    const o = new Object3D()
    spots.forEach((s, i) => {
      o.position.set(s.x, s.y, s.z)
      o.rotation.y = s.a
      o.updateMatrix()
      poles.setMatrixAt(i, o.matrix)
      bulbs.setMatrixAt(i, o.matrix)
    })
    poles.castShadow = true
    poles.frustumCulled = false
    bulbs.frustumCulled = false
    this.scene.add(poles, bulbs)
    this.disposables.push(poleGeo, bulbGeo, mat, bulbMat, poles, bulbs)

    // 紅綠燈：兩條都夠寬的路交叉的地方，對角各一支，橫桿伸到路的上面（比機甲高）
    const frame = new Mesher()
    const lamps = new Mesher()
    const grey = hex(0x3a3f45)
    const box = hex(0x1d1f22)
    const colors = [hex(0xff3b30), hex(0xffc400), hex(0x2fd15c)]
    for (const r of map.roads.filter((r) => r.axis === 'x' && r.w >= 14)) {
      for (const c of map.roads.filter((c) => c.axis === 'z' && c.w >= 14)) {
        if (!crosses(r, c)) continue
        // T 字路口那一邊沒有路就不放
        if (c.at - c.w / 2 - 3 < r.a || c.at + c.w / 2 + 3 > r.b || r.at - r.w / 2 - 3 < c.a || r.at + r.w / 2 + 3 > c.b) continue
        const rr = rng(Math.round(r.at * 31 + c.at * 17) + 5000)
        for (const side of [-1, 1]) {
          const px = c.at + side * (c.w / 2 + 1)
          const pz = r.at + side * (r.w / 2 + 1)
          frame.box(px - 0.16, px + 0.16, pz - 0.16, pz + 0.16, 0.18, 8.2, 2, grey)
          // 橫桿沿著 z 伸到東西向那條路的上面
          const reach = Math.min(6.5, r.w / 2)
          const z0 = Math.min(pz, pz - side * reach)
          frame.box(px - 0.1, px + 0.1, z0, z0 + reach, 7.9, 8.1, 2, grey)
          const tz = pz - side * (reach - 0.6)
          frame.box(px - 0.22, px + 0.22, tz - 0.75, tz + 0.75, 7.2, 7.9, 1, box)
          const on = Math.floor(rr() * 3)
          for (let k = 0; k < 3; k++) {
            const lz = tz + (k - 1) * 0.46
            const col = k === on ? colors[k] : colors[k].clone().multiplyScalar(0.12)
            lamps.box(px - 0.25, px + 0.25, lz - 0.15, lz + 0.15, 7.4, 7.7, 1, col)
          }
        }
      }
    }
    if (!frame.empty) {
      this.add(frame.geometry(), new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.5 }))
      this.add(lamps.geometry(), new MeshBasicMaterial({ vertexColors: true }), false, false)
    }
  }

  /** 機庫：屋頂、地上的重生點、門口的能量牆 */
  private addBase(team: Team, spawns: Spawn[]) {
    const s = team === 0 ? -1 : 1
    const color = TEAMS[team]
    const x0 = s < 0 ? -MAP_X : BASE.x
    const x1 = s < 0 ? -BASE.x : MAP_X
    const m = new Mesher()
    // 屋頂（底下暗一點）
    m.box(x0, x1, -BASE.z, BASE.z, HANGAR_H - 1, HANGAR_H, 6, hex(0x55595e))
    m.bottom(x0, x1, -BASE.z, BASE.z, HANGAR_H - 1, 6, hex(0x6a6e73))
    // 屋頂的鋼樑
    for (let z = -BASE.z + 6; z < BASE.z; z += 8) {
      m.box(x0, x1, z - 0.4, z + 0.4, HANGAR_H - 2.2, HANGAR_H - 1, 2, hex(0x3c4046))
      m.bottom(x0, x1, z - 0.4, z + 0.4, HANGAR_H - 2.2, 2, hex(0x3c4046))
    }
    // 門框
    const fx = s < 0 ? -BASE.x : BASE.x
    m.box(fx - 1, fx + 1, -BASE.z - 1, -BASE.z + 1, 0, HANGAR_H, 2, hex(0x3c4046))
    m.box(fx - 1, fx + 1, BASE.z - 1, BASE.z + 1, 0, HANGAR_H, 2, hex(0x3c4046))
    m.box(fx - 1, fx + 1, -BASE.z, BASE.z, HANGAR_H - 2.5, HANGAR_H, 2, hex(color.armor))
    m.bottom(fx - 1, fx + 1, -BASE.z, BASE.z, HANGAR_H - 2.5, 2, hex(color.armor))
    this.add(m.geometry(), this.mat(this.tex.concrete, { roughness: 0.7, metalness: 0.3 }))

    // 重生點的發光圈、牆上和屋頂的燈條
    const glow = new Mesher()
    const c = new Color(color.glow)
    for (const { x, z } of spawns) {
      // 一個框（四條邊），中間留空
      glow.top(x - 2, x + 2, z - 2, z - 1.7, 0.08, 4, c)
      glow.top(x - 2, x + 2, z + 1.7, z + 2, 0.08, 4, c)
      glow.top(x - 2, x - 1.7, z - 1.7, z + 1.7, 0.08, 4, c)
      glow.top(x + 1.7, x + 2, z - 1.7, z + 1.7, 0.08, 4, c)
      glow.top(x - 1.7, x + 1.7, z - 1.7, z + 1.7, 0.08, 4, c.clone().multiplyScalar(0.3))
    }
    const backX = s * (MAP_X - 3.1)
    // 後牆內側的燈條（面向機庫裡面）
    glow.quad(backX, 8, s < 0 ? BASE.z - 2 : -BASE.z + 2, 0, 0, s < 0 ? -(BASE.z - 2) * 2 : (BASE.z - 2) * 2, 0, 1.2, 0, 1, 1, 0, 0, c)
    // 屋頂鋼樑底下的燈管
    const lampC = new Color(0xfff4dc)
    for (let z = -BASE.z + 6; z < BASE.z; z += 8) glow.bottom(x0 + 4, x1 - 4, z - 0.25, z + 0.25, HANGAR_H - 2.22, 4, lampC)
    const pad = new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.6, blending: AdditiveBlending, depthWrite: false })
    this.add(glow.geometry(), pad, false, false)

    // 能量牆
    const geo = new PlaneGeometry(BASE.z * 2, HANGAR_H - 2.5)
    geo.rotateY(Math.PI / 2)
    geo.translate(fx, (HANGAR_H - 2.5) / 2, 0)
    const mat = new ShaderMaterial({
      vertexShader: barrierVertex,
      fragmentShader: barrierFragment,
      uniforms: { uColor: { value: new Color(color.beam) }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    })
    this.barriers.push(mat)
    this.add(geo, mat, false, false)
  }

  /** 每一格：能量牆流動、河水往下游流、雲慢慢飄、警示燈一閃一閃，天空跟著鏡頭 */
  update(time: number, camX: number, camY: number, camZ: number) {
    for (const m of this.barriers) m.uniforms.uTime.value = time
    this.clock.value = time
    this.sky.update(time, camX, camY, camZ)
    const blink = (time % 1.6) / 1.6
    this.beacon.color.setRGB(blink < 0.35 ? 1 : 0.16, 0.05, 0.04)
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    disposeTextures(this.tex)
    this.env.dispose()
    this.sky.dispose()
  }
}
