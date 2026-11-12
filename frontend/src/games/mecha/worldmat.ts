// 場景的材質：打了很久的仗的城市。底下還是 canvas 畫的那幾張貼圖（`textures.ts`：磚、柏油、浪板…），
// 這裡在著色器裡照「世界座標」再疊上一層層的風化和破壞（遮罩貼圖見 `worldtex.ts`），整座城市沒有兩面牆是一樣的：
//   - 牆：表面那一層剝落露出底下的磚和混凝土、彈孔（洞口崩掉一圈）、燒過的那幾區整片燻黑、往下流的水漬、牆腳濺起來的泥
//   - 外牆的窗戶（每一扇自己決定）：玻璃破了剩窗框上參差不齊的碎片、釘上木板、燒過的上面燻黑一片，少數幾扇裡面還在燒
//   - 地面：裂縫、碎石和瓦礫的碎屑、積的灰，低的地方積水（很平、很亮，映得到天空），整張地圖一張的顏色（焦痕、車轍）
//   - 金屬：生鏽、褪色
//   - 環境光遮蔽：載入時烘的（`worldbake.ts`）。大的面照 `uv1` 取那張貼圖，地面和地上的小東西照世界座標取「地面那一張」
//   - 霧：貼著地面的那一層比較濃、朝太陽那一邊被照成橘黃色（和天空的地平線同一條式子，遠處的大樓才融得進去）
// 越靠近河（兩隊交火的前線）破壞得越厲害。
import { Color, Vector4, type Material, type MeshStandardMaterial, type Texture, type Vector3 } from 'three'
import { BASE, BED, MAP_X, MAP_Z, RIVER } from './map'
import { GLOW_MIX } from './sky'
import { WDETAIL_TILE, WMASK_TILE } from './worldtex'

/** 整張地圖一張的貼圖（顏色、地面的遮蔽）比地圖多畫出去多少公尺 */
export const GROUND_PAD = 20

/** 所有場景材質共用的參數 */
export type WorldLook = {
  uWMask: { value: Texture }
  uWDetail: { value: Texture }
  uMacro: { value: Texture }
  uGroundAo: { value: Texture }
  uWTime: { value: number }
  uWSun: { value: Vector3 }
  uWGlow: { value: Color }
}

export type Weather = {
  /** 貼著地面的面：整張地圖那一層顏色、地面的遮蔽，都照世界座標取 */
  ground?: boolean
  /** 地上的小東西（車、箱子、樹、路燈）：遮蔽照腳下的地面取，越高越不受影響 */
  prop?: boolean
  /** 直立的面風化得多厲害：剝落、彈孔、煤煙、水漬、牆腳的泥（0～1） */
  wall?: number
  /** 剝落之後露出來的顏色（磚、混凝土） */
  under?: number
  /** 積水（0～1） */
  wet?: number
  /** 生鏽（0～1） */
  rust?: number
  /** 裂縫（0～1） */
  cracks?: number
  /** 朝上的面積的灰、碎屑（0～1） */
  dust?: number
  /** 漆掉了多少（0～1）：掉的地方整個不畫，露出底下的路面（地上的標線） */
  worn?: number
  /** 外牆：窗戶在一格（一個開間 × 一層樓）裡的範圍（左、下、右、上，0～1），每一扇自己決定破了沒 */
  windows?: [number, number, number, number]
  /** 破壞的程度（0～1）：窗戶破掉的比例、牆剝落的多寡 */
  damage?: number
}

export type WeatherOptions = Weather & {
  /** 手機：少取幾張貼圖、不算凹凸 */
  lite: boolean
  /** 自己算的霧（桌機）；手機用 three.js 內建的 */
  haze: boolean
  /** 畫面有泛光：窗戶裡的火調得比 1 亮才暈得開 */
  hdr: boolean
}

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v))
const SX = (1 / (2 * (MAP_X + GROUND_PAD))).toFixed(8)
const SZ = (1 / (2 * (MAP_Z + GROUND_PAD))).toFixed(8)

/** 接在 `project_vertex` 後面：世界座標的位置 */
const vertexWorld = /* glsl */ `
  vec4 wPos4 = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    wPos4 = instanceMatrix * wPos4;
  #endif
  vWPos = ( modelMatrix * wPos4 ).xyz;
`

/**
 * 霧（取代 `fog_fragment`）：`pos` 是世界座標的那個變數、`sun` 是太陽的方向、`glow` 是朝太陽那一邊的顏色。
 * 機甲的材質（`mechmat.ts`）也用這一段，遠處的機甲才和後面的大樓融在同一層霧裡
 */
export function hazeFragment(pos: string, sun: string, glow: string): string {
  return /* glsl */ `
  #ifdef USE_FOG
    vec3 hzDir = normalize( ${pos} - cameraPosition );
    vec3 hzCol = mix( fogColor, ${glow}, pow( max( dot( hzDir, ${sun} ), 0.0 ), 3.0 ) * ${GLOW_MIX.toFixed(2)} );
    // 貼著地面的那一層比較濃：照這段視線的平均高度（很高的大樓、從空中往下看都不會整片白掉）
    float hzK = mix( 1.0, 0.45, smoothstep( 25.0, 170.0, 0.5 * ( ${pos}.y + cameraPosition.y ) ) );
    float hzD = vFogDepth * fogDensity * hzK;
    gl_FragColor.rgb = mix( gl_FragColor.rgb, hzCol, 1.0 - exp( - hzD * hzD ) );
  #endif
`
}

const fragmentPars = /* glsl */ `
  uniform sampler2D uWMask;
  uniform sampler2D uWDetail;
  uniform sampler2D uMacro;
  uniform sampler2D uGroundAo;
  uniform float uWTime;
  uniform vec3 uWSun;
  uniform vec3 uWGlow;
  uniform vec4 uWParam;
  uniform vec4 uWParam2;
  uniform vec3 uWUnder;
  uniform vec4 uWWin;
  varying vec3 vWPos;
  // 環境光遮蔽、看得到多少天空、法線壓平多少（積水、窗戶的洞）、凹凸（公尺）、自己發的光（窗戶裡的火）
  float wAo = 1.0;
  float wSky = 1.0;
  float wFlat = 0.0;
  float wBumpH = 0.0;
  vec3 wFire = vec3( 0.0 );
  float wHash( vec2 p ) {
    return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  }
  // 照高低差把法線推歪（高低是公尺，用螢幕上相鄰像素的差算斜率）
  vec3 wBump( vec3 surfPos, vec3 surfNorm, vec2 dHdxy ) {
    vec3 sx = dFdx( surfPos );
    vec3 sy = dFdy( surfPos );
    vec3 r1 = cross( sy, surfNorm );
    vec3 r2 = cross( surfNorm, sx );
    float det = dot( sx, r1 );
    vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
    return normalize( abs( det ) * surfNorm - grad );
  }
`

/** 接在 `metalnessmap_fragment` 後面：顏色、粗糙度、金屬度都有了，在上面疊風化（每一種的份量在 uWParam、uWParam2） */
const fragmentWeather = /* glsl */ `
  vec3 wP = vWPos;
  vec3 wN = normalize( cross( dFdx( wP ), dFdy( wP ) ) );
  vec3 wA = abs( wN );
  // 遮罩照世界座標貼：朝上的面用 xz，直立的面用沿著牆的方向和高度
  vec2 wUv = wA.y > 0.6 ? wP.xz : ( wA.x > wA.z ? vec2( wP.z, wP.y ) : vec2( wP.x, wP.y ) );
  float wUp = smoothstep( 0.55, 0.85, wN.y );
  float wSide = 1.0 - smoothstep( 0.35, 0.65, wA.y );
  // 離地多高（河床比路面低）
  float wH = wP.y - ( abs( wP.x ) < ${f(RIVER)} ? ${f(BED)} : 0.0 );
  vec2 wG = vec2( wP.x * ${SX} + 0.5, 0.5 - wP.z * ${SZ} );
  vec4 wM = texture2D( uWMask, wUv * ${(1 / WMASK_TILE).toFixed(5)} );
  #ifndef W_LITE
    vec4 wM2 = texture2D( uWMask, wUv * 0.189 + vec2( 0.37, 0.61 ) );
    vec4 wD = texture2D( uWDetail, wUv * ${(1 / WDETAIL_TILE).toFixed(5)} );
    // 這一區燒得多厲害（很大片的起伏）
    float wZone = texture2D( uWDetail, wP.xz * 0.0067 ).a;
  #else
    vec4 wM2 = wM.barg;
    vec4 wD = vec4( 0.0 );
    float wZone = wM.r;
  #endif
  // 越靠近河（前線）破壞得越厲害
  float wFront = 1.0 - smoothstep( 40.0, 300.0, abs( wP.x ) );
  float wDmg = clamp( uWParam2.y * ( 0.55 + 0.5 * wFront ) + ( wZone - 0.5 ) * 0.6, 0.0, 1.0 );
  // 很細的東西（碎屑、凹凸）只有近的才畫：遠了一個像素蓋住一大片，會閃
  float wNear = 1.0 - smoothstep( 14.0, 60.0, vViewPosition.z );

  // ---- 環境光遮蔽 ----
  #if defined( W_GROUND )
    wAo = texture2D( uGroundAo, wG ).r;
    wSky = wAo;
  #elif defined( W_PROP )
    // 往外偏一點取（自己腳下那一格是被自己擋住的）；越高、朝上的面越不受地面那一張影響
    wAo = mix( texture2D( uGroundAo, wG + wN.xz * vec2( ${SX}, -${SZ} ) * 1.3 ).r, 1.0, max( smoothstep( 0.2, 3.2, wH ), wUp ) );
    wSky = wAo;
  #endif
  #ifdef USE_AOMAP
    if ( vAoMapUv.x >= 0.0 ) {
      vec4 wBake = texture2D( aoMap, vAoMapUv );
      wAo = wBake.r;
      wSky = wBake.g;
    }
  #endif
  // 機庫裡開著燈（wLampless 是沒有燈時的遮蔽：裡面的面被屋頂擋著，很低）
  float wBase = step( ${f(BASE.x)}, abs( wP.x ) ) * step( abs( wP.z ), ${f(BASE.z + 1)} );
  float wLampless = wAo;
  wAo = mix( wAo, max( wAo, 0.62 ), wBase );

  #ifdef W_GROUND
    diffuseColor.rgb *= texture2D( uMacro, wG ).rgb * 2.0;
  #endif

  #ifdef W_WORN
    // 標線的漆一塊一塊掉了：掉的地方不畫
    if ( wM.b * 0.6 + wM2.b * 0.4 + wM.g * 0.5 > 1.0 - uWParam2.w * 0.62 ) discard;
  #endif

  #ifdef W_FACADE
    // 一格是一扇窗（一個開間 × 一層樓，3 × 3.3 公尺）
    vec2 wFc = vMapUv * 4.0;
    vec2 wCell = floor( wFc );
    vec2 wF = fract( wFc );
    float wR1 = wHash( wCell );
    float wR2 = fract( wR1 * 91.73 );
    float wR3 = fract( wR1 * 37.31 );
    // 離窗框多遠（公尺，負的是在窗戶外面）
    vec2 wQ0 = wF - uWWin.xy;
    vec2 wQ1 = uWWin.zw - wF;
    float wEdge = min( min( wQ0.x, wQ1.x ) * 3.0, min( wQ0.y, wQ1.y ) * 3.3 );
    float wIn = step( 0.0, wEdge );
    float wBroken = step( wR1, 0.2 + 0.62 * wDmg );
    float wBoard = ( 1.0 - wBroken ) * step( wR2, 0.1 );
    float wBurnt = wBroken * step( wR2, 0.1 + 0.3 * wDmg );
    // 還插在窗框上的碎玻璃：邊上參差不齊
    float wShardN = texture2D( uWMask, wF * vec2( 0.31, 0.23 ) + wCell * 0.173 ).b;
    float wShard = smoothstep( 0.0, 0.03, ( 0.06 + 0.55 * wShardN * wShardN ) * ( 0.25 + 0.75 * wR3 ) - wEdge );
    float wHole = wIn * wBroken * ( 1.0 - wShard );
    // 0 在窗戶頂、1 在窗台
    float wTop = clamp( wQ1.y / max( uWWin.w - uWWin.y, 0.01 ), 0.0, 1.0 );
    // 洞裡面：很暗，靠上面看得到一點天花板
    vec3 wInner = vec3( 0.014, 0.013, 0.012 ) + vec3( 0.05, 0.045, 0.04 ) * smoothstep( 0.35, 0.0, wTop ) * ( 0.4 + 0.6 * wR3 );
    diffuseColor.rgb = mix( diffuseColor.rgb, wInner, wHole );
    // 釘上去的木板：一片一片橫的
    float wPl = wF.y * 12.7;
    float wPlank = wIn * wBoard;
    vec3 wWood = vec3( 0.15, 0.125, 0.095 ) * ( 0.6 + 0.6 * wHash( vec2( floor( wPl ), wCell.x + wCell.y * 7.0 ) ) ) * ( 0.8 + 0.4 * wM2.r );
    wWood *= 1.0 - 0.6 * step( fract( wPl ), 0.07 );
    diffuseColor.rgb = mix( diffuseColor.rgb, wWood, wPlank );
    float wOff = max( wHole, wPlank );
    roughnessFactor = mix( roughnessFactor, mix( 1.0, 0.82, wPlank ), wOff );
    metalnessFactor *= 1.0 - wOff;
    wFlat = max( wFlat, wHole );
    // 煤煙：燒過的窗戶上面燻黑一片，一路燻到上一層
    float wR1b = wHash( wCell - vec2( 0.0, 1.0 ) );
    float wBurntB = step( wR1b, 0.2 + 0.62 * wDmg ) * step( fract( wR1b * 91.73 ), 0.1 + 0.3 * wDmg );
    float wXs = smoothstep( uWWin.x - 0.14, uWWin.x + 0.12, wF.x ) * smoothstep( uWWin.z + 0.14, uWWin.z - 0.12, wF.x );
    float wSootW = wBurnt * step( uWWin.w, wF.y ) * ( 1.0 - 0.45 * ( wF.y - uWWin.w ) / max( 1.0 - uWWin.w, 0.01 ) );
    wSootW = max( wSootW, wBurntB * ( 1.0 - smoothstep( 0.0, 0.75, wF.y ) ) * 0.6 );
    wSootW *= wXs * ( 0.55 + 0.45 * wM2.r );
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.16 + vec3( 0.008 ), wSootW * 0.9 * ( 1.0 - wHole ) );
    // 還在燒的：洞裡透出橘色的光，一閃一閃
    float wLit = wHole * wBurnt * step( wR3, 0.07 );
    // 火舌：從窗台往上竄，照雜訊一跳一跳
    float wFlame = texture2D( uWMask, vec2( wF.x * 0.35 + wR1, wTop * 0.3 + uWTime * 0.21 ) ).r;
    float wFlick = 0.6 + 0.4 * sin( uWTime * 6.3 + wR1 * 40.0 ) * sin( uWTime * 2.7 + wR2 * 17.0 );
    float wGlowIn = wTop * wTop * ( 0.35 + 0.65 * smoothstep( 0.25, 0.75, wFlame + wTop * 0.35 ) ) * wFlick;
    wFire = mix( vec3( 0.9, 0.16, 0.02 ), vec3( 1.0, 0.5, 0.12 ), wGlowIn ) * wLit * wGlowIn * uWParam2.z;
  #endif

    float wCrack = smoothstep( 0.3, 0.75, max( wM.g, wM2.g * 0.55 * wNear ) ) * smoothstep( 0.3, 0.6, wM.r * 0.6 + wZone * 0.4 + wDmg * 0.3 ) * uWParam2.x;
    // 機庫裡的地板還算完整
    wCrack *= 1.0 - wBase * 0.75;
    diffuseColor.rgb *= 1.0 - wCrack * 0.62;
    roughnessFactor = mix( roughnessFactor, 1.0, wCrack );
    wBumpH -= wCrack * 0.012;

    float wAmt = uWParam.x;
    // 剝落：表面那一層掉了，露出底下的磚、混凝土
    float wChip = smoothstep( 0.0, 0.035, wM.b * 0.62 + wM2.b * 0.38 - ( 0.88 - 0.32 * wDmg * wAmt ) ) * wSide * min( wAmt * 4.0, 1.0 );
    vec3 wSub = uWUnder * ( 0.75 + 0.5 * wM2.r );
    diffuseColor.rgb = mix( diffuseColor.rgb, wSub, wChip );
    roughnessFactor = mix( roughnessFactor, 0.95, wChip );
    metalnessFactor *= 1.0 - wChip;
    // 彈孔：洞是黑的，洞口崩掉一圈露出底下的顏色
    float wPock = wD.r * smoothstep( 0.5, 0.72, wM.r * 0.55 + wDmg * 0.55 ) * wAmt * wSide;
    float wPit = smoothstep( 0.5, 0.72, wPock );
    float wRim = smoothstep( 0.12, 0.4, wPock ) * ( 1.0 - wPit );
    diffuseColor.rgb = mix( diffuseColor.rgb, wSub * 1.15, wRim * 0.85 );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.02 ), wPit * 0.92 );
    roughnessFactor = mix( roughnessFactor, 1.0, max( wRim, wPit ) );
    metalnessFactor *= 1.0 - max( wRim, wPit );
    wBumpH -= wPock * 0.05;
    // 煤煙：燒過的那幾區整片燻黑
    float wSoot = smoothstep( 0.52, 0.9, wM.r * 0.55 + wZone * 0.75 - 0.08 ) * wAmt * wSide;
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.22 + vec3( 0.012, 0.011, 0.01 ), wSoot * 0.8 );
    roughnessFactor = mix( roughnessFactor, 0.96, wSoot * 0.7 );
    // 水漬：一道一道往下流
    #ifndef W_LITE
      float wDripN = texture2D( uWMask, wUv * vec2( 0.071, 0.027 ) ).a;
    #else
      float wDripN = wM.a;
    #endif
    float wDrip = smoothstep( 0.2, 0.85, wDripN ) * smoothstep( 0.3, 0.7, wM.r ) * wSide * wAmt;
    diffuseColor.rgb *= 1.0 - wDrip * 0.4;
    // 牆腳：濺起來的泥、積的灰
    float wMud = ( 1.0 - smoothstep( 0.0, 2.4, wH ) ) * wSide * ( 0.35 + 0.65 * wM.r ) * wAmt;
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.2, 0.175, 0.14 ) * ( 0.7 + 0.5 * wM2.r ), wMud * 0.6 );
    roughnessFactor = mix( roughnessFactor, 0.97, wMud * 0.7 );

    float wRustN = wM.r * 0.5 + wM2.b * 0.5 + ( 1.0 - smoothstep( 0.0, 1.6, wH ) ) * 0.25 * wSide;
    float wRust = smoothstep( 0.0, 0.22, wRustN - ( 1.0 - uWParam.z ) );
    vec3 wRustC = mix( vec3( 0.085, 0.04, 0.024 ), vec3( 0.22, 0.11, 0.052 ), wM2.r );
    // 沒鏽的地方漆也褪色了
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.3, 0.6, 0.1 ) ) ), 0.3 * uWParam.z );
    diffuseColor.rgb = mix( diffuseColor.rgb, wRustC, wRust * 0.92 );
    roughnessFactor = mix( roughnessFactor, 0.94, wRust );
    metalnessFactor *= 1.0 - wRust * 0.9;

    #ifndef W_LITE
      // 碎屑：小石頭、瓦礫的碎塊
      float wGrit = wD.g * wUp * uWParam.w * smoothstep( 0.3, 0.65, wM2.r + wDmg * 0.3 ) * wNear;
      diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.34, 0.31, 0.27 ) * ( 0.5 + wD.g ), wGrit * 0.85 );
      wBumpH += wGrit * 0.02;
    #endif
    float wDust = wUp * uWParam.w * ( 0.35 + 0.65 * wM.r );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.3, 0.275, 0.24 ), wDust * 0.5 );
    roughnessFactor = mix( roughnessFactor, 0.96, wDust * 0.7 );
    metalnessFactor *= 1.0 - wDust * 0.6;

    #ifndef W_LITE
      float wPudN = texture2D( uWDetail, wP.xz * 0.0233 ).a * 0.7 + wM.r * 0.3;
    #else
      float wPudN = wM.r;
    #endif
    // 沒被東西遮住的地方才積得到水；水面很平、很亮，四周一圈濕的
    float wOpen = smoothstep( 0.35, 0.7, wSky ) * wUp * step( 0.001, uWParam.y );
    float wLevel = 1.0 - uWParam.y * 0.5;
    float wPud = smoothstep( wLevel, wLevel + 0.03, wPudN ) * wOpen;
    float wDamp = smoothstep( wLevel - 0.14, wLevel, wPudN ) * wOpen;
    diffuseColor.rgb *= 1.0 - wDamp * 0.35;
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.35, wPud * 0.85 );
    roughnessFactor = mix( roughnessFactor, 0.5, wDamp * 0.5 );
    roughnessFactor = mix( roughnessFactor, 0.035, wPud );
    metalnessFactor *= 1.0 - wPud;
    wFlat = max( wFlat, wPud );
    wBumpH *= 1.0 - wPud;
  roughnessFactor = clamp( roughnessFactor, 0.03, 1.0 );
  // 機庫裡的燈：照得到的面補一點光（外面那幾面牆沒被擋著，不補）
  wFire += diffuseColor.rgb * vec3( 1.0, 0.94, 0.84 ) * 0.42 * wBase * ( 1.0 - smoothstep( 0.35, 0.8, wLampless ) );
`

/** 接在 `normal_fragment_maps` 後面 */
const fragmentNormal = /* glsl */ `
  #ifndef W_LITE
    normal = wBump( - vViewPosition, normal, vec2( dFdx( wBumpH ), dFdy( wBumpH ) ) * ( 1.0 - smoothstep( 14.0, 60.0, vViewPosition.z ) ) );
  #endif
  normal = normalize( mix( normal, nonPerturbedNormal, wFlat ) );
`

/** 取代 `aomap_fragment` */
const fragmentAo = /* glsl */ `
  // 烘的只算了天空和地面第一次反射上來的光：室內實際上還有牆、地板之間反射來反射去的，暗的地方拉亮一點，再裡面也不會全黑
  float ambientOcclusion = 0.36 + 0.64 * sqrt( clamp( wAo, 0.0, 1.0 ) );
  // 多次反彈的近似（Jimenez 2016）：顏色亮的地方縫裡留一點顏色
  vec3 wAoA = 2.0404 * diffuseColor.rgb - 0.3324;
  vec3 wAoB = -4.7951 * diffuseColor.rgb + 0.6417;
  vec3 wAoC = 2.7552 * diffuseColor.rgb + 0.6903;
  reflectedLight.indirectDiffuse *= max( vec3( ambientOcclusion ), ( ( ambientOcclusion * wAoA + wAoB ) * ambientOcclusion + wAoC ) * ambientOcclusion );
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
`

/** 只加霧（不是 MeshStandardMaterial 的、不用風化的：遠景、發光的東西） */
export function hazed<T extends Material>(mat: T, look: WorldLook, on: boolean): T {
  if (!on) return mat
  const before = mat.onBeforeCompile
  const key = mat.customProgramCacheKey
  mat.onBeforeCompile = (s, renderer) => {
    before.call(mat, s, renderer)
    s.uniforms.uWSun = look.uWSun
    s.uniforms.uWGlow = look.uWGlow
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <project_vertex>', `#include <project_vertex>\n${vertexWorld}`)
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uWSun;\nuniform vec3 uWGlow;\nvarying vec3 vWPos;')
      .replace('#include <fog_fragment>', hazeFragment('vWPos', 'uWSun', 'uWGlow'))
  }
  mat.customProgramCacheKey = () => `${key.call(mat)}|haze`
  return mat
}

/** 場景的材質加上風化、烘好的遮蔽、霧 */
export function weathered<T extends MeshStandardMaterial>(mat: T, look: WorldLook, o: WeatherOptions): T {
  const defines: Record<string, string> = {}
  if (o.ground) defines.W_GROUND = ''
  else if (o.prop) defines.W_PROP = ''
  // 剝落、生鏽、裂縫、積灰、積水都照 uWParam 的份量算（0 就是沒有），不另外分著色器：
  // 著色器的種類少一半，第一次進來編譯快很多
  if (o.windows) defines.W_FACADE = ''
  if (o.worn) defines.W_WORN = ''
  if (o.lite) defines.W_LITE = ''
  mat.defines = { ...mat.defines, ...defines }
  const uniforms = {
    ...look,
    uWParam: { value: new Vector4(o.wall ?? 0, o.wet ?? 0, o.rust ?? 0, o.dust ?? 0) },
    uWParam2: { value: new Vector4(o.cracks ?? 0, o.damage ?? 0.5, o.hdr ? 4 : 1.4, o.worn ?? 0) },
    uWUnder: { value: new Color(o.under ?? 0x8d877c) },
    uWWin: { value: new Vector4(...(o.windows ?? [0, 0, 1, 1])) },
  }
  mat.userData.uniforms = uniforms
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms)
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <project_vertex>', `#include <project_vertex>\n${vertexWorld}`)
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${fragmentWeather}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fragmentNormal}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += wFire;')
      .replace('#include <aomap_fragment>', fragmentAo)
    if (o.haze) s.fragmentShader = s.fragmentShader.replace('#include <fog_fragment>', hazeFragment('vWPos', 'uWSun', 'uWGlow'))
  }
  mat.customProgramCacheKey = () => `world|${Object.keys(defines).join(',')}|${o.haze ? 'haze' : ''}`
  return mat
}

/** 水面：兩層不同方向、速度的波紋疊在一起，靠岸的地方有一圈白沫；水很濁，浮著一層油 */
export function flowing<T extends MeshStandardMaterial>(mat: T, look: WorldLook, haze: boolean): T {
  mat.onBeforeCompile = (s) => {
    s.uniforms.uWTime = look.uWTime
    s.uniforms.uWSun = look.uWSun
    s.uniforms.uWGlow = look.uWGlow
    s.uniforms.uWMask = look.uWMask
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <project_vertex>', `#include <project_vertex>\n${vertexWorld}`)
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform float uWTime;\nuniform vec3 uWSun;\nuniform vec3 uWGlow;\nuniform sampler2D uWMask;')
      .replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        /* glsl */ `
        vec2 wuv = vWPos.xz / 15.0;
        // 第二層轉個角度、換個大小，兩層疊起來才看不出貼圖在重複
        vec2 wuv2 = vec2( wuv.x * 0.8 - wuv.y * 0.6, wuv.x * 0.6 + wuv.y * 0.8 ) * 2.37;
        vec3 mapN = texture2D( normalMap, wuv + vec2( uWTime * 0.004, -uWTime * 0.026 ) ).xyz * 2.0 - 1.0;
        mapN += texture2D( normalMap, wuv2 + vec2( -uWTime * 0.012, -uWTime * 0.05 ) ).xyz * 2.0 - 1.0;
        // 遠的地方波紋收掉，不然會閃
        mapN.xy *= 1.0 - smoothstep( 60.0, 420.0, vViewPosition.z );
        mapN = normalize( mapN );`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        float shore = smoothstep( ${(RIVER - 3.2).toFixed(1)}, ${(RIVER - 0.2).toFixed(1)}, abs( vWPos.x ) );
        float ripple = texture2D( normalMap, vWPos.xz / 9.0 + vec2( 0.0, -uWTime * 0.05 ) ).x;
        float foam = shore * smoothstep( 0.42, 0.62, ripple + shore * 0.25 );
        // 浮在水面上的油污、灰：一片一片慢慢往下游漂
        float scum = smoothstep( 0.55, 0.8, texture2D( uWMask, vWPos.xz / 31.0 + vec2( 0.0, -uWTime * 0.012 ) ).r );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.07, 0.065, 0.05 ), scum * 0.6 );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.5, 0.5, 0.45 ), foam * 0.6 );
        diffuseColor.a = mix( diffuseColor.a, 0.97, max( foam, scum * 0.7 ) );`,
      )
    if (haze) s.fragmentShader = s.fragmentShader.replace('#include <fog_fragment>', hazeFragment('vWPos', 'uWSun', 'uWGlow'))
  }
  mat.customProgramCacheKey = () => `water${haze ? '|haze' : ''}`
  return mat
}
