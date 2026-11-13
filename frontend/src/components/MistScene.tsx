import { Fragment } from 'react'

type Point = [x: number, y: number]

const WIDTH = 560
const HEIGHT = 440

/** 把折線畫成稜線：山坡是直的，山頂和山谷磨圓（radius 是磨圓的大小），再往下封到畫面底下 */
function ridge(points: Point[], radius: number): string {
  let d = `M${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    const before = Math.hypot(x - px, y - py)
    const after = Math.hypot(nx - x, ny - y)
    const r = Math.min(radius, before / 2, after / 2)
    const from = `${(x - ((x - px) / before) * r).toFixed(1)} ${(y - ((y - py) / before) * r).toFixed(1)}`
    const to = `${(x + ((nx - x) / after) * r).toFixed(1)} ${(y + ((ny - y) / after) * r).toFixed(1)}`
    d += `L${from}Q${x} ${y} ${to}`
  }
  const [lastX, lastY] = points[points.length - 1]
  return `${d}L${lastX} ${lastY}V${HEIGHT + 20}H${points[0][0]}Z`
}

// 由遠到近五層山。path 是稜線；fog 是山腳的霧從哪個高度開始、到哪裡最濃（最近的那層直接淡出到頁面裡）
const RIDGES: { path: string; fog?: [from: number, to: number] }[] = [
  {
    // 最遠的兩座山，太陽從中間的鞍部（300, 214）升起來
    path: ridge(
      [
        [-20, 232], [60, 214], [120, 196], [196, 150], [248, 186], [300, 214],
        [352, 176], [420, 128], [480, 172], [530, 196], [580, 188],
      ],
      16,
    ),
    fog: [186, 272],
  },
  {
    path: ridge(
      [
        [-20, 262], [50, 250], [118, 226], [180, 252], [250, 268],
        [330, 246], [392, 226], [450, 252], [520, 240], [580, 262],
      ],
      18,
    ),
    fog: [248, 318],
  },
  {
    path: ridge(
      [
        [-20, 300], [60, 310], [140, 286], [214, 270], [280, 298],
        [350, 314], [430, 290], [498, 274], [548, 292], [580, 288],
      ],
      18,
    ),
    fog: [294, 362],
  },
  {
    path: ridge(
      [[-20, 350], [70, 332], [132, 322], [210, 344], [300, 358], [380, 338], [448, 326], [520, 346], [580, 340]],
      22,
    ),
    fog: [344, 406],
  },
  {
    path: ridge([[-20, 396], [100, 384], [200, 394], [300, 402], [400, 388], [480, 392], [580, 380]], 30),
  },
]

// 畫面左右兩邊各用多寬淡出
const EDGE = 150
// 淡出的漸層：從透明慢慢變成頁面的底色，兩頭都放緩，看不出是從哪裡開始淡的
const FADE = [0, 0.04, 0.16, 0.38, 0.64, 0.86, 0.97, 1].map((opacity, i, all) => (
  <stop key={i} offset={i / (all.length - 1)} className="mist-edge-stop" stopOpacity={opacity} />
))

// 夜裡的星星：x、y、半徑
const STARS: [x: number, y: number, r: number][] = [
  [40, 62, 1.3],
  [96, 122, 1],
  [150, 44, 1.2],
  [226, 88, 1],
  [268, 38, 1.4],
  [372, 60, 1],
  [462, 84, 1.2],
  [510, 40, 1],
  [538, 132, 1.1],
  [24, 156, 1],
]

/**
 * 山嵐風格的首頁：一幅不會動的山景，取代 3D 粒子太陽（不用載入 three.js）。
 * 亮色是太陽從起霧的山後面升起來，深色是月亮和幾顆星星；顏色都來自 index.css 的 --mist-* 變數。
 */
export default function MistScene() {
  return (
    <div className="sun-stage is-mist">
      <svg className="mist-scene" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
        <defs>
          <radialGradient id="mist-scene-halo">
            <stop offset="0" className="mist-halo-stop" stopOpacity="1" />
            <stop offset="1" className="mist-halo-stop" stopOpacity="0" />
          </radialGradient>
          {RIDGES.map(
            ({ path, fog }, i) =>
              fog && (
                <Fragment key={i}>
                  {/* 霧只蓋在這一層山上，不會蓋到天空和太陽 */}
                  <clipPath id={`mist-scene-ridge-${i}`}>
                    <path d={path} />
                  </clipPath>
                  <linearGradient
                    id={`mist-scene-fog-${i}`}
                    gradientUnits="userSpaceOnUse"
                    x1="0"
                    y1={fog[0]}
                    x2="0"
                    y2={fog[1]}
                  >
                    <stop offset="0" className="mist-fog-stop" stopOpacity="0" />
                    <stop offset="1" className="mist-fog-stop" stopOpacity="1" />
                  </linearGradient>
                </Fragment>
              ),
          )}
          {/* 左、右、下三邊淡出成頁面的底色，畫面不需要框；漸層以外的地方會一直是底色，蓋住超出畫面的山 */}
          <linearGradient id="mist-scene-edge-l" gradientUnits="userSpaceOnUse" x1={EDGE} y1="0" x2="0" y2="0">
            {FADE}
          </linearGradient>
          <linearGradient id="mist-scene-edge-r" gradientUnits="userSpaceOnUse" x1={WIDTH - EDGE} y1="0" x2={WIDTH} y2="0">
            {FADE}
          </linearGradient>
          <linearGradient id="mist-scene-edge-b" gradientUnits="userSpaceOnUse" x1="0" y1={HEIGHT - 76} x2="0" y2={HEIGHT - 4}>
            {FADE}
          </linearGradient>
        </defs>

        <g className="mist-stars">
          {STARS.map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} />
          ))}
        </g>
        <circle cx="306" cy="176" r="150" fill="url(#mist-scene-halo)" />
        <circle className="mist-disc" cx="306" cy="176" r="40" />

        {RIDGES.map(({ path, fog }, i) => (
          <g key={i}>
            <path className={`mist-ridge-${i + 1}`} d={path} />
            {fog && (
              <rect
                x="-20"
                y={fog[0]}
                width={WIDTH + 40}
                height={HEIGHT + 20 - fog[0]}
                fill={`url(#mist-scene-fog-${i})`}
                clipPath={`url(#mist-scene-ridge-${i})`}
              />
            )}
          </g>
        ))}

        <rect x="-600" y="-200" width={600 + EDGE} height={HEIGHT + 400} fill="url(#mist-scene-edge-l)" />
        <rect x={WIDTH - EDGE} y="-200" width={600 + EDGE} height={HEIGHT + 400} fill="url(#mist-scene-edge-r)" />
        <rect x="-600" y={HEIGHT - 76} width={WIDTH + 1200} height="276" fill="url(#mist-scene-edge-b)" />
      </svg>
      <div className="sun-caption">
        <span>MIST · 山嵐</span>
      </div>
    </div>
  )
}
