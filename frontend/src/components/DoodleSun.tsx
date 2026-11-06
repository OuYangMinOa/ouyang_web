// 太陽的光芒：12 條長短交錯、角度稍微歪一點，像隨手畫的
const RAYS = Array.from({ length: 12 }, (_, i) => {
  const angle = (i * Math.PI) / 6 + ((i % 3) - 1) * 0.05
  const inner = 74
  const outer = i % 2 ? 94 : 106
  const point = (r: number) => `${(120 + r * Math.cos(angle)).toFixed(1)} ${(120 + r * Math.sin(angle)).toFixed(1)}`
  return `M${point(inner)}L${point(outer)}`
}).join('')

/** 塗鴉風格的首頁太陽：手畫的笑臉太陽，取代 3D 粒子太陽（不用載入 three.js） */
export default function DoodleSun() {
  return (
    <div className="sun-stage is-doodle">
      <svg className="doodle-sun" viewBox="0 0 240 240" aria-hidden="true">
        <g filter="url(#doodle-rough)">
          <path className="doodle-sun-rays" d={RAYS} />
          <circle className="doodle-sun-disc" cx="120" cy="120" r="56" />
          {/* 描第二圈沒對準的線，像畫兩次 */}
          <path className="doodle-sun-loop" d="M68 108 C 76 66, 164 58, 177 118 C 186 170, 94 186, 70 138" />
          <path className="doodle-sun-face" d="M98 112 q7 -9 14 0 M128 112 q7 -9 14 0 M100 134 q20 18 40 0" />
          <circle className="doodle-sun-cheek" cx="92" cy="128" r="7" />
          <circle className="doodle-sun-cheek" cx="148" cy="128" r="7" />
        </g>
      </svg>
      <div className="sun-caption">
        <span>SUN · 太陽</span>
      </div>
    </div>
  )
}
