import { COLS, HIDDEN, NUISANCE, ROWS, SPAWN_X, SPAWN_Y, cellsOf, index, type Pair, type Puyo } from './engine'

export type Palette = {
  /** 索引 1～5：四種顏色與干擾泡 */
  cells: string[]
  bg: string
  grid: string
  eye: string
  pupil: string
  danger: string
  warn: string
  /** 大逃殺的小盤面用 */
  text: string
  muted: string
  accent: string
  scrim: string
}

/** Canvas 不認得 CSS 變數，只能從計算後的樣式讀出實際顏色（主題切換時要重讀） */
export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    cells: ['', ...Array.from({ length: NUISANCE }, (_, i) => v(`--puyo-${i + 1}`))],
    bg: v('--puyo-bg'),
    grid: v('--border'),
    eye: v('--puyo-eye'),
    pupil: v('--puyo-pupil'),
    danger: v('--danger'),
    warn: v('--warn'),
    text: v('--text-h'),
    muted: v('--text'),
    accent: v('--accent'),
    scrim: v('--scrim'),
  }
}

/** 盤面上方顯示待落下干擾泡的那一條，高度以格為單位 */
export const TRAY = 0.9
export const BOARD_ASPECT = (ROWS + TRAY) / COLS

/** 一顆氣泡：圓形、左上一點亮面、兩隻眼睛；干擾泡是灰的、眼睛小一點 */
function puyo(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, color: number, c: Palette, scale = 1) {
  const r = s * 0.46 * scale
  ctx.fillStyle = c.cells[color]
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgb(255 255 255 / 0.28)'
  ctx.beginPath()
  ctx.ellipse(cx - r * 0.35, cy - r * 0.45, r * 0.32, r * 0.2, -0.5, 0, Math.PI * 2)
  ctx.fill()
  if (r < 3) return
  const nuisance = color === NUISANCE
  const eyeR = r * (nuisance ? 0.16 : 0.24)
  for (const side of [-1, 1]) {
    const ex = cx + side * r * 0.36
    const ey = cy + r * 0.08
    ctx.fillStyle = c.eye
    ctx.beginPath()
    ctx.ellipse(ex, ey, eyeR, eyeR * 1.25, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = c.pupil
    ctx.beginPath()
    ctx.arc(ex + side * eyeR * 0.15, ey + eyeR * 0.25, eyeR * 0.55, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** 同色相鄰的氣泡之間畫一座橋，看起來黏在一起 */
function bridge(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, s: number, color: string) {
  const w = s * 0.56
  ctx.fillStyle = color
  if (x1 === x2) ctx.fillRect(x1 - w / 2, Math.min(y1, y2), w, Math.abs(y2 - y1))
  else ctx.fillRect(Math.min(x1, x2), y1 - w / 2, Math.abs(x2 - x1), w)
}

/** 待落下的干擾泡：星 180、岩 30、大 6、小 1，最多畫 6 個 */
const TRAY_UNITS: [number, 'star' | 'rock' | 'big' | 'small'][] = [
  [180, 'star'],
  [30, 'rock'],
  [6, 'big'],
  [1, 'small'],
]

function drawTray(ctx: CanvasRenderingContext2D, w: number, s: number, pending: number, c: Palette) {
  const icons: (typeof TRAY_UNITS)[number][1][] = []
  let left = pending
  for (const [n, icon] of TRAY_UNITS) {
    while (left >= n && icons.length < COLS) {
      icons.push(icon)
      left -= n
    }
  }
  const h = s * TRAY
  const cy = h / 2
  icons.forEach((icon, i) => {
    const cx = (i + 0.5) * (w / COLS)
    ctx.fillStyle = icon === 'star' ? c.warn : icon === 'rock' ? c.danger : c.cells[NUISANCE]
    ctx.beginPath()
    if (icon === 'star') {
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? h * 0.18 : h * 0.42
        const a = -Math.PI / 2 + (k * Math.PI) / 5
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
      }
    } else if (icon === 'rock') {
      ctx.roundRect(cx - h * 0.4, cy - h * 0.36, h * 0.8, h * 0.72, h * 0.2)
    } else {
      ctx.arc(cx, cy, h * (icon === 'big' ? 0.38 : 0.2), 0, Math.PI * 2)
    }
    ctx.fill()
  })
}

/** 主盤面：上面一條待落下的干擾泡，下面 6 × 12 格（第 13 列不畫） */
export function drawBoard(ctx: CanvasRenderingContext2D, w: number, game: Puyo, c: Palette) {
  const s = w / COLS
  const top = s * TRAY
  const h = top + s * ROWS
  ctx.clearRect(0, 0, w, h)
  drawTray(ctx, w, s, game.pending, c)

  ctx.save()
  ctx.beginPath()
  ctx.roundRect(0, top, w, s * ROWS, s * 0.2)
  ctx.clip()
  ctx.fillStyle = c.bg
  ctx.fillRect(0, top, w, s * ROWS)
  ctx.strokeStyle = c.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 1; x < COLS; x++) {
    ctx.moveTo(x * s + 0.5, top)
    ctx.lineTo(x * s + 0.5, h)
  }
  ctx.stroke()

  // 出生的格子：被堵住就輸了
  if (!game.get(SPAWN_X, SPAWN_Y)) {
    const cx = (SPAWN_X + 0.5) * s
    const cy = top + (SPAWN_Y - HIDDEN + 0.5) * s
    const d = s * 0.22
    ctx.strokeStyle = c.danger
    ctx.globalAlpha = 0.55
    ctx.lineWidth = Math.max(1.5, s * 0.08)
    ctx.beginPath()
    ctx.moveTo(cx - d, cy - d)
    ctx.lineTo(cx + d, cy + d)
    ctx.moveTo(cx + d, cy - d)
    ctx.lineTo(cx - d, cy + d)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // 每顆氣泡現在畫在哪一列：掉落中的照動畫進度，越掉越快
  const anim = game.anim
  const rowOf = (cell: number) => {
    const y = Math.floor(cell / COLS)
    if (anim?.kind !== 'fall') return y
    const from = anim.from.get(cell)
    if (from === undefined) return y
    const t = Math.min(anim.t / anim.dur, 1)
    return from + (y - from) * t * t
  }
  const popping = anim?.kind === 'pop' ? new Set(anim.cells) : null
  const center = (x: number, row: number): [number, number] => [(x + 0.5) * s, top + (row - HIDDEN + 0.5) * s]

  // 消除中的氣泡閃爍，最後縮小
  let popAlpha = 1
  let popScale = 1
  if (anim?.kind === 'pop') {
    const t = anim.t / anim.dur
    popAlpha = t < 0.7 ? 0.55 + 0.45 * Math.cos(t * Math.PI * 8) : 1
    popScale = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3
  }

  const steady = anim?.kind !== 'fall'
  for (let y = HIDDEN; y < HIDDEN + ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = index(x, y)
      const color = game.board[cell]
      if (!color || color === NUISANCE || !steady) continue
      const [cx, cy] = center(x, y)
      for (const [nx, ny] of [
        [x + 1, y],
        [x, y + 1],
      ]) {
        if (nx >= COLS || ny >= HIDDEN + ROWS || game.board[index(nx, ny)] !== color) continue
        if (popping && popping.has(cell) !== popping.has(index(nx, ny))) continue
        const [ox, oy] = center(nx, ny)
        ctx.globalAlpha = popping?.has(cell) ? popAlpha : 1
        bridge(ctx, cx, cy, ox, oy, s, c.cells[color])
      }
    }
  }
  ctx.globalAlpha = 1
  for (let cell = 0; cell < game.board.length; cell++) {
    const color = game.board[cell]
    if (!color) continue
    const x = cell % COLS
    const row = rowOf(cell)
    if (row < HIDDEN - 1) continue
    const [cx, cy] = center(x, row)
    const pop = popping?.has(cell)
    ctx.globalAlpha = pop ? popAlpha : 1
    puyo(ctx, cx, cy, s, color, c, pop ? popScale : 1)
  }
  ctx.globalAlpha = 1

  const p = game.piece
  if (p) {
    // 落點提示：放下去會停在哪
    const land = game.landing()
    if (land) {
      for (const [x, y, color] of land) {
        if (y < HIDDEN) continue
        const [cx, cy] = center(x, y)
        ctx.globalAlpha = 0.5
        ctx.fillStyle = c.cells[color]
        ctx.beginPath()
        ctx.arc(cx, cy, s * 0.16, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
  }
  // 操作中的那組不裁切：剛出生時上面那顆在第 13 列，露一點出來
  ctx.restore()
  if (p) {
    const [[ax, ay], [bx, by]] = cellsOf(p)
    const offset = game.fallProgress
    const [acx, acy] = center(ax, ay + offset)
    const [bcx, bcy] = center(bx, by + offset)
    if (p.axis === p.child) bridge(ctx, acx, acy, bcx, bcy, s, c.cells[p.axis])
    puyo(ctx, bcx, bcy, s, p.child, c)
    puyo(ctx, acx, acy, s, p.axis, c)
    // 軸心（旋轉時不動的那顆）外面一圈
    ctx.strokeStyle = c.eye
    ctx.globalAlpha = 0.8
    ctx.lineWidth = Math.max(1.5, s * 0.07)
    ctx.beginPath()
    ctx.arc(acx, acy, s * 0.46, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

/** NEXT 欄：下一組大、下下組小，由上往下排 */
export const NEXT_ASPECT = 3.4

export function drawNext(ctx: CanvasRenderingContext2D, w: number, pairs: Pair[], c: Palette) {
  ctx.clearRect(0, 0, w, w * NEXT_ASPECT)
  let y = w * 0.15
  pairs.forEach((pair, i) => {
    const s = w * (i === 0 ? 0.62 : 0.46)
    const cx = w / 2
    puyo(ctx, cx, y + s / 2, s, pair.child, c)
    puyo(ctx, cx, y + s * 1.5, s, pair.axis, c)
    y += s * 2 + w * 0.25
  })
}
