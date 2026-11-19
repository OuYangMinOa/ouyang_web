import { Color, SRGBColorSpace } from 'three'

/**
 * 迷宮塔防 3D 畫面的顏色：全部讀 `index.css` 的變數（亮色、深色各一組），換主題時重讀一次。
 * 四張地圖各有一種地貌（草原、森林、秋天、峽谷），地面的顏色是從同一組變數調出來的，不另外寫死色碼。
 */

export type Theme = {
  dark: boolean
  bg: Color
  board: Color
  tileA: string
  tileB: string
  line: string
  walk: string
  rockTile: string
  water: string
  path: Color
  air: Color
  spawn: Color
  exit: Color
  ok: Color
  bad: Color
  gold: Color
  text: string
  surface: string
  okCss: string
  badCss: string
  warnCss: string
  goldCss: string
  airCss: string
  owners: Color[]
  ownersCss: string[]
}

/** 讓瀏覽器把任何 CSS 顏色（包含 `rgb(1 2 3 / 0.5)`）換成 Three.js 看得懂的寫法 */
function normalize(css: string, fallback: string): string {
  const ctx = (normalize.ctx ??= document.createElement('canvas').getContext('2d'))
  if (!ctx) return fallback
  ctx.fillStyle = fallback
  ctx.fillStyle = css.trim() || fallback
  return ctx.fillStyle
}
normalize.ctx = null as CanvasRenderingContext2D | null

export function readTheme(): Theme {
  const style = getComputedStyle(document.documentElement)
  const css = (name: string, fallback: string) => normalize(style.getPropertyValue(name), fallback)
  const color = (name: string, fallback: string) => new Color().setStyle(css(name, fallback))
  const bg = color('--bg', '#f4f0e8')
  return {
    dark: bg.r * 0.3 + bg.g * 0.6 + bg.b * 0.1 < 0.2,
    bg,
    board: color('--td-board', '#bfae8c'),
    tileA: css('--td-tile-a', '#b9c98a'),
    tileB: css('--td-tile-b', '#aebf7f'),
    line: css('--td-tile-line', '#8fa268'),
    walk: css('--td-walk', '#d9c8a0'),
    rockTile: css('--td-rock-tile', '#a39f96'),
    water: css('--td-water', '#6fb3d6'),
    path: color('--accent', '#c2410c'),
    air: color('--td-air', '#6b7fd6'),
    spawn: color('--td-spawn', '#7c3aed'),
    exit: color('--td-exit', '#0f766e'),
    ok: color('--ok', '#2f7d4f'),
    bad: color('--danger', '#be123c'),
    gold: color('--td-gold', '#b7770b'),
    text: css('--text-h', '#1c1a17'),
    surface: css('--surface', '#fbf8f2'),
    okCss: css('--ok', '#2f7d4f'),
    badCss: css('--danger', '#be123c'),
    warnCss: css('--accent', '#c2410c'),
    goldCss: css('--td-gold', '#b7770b'),
    airCss: css('--td-air', '#6b7fd6'),
    owners: Array.from({ length: 8 }, (_, i) => color(`--td-p${i}`, '#888888')),
    ownersCss: Array.from({ length: 8 }, (_, i) => css(`--td-p${i}`, '#888888')),
  }
}

const hsl = { h: 0, s: 0, l: 0 }
const scratch = new Color()

/** 調一個 CSS 顏色的色相、飽和度、亮度（在 sRGB 裡調，和設計工具看到的一樣），回傳 `#rrggbb` */
export function tweak(css: string, dh: number, ds: number, dl: number): string {
  scratch.setStyle(css).getHSL(hsl, SRGBColorSpace)
  scratch.setHSL((hsl.h + dh + 1) % 1, Math.min(1, Math.max(0, hsl.s + ds)), Math.min(1, Math.max(0, hsl.l + dl)), SRGBColorSpace)
  return `#${scratch.getHexString()}`
}

const rgbA = { r: 0, g: 0, b: 0 }
const rgbB = { r: 0, g: 0, b: 0 }

/** 兩個 CSS 顏色照比例混在一起（`t` 是 0 就是 `a`）；在 sRGB 裡混，和調色盤上看到的一樣 */
export function mix(a: string, b: string, t: number): string {
  scratch.setStyle(a).getRGB(rgbA, SRGBColorSpace)
  scratch.setStyle(b).getRGB(rgbB, SRGBColorSpace)
  scratch.setRGB(rgbA.r + (rgbB.r - rgbA.r) * t, rgbA.g + (rgbB.g - rgbA.g) * t, rgbA.b + (rgbB.b - rgbA.b) * t, SRGBColorSpace)
  return `#${scratch.getHexString()}`
}

/** CSS 顏色加上透明度，給 2D 畫布用 */
export function rgba(css: string, alpha: number): string {
  scratch.setStyle(css).getRGB(rgbA, SRGBColorSpace)
  return `rgba(${Math.round(rgbA.r * 255)},${Math.round(rgbA.g * 255)},${Math.round(rgbA.b * 255)},${alpha})`
}

/** 地貌：每張地圖一種，決定地面的色調、周圍長什麼、岩石的顏色 */
export type Biome = 'meadow' | 'forest' | 'autumn' | 'canyon'

const BIOMES: Record<string, Biome> = { plains: 'meadow', forks: 'forest', cross: 'autumn', canyon: 'canyon' }

export function biomeOf(map: string): Biome {
  return BIOMES[map] ?? 'meadow'
}

/** 這種地貌的地面顏色（都是從主題的那一組調出來的） */
export type Ground = {
  tileA: string
  tileB: string
  line: string
  /** 可以蓋塔的範圍外面那一圈 */
  rim: string
  walk: string
  /** 岩石底下的土 */
  dirt: string
  water: string
  /** 側面的土層和最底下的岩層 */
  soil: string
  stone: string
  /** 岩石模型要乘上的顏色 */
  rockTint: number
}

export function groundOf(theme: Theme, biome: Biome): Ground {
  const { tileA, tileB, line, walk, rockTile, water } = theme
  const board = `#${theme.board.getHexString()}`
  switch (biome) {
    case 'forest':
      return {
        tileA: tweak(tileA, 0.03, -0.01, -0.05),
        tileB: tweak(tileB, 0.03, -0.01, -0.05),
        line: tweak(line, 0.03, 0, -0.05),
        rim: tweak(tileB, 0.04, 0.01, -0.11),
        walk: tweak(walk, -0.01, -0.08, -0.05),
        dirt: tweak(rockTile, 0.02, 0.02, -0.06),
        water,
        soil: tweak(board, -0.01, -0.02, -0.06),
        stone: mix(board, rockTile, 0.65),
        rockTint: 0xd6e0cf,
      }
    case 'autumn':
      return {
        tileA: tweak(tileA, -0.04, 0.07, 0.01),
        tileB: tweak(tileB, -0.04, 0.07, 0.01),
        line: tweak(line, -0.04, 0.05, -0.01),
        rim: tweak(tileB, -0.05, 0.09, -0.05),
        walk: tweak(walk, -0.015, 0.03, -0.01),
        dirt: tweak(rockTile, 0, 0.05, -0.02),
        water,
        soil: tweak(board, -0.015, 0.06, -0.03),
        stone: mix(board, rockTile, 0.55),
        rockTint: 0xf0e2cf,
      }
    case 'canyon':
      return {
        tileA: tweak(mix(tileA, walk, 0.78), -0.03, 0.16, -0.035),
        tileB: tweak(mix(tileB, walk, 0.78), -0.03, 0.16, -0.035),
        line: tweak(mix(line, walk, 0.65), -0.04, 0.12, -0.11),
        rim: tweak(mix(tileB, walk, 0.85), -0.04, 0.18, -0.09),
        walk: tweak(walk, -0.03, 0.06, 0.04),
        dirt: tweak(mix(rockTile, walk, 0.5), -0.03, 0.14, -0.08),
        water,
        soil: tweak(board, -0.04, 0.16, -0.05),
        stone: tweak(mix(board, rockTile, 0.3), -0.04, 0.12, -0.12),
        rockTint: 0xf2b08a,
      }
    default:
      return {
        tileA,
        tileB,
        line,
        rim: tweak(tileB, 0.01, 0.02, -0.07),
        walk,
        dirt: rockTile,
        water,
        soil: board,
        stone: mix(board, rockTile, 0.6),
        rockTint: 0xffffff,
      }
  }
}
