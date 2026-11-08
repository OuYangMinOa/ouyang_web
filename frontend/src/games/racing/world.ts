// 賽道的場景：天空、地形、路面、路緣石、護欄、起跑門、橋，以及樹、仙人掌、岩石、大樓、路燈這些擺設。
// 貼圖都用 canvas 畫，不用下載圖檔。
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SpotLight,
  Vector3,
  type Material,
  type Texture,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { clamp, rng, smoothstep } from './noise'
import { CURB } from './spec'
import type { TrackPath } from './track'
import type { PropSpec, TrackDef } from './tracks'

export type World = {
  scene: Scene
  /** 夜間賽道跟著鏡頭焦點那台車的車頭燈 */
  headlight: SpotLight | null
  /** 天空、星星跟著鏡頭移動 */
  follow: (camera: Vector3) => void
  dispose: () => void
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`

function makeTexture(
  w: number,
  h: number,
  anisotropy: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  draw(canvas.getContext('2d')!)
  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.anisotropy = anisotropy
  return tex
}

/**
 * 沿著賽道的帶狀網格：左邊緣在 latL、右邊緣在 latR（左正右負），高度是那裡的路面（含彎道傾斜）再加 yL、yR。
 * 兩邊同一個 lat、不同高度就是一面直立的牆。`from`、`count` 只做其中一段（橋）
 */
function ribbon(
  track: TrackPath,
  latL: number,
  latR: number,
  yL: number,
  yR: number,
  vScale: number,
  from = 0,
  count = track.n,
): BufferGeometry {
  const { n, px, pz, tx, tz, step } = track
  const pos = new Float32Array((count + 1) * 6)
  const uv = new Float32Array((count + 1) * 4)
  for (let k = 0; k <= count; k++) {
    const i = (from + k) % n
    const nx = tz[i]
    const nz = -tx[i]
    const l = track.roadY(i, latL) + yL
    const r = track.roadY(i, latR) + yR
    pos.set([px[i] + nx * latL, l, pz[i] + nz * latL, px[i] + nx * latR, r, pz[i] + nz * latR], k * 6)
    const v = ((from + k) * step) / vScale
    uv.set([0, v, 1, v], k * 4)
  }
  const index = new Uint32Array(count * 6)
  for (let k = 0; k < count; k++) {
    const a = k * 2
    index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], k * 6)
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(pos, 3))
  geo.setAttribute('uv', new BufferAttribute(uv, 2))
  geo.setIndex(new BufferAttribute(index, 1))
  geo.computeVertexNormals()
  return geo
}

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`
const skyFragment = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uSun;
  uniform vec3 uSunDir;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 col = mix(uHorizon, uTop, pow(clamp(d.y, 0.0, 1.0), 0.5));
    float s = max(dot(d, uSunDir), 0.0);
    col += uSun * (pow(s, 1200.0) * 1.6 + pow(s, 16.0) * 0.3);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

type Spot = { x: number; y: number; z: number; rot: number; scale: number; r: number }

export function buildWorld(track: TrackPath, def: TrackDef, anisotropy: number): World {
  const th = def.theme
  const scene = new Scene()
  const textures: Texture[] = []
  const tex = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => {
    const t = makeTexture(w, h, anisotropy, draw)
    textures.push(t)
    return t
  }

  scene.background = new Color(th.skyHorizon)
  scene.fog = new Fog(th.skyHorizon, th.fogNear, th.fogFar)
  scene.add(new HemisphereLight(th.hemiSky, th.hemiGround, th.hemiIntensity))
  const sunDir = new Vector3(...th.sunDir).normalize()
  const sun = new DirectionalLight(th.sunColor, th.sunIntensity)
  sun.position.copy(sunDir).multiplyScalar(100)
  scene.add(sun)

  // 天空：上下漸層加太陽光暈，畫在最遠處
  const sky = new Mesh(
    new SphereGeometry(2000, 32, 16),
    new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        uTop: { value: new Color(th.skyTop) },
        uHorizon: { value: new Color(th.skyHorizon) },
        uSun: { value: new Color(th.skySun) },
        uSunDir: { value: sunDir },
      },
      side: BackSide,
      depthWrite: false,
      fog: false,
    }),
  )
  sky.renderOrder = -1
  sky.frustumCulled = false
  scene.add(sky)

  let stars: Points | null = null
  if (th.night) {
    const rand = rng(99)
    const pos = new Float32Array(900 * 3)
    for (let i = 0; i < 900; i++) {
      const a = rand() * Math.PI * 2
      const y = 0.08 + rand() * 0.92
      const r = Math.sqrt(1 - y * y)
      pos.set([Math.cos(a) * r * 1800, y * 1800, Math.sin(a) * r * 1800], i * 3)
    }
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(pos, 3))
    stars = new Points(geo, new PointsMaterial({ color: 0xffffff, size: 1.8, sizeAttenuation: false, fog: false }))
    stars.frustumCulled = false
    scene.add(stars)
  }

  // 地形：離賽道近的地方貼著路面（略低一點，免得穿過路面），遠一點才照賽道自己的起伏。
  // 橋不算：橋底下的地形貼著下面那條路或原本的地面。格子大約 7 公尺一格，路面有起伏時才不會穿出來
  const margin = 480
  const x0 = track.minX - margin
  const z0 = track.minZ - margin
  const w = track.maxX - track.minX + margin * 2
  const d = track.maxZ - track.minZ + margin * 2
  const res = clamp(Math.round(Math.max(w, d) / 7), 160, 280)
  const cols = res + 1
  const heights = new Float32Array(cols * cols)
  const tPos = new Float32Array(cols * cols * 3)
  const tCol = new Float32Array(cols * cols * 3)
  const color = new Color()
  const near = track.wall + 2
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + (c / res) * w
      const z = z0 + (r / res) * d
      const nearest = track.nearest(x, z, true)
      const far = def.terrain(x, z, nearest.dist, nearest.y)
      const y = nearest.y - 0.55 + (far - (nearest.y - 0.55)) * smoothstep(near, near + 40, nearest.dist)
      const k = r * cols + c
      heights[k] = y
      tPos.set([x, y, z], k * 3)
      def.paint(y, nearest.dist, x, z, color)
      tCol.set([color.r, color.g, color.b], k * 3)
    }
  }
  const tIndex = new Uint32Array(res * res * 6)
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      const a = r * cols + c
      tIndex.set([a, a + cols, a + 1, a + 1, a + cols, a + cols + 1], (r * res + c) * 6)
    }
  }
  const terrainGeo = new BufferGeometry()
  terrainGeo.setAttribute('position', new BufferAttribute(tPos, 3))
  terrainGeo.setAttribute('color', new BufferAttribute(tCol, 3))
  terrainGeo.setIndex(new BufferAttribute(tIndex, 1))
  terrainGeo.computeVertexNormals()
  scene.add(new Mesh(terrainGeo, new MeshLambertMaterial({ vertexColors: true })))

  const groundAt = (x: number, z: number) => {
    const fc = clamp(((x - x0) / w) * res, 0, res - 0.001)
    const fr = clamp(((z - z0) / d) * res, 0, res - 0.001)
    const c = Math.floor(fc)
    const r = Math.floor(fr)
    const u = fc - c
    const v = fr - r
    const k = r * cols + c
    const a = heights[k] + (heights[k + 1] - heights[k]) * u
    const b = heights[k + cols] + (heights[k + cols + 1] - heights[k + cols]) * u
    return a + (b - a) * v
  }

  if (th.water) {
    const water = new Mesh(
      new PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2),
      new MeshPhongMaterial({ color: th.water.color, shininess: 90, specular: 0x7799bb }),
    )
    water.position.set(x0 + w / 2, th.water.level, z0 + d / 2)
    scene.add(water)
  }

  // 路面：柏油、白色邊線、中間的虛線（一組 12 公尺：4 公尺線、8 公尺空白）。
  // 路面、路肩、護欄都要有夠明顯、一段一段的花紋，開快的時候才看得出東西在往後衝
  const hw = track.halfWidth
  const roadTex = tex(256, 512, (ctx) => {
    ctx.fillStyle = css(th.road)
    ctx.fillRect(0, 0, 256, 512)
    const rand = rng(5)
    // 大塊的深淺補丁：細小的顆粒遠一點就糊成一片，大塊的才看得到在動
    for (let i = 0; i < 26; i++) {
      const l = rand() < 0.5 ? 255 : 0
      ctx.fillStyle = `rgba(${l},${l},${l},${0.03 + rand() * 0.04})`
      ctx.fillRect(rand() * 220, rand() * 512, 30 + rand() * 90, 14 + rand() * 60)
    }
    for (let i = 0; i < 5000; i++) {
      const l = rand() < 0.5 ? 255 : 0
      ctx.fillStyle = `rgba(${l},${l},${l},${0.03 + rand() * 0.05})`
      ctx.fillRect(rand() * 256, rand() * 512, 1 + rand() * 2, 1 + rand() * 2)
    }
    // 橫過整條路的接縫
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.fillRect(0, 340, 256, 4)
    ctx.fillStyle = css(th.roadLine)
    ctx.fillRect(9, 0, 6, 512)
    ctx.fillRect(241, 0, 6, 512)
    ctx.globalAlpha = 0.85
    ctx.fillRect(125, 0, 6, 171)
  })
  const road = new Mesh(ribbon(track, hw, -hw, 0.02, 0.02, 12), new MeshLambertMaterial({ map: roadTex }))
  scene.add(road)

  // 路緣石：兩色相間，比路面高一點點
  const curbTex = tex(8, 64, (ctx) => {
    ctx.fillStyle = css(th.curb[0])
    ctx.fillRect(0, 0, 8, 32)
    ctx.fillStyle = css(th.curb[1])
    ctx.fillRect(0, 32, 8, 32)
  })
  const curbMat = new MeshLambertMaterial({ map: curbTex })
  scene.add(new Mesh(ribbon(track, hw + CURB, hw, 0.04, 0.05, 4), curbMat))
  scene.add(new Mesh(ribbon(track, -hw, -hw - CURB, 0.05, 0.04, 4), curbMat))

  // 路緣石到護欄之間的緩衝區：一深一淺的橫條（像修剪過的草皮），加上不規則的斑塊
  const shoulderTex = tex(64, 128, (ctx) => {
    const base = new Color(th.shoulder)
    ctx.fillStyle = css(base.getHex())
    ctx.fillRect(0, 0, 64, 128)
    ctx.fillStyle = css(base.clone().multiplyScalar(0.86).getHex())
    ctx.fillRect(0, 0, 64, 32)
    ctx.fillRect(0, 64, 64, 32)
    const rand = rng(11)
    for (let i = 0; i < 60; i++) {
      const l = rand() < 0.5 ? 255 : 0
      ctx.fillStyle = `rgba(${l},${l},${l},${0.04 + rand() * 0.06})`
      ctx.fillRect(rand() * 64, rand() * 128, 3 + rand() * 12, 2 + rand() * 8)
    }
  })
  const shoulderMat = new MeshLambertMaterial({ map: shoulderTex })
  scene.add(new Mesh(ribbon(track, track.wall + 0.4, hw + CURB, 0, 0, 10), shoulderMat))
  scene.add(new Mesh(ribbon(track, -hw - CURB, -track.wall - 0.4, 0, 0, 10), shoulderMat))

  // 護欄：每 2.5 公尺一根立柱（淺色護欄畫深色、深色護欄畫淺色），貼著畫面兩邊一根根閃過去
  const wallTex = tex(16, 64, (ctx) => {
    const base = new Color(th.wall)
    const light = base.r * 0.3 + base.g * 0.59 + base.b * 0.11 > 0.45
    ctx.fillStyle = css(base.getHex())
    ctx.fillRect(0, 0, 16, 64)
    ctx.fillStyle = css(light ? base.clone().multiplyScalar(0.5).getHex() : base.clone().lerp(new Color(0xffffff), 0.3).getHex())
    for (let y = 0; y < 64; y += 16) ctx.fillRect(0, y, 16, 4)
  })
  const wallMat = new MeshLambertMaterial({ map: wallTex, side: DoubleSide })
  const wh = th.wallHeight
  scene.add(new Mesh(ribbon(track, track.wall, track.wall, wh, -1, 10), wallMat))
  scene.add(new Mesh(ribbon(track, -track.wall, -track.wall, -1, wh, 10), wallMat))
  // 護欄頂端的蓋板（夜間是一段一段發光的燈條）
  const capTex = tex(4, 64, (ctx) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 4, 64)
    ctx.fillStyle = '#1a1a1a'
    for (let y = 0; y < 64; y += 16) ctx.fillRect(0, y, 4, 5)
  })
  const capMat = th.wallGlow
    ? new MeshBasicMaterial({ color: th.wallGlow, map: capTex })
    : new MeshLambertMaterial({ color: new Color(th.wall).multiplyScalar(0.8) })
  scene.add(new Mesh(ribbon(track, track.wall + 0.25, track.wall, wh, wh, 10), capMat))
  scene.add(new Mesh(ribbon(track, -track.wall, -track.wall - 0.25, wh, wh, 10), capMat))

  // 起跑線與起跑門
  const checker = tex(64, 16, (ctx) => {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 2; y++) {
        ctx.fillStyle = (x + y) % 2 ? '#111111' : '#f5f5f5'
        ctx.fillRect(x * 8, y * 8, 8, 8)
      }
    }
  })
  const p0 = track.pointAt(0)
  const startHeading = Math.atan2(p0.tx, p0.tz)
  const line = new Mesh(
    new PlaneGeometry(hw * 2, 2.4).rotateX(-Math.PI / 2),
    new MeshLambertMaterial({ map: checker, polygonOffset: true, polygonOffsetFactor: -1 }),
  )
  // 每格約 0.6 公尺見方
  checker.repeat.set(hw / 2.4, 2)
  line.position.set(p0.x, p0.y + 0.035, p0.z)
  line.rotation.y = startHeading
  scene.add(line)

  const gantry = new Group()
  const trimMat = new MeshLambertMaterial({ color: th.night ? 0x2a2c36 : 0x3a3d45 })
  const span = track.wall + 0.6
  for (const side of [-1, 1]) {
    const post = new Mesh(new BoxGeometry(0.7, 8, 0.7), trimMat)
    post.position.set(side * span, 4, 0)
    gantry.add(post)
  }
  const bannerTex = tex(256, 32, (ctx) => {
    for (let x = 0; x < 32; x++) {
      for (let y = 0; y < 4; y++) {
        ctx.fillStyle = (x + y) % 2 ? '#111111' : '#f5f5f5'
        ctx.fillRect(x * 8, y * 8, 8, 8)
      }
    }
  })
  bannerTex.wrapS = bannerTex.wrapT = RepeatWrapping
  const banner = new Mesh(
    new BoxGeometry(span * 2 + 0.7, 1.5, 0.5),
    th.night
      ? new MeshBasicMaterial({ map: bannerTex, color: 0xd8f6ff })
      : new MeshLambertMaterial({ map: bannerTex }),
  )
  banner.position.set(0, 7.4, 0)
  gantry.add(banner)
  gantry.position.set(p0.x, p0.y, p0.z)
  gantry.rotation.y = startHeading
  scene.add(gantry)

  addBridges(scene, track, groundAt, new Color(th.bridge ?? th.wall))

  // 擺設
  for (const spec of def.props) addProps(scene, track, spec, groundAt, th.night === true, tex)

  // 夜城的路燈
  if (th.night) addLamps(scene, track)

  let headlight: SpotLight | null = null
  if (th.night) {
    headlight = new SpotLight(0xfff0d0, 110, 130, 0.6, 0.5, 1)
    scene.add(headlight)
    scene.add(headlight.target)
  }

  return {
    scene,
    headlight,
    follow: (camera) => {
      sky.position.copy(camera)
      stars?.position.copy(camera)
    },
    dispose: () => {
      scene.traverse((obj) => {
        const mesh = obj as Mesh
        mesh.geometry?.dispose()
        const mat = mesh.material as Material | Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose()
      })
      for (const t of textures) t.dispose()
    },
  }
}

/** 在賽道兩旁隨機找位置，離賽道（任何一段）太近的不要 */
function scatter(
  track: TrackPath,
  spec: PropSpec,
  groundAt: (x: number, z: number) => number,
  footprint: (rand: () => number) => number,
): Spot[] {
  const rand = rng(spec.seed)
  const spots: Spot[] = []
  for (let attempt = 0; attempt < spec.count * 4 && spots.length < spec.count; attempt++) {
    const i = Math.floor(rand() * track.n)
    const side = rand() < 0.5 ? -1 : 1
    const r = footprint(rand)
    const off = track.wall + spec.near + r + (spec.far - spec.near) * rand() ** 1.6
    const x = track.px[i] + track.tz[i] * off * side
    const z = track.pz[i] - track.tx[i] * off * side
    if (track.nearest(x, z).dist < track.wall + spec.near * 0.7 + r) continue
    const y = groundAt(x, z)
    if (spec.minY !== undefined && y < spec.minY) continue
    if (track.under(x, z, y)) continue
    spots.push({ x, y, z, rot: rand() * Math.PI * 2, scale: 0.7 + rand() * 0.8, r })
  }
  return spots
}

function instanced(
  scene: Scene,
  geo: BufferGeometry,
  mat: Material,
  spots: Spot[],
  each?: (dummy: Object3D, spot: Spot, index: number) => void,
  colors?: (index: number) => Color,
) {
  const mesh = new InstancedMesh(geo, mat, spots.length)
  const dummy = new Object3D()
  spots.forEach((spot, i) => {
    dummy.position.set(spot.x, spot.y, spot.z)
    dummy.rotation.set(0, spot.rot, 0)
    dummy.scale.setScalar(spot.scale)
    each?.(dummy, spot, i)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
    if (colors) mesh.setColorAt(i, colors(i))
  })
  scene.add(mesh)
}

function addProps(
  scene: Scene,
  track: TrackPath,
  spec: PropSpec,
  groundAt: (x: number, z: number) => number,
  night: boolean,
  tex: (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => CanvasTexture,
) {
  const tint = rng(spec.seed + 1000)
  const vary = (base: number, amount: number) => () =>
    new Color(base).offsetHSL((tint() - 0.5) * 0.04, (tint() - 0.5) * 0.15, (tint() - 0.5) * amount)

  switch (spec.kind) {
    case 'tree': {
      const spots = scatter(track, spec, groundAt, () => 2)
      const trunk = new CylinderGeometry(0.22, 0.32, 2.4, 6).translate(0, 1.2, 0)
      const leaves = mergeGeometries([
        new ConeGeometry(2.1, 4.2, 7).translate(0, 3.8, 0),
        new ConeGeometry(1.5, 3.4, 7).translate(0, 5.9, 0),
      ])
      instanced(scene, trunk, new MeshLambertMaterial({ color: 0x6b4a2f }), spots)
      const green = vary(0x3f7d3a, 0.12)
      instanced(scene, leaves, new MeshLambertMaterial({ color: 0xffffff }), spots, undefined, green)
      break
    }
    case 'palm': {
      const spots = scatter(track, spec, groundAt, () => 2)
      const trunk = new CylinderGeometry(0.15, 0.26, 7.5, 6).translate(0, 3.75, 0)
      const crown = new ConeGeometry(3.4, 1.3, 9).translate(0, 7.6, 0)
      const lean = (dummy: Object3D, spot: Spot) => {
        dummy.rotation.set(Math.sin(spot.rot) * 0.12, spot.rot, Math.cos(spot.rot) * 0.12)
      }
      instanced(scene, trunk, new MeshLambertMaterial({ color: 0x8a6a45 }), spots, lean)
      const green = vary(0x4c8a3c, 0.1)
      instanced(scene, crown, new MeshLambertMaterial({ color: 0xffffff }), spots, lean, green)
      break
    }
    case 'cactus': {
      const spots = scatter(track, spec, groundAt, () => 1)
      const geo = mergeGeometries([
        new CylinderGeometry(0.34, 0.4, 4, 8).translate(0, 2, 0),
        new CylinderGeometry(0.2, 0.2, 0.7, 6).rotateZ(Math.PI / 2).translate(0.5, 1.7, 0),
        new CylinderGeometry(0.2, 0.22, 1.5, 6).translate(0.82, 2.4, 0),
        new CylinderGeometry(0.2, 0.2, 0.6, 6).rotateZ(Math.PI / 2).translate(-0.46, 2.3, 0),
        new CylinderGeometry(0.18, 0.2, 1.1, 6).translate(-0.74, 2.8, 0),
      ])
      instanced(scene, geo, new MeshLambertMaterial({ color: 0xffffff }), spots, undefined, vary(0x4f7d3c, 0.1))
      break
    }
    case 'rock': {
      const spots = scatter(track, spec, groundAt, (rand) => 1 + rand() * 2)
      const rand = rng(spec.seed + 7)
      instanced(
        scene,
        new DodecahedronGeometry(1.5, 0),
        new MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
        spots,
        (dummy, spot) => {
          dummy.position.y -= 0.4
          dummy.scale.set(spot.r * (0.8 + rand() * 0.6), spot.r * (0.5 + rand() * 0.5), spot.r * (0.8 + rand() * 0.6))
          dummy.rotation.set(rand(), spot.rot, rand())
        },
        vary(spec.color ?? 0x8f8b80, 0.12),
      )
      break
    }
    case 'building': {
      // 每棟大樓的窗戶要照實際尺寸重複，所以不用 instancing，直接把所有大樓合成一個網格
      const rand = rng(spec.seed)
      const spots = scatter(track, spec, groundAt, (r) => 8 + r() * 10)
      const facade = tex(128, 128, (ctx) => drawWindows(ctx, 7, false))
      const lights = tex(128, 128, (ctx) => drawWindows(ctx, 7, true))
      const parts: BufferGeometry[] = []
      for (const spot of spots) {
        const bw = spot.r * 1.3
        const bd = spot.r * (0.9 + rand() * 0.5)
        const bh = 14 + rand() ** 1.5 * 80
        const box = new BoxGeometry(bw, bh, bd)
        const uv = box.getAttribute('uv') as BufferAttribute
        // 面的順序：+x、-x、+y、-y、+z、-z，每面 4 個頂點
        for (let face = 0; face < 6; face++) {
          const across = face < 2 ? bd : bw
          for (let v = 0; v < 4; v++) {
            const k = face * 4 + v
            if (face === 2 || face === 3) uv.setXY(k, 0.02, 0.02)
            else uv.setXY(k, uv.getX(k) * Math.max(1, Math.round(across / 12)), uv.getY(k) * Math.max(1, Math.round(bh / 14)))
          }
        }
        box.rotateY(spot.rot)
        box.translate(spot.x, spot.y + bh / 2 - 0.5, spot.z)
        parts.push(box)
      }
      if (parts.length === 0) return
      const geo = mergeGeometries(parts)
      parts.forEach((p) => p.dispose())
      scene.add(
        new Mesh(
          geo,
          new MeshLambertMaterial({
            map: facade,
            emissiveMap: lights,
            emissive: 0xffffff,
            emissiveIntensity: night ? 1 : 0.2,
          }),
        ),
      )
      break
    }
  }
}

/** 大樓外牆：一格 12 公尺寬、14 公尺高，四層樓、每層四扇窗；`lit` 只畫亮著的窗 */
function drawWindows(ctx: CanvasRenderingContext2D, seed: number, lit: boolean) {
  const rand = rng(seed)
  ctx.fillStyle = lit ? '#000000' : '#262838'
  ctx.fillRect(0, 0, 128, 128)
  const palette = ['#ffd98a', '#fff1c9', '#9fe8ff', '#ffb3d9']
  for (let floor = 0; floor < 4; floor++) {
    for (let col = 0; col < 4; col++) {
      const on = rand() < 0.55
      const color = palette[Math.floor(rand() * palette.length)]
      if (lit && !on) continue
      ctx.fillStyle = lit ? color : on ? color : '#141621'
      ctx.fillRect(6 + col * 31, 8 + floor * 31, 20, 16)
    }
  }
}

/** 路燈：兩側每 36 公尺一支，燈臂朝向路中間 */
/** 橋的兩側比護欄多出來的寬度（路燈立在這裡） */
const LEDGE = 1.6
/** 橋面板的厚度 */
const DECK = 1.7

/**
 * 橋：路面底下沒有填土的那幾段，畫橋面板的側面、底面和橋墩。
 * 橋墩大約 24 公尺一根，立在路中間；底下有另一條路經過的地方不放
 */
function addBridges(scene: Scene, track: TrackPath, groundAt: (x: number, z: number) => number, color: Color) {
  const { n, bridge } = track
  if (!bridge.some((b) => b)) return
  const mat = new MeshLambertMaterial({ color, side: DoubleSide })
  const edge = track.wall + LEDGE
  // 一段一段找出來（頭尾多包幾個點，橋面板才接得上地面那段）
  let start = 0
  while (start < n && bridge[start]) start++
  const runs: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if (!bridge[i]) continue
    const last = runs[runs.length - 1]
    if (last && (last[0] + last[1]) % n === i) last[1]++
    else runs.push([i, 1])
  }
  const pad = 3
  const parts: BufferGeometry[] = []
  for (const [from0, count0] of runs) {
    const from = (from0 - pad + n) % n
    const count = Math.min(n, count0 + pad * 2)
    // 護欄外面的平台、外側面、底面
    parts.push(ribbon(track, edge, track.wall + 0.4, -0.02, -0.02, 10, from, count))
    parts.push(ribbon(track, -track.wall - 0.4, -edge, -0.02, -0.02, 10, from, count))
    parts.push(ribbon(track, edge, edge, -0.02, -DECK, 10, from, count))
    parts.push(ribbon(track, -edge, -edge, -DECK, -0.02, 10, from, count))
    parts.push(ribbon(track, -edge, edge, -DECK, -DECK, 10, from, count))

    const every = Math.round(24 / track.step)
    for (let k = Math.round(every / 2); k < count0; k += every) {
      const i = (from0 + k) % n
      const x = track.px[i]
      const z = track.pz[i]
      const top = track.py[i] - DECK
      const ground = groundAt(x, z)
      const h = top - ground
      if (h < 1 || blocksRoad(track, i, x, z)) continue
      const heading = Math.atan2(track.tx[i], track.tz[i])
      const pier = new BoxGeometry(2.2, h + 0.5, 1.6).translate(0, ground + (h + 0.5) / 2 - 0.5, 0)
      // 橋墩頂端橫著的蓋梁
      const cap = new BoxGeometry(edge * 1.3, 0.9, 1.9).translate(0, top - 0.45, 0)
      for (const g of [pier, cap]) {
        g.rotateY(heading)
        g.translate(x, 0, z)
        parts.push(g)
      }
    }
  }
  const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
    g.deleteAttribute('uv')
    return g
  }))
  for (const g of parts) g.dispose()
  geo.computeVertexNormals()
  scene.add(new Mesh(geo, mat))
}

/** 在取樣點 i 的橋下立柱子會不會擋到底下那條路 */
function blocksRoad(track: TrackPath, i: number, x: number, z: number): boolean {
  const r = (track.wall + 2.5) ** 2
  for (let j = 0; j < track.n; j++) {
    if (track.py[j] > track.py[i] - 2) continue
    const dx = x - track.px[j]
    const dz = z - track.pz[j]
    if (dx * dx + dz * dz < r) return true
  }
  return false
}

function addLamps(scene: Scene, track: TrackPath) {
  const spots: Spot[] = []
  const every = Math.round(36 / track.step)
  for (let i = 0; i < track.n; i += every) {
    for (const side of [-1, 1]) {
      const off = (track.wall + 1.2) * side
      const x = track.px[i] + track.tz[i] * off
      const z = track.pz[i] - track.tx[i] * off
      const y = track.roadY(i, off)
      // 橋下的路燈會穿過橋面，不放
      if (track.under(x, z, y, 1)) continue
      // 燈臂沿著模型的 +z，轉向路中間（-side 的法線方向）
      const rot = Math.atan2(-track.tz[i] * side, track.tx[i] * side)
      spots.push({ x, y, z, rot, scale: 1, r: 0 })
    }
  }
  const pole = mergeGeometries([
    new CylinderGeometry(0.12, 0.18, 8, 6).translate(0, 4, 0),
    new BoxGeometry(0.14, 0.14, 2.6).translate(0, 7.9, 1.2),
  ])
  instanced(scene, pole, new MeshLambertMaterial({ color: 0x2b2d38 }), spots)
  instanced(
    scene,
    new BoxGeometry(0.5, 0.14, 1).translate(0, 7.78, 2.3),
    new MeshBasicMaterial({ color: 0xffe7b0 }),
    spots,
  )
}
