/**
 * 塗鴉風格用的 SVG 濾鏡：用雜訊把線條推歪一點點，看起來像手畫的。
 * CSS 用 `filter: url(#doodle-rough)` 取用，只套在框線（::before）或圖案上，字不會跟著抖。
 * 放在 App 最外層一次就好（doodle.css 的 .doodle-defs 讓它不佔版面）。
 */
export default function DoodleDefs() {
  return (
    <svg className="doodle-defs" aria-hidden="true" focusable="false" width="0" height="0">
      <filter id="doodle-rough" x="-6%" y="-6%" width="112%" height="112%">
        <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="4" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  )
}
