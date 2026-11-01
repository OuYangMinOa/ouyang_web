// 海戰棋的規則與局面：所有模式（電腦、本地雙人、線上）都把對局記成一串事件，用 reduceEvents 重播成局面。
// 線上時事件經過轉送伺服器，所以佈局本身從來不放進事件：被打的一方自己算出結果（answerShot）再回報，
// 開局只送佈局的雜湊，結束才公開佈局（reveal），由對方檢查每一次回報是不是都和佈局一致（checkReports）。

export const SIZE = 10
export const CELLS = SIZE * SIZE
const COLS = 'ABCDEFGHIJ'

export type Side = 0 | 1
export type ShipInfo = { id: number; len: number; name: string }

/** 船隊：5、4、3、3、2 格，共 17 格 */
export const FLEET: readonly ShipInfo[] = [
  { id: 0, len: 5, name: '航空母艦' },
  { id: 1, len: 4, name: '戰艦' },
  { id: 2, len: 3, name: '巡洋艦' },
  { id: 3, len: 3, name: '潛艦' },
  { id: 4, len: 2, name: '驅逐艦' },
]

/** 一艘船的位置：船頭在 cell，vertical 為 true 往下延伸，否則往右 */
export type Placement = { id: number; cell: number; vertical: boolean }
export type Layout = Placement[]

export type Options = {
  /** 打中（含擊沉）可以再打一次 */
  chain: boolean
  /** 船和船不能相鄰（連斜角也不行） */
  noTouch: boolean
}
export const DEFAULT_OPTIONS: Options = { chain: false, noTouch: true }

export type ShotResult = 'miss' | 'hit' | 'sunk'
/** 一砲：by 是開砲的一方；result 是 null 表示還在等對方回報 */
export type Shot = { by: Side; cell: number; result: ShotResult | null; ship?: number }

export type Reveal = { layout: Layout; salt: string }

export type BsEvent =
  | { type: 'options'; options: Options }
  | { type: 'commit'; hash: string }
  | { type: 'shot'; cell: number }
  | { type: 'report'; cell: number; result: 'miss' | 'hit' }
  | { type: 'report'; cell: number; result: 'sunk'; ship: Placement }
  | { type: 'reveal'; layout: Layout; salt: string }
  | { type: 'resign' }
  | { type: 'restart' }

export type Phase = 'setup' | 'playing' | 'over'
export type Result = { winner: Side; reason: 'fleet' | 'resign' | 'cheat' }

export type Battle = {
  /** 第幾局（從 0 起算） */
  round: number
  options: Options
  phase: Phase
  /** 這局先開砲的一方 */
  first: Side
  toMove: Side
  /** 各自開局時送出的佈局雜湊；兩邊都送了才開打 */
  commits: [string | null, string | null]
  shots: Shot[]
  /** 正在等回報的那一砲（一定是 shots 的最後一筆） */
  pending: Shot | null
  /** 每一方被擊沉的船（打沉時由被打的一方公布位置） */
  sunk: [Placement[], Placement[]]
  /** 對局結束後各自公開的佈局 */
  reveals: [Reveal | null, Reveal | null]
  /** 回報不實的原因；結束前就能看出來的（擊沉的位置不合理）會直接判輸 */
  cheat: [string | null, string | null]
  result: Result | null
}

export function other(side: Side): Side {
  return side === 0 ? 1 : 0
}

export function cellName(cell: number): string {
  return `${COLS[cell % SIZE]}${Math.floor(cell / SIZE) + 1}`
}

export const COL_LABELS = COLS.split('')

export function shipInfo(id: number): ShipInfo {
  return FLEET[id]
}

function isCell(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < CELLS
}

/** 船佔的格子；超出海域就是 null */
export function shipCells(p: Placement): number[] | null {
  const len = FLEET[p.id]?.len
  if (!len || !isCell(p.cell)) return null
  const row = Math.floor(p.cell / SIZE)
  const col = p.cell % SIZE
  if (p.vertical ? row + len > SIZE : col + len > SIZE) return null
  return Array.from({ length: len }, (_, i) => p.cell + i * (p.vertical ? SIZE : 1))
}

/** 上下左右 */
export function neighbors(cell: number): number[] {
  const row = Math.floor(cell / SIZE)
  const col = cell % SIZE
  const out: number[] = []
  if (row > 0) out.push(cell - SIZE)
  if (row < SIZE - 1) out.push(cell + SIZE)
  if (col > 0) out.push(cell - 1)
  if (col < SIZE - 1) out.push(cell + 1)
  return out
}

/** 周圍八格（不含自己） */
export function around(cell: number): number[] {
  const row = Math.floor(cell / SIZE)
  const col = cell % SIZE
  const out: number[] = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr
      const c = col + dc
      if ((dr || dc) && r >= 0 && r < SIZE && c >= 0 && c < SIZE) out.push(r * SIZE + c)
    }
  }
  return out
}

/** 船頭放在 cell 會超出海域時往回移，讓點邊緣也放得下（手機上很難剛好點在船頭） */
export function fitPlacement(id: number, cell: number, vertical: boolean): Placement {
  const len = FLEET[id].len
  let row = Math.floor(cell / SIZE)
  let col = cell % SIZE
  if (vertical) row = Math.min(row, SIZE - len)
  else col = Math.min(col, SIZE - len)
  return { id, cell: row * SIZE + col, vertical }
}

/** p 能不能放進 layout（layout 裡同一艘船的舊位置不算） */
export function canPlace(layout: Layout, p: Placement, options: Options): boolean {
  const cells = shipCells(p)
  if (!cells) return false
  const taken = new Set<number>()
  for (const q of layout) {
    if (q.id === p.id) continue
    for (const c of shipCells(q) ?? []) {
      taken.add(c)
      if (options.noTouch) for (const n of around(c)) taken.add(n)
    }
  }
  return cells.every((c) => !taken.has(c))
}

/** 佈局完整又合規則就回傳整理過的佈局（照船的編號排好），否則 null。也用來檢查對方公開的佈局 */
export function validLayout(value: unknown, options: Options): Layout | null {
  if (!Array.isArray(value) || value.length !== FLEET.length) return null
  const layout: Layout = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const { id, cell, vertical } = item as Record<string, unknown>
    if (!Number.isInteger(id) || !FLEET[id as number] || typeof vertical !== 'boolean' || !isCell(cell)) return null
    if (layout.some((p) => p.id === id)) return null
    layout.push({ id: id as number, cell: cell as number, vertical })
  }
  layout.sort((a, b) => a.id - b.id)
  for (const p of layout) if (!canPlace(layout, p, options)) return null
  return layout
}

export function randomLayout(options: Options, random: () => number = Math.random): Layout {
  // 大船先放；運氣不好卡住（不相鄰時偶爾會）就整個重來
  for (;;) {
    const layout: Layout = []
    for (const ship of FLEET) {
      for (let tries = 0; tries < 200; tries++) {
        const p = { id: ship.id, cell: Math.floor(random() * CELLS), vertical: random() < 0.5 }
        if (canPlace(layout, p, options)) {
          layout.push(p)
          break
        }
      }
    }
    if (layout.length === FLEET.length) return layout
  }
}

/** 每一格是哪艘船（沒有船是 -1） */
export function occupancy(layout: Layout): Int8Array {
  const occ = new Int8Array(CELLS).fill(-1)
  for (const p of layout) for (const c of shipCells(p) ?? []) occ[c] = p.id
  return occ
}

/** 算雜湊用的固定寫法：船照編號排，每艘「編號:格子:方向」 */
export function serializeLayout(layout: Layout): string {
  return [...layout]
    .sort((a, b) => a.id - b.id)
    .map((p) => `${p.id}:${p.cell}:${p.vertical ? 'v' : 'h'}`)
    .join(';')
}

function sameShip(a: Placement, b: Placement): boolean {
  return a.id === b.id && a.cell === b.cell && a.vertical === b.vertical
}

/** 打在 side 這一方海域的每一砲 */
export function shotsOn(battle: Battle, side: Side): Shot[] {
  return battle.shots.filter((s) => s.by !== side)
}

/** 被打的一方回報這一砲的結果（只用自己的佈局算，不必相信對方） */
export function answerShot(battle: Battle, side: Side, layout: Layout, cell: number): BsEvent {
  const occ = occupancy(layout)
  const id = occ[cell]
  if (id < 0) return { type: 'report', cell, result: 'miss' }
  const hit = new Set(shotsOn(battle, side).map((s) => s.cell))
  hit.add(cell)
  const ship = layout.find((p) => p.id === id)!
  const sunk = (shipCells(ship) ?? []).every((c) => hit.has(c))
  return sunk ? { type: 'report', cell, result: 'sunk', ship } : { type: 'report', cell, result: 'hit' }
}

/**
 * 公開的佈局和過程中每一次回報對不對得上；對得上回傳 null，否則回傳原因。
 * 還沒回報的那一砲（對局在等回報時結束）不檢查。
 */
export function checkReports(battle: Battle, side: Side, layout: Layout): string | null {
  const occ = occupancy(layout)
  const left = FLEET.map((s) => s.len)
  for (const shot of shotsOn(battle, side)) {
    if (shot.result === null) continue
    const id = occ[shot.cell]
    let expected: ShotResult = 'miss'
    if (id >= 0) expected = --left[id] === 0 ? 'sunk' : 'hit'
    if (expected !== shot.result) {
      const truth = id >= 0 ? `打中了${FLEET[id].name}` : '沒打中'
      return `${cellName(shot.cell)} 回報「${resultName(shot.result)}」，實際上${truth}${expected === 'sunk' ? '並擊沉' : ''}`
    }
    if (expected === 'sunk' && shot.ship !== id) return `${cellName(shot.cell)} 回報擊沉的船不對`
  }
  for (const ship of battle.sunk[side]) {
    const real = layout.find((p) => p.id === ship.id)
    if (!real || !sameShip(real, ship)) return `${FLEET[ship.id].name}擊沉時公布的位置和實際不同`
  }
  return null
}

export function resultName(result: ShotResult): string {
  return result === 'miss' ? '沒打中' : result === 'hit' ? '擊中' : '擊沉'
}

/** 每局誰先開砲：預設每局交換 */
export function alternateFirst(round: number): Side {
  return round % 2 === 0 ? 0 : 1
}

function newBattle(round: number, options: Options, first: Side): Battle {
  return {
    round,
    options,
    phase: 'setup',
    first,
    toMove: first,
    commits: [null, null],
    shots: [],
    pending: null,
    sunk: [[], []],
    reveals: [null, null],
    cheat: [null, null],
    result: null,
  }
}

function readOptions(value: unknown): Options | null {
  if (!value || typeof value !== 'object') return null
  const { chain, noTouch } = value as Record<string, unknown>
  if (typeof chain !== 'boolean' || typeof noTouch !== 'boolean') return null
  return { chain, noTouch }
}

/**
 * 擊沉時公布的船位置合不合理：要包含這一砲、其他格子都已經回報過擊中、還沒被算進別艘沉船，
 * 不相鄰的規則下也不能貼著其他沉船。不合理就是亂報，不必等到最後公開佈局就能判定。
 */
function sunkShipError(battle: Battle, side: Side, ship: unknown, cell: number): string | null {
  if (!ship || typeof ship !== 'object') return '擊沉回報缺少船的位置'
  const { id, cell: bow, vertical } = ship as Record<string, unknown>
  if (!Number.isInteger(id) || !FLEET[id as number] || typeof vertical !== 'boolean' || !isCell(bow)) {
    return '擊沉回報的船位置格式不對'
  }
  const placement: Placement = { id: id as number, cell: bow as number, vertical }
  if (battle.sunk[side].some((p) => p.id === placement.id)) return `${FLEET[placement.id].name}被報了兩次擊沉`
  const cells = shipCells(placement)
  if (!cells || !cells.includes(cell)) return '擊沉回報的船不在被打的位置上'
  const hits = new Set(
    shotsOn(battle, side)
      .filter((s) => s.result === 'hit')
      .map((s) => s.cell),
  )
  const sunkCells = new Set(battle.sunk[side].flatMap((p) => shipCells(p) ?? []))
  for (const c of cells) {
    if (c !== cell && (!hits.has(c) || sunkCells.has(c)))
      return `擊沉回報的${FLEET[placement.id].name}位置和先前的回報對不上`
  }
  if (!canPlace(battle.sunk[side], placement, battle.options)) return '擊沉回報的船和其他沉船重疊或相鄰'
  return null
}

/**
 * 把事件從頭重播成目前局面。不合法、不是輪到該方、時機不對的事件一律忽略，
 * 兩邊照同樣的順序重播就會得到一樣的局面。
 * `firstOf` 決定每局誰先開砲（線上每局交換；電腦模式由玩家選）。
 */
export function reduceEvents(
  events: readonly { seat: Side; data: BsEvent }[],
  firstOf: (round: number) => Side = alternateFirst,
): Battle {
  let b = newBattle(0, DEFAULT_OPTIONS, firstOf(0))
  for (const { seat, data } of events) {
    if (!data || typeof data !== 'object') continue
    switch (data.type) {
      case 'options': {
        const options = readOptions(data.options)
        if (options && b.phase === 'setup' && !b.commits[0] && !b.commits[1]) b = { ...b, options }
        break
      }
      case 'commit': {
        if (b.phase !== 'setup' || b.commits[seat] !== null) break
        if (typeof data.hash !== 'string' || data.hash.length > 128) break
        const commits: Battle['commits'] = [...b.commits]
        commits[seat] = data.hash
        b = { ...b, commits }
        if (commits[0] !== null && commits[1] !== null) b = { ...b, phase: 'playing', toMove: b.first }
        break
      }
      case 'shot': {
        if (b.phase !== 'playing' || b.pending || seat !== b.toMove || !isCell(data.cell)) break
        if (b.shots.some((s) => s.by === seat && s.cell === data.cell)) break
        const shot: Shot = { by: seat, cell: data.cell, result: null }
        b = { ...b, shots: [...b.shots, shot], pending: shot }
        break
      }
      case 'report': {
        const pending = b.pending
        if (b.phase !== 'playing' || !pending || seat === pending.by || data.cell !== pending.cell) break
        if (data.result !== 'miss' && data.result !== 'hit' && data.result !== 'sunk') break
        const shooter = pending.by
        let shot: Shot = { ...pending, result: data.result }
        const sunk: Battle['sunk'] = [b.sunk[0], b.sunk[1]]
        if (data.result === 'sunk') {
          const error = sunkShipError(b, seat, data.ship, pending.cell)
          if (error) {
            const cheat: Battle['cheat'] = [...b.cheat]
            cheat[seat] = error
            b = { ...b, pending: null, cheat, phase: 'over', result: { winner: shooter, reason: 'cheat' } }
            break
          }
          shot = { ...shot, ship: data.ship.id }
          sunk[seat] = [...sunk[seat], { id: data.ship.id, cell: data.ship.cell, vertical: data.ship.vertical }]
        }
        const shots = [...b.shots.slice(0, -1), shot]
        const again = data.result !== 'miss' && b.options.chain
        b = { ...b, shots, sunk, pending: null, toMove: again ? shooter : other(shooter) }
        if (sunk[seat].length === FLEET.length)
          b = { ...b, phase: 'over', result: { winner: shooter, reason: 'fleet' } }
        break
      }
      case 'resign': {
        if (b.phase !== 'over')
          b = { ...b, pending: null, phase: 'over', result: { winner: other(seat), reason: 'resign' } }
        break
      }
      case 'reveal': {
        if (b.phase !== 'over' || b.reveals[seat] || b.commits[seat] === null || typeof data.salt !== 'string') break
        const reveals: Battle['reveals'] = [...b.reveals]
        const cheat: Battle['cheat'] = [...b.cheat]
        const layout = validLayout(data.layout, b.options)
        if (!layout) {
          cheat[seat] ??= '公開的佈局不合規則'
          reveals[seat] = { layout: [], salt: data.salt }
        } else {
          reveals[seat] = { layout, salt: data.salt }
          cheat[seat] ??= checkReports(b, seat, layout)
        }
        b = { ...b, reveals, cheat }
        break
      }
      case 'restart': {
        if (b.phase === 'over') b = newBattle(b.round + 1, b.options, firstOf(b.round + 1))
        break
      }
    }
  }
  return b
}

/** 一方的開砲統計 */
export function stats(battle: Battle, side: Side): { shots: number; hits: number } {
  let shots = 0
  let hits = 0
  for (const s of battle.shots) {
    if (s.by !== side || s.result === null) continue
    shots++
    if (s.result !== 'miss') hits++
  }
  return { shots, hits }
}

/**
 * 狀態列用的一句話：最後一砲的結果。layout 是自己的佈局（知道對手打中的是哪艘）
 */
export function describeShot(
  shot: Shot | undefined,
  view: {
    me: Side
    /** 自己的佈局：知道對手打中的是哪一艘 */
    myLayout?: Layout | null
    /** 對手的稱呼（電腦、對手） */
    opponent?: string
    /** 本地雙人用：兩邊都用名字稱呼 */
    names?: [string, string]
  },
): string | null {
  if (!shot) return null
  const { me, myLayout, opponent = '對手', names } = view
  const mine = shot.by === me
  const who = names ? names[shot.by] : mine ? '你' : opponent
  const where = cellName(shot.cell)
  if (shot.result === null) return `${who}打 ${where}…`
  if (shot.result === 'miss') return `${who}打 ${where}：沒打中`
  const id = shot.ship ?? (mine || !myLayout ? undefined : findShip(myLayout, shot.cell))
  const ship = id === undefined ? '' : FLEET[id].name
  if (shot.result === 'sunk') {
    if (names) return `${who}打 ${where}：擊沉了${names[other(shot.by)]}的${ship}！`
    return `${who}打 ${where}：擊沉${mine ? opponent : '你'}的${ship}！`
  }
  if (names || mine) return `${who}打 ${where}：${resultName(shot.result)}！`
  return `${who}打 ${where}：擊中你的${ship}`
}

function findShip(layout: Layout, cell: number): number | undefined {
  return layout.find((p) => shipCells(p)?.includes(cell))?.id
}
