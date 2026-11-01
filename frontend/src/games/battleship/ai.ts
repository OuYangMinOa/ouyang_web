// 電腦開砲：只用「開砲的一方看得到的資訊」（自己打過的結果、對方公布的沉船），不偷看佈局。
// - 簡單：隨便打一格沒打過的。
// - 普通：獵殺與追擊。沒有線索時亂打；打中後沿著上下左右追，打出一直線就沿著那條線打。
// - 困難：機率密度。把剩下的每艘船所有可能的擺法都列出來（不能蓋到沒打中的格子和沉船，
//   不相鄰的規則下也不能貼著沉船），蓋到越多「打中但還沒沉」的擺法權重越高，挑被最多擺法蓋到的格子。

import { around, CELLS, FLEET, neighbors, shipCells, SIZE, type Battle, type Side } from './rules'

export type Level = 'easy' | 'normal' | 'hard'

type Knowledge = {
  /** 打過的格子 */
  shot: Uint8Array
  /** 一定沒有「還沒沉的船」的格子：沒打中、沉船，以及不相鄰時沉船的周圍 */
  blocked: Uint8Array
  /** 打中但還沒沉 */
  open: number[]
  /** 還沒沉的船 */
  remaining: number[]
}

function knowledge(battle: Battle, shooter: Side): Knowledge {
  const target = shooter === 0 ? 1 : 0
  const shot = new Uint8Array(CELLS)
  const blocked = new Uint8Array(CELLS)
  const hit = new Uint8Array(CELLS)
  for (const s of battle.shots) {
    if (s.by !== shooter || s.result === null) continue
    shot[s.cell] = 1
    if (s.result === 'miss') blocked[s.cell] = 1
    else hit[s.cell] = 1
  }
  const sunkIds = new Set<number>()
  for (const ship of battle.sunk[target]) {
    sunkIds.add(ship.id)
    for (const c of shipCells(ship) ?? []) {
      blocked[c] = 1
      hit[c] = 0
      if (battle.options.noTouch) for (const n of around(c)) blocked[n] = 1
    }
  }
  const open: number[] = []
  for (let c = 0; c < CELLS; c++) if (hit[c]) open.push(c)
  return { shot, blocked, open, remaining: FLEET.filter((s) => !sunkIds.has(s.id)).map((s) => s.id) }
}

function pick(cells: number[], random: () => number): number {
  return cells[Math.floor(random() * cells.length)]
}

function unshot(k: Knowledge, avoidBlocked: boolean): number[] {
  const out: number[] = []
  for (let c = 0; c < CELLS; c++) if (!k.shot[c] && !(avoidBlocked && k.blocked[c])) out.push(c)
  return out
}

function chooseNormal(k: Knowledge, random: () => number): number {
  const open = new Set(k.open)
  const free = (c: number) => !k.shot[c] && !k.blocked[c]
  // 連成一直線的命中：沿著線往兩端延伸
  const line: number[] = []
  for (const c of k.open) {
    const row = Math.floor(c / SIZE)
    const col = c % SIZE
    if (col < SIZE - 1 && open.has(c + 1)) {
      let a = c
      while (a % SIZE > 0 && open.has(a - 1)) a--
      let z = c
      while (z % SIZE < SIZE - 1 && open.has(z + 1)) z++
      if (a % SIZE > 0 && free(a - 1)) line.push(a - 1)
      if (z % SIZE < SIZE - 1 && free(z + 1)) line.push(z + 1)
    }
    if (row < SIZE - 1 && open.has(c + SIZE)) {
      let a = c
      while (a >= SIZE && open.has(a - SIZE)) a -= SIZE
      let z = c
      while (z < CELLS - SIZE && open.has(z + SIZE)) z += SIZE
      if (a >= SIZE && free(a - SIZE)) line.push(a - SIZE)
      if (z < CELLS - SIZE && free(z + SIZE)) line.push(z + SIZE)
    }
  }
  if (line.length) return pick(line, random)
  const near = k.open.flatMap((c) => neighbors(c).filter(free))
  if (near.length) return pick(near, random)
  const hunt = unshot(k, true)
  return pick(hunt.length ? hunt : unshot(k, false), random)
}

/** 每一格被幾種可能的擺法蓋到（加權） */
function density(k: Knowledge, noTouch: boolean): Float64Array {
  const open = new Set(k.open)
  const heat = new Float64Array(CELLS)
  const add = (requireHit: boolean) => {
    let any = false
    for (const id of k.remaining) {
      for (let cell = 0; cell < CELLS; cell++) {
        for (const vertical of [false, true]) {
          const cells = shipCells({ id, cell, vertical })
          if (!cells || cells.some((c) => k.blocked[c])) continue
          const inside = new Set(cells)
          const covered = cells.filter((c) => open.has(c)).length
          if (requireHit && covered === 0) continue
          // 不相鄰的規則下，貼著別的命中格表示兩艘船相鄰，不可能
          if (noTouch && cells.some((c) => around(c).some((n) => open.has(n) && !inside.has(n)))) continue
          const weight = covered ? 20 ** covered : 1
          for (const c of cells) if (!k.shot[c]) heat[c] += weight
          any = true
        }
      }
    }
    return any
  }
  // 有命中還沒沉時只看蓋得到命中的擺法；理論上一定有，萬一沒有（對方亂報）就退回全部
  if (!(k.open.length && add(true))) add(false)
  return heat
}

function chooseHard(k: Knowledge, noTouch: boolean, random: () => number): number {
  const heat = density(k, noTouch)
  let best = -1
  let cells: number[] = []
  for (let c = 0; c < CELLS; c++) {
    if (k.shot[c] || heat[c] <= 0) continue
    if (heat[c] > best + 1e-9) {
      best = heat[c]
      cells = [c]
    } else if (Math.abs(heat[c] - best) <= 1e-9) cells.push(c)
  }
  if (cells.length) return pick(cells, random)
  return chooseNormal(k, random)
}

/** 電腦這一砲要打哪一格（一定是還沒打過的格子） */
export function chooseShot(level: Level, battle: Battle, shooter: Side, random: () => number = Math.random): number {
  const k = knowledge(battle, shooter)
  if (level === 'easy') return pick(unshot(k, false), random)
  if (level === 'normal') return chooseNormal(k, random)
  return chooseHard(k, battle.options.noTouch, random)
}
