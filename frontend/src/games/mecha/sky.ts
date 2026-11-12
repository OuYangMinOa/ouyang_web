// 天空：打了很久的仗的城市。整片天空蓋著一層煙，太陽壓得很低、從煙裡透出橘黃色的光，地平線上幾道黑煙往上冒。
// 一顆包住鏡頭的球，用著色器畫漸層、太陽和光暈、慢慢飄的煙層、遠處的煙柱、地平線上的遠山；
// 同一片天空另外拍成環境貼圖，讓玻璃帷幕、水面、機甲的裝甲反射得到天空。
import { BackSide, Color, Mesh, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, Vector3, type WebGLRenderer, type WebGLRenderTarget } from 'three'

/** 太陽的方向（從場景指向太陽）：在南邊偏西、仰角 32 度。河是南北向的，太陽在河的那一頭，兩隊看過去的逆光程度差不多 */
export const SUN_DIR = new Vector3(-0.3, 0.62, 0.95).normalize()
/** 地平線的顏色（霧也用這個顏色，遠處的大樓才會融進天空）：煙和灰塵的冷灰色，只有朝太陽那一邊是暖的 */
export const HORIZON = 0x8f9499
/** 朝太陽那一邊的霧、煙被照成的顏色 */
export const GLOW = 0xf7ad72
export const SUN_COLOR = 0xffd8b6
/** 朝太陽那一邊的地平線有多少換成 `GLOW`（霧的顏色照同一條式子算，見 `worldmat.ts` 的霧） */
export const GLOW_MIX = 0.55

const vertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const fragment = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  uniform vec3 uGround;
  uniform float uTime;
  uniform float uDisc;
  varying vec3 vDir;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec2(17.0, 9.0);
      a *= 0.5;
    }
    return v;
  }
  float fbm3(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise(p);
      p = p * 2.07 + vec2(5.0, 13.0);
      a *= 0.5;
    }
    return v / 0.875;
  }
  // 遠山的稜線：照方位角疊幾個正弦波
  float ridge(float az, float seed) {
    return 0.5 + 0.5 * (sin(az * 3.0 + seed) * 0.5 + sin(az * 7.0 + seed * 2.3) * 0.3 + sin(az * 17.0 + seed * 4.1) * 0.14 + sin(az * 41.0 + seed) * 0.06);
  }
  // 遠處的一道煙柱：在方位角 az0 那裡從地平線往上冒，越高越寬、被風吹歪，到了煙層的高度散開
  float plume(float az, float el, float az0, float width, float lean, float seed) {
    float da = az - az0;
    da = atan(sin(da), cos(da));
    float x = (da - lean * el) / (width * (0.4 + el * 4.5));
    float n = fbm3(vec2(x * 1.6 + seed, el * 10.0 - uTime * 0.03 + seed * 3.1));
    float core = 1.0 - smoothstep(0.2, 1.0, abs(x) + (n - 0.5) * 1.1);
    float top = 1.0 - smoothstep(0.2, 0.46, el + (n - 0.5) * 0.14);
    return core * top * smoothstep(-0.004, 0.02, el);
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = max(d.y, 0.0);
    float toSun = max(dot(d, uSun), 0.0);
    // 靠太陽那一邊的地平線被照成橘黃色（霧也照這條式子算，大樓才融得進天空）
    vec3 horizon = mix(uHorizon, uGlow, pow(toSun, 3.0) * ${GLOW_MIX.toFixed(2)});
    vec3 col = mix(horizon, uZenith, pow(up, 0.5));

    // 太陽：隔著煙看過去的一大片光暈，中間一顆暗紅色的日輪（拍環境貼圖時不畫日輪，光已經由平行光打了）
    col += uGlow * (pow(toSun, 10.0) * 0.35 + pow(toSun, 70.0) * 0.8);
    col += vec3(1.0, 0.6, 0.3) * smoothstep(0.9994, 0.9997, dot(d, uSun)) * 4.0 * uDisc;

    // 煙層：把視線投到頭上的一個平面，蓋住大半個天空
    vec2 uv = d.xz / (d.y + 0.12) * 0.9 + vec2(uTime * 0.006, uTime * 0.002);
    float base = fbm(uv);
    float detail = fbm(uv * 2.9 + 11.0);
    float cover = smoothstep(0.4, 0.74, base + detail * 0.3);
    // 朝太陽那一側的邊被照亮、背光的那一面很暗
    float lit = fbm(uv + uSun.xz * 0.12);
    vec3 cloud = mix(vec3(0.085, 0.09, 0.1), mix(vec3(0.42, 0.43, 0.45), uGlow, 0.22), smoothstep(0.74, 0.3, lit));
    // 逆光：靠近太陽的地方，薄的煙被照得透亮，厚的還是黑的
    float thick = smoothstep(0.5, 0.95, base + detail * 0.3);
    cloud = mix(cloud, mix(uGlow * 1.5, vec3(0.15, 0.125, 0.115), thick), pow(toSun, 6.0) * 0.85);
    float fade = smoothstep(0.0, 0.22, d.y);
    col = mix(col, cloud, cover * fade * 0.9);

    // 遠處的煙柱：底下被火照紅
    float az = atan(d.z, d.x);
    float smoke = 0.0;
    smoke = max(smoke, plume(az, d.y, 0.45, 0.05, 0.9, 1.3));
    smoke = max(smoke, plume(az, d.y, 1.95, 0.035, 1.1, 4.7));
    smoke = max(smoke, plume(az, d.y, 2.85, 0.06, 0.8, 8.2));
    smoke = max(smoke, plume(az, d.y, -2.2, 0.045, 1.0, 2.9));
    smoke = max(smoke, plume(az, d.y, -0.95, 0.03, 1.2, 6.1));
    vec3 smokeCol = mix(vec3(0.05, 0.045, 0.042), vec3(0.22, 0.2, 0.185), smoothstep(0.0, 0.35, d.y));
    smokeCol += uGlow * 0.9 * exp(-d.y * 55.0);
    col = mix(col, smokeCol, smoke * 0.88);

    // 遠山：兩層，越遠越淡
    float m1 = 0.018 + 0.05 * ridge(az, 1.7);
    float m2 = 0.008 + 0.032 * ridge(az * 1.3 + 2.0, 5.1);
    col = mix(col, mix(horizon, vec3(0.26, 0.26, 0.27), 0.4), smoothstep(m1 + 0.004, m1, d.y));
    col = mix(col, mix(horizon, vec3(0.17, 0.17, 0.18), 0.5), smoothstep(m2 + 0.003, m2, d.y));

    // 地平線以下：先是霧的顏色，再往下是地面反射上來的顏色（只有環境貼圖看得到）
    col = mix(col, horizon, smoothstep(0.012, -0.004, d.y));
    col = mix(col, uGround, smoothstep(-0.03, -0.35, d.y));

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export class Sky {
  readonly mesh: Mesh
  private readonly material: ShaderMaterial
  private readonly geometry: SphereGeometry

  constructor() {
    this.geometry = new SphereGeometry(2500, 48, 24)
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uSun: { value: SUN_DIR },
        uZenith: { value: new Color(0x55626f) },
        uHorizon: { value: new Color(HORIZON) },
        uGlow: { value: new Color(GLOW) },
        uGround: { value: new Color(0x4a453f) },
        uTime: { value: 0 },
        uDisc: { value: 1 },
      },
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.renderOrder = -10
    this.mesh.frustumCulled = false
  }

  /** 畫不畫日輪（拍環境貼圖、反射探針時不畫） */
  disc(on: boolean) {
    this.material.uniforms.uDisc.value = on ? 1 : 0
  }

  /** 把天空拍成環境貼圖（反射、環境光用）；`size` 是立方體一面的大小 */
  environment(renderer: WebGLRenderer, size = 256): WebGLRenderTarget {
    const scene = new Scene()
    const dome = new Mesh(this.geometry, this.material)
    dome.scale.setScalar(0.01)
    scene.add(dome)
    this.material.uniforms.uDisc.value = 0
    const pmrem = new PMREMGenerator(renderer)
    const target = pmrem.fromScene(scene, 0, 0.1, 100, { size })
    pmrem.dispose()
    this.material.uniforms.uDisc.value = 1
    return target
  }

  update(time: number, camX: number, camY: number, camZ: number) {
    this.material.uniforms.uTime.value = time
    this.mesh.position.set(camX, camY, camZ)
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
