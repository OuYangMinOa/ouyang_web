// 機甲的材質：一個網格裡每個零件照頂點帶的資料（`mechgeo.ts` 的 aLayer、aEdge、aHeight）分成幾層，在著色器裡疊出來。
//   - 漆面（主裝甲、副色）：每個零件、每塊面板深淺差一點；邊上的漆照雜訊一塊一塊掉，掉漆的地方先露出底漆、再露出鋼；
//     淺的刮痕只刮花表面、深的刮到底；漆面上再一層透明漆（clearcoat），高光才有兩層
//   - 沒上漆的鋼：拉絲的紋路，邊被磨亮
//   - 發黑處理的骨架：很暗的金屬，邊磨到露出鋼
//   - 鍍鉻的液壓桿：幾乎是鏡面
//   之後每一層再疊上：縫裡的油垢（照烘好的遮蔽貼圖和面板的溝）、直立的面上往下流的水漬、越靠近地面越厚的灰塵。
// 光：
//   - 環境光、反射照遮蔽貼圖壓暗（縫裡不會亮亮的反射天空）；亮的漆在縫裡照多次反彈的近似留一點顏色，不會死黑
//   - 很窄的縫連陽光也照不太進去（陰影貼圖解析不到的地方）
import { Color, MeshPhysicalMaterial, MeshStandardMaterial, Vector2, type Texture } from 'three'
import type { MechLighting } from './mechlight'
import { MASK_TILE, MICRO_TILE, PANEL_TILE, type MechTextures } from './mechtex'
import { hazeFragment } from './worldmat'

/** 所有機甲材質共用的參數（改這裡每一台都跟著變） */
export type MechLook = {
  uMasks: { value: Texture }
  uPanels: { value: Texture }
  uDecals: { value: Texture }
  /** 掉漆的程度（0～1）、從邊往裡面掉多寬（公尺） */
  uWear: { value: Vector2 }
  /** 油垢和水漬、灰塵各多重 */
  uDirt: { value: Vector2 }
  /** 面板線的法線多強 */
  uPanelDepth: { value: number }
  /** 烘好的遮蔽取幾次方（越大縫越黑） */
  uAoPower: { value: number }
}

export function createLook(tex: MechTextures): MechLook {
  return {
    uMasks: { value: tex.masks },
    uPanels: { value: tex.panels },
    uDecals: { value: tex.decals.texture },
    uWear: { value: new Vector2(0.5, 0.03) },
    uDirt: { value: new Vector2(1, 1) },
    uPanelDepth: { value: 1 },
    uAoPower: { value: 1.5 },
  }
}

const vertexPars = /* glsl */ `
  attribute vec4 aEdge;
  attribute vec4 aLayer;
  attribute float aHeight;
  attribute vec4 aDecal;
  attribute vec2 aDecalUv;
  varying vec2 vMUv;
  varying vec4 vEdge;
  varying vec4 vLayer;
  varying float vHeight;
  varying vec4 vDecal;
  varying vec2 vDecalUv;
  #ifdef MECH_LIGHT
    varying vec3 vMWorld;
    varying vec3 vMNormal;
  #endif
`

const vertexMain = /* glsl */ `
  vMUv = uv;
  vEdge = aEdge;
  vLayer = aLayer;
  vHeight = aHeight;
  vDecal = aDecal;
  vDecalUv = aDecalUv;
`

/** 接在 `project_vertex` 後面：世界座標的位置和法線（陰影、探針要用） */
const vertexWorld = /* glsl */ `
  #ifdef MECH_LIGHT
    vMWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
    vMNormal = mat3( modelMatrix ) * objectNormal;
  #endif
`

const fragmentPars = /* glsl */ `
  uniform sampler2D uMasks;
  uniform sampler2D uPanels;
  uniform sampler2D uDecals;
  uniform vec3 uArmor;
  uniform vec3 uTrim;
  uniform vec2 uWear;
  uniform vec2 uDirt;
  uniform float uPanelDepth;
  uniform float uAoPower;
  varying vec2 vMUv;
  varying vec4 vEdge;
  varying vec4 vLayer;
  varying float vHeight;
  varying vec4 vDecal;
  varying vec2 vDecalUv;
  // 環境光往哪個方向取（鏡頭座標）：烘出來的「沒被擋住的方向」
  vec3 mBentN;
  #ifdef MECH_LIGHT
    uniform sampler2DShadow uHeroMap;
    uniform mat4 uHeroMatrix;
    uniform vec4 uHeroInfo;
    uniform sampler2DShadow uCityMap;
    uniform mat4 uCityMatrix;
    uniform vec4 uCityInfo;
    uniform vec3 uSunDir;
    uniform sampler2D uSkyEnv;
    uniform vec4 uProbe;
    uniform vec2 uEnvGain;
    uniform vec3 uFogGlow;
    uniform mat3 normalMatrix;
    varying vec3 vMWorld;
    varying vec3 vMNormal;

    float mNoise( vec2 p ) {
      return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
    }
    vec2 mDisk( int i, float n, float phi ) {
      float r = sqrt( ( float( i ) + 0.5 ) / n );
      float t = float( i ) * 2.399963229728653 + phi;
      return vec2( cos( t ), sin( t ) ) * r;
    }

    // 太陽照不照得到這一點：機甲自己的影子（很密的那一張）乘上大樓的影子（整張地圖那一張）
    float mSunShadow() {
      vec3 n = normalize( vMNormal );
      // 越斜的面沿著法線移開越多再比（不然自己擋到自己）
      float slope = clamp( 1.0 - dot( n, uSunDir ), 0.0, 1.0 );
      float phi = mNoise( gl_FragCoord.xy ) * 6.2831853;
      float lit = 1.0;
      if ( uHeroInfo.z > 0.5 ) {
        vec4 c = uHeroMatrix * vec4( vMWorld + n * uHeroInfo.y * ( 1.2 + 2.6 * slope ), 1.0 );
        vec2 q = abs( c.xy - 0.5 );
        float rim = max( q.x, q.y );
        if ( rim < 0.5 && c.z < 1.0 ) {
          float z = c.z - uHeroInfo.w;
          float r = uHeroInfo.x * 1.7;
          float sum = 0.0;
          for ( int i = 0; i < 8; i ++ ) sum += texture( uHeroMap, vec3( c.xy + mDisk( i, 8.0, phi ) * r, z ) );
          // 靠近那張貼圖的邊慢慢淡掉（再外面的機甲沒有自陰影）
          lit = mix( 1.0, sum / 8.0, smoothstep( 0.5, 0.44, rim ) );
        }
      }
      if ( uCityInfo.z > 0.5 ) {
        vec4 c = uCityMatrix * vec4( vMWorld + n * uCityInfo.y * ( 0.6 + 1.2 * slope ), 1.0 );
        if ( c.x > 0.0 && c.x < 1.0 && c.y > 0.0 && c.y < 1.0 && c.z < 1.0 ) {
          float z = c.z - uCityInfo.w;
          float r = uCityInfo.x * 1.6;
          float sum = 0.0;
          for ( int i = 0; i < 5; i ++ ) sum += texture( uCityMap, vec3( c.xy + mDisk( i, 5.0, phi ) * r, z ) );
          lit *= sum / 5.0;
        }
      }
      return lit;
    }
  #endif
`

/** 取代 `envmap_physical_pars_fragment`：探針和天空兩張環境貼圖照離探針多遠混在一起；環境光往烘出來的方向取 */
const fragmentEnv = /* glsl */ `
  #ifdef MECH_LIGHT
    vec3 mEnv( vec3 dir, float roughness ) {
      float k = uProbe.w > 0.0 ? 1.0 - smoothstep( uProbe.w, uProbe.w * 1.6, distance( vMWorld, uProbe.xyz ) ) : 0.0;
      return mix( textureCubeUV( uSkyEnv, dir, roughness ).rgb, textureCubeUV( envMap, dir, roughness ).rgb, k );
    }
    vec3 getIBLIrradiance( const in vec3 normal ) {
      vec3 worldNormal = transformNormalByInverseViewMatrix( mBentN, viewMatrix );
      return PI * mEnv( envMapRotation * worldNormal, 1.0 ) * envMapIntensity * uEnvGain.x;
    }
    vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
      vec3 reflectVec = reflect( - viewDir, normal );
      reflectVec = normalize( mix( reflectVec, normal, pow4( roughness ) ) );
      reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
      return mEnv( envMapRotation * reflectVec, roughness ) * envMapIntensity * uEnvGain.y;
    }
  #else
    #include <envmap_physical_pars_fragment>
  #endif
`

/** 接在 `lights_fragment_begin` 後面：陽光乘上自己算的陰影（場景裡直接照過來的光只有太陽） */
const fragmentSun = /* glsl */ `
  #ifdef MECH_LIGHT
    float mSun = mSunShadow();
    reflectedLight.directDiffuse *= mSun;
    reflectedLight.directSpecular *= mSun;
    #ifdef USE_CLEARCOAT
      clearcoatSpecularDirect *= mSun;
    #endif
  #endif
`

/** 取代 `map_fragment`：算出這一點的顏色、粗糙度、金屬度、透明漆還剩多少 */
const fragmentLayers = /* glsl */ `
  float mLayer = vLayer.x;
  float mRnd = vLayer.y;
  vec4 mMask = texture2D( uMasks, vMUv * ${(1 / MASK_TILE).toFixed(5)} );
  vec4 mFine = texture2D( uMasks, vMUv * ${(3.7 / MASK_TILE).toFixed(5)} + vec2( 0.37, 0.61 ) );
  vec4 mPanel = texture2D( uPanels, vMUv * ${(1 / PANEL_TILE).toFixed(5)} );
  // 面板線：漆面最清楚，鋼和骨架淡一點，鍍鉻沒有；小零件不畫
  float mPanelW = vLayer.z * ( mLayer < 1.5 ? 1.0 : ( mLayer < 3.5 ? 0.55 : 0.0 ) );
  #ifdef USE_AOMAP
    vec4 mBake = texture2D( aoMap, vAoMapUv );
    mBake.r = pow( mBake.r, uAoPower );
  #else
    vec4 mBake = vec4( 1.0, 0.5, 0.5, 0.5 );
  #endif
  float mCavity = 1.0 - mBake.r;

  // 離這個面的邊多遠：0 在邊上（倒角整條都是）、1 在掉漆的範圍以外
  float mEdgeD = min( min( vEdge.x, vEdge.y ), min( vEdge.z, vEdge.w ) );
  float mFaceMin = min( vEdge.x + vEdge.z, vEdge.y + vEdge.w );
  float mBand = min( uWear.y, mFaceMin * 0.5 + 0.004 );
  float mEdge = 1.0 - clamp( mEdgeD / mBand, 0.0, 1.0 );

  float mChipNoise = mMask.b * 0.6 + mFine.b * 0.4;
  float mWear = uWear.x * ( 0.7 + mRnd * 0.6 );
  float mScr = mMask.g;
  // 掉漆：邊上掉得多、往裡面零零碎碎；很深的刮痕也刮到底
  float mChipV = mEdge * mEdge * 0.5 + mChipNoise * 0.55 + mWear * 0.25 - 0.98;
  mChipV = max( mChipV, ( mScr - 0.94 ) * 0.5 + ( mChipNoise - 0.6 ) * 0.1 );
  float mChip = smoothstep( 0.0, 0.03, mChipV );
  float mPrimer = smoothstep( -0.075, -0.02, mChipV ) * ( 1.0 - mChip );

  vec3 mPaint = mLayer < 0.5 ? uArmor : uTrim;
  mPaint *= 0.86 + ( mRnd - 0.5 ) * 0.16 + ( mPanel.a - 0.5 ) * 0.18 * mPanelW;
  mPaint = mix( mPaint, mPaint * 0.72 + vec3( 0.012 ), mMask.r * 0.35 );
  // 噴在漆上的標誌（型號、隊徽、警示條…）：有點褪色、斑駁；掉漆、髒污照樣蓋在它上面。
  // 標誌圖的顏色是乘過透明度的螢幕顏色：先除回來、轉成線性的再混
  vec2 mDq = vDecalUv;
  float mDecalIn = step( 0.0, mDq.x ) * step( mDq.x, 1.0 ) * step( 0.0, mDq.y ) * step( mDq.y, 1.0 );
  vec4 mDecal = texture2D( uDecals, mix( vDecal.xy, vDecal.zw, clamp( mDq, 0.0, 1.0 ) ) );
  float mDecalA = mDecal.a * mDecalIn * ( 0.94 - 0.5 * mMask.r * mFine.b );
  mPaint = mix( mPaint, pow( mDecal.rgb / max( mDecal.a, 0.004 ), vec3( 2.2 ) ) * 0.82, mDecalA );
  vec3 mPrimerCol = mix( mPaint, vec3( 0.6, 0.58, 0.53 ), 0.62 );
  vec3 mSteel = vec3( 0.56, 0.57, 0.58 ) * ( 0.7 + 0.42 * mFine.r );
  float mLight = smoothstep( 0.5, 0.95, mScr ) * ( 1.0 - mChip );

  vec3 mAlbedo = mix( mPaint, mPaint * 1.25 + 0.02, mLight * 0.3 );
  float mRough = 0.42 + ( mMask.r - 0.5 ) * 0.24 - ( mPanel.a - 0.5 ) * 0.1 * mPanelW + mLight * 0.16;
  float mMetal = mChip;
  float mCoat = ( 1.0 - mChip ) * ( 1.0 - mPrimer ) * ( 1.0 - mLight * 0.6 );
  mAlbedo = mix( mAlbedo, mPrimerCol, mPrimer );
  mRough = mix( mRough, 0.72, mPrimer );
  mAlbedo = mix( mAlbedo, mSteel, mChip );
  mRough = mix( mRough, 0.28 + mFine.r * 0.24, mChip );

  if ( mLayer > 1.5 ) {
    mCoat = 0.0;
    // 沿著一個方向拉長的紋路：拉絲
    float mBrush = texture2D( uMasks, vec2( vMUv.x * 0.21, vMUv.y * 2.9 ) ).a;
    if ( mLayer < 2.5 ) {
      mAlbedo = vec3( 0.5, 0.51, 0.53 ) * ( 0.72 + 0.3 * mMask.r + 0.12 * mRnd ) + mEdge * 0.1;
      mRough = 0.33 + mMask.r * 0.2 + mBrush * 0.14 - mEdge * 0.1 + mLight * 0.1;
      mMetal = 1.0;
    } else if ( mLayer < 3.5 ) {
      float mWorn = smoothstep( 0.0, 0.06, mEdge * mEdge * 0.55 + mChipNoise * 0.5 + mWear * 0.25 - 0.86 );
      mWorn = max( mWorn, mLight * 0.35 );
      mAlbedo = mix( vec3( 0.085, 0.09, 0.1 ) * ( 0.75 + 0.5 * mMask.r ), mSteel * 0.92, mWorn );
      mRough = mix( 0.5 + mMask.r * 0.22, 0.3 + mFine.r * 0.15, mWorn );
      mMetal = 1.0;
    } else {
      mAlbedo = vec3( 0.86, 0.87, 0.9 );
      mRough = 0.07 + mMask.r * 0.1 + mLight * 0.12;
      mMetal = 1.0;
    }
  }

  // 縫裡的油垢：照烘好的遮蔽、面板的溝
  float mGrime = clamp( smoothstep( 0.18, 0.75, mCavity ) * ( 0.4 + 0.6 * mMask.r ) + mPanel.b * mPanelW * 0.8, 0.0, 1.0 ) * uDirt.x;
  mAlbedo = mix( mAlbedo, mAlbedo * 0.28 + vec3( 0.016, 0.014, 0.012 ), mGrime );
  mRough = mix( mRough, 0.88, mGrime );
  mMetal *= 1.0 - mGrime * 0.6;
  mCoat *= 1.0 - mGrime;
  // 水漬：直立的面上往下流，一片一片的（不是整面都有）
  float mDripZone = smoothstep( 0.4, 0.8, texture2D( uMasks, vMUv * 0.19 + vec2( 0.13, 0.71 ) ).r );
  float mDrip = smoothstep( 0.15, 0.9, texture2D( uMasks, vMUv * vec2( 0.52, 0.27 ) ).a ) * mDripZone * vLayer.w * uDirt.x;
  mAlbedo *= 1.0 - mDrip * 0.42;
  mRough = mix( mRough, 0.78, mDrip * 0.6 );
  mCoat *= 1.0 - mDrip * 0.5;
  // 灰塵：越靠近地面越厚
  float mLow = 1.0 - smoothstep( 0.1, 2.8, vHeight );
  float mDust = clamp( mLow * ( 0.3 + 0.95 * mMask.r ) + mCavity * 0.2, 0.0, 1.0 ) * uDirt.y * ( mLayer > 1.5 ? 0.6 : 1.0 );
  mAlbedo = mix( mAlbedo, vec3( 0.3, 0.265, 0.22 ), mDust * 0.5 );
  mRough = mix( mRough, 0.95, mDust * 0.8 );
  mMetal *= 1.0 - mDust * 0.7;
  mCoat *= 1.0 - mDust * 0.85;

  diffuseColor.rgb = mAlbedo;
`

/** 取代 `normal_fragment_maps`：細的法線（照層調強弱）加上面板線 */
const fragmentNormal = /* glsl */ `
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  float mMicro = mLayer > 3.5 ? 0.12 : ( mLayer > 1.5 ? 0.6 : 0.8 );
  mapN.xy *= normalScale * mMicro * ( 1.0 + mChip * 0.8 );
  mapN.xy += ( mPanel.rg * 2.0 - 1.0 ) * mPanelW * uPanelDepth;
  normal = normalize( tbn * normalize( mapN ) );
  mBentN = normal;
  #if defined( MECH_LIGHT ) && ! defined( MECH_FAR )
    // 烘出來的方向是關節自己的座標；細節法線的偏移也加上去（遠處的簡化版整台是一個網格，沒有關節的座標，不用）
    vec3 mBentL = mBake.gba * 2.0 - 1.0;
    if ( dot( mBentL, mBentL ) > 0.05 ) mBentN = normalize( normalize( normalMatrix * mBentL ) + normal - nonPerturbedNormal );
  #endif
`

/** 取代 `aomap_fragment` */
const fragmentAo = /* glsl */ `
  #ifdef USE_AOMAP
    float ambientOcclusion = ( mBake.r - 1.0 ) * aoMapIntensity + 1.0;
  #else
    float ambientOcclusion = 1.0;
  #endif
  ambientOcclusion *= 1.0 - mPanel.b * mPanelW * 0.55;
  // 多次反彈的近似（Jimenez 2016）：顏色亮的地方縫裡留一點顏色
  vec3 mAoA = 2.0404 * diffuseColor.rgb - 0.3324;
  vec3 mAoB = -4.7951 * diffuseColor.rgb + 0.6417;
  vec3 mAoC = 2.7552 * diffuseColor.rgb + 0.6903;
  vec3 mAoColor = max( vec3( ambientOcclusion ), ( ( ambientOcclusion * mAoA + mAoB ) * ambientOcclusion + mAoC ) * ambientOcclusion );
  reflectedLight.indirectDiffuse *= mAoColor;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
  reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  // 很窄的縫陽光也照不太進去
  float mMicroShadow = mix( 1.0, smoothstep( 0.0, 0.45, ambientOcclusion ), 0.65 );
  reflectedLight.directDiffuse *= mMicroShadow;
  reflectedLight.directSpecular *= mMicroShadow;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularDirect *= mMicroShadow;
  #endif
`

/** 取代 `fog_fragment`：和場景同一種霧（貼著地面比較濃、朝太陽那一邊偏暖），遠處的機甲才和後面的大樓融在同一層霧裡 */
const fragmentFog = /* glsl */ `
  #ifdef MECH_LIGHT
    ${hazeFragment('vMWorld', 'uSunDir', 'uFogGlow')}
  #else
    #include <fog_fragment>
  #endif
`

export type BodyMaterial = MeshPhysicalMaterial | MeshStandardMaterial

export type BodyOptions = {
  look: MechLook
  textures: MechTextures
  armor: number
  trim: number
  /** 烘好的遮蔽貼圖（用 uv1）；還沒烘是 null */
  ao: Texture | null
  /** 手機：不要透明漆那一層（省一半的高光計算） */
  lite: boolean
  /** 機甲專用的陰影和反射探針；沒有就用場景的陰影、天空的環境貼圖 */
  light: MechLighting | null
  /** 遠處的簡化版用的（整台合成一個網格）：沒有透明漆那一層 */
  far?: boolean
}

/** 機甲本體的材質：一隊、一種機甲一個（顏色和遮蔽貼圖不一樣，著色器是同一個） */
export function createBodyMaterial(o: BodyOptions): BodyMaterial {
  const params = {
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0,
    normalMap: o.textures.micro,
    normalScale: new Vector2(0.22, 0.22),
    aoMap: o.ao,
    aoMapIntensity: 1,
  }
  const mat = o.lite || o.far ? new MeshStandardMaterial(params) : new MeshPhysicalMaterial({ ...params, clearcoat: 0.7, clearcoatRoughness: 0.2 })
  if (o.far) mat.defines = { ...mat.defines, MECH_FAR: '' }
  // 細的法線貼圖一格 MICRO_TILE 公尺（貼圖座標是公尺）
  o.textures.micro.repeat.setScalar(1 / MICRO_TILE)
  const uniforms = {
    ...o.look,
    ...o.light?.uniforms,
    uArmor: { value: new Color(o.armor) },
    uTrim: { value: new Color(o.trim) },
  }
  if (o.light) {
    mat.envMap = o.light.envMap
    mat.defines = { ...mat.defines, MECH_LIGHT: '' }
  }
  mat.userData.uniforms = uniforms
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms)
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\n${vertexPars}`).replace('#include <uv_vertex>', `#include <uv_vertex>\n${vertexMain}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${vertexWorld}`)
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <envmap_physical_pars_fragment>', fragmentEnv)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>\n${fragmentSun}`)
      .replace('#include <map_fragment>', fragmentLayers)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp( mRough, 0.04, 1.0 );')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = clamp( mMetal, 0.0, 1.0 );')
      .replace('#include <normal_fragment_maps>', fragmentNormal)
      .replace(
        '#include <clearcoat_normal_fragment_begin>',
        '#include <clearcoat_normal_fragment_begin>\n#ifdef USE_CLEARCOAT\nclearcoatNormal = normalize( mix( nonPerturbedNormal, normal, 0.65 ) );\n#endif',
      )
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= mCoat;\n#endif')
      .replace('#include <aomap_fragment>', fragmentAo)
      .replace('#include <fog_fragment>', fragmentFog)
  }
  mat.customProgramCacheKey = () => `mech-body${o.light ? '-light' : ''}${o.far ? '-far' : ''}`
  return mat
}
