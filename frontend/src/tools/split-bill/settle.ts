// 分帳的計算：金額一律換成整數「單位」（以元為單位或以分為單位）計算，避免浮點數誤差。

export type SplitMode = 'equal' | 'ratio' | 'amount'

export type Member = { id: string; name: string }

export type Expense = {
  id: string
  title: string
  /** 付款人的成員 id */
  payer: string
  /** 使用者輸入的金額文字 */
  amount: string
  mode: SplitMode
  /** 參與分攤的成員 id */
  participants: string[]
  /** 比例或自訂金額的輸入文字，依成員 id */
  shares: Record<string, string>
}

export type Transfer = { from: string; to: string; amount: number }

/** 金額文字轉數字：可以有千分位逗號；空白、負數或看不懂回傳 null */
export function parseMoney(text: string): number | null {
  const s = text.replace(/[,\s，]/g, '')
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 把 total 個單位依權重分給每個人；除不盡的零頭依小數部分大小分配（同樣大就依順序） */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weights.map(() => 0)
  const exact = weights.map((w) => (total * w) / sum)
  const base = exact.map(Math.floor)
  let left = total - base.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) base[order[k].i]++
  return base
}

export type ExpenseResult =
  | { ok: true; amount: number; shares: Map<string, number> }
  | { ok: false; error: string }

/** 一筆支出每個人該分攤多少單位；unit 是一個單位等於多少元（1 或 0.01） */
export function splitExpense(e: Expense, members: Member[], unit: number): ExpenseResult {
  const amount = parseMoney(e.amount)
  if (amount === null || amount <= 0) return { ok: false, error: '請輸入金額' }
  if (!members.some((m) => m.id === e.payer)) return { ok: false, error: '請選擇付款人' }
  const people = members.filter((m) => e.participants.includes(m.id)).map((m) => m.id)
  if (people.length === 0) return { ok: false, error: '請勾選分攤的人' }
  const total = Math.round(amount / unit)
  const shares = new Map<string, number>()

  if (e.mode === 'equal') {
    allocate(total, people.map(() => 1)).forEach((v, i) => shares.set(people[i], v))
  } else if (e.mode === 'ratio') {
    // 沒填的當作 1
    const weights = people.map((id) => {
      const t = (e.shares[id] ?? '').trim()
      return t === '' ? 1 : parseMoney(t)
    })
    if (weights.some((w) => w === null)) return { ok: false, error: '有看不懂的比例' }
    if (weights.every((w) => w === 0)) return { ok: false, error: '比例不能全部是 0' }
    allocate(total, weights as number[]).forEach((v, i) => shares.set(people[i], v))
  } else {
    // 自訂金額：有填的照填，沒填的人平分剩下的
    const fixed = people.map((id) => {
      const t = (e.shares[id] ?? '').trim()
      return t === '' ? null : parseMoney(t)
    })
    if (people.some((id, i) => fixed[i] === null && (e.shares[id] ?? '').trim() !== '')) return { ok: false, error: '有看不懂的金額' }
    const fixedUnits = fixed.map((v) => (v === null ? 0 : Math.round(v / unit)))
    const rest = total - fixedUnits.reduce((a, b) => a + b, 0)
    const blanks = people.filter((_, i) => fixed[i] === null)
    if (rest < 0) return { ok: false, error: `自訂金額加總超過支出 ${formatUnits(-rest, unit)} 元` }
    if (blanks.length === 0 && rest !== 0) return { ok: false, error: `自訂金額加總還差 ${formatUnits(rest, unit)} 元` }
    const restShares = allocate(rest, blanks.map(() => 1))
    people.forEach((id, i) => shares.set(id, fixedUnits[i]))
    blanks.forEach((id, i) => shares.set(id, restShares[i]))
  }
  return { ok: true, amount: total, shares }
}

export function formatUnits(units: number, unit: number): string {
  return (units * unit).toLocaleString('zh-TW', { maximumFractionDigits: unit < 1 ? 2 : 0, minimumFractionDigits: 0 })
}

export type Summary = {
  /** 每個人：應付（分攤）、已付、差額（正數是應收回） */
  rows: { id: string; owe: number; paid: number; net: number }[]
  total: number
  counted: number
}

export function summarize(members: Member[], expenses: Expense[], unit: number): Summary {
  const owe = new Map(members.map((m) => [m.id, 0]))
  const paid = new Map(members.map((m) => [m.id, 0]))
  let total = 0
  let counted = 0
  for (const e of expenses) {
    const r = splitExpense(e, members, unit)
    if (!r.ok) continue
    counted++
    total += r.amount
    paid.set(e.payer, (paid.get(e.payer) ?? 0) + r.amount)
    for (const [id, v] of r.shares) owe.set(id, (owe.get(id) ?? 0) + v)
  }
  return {
    rows: members.map((m) => {
      const o = owe.get(m.id) ?? 0
      const p = paid.get(m.id) ?? 0
      return { id: m.id, owe: o, paid: p, net: p - o }
    }),
    total,
    counted,
  }
}

/** 一組加總為零的人：多的人收、少的人付，每次都讓金額最大的兩人對沖 */
function settleGroup(group: { id: string; net: number }[]): Transfer[] {
  const creditors = group.filter((g) => g.net > 0).map((g) => ({ ...g }))
  const debtors = group.filter((g) => g.net < 0).map((g) => ({ id: g.id, net: -g.net }))
  const out: Transfer[] = []
  while (creditors.length && debtors.length) {
    creditors.sort((a, b) => b.net - a.net)
    debtors.sort((a, b) => b.net - a.net)
    const c = creditors[0]
    const d = debtors[0]
    const amount = Math.min(c.net, d.net)
    out.push({ from: d.id, to: c.id, amount })
    c.net -= amount
    d.net -= amount
    if (c.net === 0) creditors.shift()
    if (d.net === 0) debtors.shift()
  }
  return out
}

/** 精確解只算到這麼多人（2^n 個子集合） */
const EXACT_LIMIT = 16

/**
 * 最少轉帳次數：把有差額的人分成越多「加總為零」的小組越好，每組 k 人只要轉 k−1 次。
 * 人數不多時用位元 DP 找最多能分幾組（dp[mask] = 拿掉一個人的最佳值，加上這組是否剛好歸零），
 * 人太多就直接整組對沖（不一定最少，但最多 n−1 次）。
 */
export function minTransfers(rows: { id: string; net: number }[]): Transfer[] {
  const people = rows.filter((r) => r.net !== 0)
  const n = people.length
  if (n === 0) return []
  if (n > EXACT_LIMIT) return settleGroup(people)

  const size = 1 << n
  const sum = new Float64Array(size)
  const dp = new Int16Array(size)
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask
    const i = 31 - Math.clz32(low)
    sum[mask] = sum[mask ^ low] + people[i].net
    let best = 0
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j) && dp[mask ^ (1 << j)] > best) best = dp[mask ^ (1 << j)]
    }
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0)
  }

  // 從全部的人往回拿，每遇到加總為零就切出一組
  const groups: { id: string; net: number }[][] = []
  let mask = size - 1
  let current: { id: string; net: number }[] = []
  while (mask) {
    const bonus = sum[mask] === 0 ? 1 : 0
    let pick = -1
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j) && dp[mask ^ (1 << j)] + bonus === dp[mask]) {
        pick = j
        break
      }
    }
    current.push(people[pick])
    mask ^= 1 << pick
    if (sum[mask] === 0) {
      groups.push(current)
      current = []
    }
  }
  if (current.length) groups.push(current)
  return groups.flatMap(settleGroup)
}
