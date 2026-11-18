import type { CSSProperties, ReactNode } from 'react'
import { useIcons } from './icons'
import { MONSTER_LOOK, TOWER_LOOK } from './models'
import type { MonsterId, TowerId } from './online'

/**
 * 迷宮塔防介面上的圖：
 * - `Glyph`：按鈕、數字旁邊的小符號，用 SVG 畫（跟著文字的顏色走；表情符號每個系統長得不一樣，深色主題下也常常看不清楚）
 * - `TowerArt`、`MonsterArt`：塔和怪物真正的 3D 模型拍出來的小圖（`icons.ts`），還沒拍好或拍不了時退回表情符號
 */

export type GlyphName =
  | 'back'
  | 'heart'
  | 'coin'
  | 'skull'
  | 'speed'
  | 'players'
  | 'menu'
  | 'expand'
  | 'shrink'
  | 'sound'
  | 'mute'
  | 'sword'
  | 'target'
  | 'close'
  | 'up'
  | 'check'
  | 'route'
  | 'info'
  | 'down'
  | 'ping'

const SHAPES: Record<GlyphName, ReactNode> = {
  back: <path d="M14.5 5 7.5 12l7 7" />,
  heart: <path d="M12 20.3s-7.6-4.7-7.6-10.4A4.4 4.4 0 0 1 12 7.2a4.4 4.4 0 0 1 7.6 2.7c0 5.7-7.6 10.4-7.6 10.4Z" fill="currentColor" />,
  coin: (
    <>
      <circle cx="12" cy="12" r="8.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="5" stroke="var(--surface)" strokeWidth="1.7" opacity="0.8" />
    </>
  ),
  skull: (
    <>
      <path d="M12 3.6a7.6 7.6 0 0 0-7.6 7.6c0 2.5 1.2 4.5 3 5.7V19a1.4 1.4 0 0 0 1.4 1.4h6.4A1.4 1.4 0 0 0 16.6 19v-2.1c1.8-1.2 3-3.2 3-5.7A7.6 7.6 0 0 0 12 3.6Z" />
      <circle cx="9.2" cy="11.4" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="11.4" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  speed: <path d="M4.5 6.5 11 12l-6.5 5.5ZM13 6.5l6.5 5.5-6.5 5.5Z" fill="currentColor" />,
  players: (
    <>
      <circle cx="9" cy="8.6" r="3.1" />
      <path d="M3.4 19c.6-3.1 2.8-4.9 5.6-4.9s5 1.8 5.6 4.9" />
      <circle cx="16.8" cy="8" r="2.4" />
      <path d="M16 14.2c2.5.2 4.1 1.8 4.6 4.6" />
    </>
  ),
  menu: <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />,
  expand: <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />,
  shrink: <path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5" />,
  sound: (
    <>
      <path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4Z" fill="currentColor" />
      <path d="M15 9a4.2 4.2 0 0 1 0 6M17.6 6.6a7.6 7.6 0 0 1 0 10.8" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4Z" fill="currentColor" />
      <path d="m15.5 9.5 5 5M20.5 9.5l-5 5" />
    </>
  ),
  sword: <path d="M20 4h-3.6L7.6 12.8l3.6 3.6L20 7.6ZM5.4 11.4l7.2 7.2M8.4 15.6 4.4 19.6" />,
  target: (
    <>
      <circle cx="12" cy="12" r="7.2" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  up: <path d="M12 19.5V5.5M6 11.5l6-6 6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  route: <path d="M5 18.5c0-5 4-3.5 7-6.5s2-6.5 7-6.5M16.5 3l2.8 2.5L16.5 8" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 11.2v5M12 7.7v.2" />
    </>
  ),
  down: <path d="m6 9.5 6 6 6-6" />,
  ping: <path d="M12 21s-6.4-5.7-6.4-10.7a6.4 6.4 0 0 1 12.8 0C18.4 15.3 12 21 12 21ZM12 7.2v3.6M12 13.5v.2" />,
}

export function Glyph({ name, size = 20 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className={`td-glyph td-glyph-${name}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  )
}

function Art({ src, emoji, size, className }: { src: string | undefined; emoji: string; size: number; className?: string }) {
  const style = { '--art': `${size}px` } as CSSProperties
  return src ? (
    <img className={`td-art${className ? ` ${className}` : ''}`} style={style} src={src} alt="" width={size} height={size} draggable={false} />
  ) : (
    <span className={`td-art td-art-emoji${className ? ` ${className}` : ''}`} style={style} aria-hidden="true">
      {emoji}
    </span>
  )
}

/** 一種塔的圖（`level` 是 1～4，每一級長得不一樣） */
export function TowerArt({ id, level = 1, size = 40, className }: { id: TowerId; level?: number; size?: number; className?: string }) {
  const icons = useIcons()
  return <Art src={icons?.towers[id]?.[level - 1]} emoji={TOWER_LOOK[id].icon} size={size} className={className} />
}

export function MonsterArt({ id, size = 28, className }: { id: MonsterId; size?: number; className?: string }) {
  const icons = useIcons()
  return <Art src={icons?.monsters[id]} emoji={MONSTER_LOOK[id].icon} size={size} className={className} />
}
