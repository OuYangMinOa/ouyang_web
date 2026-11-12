// 後處理：場景先畫到一張浮點數的貼圖上（亮度可以超過 1，保留多重取樣的反鋸齒），
// 很亮的地方（發光的鏡頭、推進器、槍口的火、燒著的東西、金屬上的高光、太陽）往外暈開（泛光），
// 最後才做色調映射、調色（陰影偏冷、亮的地方偏暖，彩度收一點、對比加一點，四個角暗一點，加一點底片的顆粒）、轉成螢幕的顏色。
// 直接畫到螢幕上的話亮度一開始就被壓進 0～1，發光的東西只是一塊平平的顏色。
import { HalfFloatType, RawShaderMaterial, Vector2, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer } from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

/** 超過這個亮度才暈開：比被太陽照到的白牆、天空都亮，只有發光的東西和高光過得去 */
const THRESHOLD = 1.5

const gradeVertex = /* glsl */ `
  precision highp float;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  attribute vec3 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`
const gradeFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uTime;
  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D( tDiffuse, vUv ).rgb;
    // 暗角
    vec2 q = vUv - 0.5;
    c *= 1.0 - dot( q, q ) * 0.5;
    c = ACESFilmicToneMapping( c );
    // 調色：彩度收一點，陰影偏冷、亮的地方偏暖，對比加一點
    float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    c = mix( vec3( l ), c, 0.94 );
    c *= mix( vec3( 0.95, 1.0, 1.06 ), vec3( 1.04, 1.0, 0.94 ), smoothstep( 0.0, 0.65, l ) );
    c = mix( c, c * c * ( 3.0 - 2.0 * c ), 0.22 );
    // 底片的顆粒
    float n = fract( sin( dot( gl_FragCoord.xy + fract( uTime ) * 61.0, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    c += ( n - 0.5 ) * 0.011;
    gl_FragColor = sRGBTransferOETF( vec4( max( c, 0.0 ), 1.0 ) );
  }
`

export class Post {
  private readonly renderer: WebGLRenderer
  private readonly target: WebGLRenderTarget
  private readonly bloom: UnrealBloomPass
  private readonly grade: RawShaderMaterial
  private readonly quad: FullScreenQuad
  private readonly size = new Vector2()
  /** 泛光開著沒（畫面跟不上時關掉） */
  glow = true

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer
    renderer.getDrawingBufferSize(this.size)
    this.target = new WebGLRenderTarget(this.size.x, this.size.y, { type: HalfFloatType, samples: this.samples() })
    this.bloom = new UnrealBloomPass(this.size.clone(), 0.38, 0.55, THRESHOLD)
    this.grade = new RawShaderMaterial({
      vertexShader: gradeVertex,
      fragmentShader: gradeFragment,
      uniforms: { tDiffuse: { value: this.target.texture }, toneMappingExposure: { value: 1 }, uTime: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new FullScreenQuad(this.grade)
  }

  /** 像素很多（4K、高 DPI）時少取樣一點：那張貼圖很吃記憶體，像素密了鋸齒也不明顯 */
  private samples(): number {
    return this.size.x * this.size.y > 4.6e6 ? 2 : 4
  }

  /** 畫面大小變了（`renderer.setSize`、`setPixelRatio` 之後呼叫） */
  resize() {
    this.renderer.getDrawingBufferSize(this.size)
    this.target.samples = this.samples()
    this.target.setSize(this.size.x, this.size.y)
    this.bloom.setSize(this.size.x, this.size.y)
  }

  /** `time` 是秒（顆粒每一格不一樣） */
  render(scene: Scene, camera: Camera, time: number) {
    const { renderer, target } = this
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    if (this.glow) this.bloom.render(renderer, target, target, 0, false)
    this.grade.uniforms.toneMappingExposure.value = renderer.toneMappingExposure
    this.grade.uniforms.uTime.value = time
    renderer.setRenderTarget(null)
    this.quad.render(renderer)
  }

  dispose() {
    this.target.dispose()
    this.bloom.dispose()
    this.grade.dispose()
    this.quad.dispose()
  }
}
