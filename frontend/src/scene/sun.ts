// 首頁的 3D 場景：粒子組成的太陽，點一下凝聚成「歐陽明崴」四個字輪流出現，游標／手指會把附近的粒子撥開。
// 顏色和混色方式從 CSS 變數（--particle-a、--particle-b、--particle-blend）讀，跟著亮色／深色主題切換。
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  NormalBlending,
  PerspectiveCamera,
  Plane,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'

export type SunScene = {
  /** 在太陽和文字之間切換 */
  toggle: () => void
  dispose: () => void
}

type Options = {
  container: HTMLElement
  reducedMotion: boolean
  /** 現在顯示的字，太陽時是 null */
  onShapeChange?: (glyph: string | null) => void
}

const GLYPHS = ['歐', '陽', '明', '崴']
const AUTO_TOGGLE_MS = 7000
const GLYPH_HOLD_MS = 3200
const IDLE_BEFORE_AUTO_MS = 9000

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uMorph;
  uniform float uSwap;
  uniform vec3 uPointer;
  uniform float uPointerStrength;
  uniform float uSize;
  uniform float uPixelRatio;
  attribute vec3 aGlyphFrom;
  attribute vec3 aGlyphTo;
  attribute vec4 aRandom;
  varying float vRand;
  varying float vPush;
  varying float vMix;

  float swapEase(float t, float r) {
    return smoothstep(0.0, 1.0, clamp(t * 1.6 - r * 0.6, 0.0, 1.0));
  }

  mat3 rotY(float a) {
    float c = cos(a), s = sin(a);
    return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  }

  void main() {
    // 太陽：慢慢自轉、微微呼吸
    vec3 sun = rotY(uTime * 0.12) * position;
    sun *= 1.0 + 0.035 * sin(uTime * 1.2 + aRandom.x * 6.2831);

    // 換字時粒子錯開出發，途中往前後散開一點
    float s = swapEase(uSwap, aRandom.w);
    vec3 g = mix(aGlyphFrom, aGlyphTo, s);
    g.z += sin(s * 3.14159) * (aRandom.z - 0.5) * 0.8;

    // 字：左右輕擺，看得出字有厚度
    vec3 glyph = rotY(sin(uTime * 0.45) * 0.38) * g;

    // 每顆粒子出發時間錯開，變形時像被吸過去
    float m = smoothstep(0.0, 1.0, clamp(uMorph * 1.6 - aRandom.x * 0.6, 0.0, 1.0));
    vec3 p = mix(sun, glyph, m);
    p += 0.018 * vec3(
      sin(uTime * 0.9 + aRandom.y * 20.0),
      cos(uTime * 0.8 + aRandom.z * 20.0),
      sin(uTime * 0.7 + aRandom.w * 20.0)
    );

    // 游標附近的粒子往外推、往前浮
    vec2 d = p.xy - uPointer.xy;
    float push = uPointerStrength * smoothstep(0.6, 0.0, length(d));
    p.xy += normalize(d + 1e-5) * push * 0.5;
    p.z += push * 0.35;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * (0.45 + aRandom.y) / -mv.z;
    vRand = aRandom.z;
    vPush = push;
    vMix = m;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uAlpha;
  varying float vRand;
  varying float vPush;
  varying float vMix;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.12, d);
    // 約三成粒子用強調色；被撥動、凝聚成字時強調色更多
    float t = clamp(step(0.7, vRand) + vPush * 1.6 + vMix * step(0.45, vRand) * 0.6, 0.0, 1.0);
    gl_FragColor = vec4(mix(uColorA, uColorB, t), alpha * uAlpha);
  }
`

/** 跟 shader 裡的 swapEase 一樣 */
function swapEase(t: number, r: number): number {
  const x = Math.min(1, Math.max(0, t * 1.6 - r * 0.6))
  return x * x * (3 - 2 * x)
}

function sunPositions(count: number): Float32Array {
  const out = new Float32Array(count * 3)
  const golden = Math.PI * (1 + Math.sqrt(5))
  const surface = Math.floor(count * 0.85)
  for (let i = 0; i < count; i++) {
    // 前 85% 均勻鋪在球面（費波那契球），其餘往隨機方向散在外圍當日冕
    const corona = i >= surface
    const t = corona ? Math.random() : (i + 0.5) / surface
    const phi = Math.acos(1 - 2 * t)
    const theta = corona ? Math.random() * Math.PI * 2 : golden * i
    const r = corona ? 1.25 + Math.random() ** 2 * 0.75 : 1.12 * (0.93 + Math.random() * 0.07)
    out[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    out[i * 3 + 1] = r * Math.cos(phi)
    out[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
  }
  return out
}

/** 把字畫在離屏 canvas 上取樣，得到落在筆畫裡的點，再加上前後厚度 */
function glyphPositions(count: number, char: string): Float32Array {
  const size = 220
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const out = new Float32Array(count * 3)
  if (!ctx) return out

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `900 ${size * 0.88}px "Noto Serif TC", "Songti TC", "PMingLiU", serif`
  ctx.fillText(char, size / 2, size / 2 + size * 0.03)
  const pixels = ctx.getImageData(0, 0, size, size).data

  const hits: number[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (pixels[(y * size + x) * 4 + 3] > 140) hits.push(x, y)
    }
  }
  const span = 2.7
  for (let i = 0; i < count; i++) {
    if (hits.length === 0) break
    const h = Math.floor(Math.random() * (hits.length / 2)) * 2
    out[i * 3] = ((hits[h] + Math.random()) / size - 0.5) * span
    out[i * 3 + 1] = -((hits[h + 1] + Math.random()) / size - 0.5) * span
    out[i * 3 + 2] = (Math.random() - 0.5) * 0.4
  }
  return out
}

function cssColor(name: string): Vector3 {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  let hex = value.replace('#', '')
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('')
  const n = Number.parseInt(hex, 16)
  if (hex.length !== 6 || Number.isNaN(n)) return new Vector3(0.5, 0.5, 0.5)
  return new Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

function particleCount(): number {
  const small = window.innerWidth < 640
  const weak = (navigator.hardwareConcurrency ?? 8) <= 4
  return small || weak ? 3200 : 7000
}

export async function createSunScene({ container, reducedMotion, onShapeChange }: Options): Promise<SunScene> {
  const renderer = new WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)
  renderer.domElement.setAttribute('aria-hidden', 'true')
  container.appendChild(renderer.domElement)

  const count = particleCount()
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(sunPositions(count), 3))
  try {
    await document.fonts.load(`900 200px "Noto Serif TC"`, GLYPHS.join(''))
  } catch {
    // 字型載入失敗就用系統襯線字
  }
  const glyphs = GLYPHS.map((char) => glyphPositions(count, char))
  const glyphFrom = new BufferAttribute(glyphs[0].slice(), 3)
  const glyphTo = new BufferAttribute(glyphs[0].slice(), 3)
  geometry.setAttribute('aGlyphFrom', glyphFrom)
  geometry.setAttribute('aGlyphTo', glyphTo)
  const random = new Float32Array(count * 4)
  for (let i = 0; i < random.length; i++) random[i] = Math.random()
  geometry.setAttribute('aRandom', new BufferAttribute(random, 4))

  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uMorph: { value: 0 },
      uSwap: { value: 1 },
      uPointer: { value: new Vector3(99, 99, 0) },
      uPointerStrength: { value: 0 },
      uSize: { value: 26 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uColorA: { value: new Vector3() },
      uColorB: { value: new Vector3() },
      uAlpha: { value: 1 },
    },
  })

  const applyTheme = () => {
    material.uniforms.uColorA.value = cssColor('--particle-a')
    material.uniforms.uColorB.value = cssColor('--particle-b')
    // 深色背景用相加混色會發光；亮色背景相加會變白看不到，所以用一般混色
    const additive = getComputedStyle(document.documentElement).getPropertyValue('--particle-blend').trim() === 'additive'
    material.blending = additive ? AdditiveBlending : NormalBlending
    material.uniforms.uAlpha.value = additive ? 0.85 : 0.9
    material.needsUpdate = true
  }
  applyTheme()

  const scene = new Scene()
  const group = new Group()
  group.add(new Points(geometry, material))
  scene.add(group)
  const camera = new PerspectiveCamera(35, 1, 0.1, 50)

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container
    if (w === 0 || h === 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    // 窄的直式畫面把鏡頭拉遠，整顆太陽才放得下
    const halfFov = Math.tan((camera.fov * Math.PI) / 360)
    camera.position.z = Math.max(6.2, 2.1 / (halfFov * camera.aspect))
    camera.updateProjectionMatrix()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  resize()

  // ---- 互動 ----
  const raycaster = new Raycaster()
  const plane = new Plane(new Vector3(0, 0, 1), 0)
  const ndc = new Vector2()
  const tilt = new Vector2()
  const hit = new Vector3()
  let pointerActive = false
  let downAt: { x: number; y: number } | null = null
  let lastInteraction = 0
  let glyph = false
  let index = 0
  let nextSwap = 0

  // 換到第 i 個字：從粒子現在的位置（換字可能還沒跑完）出發，飛向新的字
  const swapTo = (i: number) => {
    const u = material.uniforms
    const from = glyphFrom.array as Float32Array
    const to = glyphTo.array as Float32Array
    if (u.uMorph.value === 0) {
      // 還是太陽，直接換掉目標，不用飛
      from.set(glyphs[i])
      u.uSwap.value = 1
    } else {
      const t = u.uSwap.value
      for (let p = 0; p < count; p++) {
        const s = swapEase(t, random[p * 4 + 3])
        for (let k = p * 3; k < p * 3 + 3; k++) from[k] += (to[k] - from[k]) * s
      }
      u.uSwap.value = 0
    }
    to.set(glyphs[i])
    glyphFrom.needsUpdate = true
    glyphTo.needsUpdate = true
    index = i
    nextSwap = performance.now() + GLYPH_HOLD_MS
  }

  const setShape = (next: boolean) => {
    glyph = next
    if (glyph) swapTo(0)
    onShapeChange?.(glyph ? GLYPHS[index] : null)
  }

  const showGlyph = (i: number) => {
    swapTo(i)
    onShapeChange?.(GLYPHS[index])
  }

  // 點一下走下一步：太陽 → 歐 → 陽 → 明 → 崴 → 太陽
  const step = () => {
    if (!glyph) setShape(true)
    else if (index === GLYPHS.length - 1) setShape(false)
    else showGlyph(index + 1)
  }

  const onPointerMove = (e: PointerEvent) => {
    const rect = container.getBoundingClientRect()
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    tilt.copy(ndc)
    raycaster.setFromCamera(ndc, camera)
    if (raycaster.ray.intersectPlane(plane, hit)) {
      material.uniforms.uPointer.value.copy(group.worldToLocal(hit))
    }
    pointerActive = true
    lastInteraction = performance.now()
  }
  const onPointerLeave = () => {
    pointerActive = false
    tilt.set(0, 0)
  }
  const onPointerDown = (e: PointerEvent) => {
    downAt = { x: e.clientX, y: e.clientY }
    onPointerMove(e)
  }
  const onPointerUp = (e: PointerEvent) => {
    // 只有「點」才切換，拖曳撥粒子不算
    if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 8) step()
    downAt = null
    if (e.pointerType !== 'mouse') onPointerLeave()
  }
  container.addEventListener('pointermove', onPointerMove)
  container.addEventListener('pointerleave', onPointerLeave)
  container.addEventListener('pointercancel', onPointerLeave)
  container.addEventListener('pointerdown', onPointerDown)
  container.addEventListener('pointerup', onPointerUp)

  // ---- 主題變更 ----
  const themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  darkQuery.addEventListener('change', applyTheme)

  // ---- 動畫迴圈：畫面捲出視窗就停 ----
  let visible = true
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible && !frame) frame = requestAnimationFrame(tick)
  })
  visibilityObserver.observe(container)

  let frame = 0
  let last = performance.now()
  let elapsed = 0
  let nextAuto = last + AUTO_TOGGLE_MS
  const tick = (now: number) => {
    frame = 0
    const dt = Math.min((now - last) / 1000, 0.05)
    last = now
    if (!reducedMotion) elapsed += dt

    const idle = now - lastInteraction > IDLE_BEFORE_AUTO_MS
    if (!reducedMotion && glyph && now > nextSwap) {
      // 字輪流換；閒置時輪完一圈就散回太陽
      if (index === GLYPHS.length - 1 && idle) {
        setShape(false)
        nextAuto = now + AUTO_TOGGLE_MS
      } else {
        showGlyph((index + 1) % GLYPHS.length)
      }
    } else if (!reducedMotion && !glyph && now > nextAuto) {
      if (idle) setShape(true)
      nextAuto = now + AUTO_TOGGLE_MS
    }

    const u = material.uniforms
    u.uTime.value = elapsed
    const target = glyph ? 1 : 0
    u.uMorph.value = reducedMotion
      ? target
      : u.uMorph.value + Math.sign(target - u.uMorph.value) * Math.min(Math.abs(target - u.uMorph.value), dt * 0.65)
    u.uSwap.value = reducedMotion ? 1 : Math.min(1, u.uSwap.value + dt * 0.9)
    u.uPointerStrength.value += ((pointerActive ? 1 : 0) - u.uPointerStrength.value) * Math.min(1, dt * 6)
    group.rotation.x += (-tilt.y * 0.22 - group.rotation.x) * Math.min(1, dt * 3)
    group.rotation.y += (tilt.x * 0.32 - group.rotation.y) * Math.min(1, dt * 3)

    renderer.render(scene, camera)
    if (visible) frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)

  return {
    toggle: () => {
      lastInteraction = performance.now()
      setShape(!glyph)
    },
    dispose: () => {
      cancelAnimationFrame(frame)
      visibilityObserver.disconnect()
      resizeObserver.disconnect()
      themeObserver.disconnect()
      darkQuery.removeEventListener('change', applyTheme)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerleave', onPointerLeave)
      container.removeEventListener('pointercancel', onPointerLeave)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointerup', onPointerUp)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
