// 天空：傍晚前的斜陽。一顆包住鏡頭的球，用著色器畫漸層、太陽和光暈、會慢慢飄的雲、地平線上的遠山；
// 同一片天空另外拍成環境貼圖，讓玻璃帷幕、水面、機甲的裝甲反射得到天空。
import { BackSide, Color, Mesh, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, Vector3, type WebGLRenderer, type WebGLRenderTarget } from 'three'

/** 太陽的方向（從場景指向太陽）：在南邊偏西、仰角 36 度。河是南北向的，太陽在河的那一頭，兩隊看過去的逆光程度差不多 */
export const SUN_DIR = new Vector3(-0.3, 0.74, 0.95).normalize()
/** 地平線的顏色（霧也用這個顏色，遠處的大樓才會融進天空） */
export const HORIZON = 0xc9d3dc
export const SUN_COLOR = 0xffe2bd

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
  // 遠山的稜線：照方位角疊幾個正弦波
  float ridge(float az, float seed) {
    return 0.5 + 0.5 * (sin(az * 3.0 + seed) * 0.5 + sin(az * 7.0 + seed * 2.3) * 0.3 + sin(az * 17.0 + seed * 4.1) * 0.14 + sin(az * 41.0 + seed) * 0.06);
  }

  void main() {
    vec3 d = normalize(vDir);
    float up = max(d.y, 0.0);
    float toSun = max(dot(d, uSun), 0.0);
    // 靠太陽那一邊的地平線偏暖
    vec3 horizon = mix(uHorizon, uGlow, pow(toSun, 3.0) * 0.55);
    vec3 col = mix(horizon, uZenith, pow(up, 0.48));

    // 雲：把視線投到頭上的一個平面
    vec2 uv = d.xz / (d.y + 0.16) * 1.15 + vec2(uTime * 0.004, uTime * 0.0015);
    float base = fbm(uv);
    float detail = fbm(uv * 3.1 + 7.0);
    float cover = smoothstep(0.5, 0.78, base + detail * 0.22);
    // 朝太陽那一側的雲邊亮、背光的那一面暗
    float lit = fbm(uv + uSun.xz * 0.09);
    vec3 cloud = mix(vec3(0.56, 0.6, 0.68), vec3(1.0, 0.97, 0.92), smoothstep(0.75, 0.3, lit));
    cloud = mix(cloud, uGlow * 1.25, pow(toSun, 6.0) * 0.5);
    float fade = smoothstep(0.02, 0.24, d.y);
    col = mix(col, cloud, cover * fade * 0.86);

    // 太陽：光暈和日輪（拍環境貼圖時不畫日輪，光已經由平行光打了）
    col += uGlow * (pow(toSun, 18.0) * 0.32 + pow(toSun, 220.0) * 0.9);
    col += vec3(1.0, 0.95, 0.85) * smoothstep(0.9993, 0.9997, dot(d, uSun)) * 6.0 * uDisc;

    // 遠山：兩層，越遠越淡
    float az = atan(d.z, d.x);
    float m1 = 0.018 + 0.05 * ridge(az, 1.7);
    float m2 = 0.008 + 0.032 * ridge(az * 1.3 + 2.0, 5.1);
    col = mix(col, mix(horizon, vec3(0.5, 0.58, 0.68), 0.42), smoothstep(m1 + 0.004, m1, d.y));
    col = mix(col, mix(horizon, vec3(0.36, 0.43, 0.52), 0.5), smoothstep(m2 + 0.003, m2, d.y));

    // 地平線以下：先是霧的顏色，再往下是地面反射上來的顏色（只有環境貼圖看得到）
    col = mix(col, uHorizon, smoothstep(0.012, -0.004, d.y));
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
        uZenith: { value: new Color(0x3f6fb2) },
        uHorizon: { value: new Color(HORIZON) },
        uGlow: { value: new Color(0xffd9a6) },
        uGround: { value: new Color(0x6b6a66) },
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

  /** 把天空拍成環境貼圖（反射、環境光用） */
  environment(renderer: WebGLRenderer): WebGLRenderTarget {
    const scene = new Scene()
    const dome = new Mesh(this.geometry, this.material)
    dome.scale.setScalar(0.01)
    scene.add(dome)
    this.material.uniforms.uDisc.value = 0
    const pmrem = new PMREMGenerator(renderer)
    const target = pmrem.fromScene(scene, 0, 0.1, 100)
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
