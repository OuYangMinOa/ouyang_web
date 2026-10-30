// 賽道都畫在寬 WORLD_W 的座標裡，y 往下增加；高度各自不同，畫面會跟著領先的彈珠捲動

export const WORLD_W = 360
/** 起跑閘門的高度，彈珠在閘門上方排好 */
export const GATE_Y = 150
/** 牆壁、坡道的半個厚度 */
export const SEG_R = 2.5

export type Seg = { x1: number; y1: number; x2: number; y2: number }
export type Peg = { x: number; y: number; r: number }
/** 繞著中心轉的風車，arms 支扇葉平均分布；speed 是每秒幾弧度，正的是順時針 */
export type Spinner = { x: number; y: number; len: number; arms: number; speed: number; phase: number }

export type Track = {
  height: number
  /** 過了這條線就算抵達 */
  finishY: number
  segs: Seg[]
  pegs: Peg[]
  spinners: Spinner[]
}

export type TrackInfo = {
  id: string
  name: string
  icon: string
  blurb: string
  /** r 是彈珠半徑；通道寬度要跟著彈珠大小調，免得卡住 */
  build: (r: number) => Track
}

function finish(height: number, segs: Seg[], pegs: Peg[], spinners: Spinner[] = []): Track {
  // 左右兩面牆和底板
  segs.push({ x1: 0, y1: 0, x2: 0, y2: height }, { x1: WORLD_W, y1: 0, x2: WORLD_W, y2: height })
  segs.push({ x1: 0, y1: height, x2: WORLD_W, y2: height })
  return { height, finishY: height - 50, segs, pegs, spinners }
}

/** 釘板：一排排交錯的釘子，每碰一下就隨機往左或往右 */
function plinko(r: number): Track {
  const pegs: Peg[] = []
  const segs: Seg[] = []
  const dx = 40
  let row = 0
  for (let y = 230; y < 1560; y += 42, row++) {
    if (row % 2 === 0) {
      for (let x = dx; x < WORLD_W - 10; x += dx) pegs.push({ x, y, r: 5 })
    } else {
      // 錯開的那排不放最靠牆的釘子，牆邊才不會窄到卡住彈珠
      for (let x = dx / 2 + dx; x < WORLD_W - dx; x += dx) pegs.push({ x, y, r: 5 })
      // 牆邊的小斜板把貼牆滑下的彈珠推回中間
      segs.push({ x1: 0, y1: y - 14, x2: 18, y2: y }, { x1: WORLD_W, y1: y - 14, x2: WORLD_W - 18, y2: y })
    }
  }
  // 最後收成一個漏斗，名次在出口才定下來
  const hw = Math.max(r * 3.4, 22)
  segs.push({ x1: 0, y1: 1600, x2: WORLD_W / 2 - hw, y2: 1700 }, { x1: WORLD_W, y1: 1600, x2: WORLD_W / 2 + hw, y2: 1700 })
  return finish(1820, segs, pegs)
}

/** 之字坡：左右交替的長坡，坡上懸著幾根釘子，落到下一層時會互相碰撞 */
function zigzag(r: number): Track {
  const segs: Seg[] = []
  const pegs: Peg[] = []
  const gap = Math.max(r * 5, 46)
  const drop = 64
  let y = 210
  for (let i = 0; i < 9; i++, y += 140) {
    const toRight = i % 2 === 0
    const [x1, x2] = toRight ? [0, WORLD_W - gap] : [WORLD_W, gap]
    segs.push({ x1, y1: y, x2, y2: y + drop })
    // 懸在坡上的釘子，底下留一顆半彈珠的高度，彈起來的會被擋一下
    const f = i % 2 === 0 ? 0.4 : 0.65
    pegs.push({ x: x1 + (x2 - x1) * f, y: y + drop * f - r * 3 - 6, r: 4 })
    // 落下處的釘子，把一串彈珠打散
    const fallX = toRight ? WORLD_W - gap / 2 : gap / 2
    pegs.push({ x: fallX + (toRight ? -4 : 4), y: y + drop + 40, r: 5 })
  }
  return finish(y + 100, segs, pegs)
}

/** 風車：一路上有轉個不停的扇葉，被打到就飛出去 */
function windmill(r: number): Track {
  const segs: Seg[] = []
  const pegs: Peg[] = []
  const spinners: Spinner[] = []
  let y = 300
  for (let i = 0; i < 7; i++, y += 210) {
    const dir = i % 2 === 0 ? 1 : -1
    if (i % 2 === 0) {
      spinners.push({ x: 92, y, len: 56, arms: 4, speed: 2.4 * dir, phase: 0 })
      spinners.push({ x: WORLD_W - 92, y, len: 56, arms: 4, speed: -2.4 * dir, phase: Math.PI / 4 })
      pegs.push({ x: WORLD_W / 2, y: y - 40, r: 7 })
    } else {
      spinners.push({ x: WORLD_W / 2, y, len: 68, arms: 3, speed: 2 * dir, phase: i })
      pegs.push({ x: 40, y: y + 50, r: 6 }, { x: WORLD_W - 40, y: y + 50, r: 6 })
    }
    // 兩排之間的斜擋板，避免彈珠貼著牆一路滑下
    const ly = y + 105
    segs.push({ x1: 0, y1: ly - 20, x2: 36 + r, y2: ly }, { x1: WORLD_W, y1: ly - 20, x2: WORLD_W - 36 - r, y2: ly })
  }
  return finish(y + 80, segs, pegs, spinners)
}

/** 漏斗：一層層的漏斗，出口偏左偏右輪流換，大家在出口擠成一團 */
function funnels(r: number): Track {
  const segs: Seg[] = []
  const pegs: Peg[] = []
  const hw = Math.max(r * 3.3, 20)
  const centers = [WORLD_W / 2, 110, WORLD_W - 110, WORLD_W / 2, WORLD_W - 120, 120]
  let y = 200
  for (const cx of centers) {
    segs.push({ x1: 0, y1: y, x2: cx - hw, y2: y + 95 }, { x1: WORLD_W, y1: y, x2: cx + hw, y2: y + 95 })
    // 出口下方的分流釘
    pegs.push({ x: cx + (cx < WORLD_W / 2 ? 3 : -3), y: y + 140, r: 7 })
    y += 255
  }
  return finish(y + 40, segs, pegs)
}

export const TRACKS: TrackInfo[] = [
  { id: 'plinko', name: '釘板', icon: '📍', blurb: '一排排釘子，每碰一下都是新的機會', build: plinko },
  { id: 'zigzag', name: '之字坡', icon: '〰️', blurb: '左右來回的長坡，速度跟碰撞決定一切', build: zigzag },
  { id: 'windmill', name: '風車', icon: '🌀', blurb: '轉不停的扇葉，被打飛就從後面追', build: windmill },
  { id: 'funnels', name: '漏斗', icon: '⏳', blurb: '一層層的漏斗，出口前擠成一團', build: funnels },
]

export function findTrack(id: string): TrackInfo {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0]
}
