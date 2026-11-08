// 高速效果：
// - SpeedBlur：畫面左右兩側的動態模糊。先把場景畫到一張貼圖上，再從畫面中心往外拉出殘影，
//   越靠左右邊緣拉得越長，中間的車和路面保持清楚。速度不夠快時不用這一步，直接畫到螢幕上。
//   同一步也畫集中線：畫面外圍一條條從中心往外衝的白色細線，極速時淡淡的、噴射時很明顯。
// - WindLines：從車頭冒出來、順著車身兩側和車頂往後流的白色風線。
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type WebGLRenderer,
} from 'three'

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D tScene;
  uniform float uStrength;
  uniform float uLines;
  uniform float uTime;
  uniform float uAspect;
  uniform vec2 uCenter;
  varying vec2 vUv;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    vec2 dir = vUv - uCenter;
    // 中間約三分之一不糊，往左右邊緣越來越糊
    float side = smoothstep(0.16, 0.5, abs(vUv.x - 0.5));
    float amount = uStrength * side * 0.09;
    vec4 col = vec4(0.0);
    for (int i = 0; i < 12; i++) {
      col += texture2D(tScene, vUv - dir * amount * (float(i) / 11.0));
    }
    col /= 12.0;

    if (uLines > 0.001) {
      // 以消失點為中心切成一圈扇形，每一格可能有一條線；離中心越遠線越粗，看起來像從中心射出來
      vec2 p = dir * vec2(uAspect, 1.0);
      float r = length(p) / length(vec2(0.5 * uAspect, 0.5));
      float a = (atan(p.y, p.x) / 6.28318 + 0.5) * 150.0;
      float id = floor(a);
      float h = hash(id * 1.37 + 0.5);
      float h2 = hash(id * 2.71 + 3.1);
      float across = abs(fract(a) - (0.3 + 0.4 * h2));
      float thin = 1.0 - smoothstep(0.03, 0.13, across);
      // 每條線是一小段，沿著半徑往外跑；跑出畫面後重新抽要不要出現，所以不會突然閃一下
      float run = h * 13.7 + uTime * (0.8 + 1.2 * h2);
      float phase = fract(run);
      float start = mix(0.2, 1.25, phase);
      float len = 0.18 + 0.3 * h;
      float seg = smoothstep(start, start + len, r) * (1.0 - smoothstep(start + len - 0.04, start + len, r));
      float show = step(0.62 - 0.32 * uLines, hash(id * 3.1 + floor(run) * 7.7));
      float edge = smoothstep(0.42, 0.85, r);
      float line = thin * seg * show * edge * uLines;
      col.rgb = mix(col.rgb, vec3(1.0), clamp(line * 0.7, 0.0, 1.0));
    }
    gl_FragColor = col;
    #include <colorspace_fragment>
  }
`

export class SpeedBlur {
  private readonly target: WebGLRenderTarget
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material: ShaderMaterial
  private readonly quad: Mesh

  constructor(samples: number) {
    this.target = new WebGLRenderTarget(1, 1, { samples })
    // 存成 sRGB：每色 8 位元也不會在暗處（夜城）出現色階
    this.target.texture.colorSpace = SRGBColorSpace
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        tScene: { value: this.target.texture },
        uStrength: { value: 0 },
        uLines: { value: 0 },
        uTime: { value: 0 },
        uAspect: { value: 1 },
        // 消失點大約在畫面中間偏上（地平線的位置）
        uCenter: { value: new Vector2(0.5, 0.56) },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  /** 畫布實際的像素大小（含 devicePixelRatio） */
  setSize(width: number, height: number) {
    this.target.setSize(width, height)
    this.material.uniforms.uAspect.value = width / Math.max(1, height)
  }

  /**
   * `strength` 0～1.3：模糊程度，0 是不糊，1 是極速。
   * `lines` 0～1：集中線多明顯；`time` 讓集中線往外跑，開越快傳越快的時間。
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, strength: number, lines: number, time: number) {
    const u = this.material.uniforms
    u.uStrength.value = strength
    u.uLines.value = lines
    u.uTime.value = time
    renderer.setRenderTarget(this.target)
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.target.dispose()
    this.material.dispose()
    this.quad.geometry.dispose()
  }
}

const windVertex = /* glsl */ `
  attribute vec3 aHead;
  attribute vec3 aTail;
  attribute float aSide;
  attribute float aT;
  attribute float aAlpha;
  uniform float uWidth;
  varying float vAlpha;
  varying float vT;
  void main() {
    vec4 head = modelViewMatrix * vec4(aHead, 1.0);
    vec4 tail = modelViewMatrix * vec4(aTail, 1.0);
    vec4 mv = mix(head, tail, aT);
    // 往畫面上和線垂直的方向撐開一點寬度，靠車頭那端細一點
    vec2 d = tail.xy / max(-tail.z, 0.1) - head.xy / max(-head.z, 0.1);
    vec2 n = normalize(vec2(-d.y, d.x) + 1e-6);
    mv.xy += n * aSide * uWidth * mix(1.0, 0.5, aT);
    gl_Position = projectionMatrix * mv;
    vAlpha = aAlpha;
    vT = aT;
  }
`

const windFragment = /* glsl */ `
  uniform float uOpacity;
  varying float vAlpha;
  varying float vT;
  void main() {
    // 兩端淡、中間最白，看起來是一縷氣流而不是一根棍子
    float a = vAlpha * uOpacity * sin(3.14159 * vT);
    if (a < 0.004) discard;
    gl_FragColor = vec4(1.0, 1.0, 1.0, a);
    #include <colorspace_fragment>
  }
`

const MAX_STREAKS = 64
/** 車頭最前端在車身座標的位置（公尺，車頭朝 +z） */
const NOSE = 2.25
/** 風線流到車頭後面多遠就消失：兩側的流過車尾一段，翻過車頂的到尾翼就停（再往後會直直衝向鏡頭，畫面中間多一條線） */
const GONE = 7.5
const GONE_CENTER = 4.8

export type WindCar = { x: number; y: number; z: number; heading: number; speed: number }

/**
 * 風線：從車頭（保險桿兩角和引擎蓋）冒出來，順著車身往後流，兩側的往外散開、中間的翻過擋風玻璃和車頂，
 * 流到車尾後面就淡掉。風線跟著車子走（用車身座標），像空氣被車頭劈開往兩旁刷過去。
 */
export class WindLines {
  readonly mesh: Mesh
  private readonly head = new Float32Array(MAX_STREAKS * 12)
  private readonly tail = new Float32Array(MAX_STREAKS * 12)
  private readonly alpha = new Float32Array(MAX_STREAKS * 4)
  /** 每條線：在車頭的起點（左右、高度）、往外散的程度、是不是中間那種、流了多遠、長度、流速、存在多久 */
  private readonly x0 = new Float32Array(MAX_STREAKS)
  private readonly y0 = new Float32Array(MAX_STREAKS)
  private readonly flare = new Float32Array(MAX_STREAKS)
  private readonly center = new Uint8Array(MAX_STREAKS)
  private readonly dist = new Float32Array(MAX_STREAKS)
  private readonly len = new Float32Array(MAX_STREAKS)
  private readonly flow = new Float32Array(MAX_STREAKS)
  private readonly age = new Float32Array(MAX_STREAKS).fill(Infinity)
  private readonly material: ShaderMaterial
  private readonly point = { x: 0, y: 0, z: 0 }
  private next = 0
  private pending = 0

  constructor() {
    const side = new Float32Array(MAX_STREAKS * 4)
    const t = new Float32Array(MAX_STREAKS * 4)
    const index = new Uint16Array(MAX_STREAKS * 6)
    for (let i = 0; i < MAX_STREAKS; i++) {
      side.set([-1, 1, -1, 1], i * 4)
      t.set([0, 0, 1, 1], i * 4)
      const v = i * 4
      index.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6)
    }
    const geo = new BufferGeometry()
    // position 只是讓 three.js 知道有幾個頂點，實際位置在 shader 裡用 aHead／aTail 算
    geo.setAttribute('position', new BufferAttribute(this.head, 3))
    geo.setAttribute('aHead', new BufferAttribute(this.head, 3))
    geo.setAttribute('aTail', new BufferAttribute(this.tail, 3))
    geo.setAttribute('aSide', new BufferAttribute(side, 1))
    geo.setAttribute('aT', new BufferAttribute(t, 1))
    geo.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1))
    geo.setIndex(new BufferAttribute(index, 1))
    this.material = new ShaderMaterial({
      vertexShader: windVertex,
      fragmentShader: windFragment,
      uniforms: { uWidth: { value: 0.026 }, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
    this.mesh = new Mesh(geo, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 3
  }

  /**
   * `strength` 0～1：0 不再冒出新的風線（已經有的流完就沒了），1 是極速。
   * `sidesOnly`：車頂視角時鏡頭就在車頂上，只畫兩側的，免得翻過車頂的線直接穿過鏡頭。
   * `reach`：風線最多流到車子中心後面幾公尺（鏡頭在那附近就提早消失）。
   */
  update(dt: number, car: WindCar, strength: number, boosting: boolean, sidesOnly: boolean, reach: number) {
    const speed = Math.max(0, car.speed)
    this.pending += dt * strength * (boosting ? 75 : 45)
    while (this.pending >= 1) {
      this.pending -= 1
      this.spawn(speed, boosting, sidesOnly)
    }
    this.material.uniforms.uOpacity.value = Math.min(1, strength * 1.5) * 0.6 + (boosting && strength > 0 ? 0.15 : 0)

    const sin = Math.sin(car.heading)
    const cos = Math.cos(car.heading)
    // 從車頭算起最遠流到哪裡：線的後端到這裡就停住，整條線縮進去再消失
    const end = Math.max(2, NOSE + reach)
    for (let i = 0; i < MAX_STREAKS; i++) {
      let a = 0
      if (this.age[i] !== Infinity) {
        this.age[i] += dt
        this.dist[i] += this.flow[i] * dt
        const back = Math.max(0, this.dist[i] - this.len[i])
        const gone = Math.min(this.center[i] ? GONE_CENTER : GONE, end)
        if (back > gone || (sidesOnly && this.center[i])) this.age[i] = Infinity
        else a = Math.min(1, this.age[i] / 0.06) * Math.min(1, (gone - back) / 2)
      }
      this.alpha.fill(a, i * 4, i * 4 + 4)
      if (a <= 0) continue
      // 線的後端（流得比較遠）是 head，靠車頭的那端是 tail；剛冒出來時兩端都在車頭，慢慢拉長
      this.toWorld(i, Math.min(this.dist[i], end), car, sin, cos)
      const { x: hx, y: hy, z: hz } = this.point
      this.toWorld(i, Math.min(Math.max(0, this.dist[i] - this.len[i]), end), car, sin, cos)
      const { x: tx, y: ty, z: tz } = this.point
      for (let v = 0; v < 4; v++) {
        this.head.set([hx, hy, hz], (i * 4 + v) * 3)
        this.tail.set([tx, ty, tz], (i * 4 + v) * 3)
      }
    }
    const geo = this.mesh.geometry
    geo.attributes.aHead.needsUpdate = true
    geo.attributes.aTail.needsUpdate = true
    geo.attributes.aAlpha.needsUpdate = true
  }

  /** 風線 i 從車頭往後流了 d 公尺的位置（世界座標，寫進 this.point） */
  private toWorld(i: number, d: number, car: WindCar, sin: number, cos: number) {
    const x0 = this.x0[i]
    let x: number
    let y: number
    if (this.center[i]) {
      // 中間的：貼著引擎蓋往後，翻過擋風玻璃到車頂，到尾翼就散掉
      x = x0 * (1 + 0.04 * d)
      y = this.y0[i] + 0.78 * smooth(0.6, 3.0, d)
    } else {
      // 兩側的：離開保險桿角落稍微往外彎，之後貼著車身往後流，只散開一點點
      x = x0 + Math.sign(x0) * (0.12 * Math.min(d, 1.4) + this.flare[i] * d)
      y = this.y0[i] + 0.05 * d
    }
    const z = NOSE - d
    // 車身座標：+x 是左邊 (cos, -sin)、+z 是車頭 (sin, cos)
    this.point.x = car.x + cos * x + sin * z
    this.point.y = car.y + y
    this.point.z = car.z - sin * x + cos * z
  }

  private spawn(speed: number, boosting: boolean, sidesOnly: boolean) {
    const i = this.next
    this.next = (this.next + 1) % MAX_STREAKS
    const center = !sidesOnly && Math.random() < 0.3
    this.center[i] = center ? 1 : 0
    if (center) {
      this.x0[i] = (Math.random() - 0.5) * 1.2
      this.y0[i] = 0.62 + Math.random() * 0.12
    } else {
      // 保險桿兩角，貼地到大燈上方的高度
      this.x0[i] = (Math.random() < 0.5 ? -1 : 1) * (0.92 + Math.random() * 0.18)
      this.y0[i] = 0.28 + Math.random() * 0.8
    }
    this.flare[i] = 0.02 + Math.random() * 0.05
    this.dist[i] = 0
    // 相對車子的流速比車速慢很多，不然一眨眼就流完了，看不出是從車頭出來的
    this.flow[i] = 12 + speed * 0.28 + (boosting ? 6 : 0)
    this.len[i] = 1.4 + speed * 0.03 + (boosting ? 1 : 0)
    this.age[i] = 0
  }

  clear() {
    this.age.fill(Infinity)
    this.alpha.fill(0)
    this.pending = 0
    this.mesh.geometry.attributes.aAlpha.needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

function smooth(lo: number, hi: number, v: number) {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}
