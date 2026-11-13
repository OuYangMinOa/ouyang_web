// 太陽的輪廓：一圈 14 個圓鈍的尖角，像剪出來的星芒
const BURST = (() => {
  const points = Array.from({ length: 28 }, (_, i) => {
    const angle = (i * Math.PI) / 14 - Math.PI / 2
    const r = i % 2 ? 76 : 100
    return `${(180 + r * Math.cos(angle)).toFixed(1)} ${(160 + r * Math.sin(angle)).toFixed(1)}`
  })
  return `M${points.join('L')}Z`
})()

const STAR = 'M0 -24L6.6 -8.2L23.6 -7.4L10.4 3.4L14.6 20L0 10.6L-14.6 20L-10.4 3.4L-23.6 -7.4L-6.6 -8.2Z'
const HEART = 'M0 20C-26 2 -24 -20 -10 -20C-4 -20 0 -15 0 -11C0 -15 4 -20 10 -20C24 -20 26 2 0 20Z'
const BOLT = 'M6 -26L-16 4L-2 4L-8 26L16 -6L2 -6Z'
const SPARK = 'M0 -24C2 -8 8 -2 24 0C8 2 2 8 0 24C-2 8 -8 2 -24 0C-8 -2 -2 -8 0 -24Z'
const BUBBLE = 'M-40 -24H40A12 12 0 0 1 52 -12V10A12 12 0 0 1 40 22H-8L-26 38L-22 22H-40A12 12 0 0 1 -52 10V-12A12 12 0 0 1 -40 -24Z'

/**
 * 一張剪下來的貼紙：同一個形狀畫三層：往左下錯開的實心影子、一圈白邊、黑框加上顏色。
 * children 是畫在貼紙上面的東西（臉、字）。
 */
function Die({
  d,
  tone,
  x,
  y,
  tilt = 0,
  children,
}: {
  d: string
  tone: string
  x: number
  y: number
  tilt?: number
  children?: React.ReactNode
}) {
  return (
    <g className={`sticker-die is-${tone}`} transform={`translate(${x} ${y}) rotate(${tilt})`}>
      <g className="sticker-die-lift">
        <path className="sticker-die-shadow" d={d} transform="translate(-5 7)" />
        <path className="sticker-die-edge" d={d} />
        <path className="sticker-die-face" d={d} />
        {children}
      </g>
    </g>
  )
}

/** 貼紙風格的首頁太陽：一張笑臉太陽貼紙，旁邊貼幾張小的，取代 3D 粒子太陽（不用載入 three.js） */
export default function StickerSun() {
  return (
    <div className="sun-stage is-sticker">
      <svg className="sticker-sun" viewBox="0 0 360 320" aria-hidden="true">
        <Die d={BUBBLE} tone="surface" x={84} y={62} tilt={-8}>
          <text className="sticker-die-text" x="0" y="7" textAnchor="middle">
            HELLO!
          </text>
        </Die>
        <Die d={STAR} tone="yellow" x={300} y={66} tilt={12} />
        <Die d={HEART} tone="pink" x={56} y={232} tilt={-14} />
        <Die d={BOLT} tone="sky" x={312} y={236} tilt={10} />
        <Die d={SPARK} tone="mint" x={250} y={290} tilt={0} />
        <Die d={BURST} tone="pop" x={0} y={0}>
          <circle className="sticker-sun-disc" cx="180" cy="160" r="56" />
          <path className="sticker-sun-face" d="M158 150v10M202 150v10M160 176q20 18 40 0" />
          <circle className="sticker-sun-cheek" cx="146" cy="172" r="8" />
          <circle className="sticker-sun-cheek" cx="214" cy="172" r="8" />
        </Die>
      </svg>
      <div className="sun-caption">
        <span>SUN · 太陽</span>
      </div>
    </div>
  )
}
