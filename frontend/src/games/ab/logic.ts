// 1A2B 的規則、策略與賽後分析（純邏輯，不含 React，方便測試與放進 Worker）

/** 全部 5040 組四位不重複數字（首位可為 0），依字典序 */
export const CODES: string[] = []
// 每組的四個數字與「用到哪些數字」的位元遮罩，算 A／B 時不用切字串
const DIGITS = new Uint8Array(5040 * 4)
const MASK = new Uint16Array(5040)
const POPCOUNT = new Uint8Array(1024)
const INDEX = new Map<string, number>()

for (let m = 1; m < 1024; m++) POPCOUNT[m] = POPCOUNT[m >> 1] + (m & 1)
for (let a = 0; a < 10; a++)
  for (let b = 0; b < 10; b++)
    for (let c = 0; c < 10; c++)
      for (let d = 0; d < 10; d++) {
        if (a === b || a === c || a === d || b === c || b === d || c === d) continue
        const i = CODES.length
        const code = `${a}${b}${c}${d}`
        CODES.push(code)
        INDEX.set(code, i)
        DIGITS.set([a, b, c, d], i * 4)
        MASK[i] = (1 << a) | (1 << b) | (1 << c) | (1 << d)
      }

export const TOTAL = CODES.length
/** 4A0B 的回饋編號 */
export const WIN = 20

export function indexOf(code: string): number {
  return INDEX.get(code) ?? -1
}

/** 回饋編號 = A * 5 + B */
export function feedback(i: number, j: number): number {
  const p = i * 4
  const q = j * 4
  const a =
    +(DIGITS[p] === DIGITS[q]) +
    +(DIGITS[p + 1] === DIGITS[q + 1]) +
    +(DIGITS[p + 2] === DIGITS[q + 2]) +
    +(DIGITS[p + 3] === DIGITS[q + 3])
  const common = POPCOUNT[MASK[i] & MASK[j]]
  return a * 5 + (common - a)
}

export function fbA(fb: number): number {
  return Math.floor(fb / 5)
}
export function fbB(fb: number): number {
  return fb % 5
}
export function fbOf(a: number, b: number): number {
  return a * 5 + b
}
export function fbText(fb: number): string {
  return `${fbA(fb)}A${fbB(fb)}B`
}

/** A、B 的組合是否可能出現（A+B≤4，且沒有 3A1B） */
export function validFeedback(a: number, b: number): boolean {
  return a >= 0 && b >= 0 && a + b <= 4 && !(a === 3 && b === 1)
}

export function isValidCode(code: string): boolean {
  return INDEX.has(code)
}

export type Clue = { guess: string; a: number; b: number }

export function allIndices(): number[] {
  return Array.from({ length: TOTAL }, (_, i) => i)
}

/** 依序套用每一條線索後剩下的可能答案 */
export function poolAfter(clues: Clue[]): number[] {
  let pool = allIndices()
  for (const c of clues) pool = filterPool(pool, indexOf(c.guess), fbOf(c.a, c.b))
  return pool
}

export function filterPool(pool: number[], guess: number, fb: number): number[] {
  return pool.filter((p) => feedback(guess, p) === fb)
}

export type Eval = {
  guess: number
  /** 期望剩餘數 × 池大小（整數，避免浮點比較誤差）；猜中算剩 0 */
  sumSq: number
  /** 最壞情況剩幾種（猜中不算） */
  worst: number
  inPool: boolean
}

const counts = new Int32Array(25)

/** 評估用 guess 去切 pool 的效果 */
export function evaluate(guess: number, pool: number[], inPool?: boolean): Eval {
  counts.fill(0)
  for (const p of pool) counts[feedback(guess, p)]++
  let sumSq = 0
  let worst = 0
  for (let k = 0; k < 25; k++) {
    if (k === WIN) continue
    const c = counts[k]
    sumSq += c * c
    if (c > worst) worst = c
  }
  return { guess, sumSq, worst, inPool: inPool ?? counts[WIN] > 0 }
}

/** a 是否比 b 好：期望剩餘少者優先，一樣時優先選可能是答案的，再比最壞情況 */
export function better(a: Eval, b: Eval): number {
  if (a.sumSq !== b.sumSq) return a.sumSq - b.sumSq
  if (a.inPool !== b.inPool) return a.inPool ? -1 : 1
  return a.worst - b.worst
}

export type Best = { overall: Eval; inPool: Eval; ties: number[] }

/** 從全部 5040 組裡找最佳猜測（計算量 5040 × 池大小），同時找池內最佳 */
export function bestGuesses(pool: number[]): Best {
  const member = new Uint8Array(TOTAL)
  for (const p of pool) member[p] = 1
  let overall: Eval | null = null
  let inPool: Eval | null = null
  let ties: number[] = []
  for (let g = 0; g < TOTAL; g++) {
    const e = evaluate(g, pool, member[g] === 1)
    const cmp = overall ? better(e, overall) : -1
    if (cmp < 0) {
      overall = e
      ties = [g]
    } else if (cmp === 0) ties.push(g)
    if (e.inPool && (!inPool || better(e, inPool) < 0)) inPool = e
  }
  return { overall: overall!, inPool: inPool!, ties }
}

/** 電腦猜模式：選下一個猜測（池子空了回傳 -1） */
export function chooseGuess(pool: number[], random: () => number = Math.random): number {
  if (pool.length === 0) return -1
  // 第一步所有猜測都等價，直接隨機
  if (pool.length === TOTAL || pool.length <= 2) return pool[Math.floor(random() * pool.length)]
  const { ties } = bestGuesses(pool)
  return ties[Math.floor(random() * ties.length)]
}

// ---- 賽後分析 ----

export type Violation = { step: number; guess: string; expected: string; actual: string }

export type Verdict = 'first' | 'best' | 'good' | 'fair' | 'probe' | 'wasted'

export type StepAnalysis = {
  step: number
  guess: string
  result: string
  before: number
  after: number
  inPool: boolean
  /** 不在池裡時：如果答案就是這個猜測，之前哪幾次提示會對不上 */
  violations: Violation[]
  /** 猜測裡已經確定不在答案中的數字 */
  excluded: number[]
  /** 期望剩餘數（第一步不評分時為 null） */
  mine: number | null
  worst: number | null
  best: { guess: string; expected: number; worst: number; inPool: boolean } | null
  bestIn: { guess: string; expected: number; worst: number } | null
  verdict: Verdict
}

export type Summary = {
  total: number
  solved: boolean
  outOfPool: number[]
  wasted: number[]
  probes: number[]
  fair: number[]
  stars: number
  tips: string[]
  remaining: number
}

export type Analysis = { steps: StepAnalysis[]; summary: Summary }

/** 電腦用 chooseGuess 的平均猜中次數（scratchpad 模擬 5040 題的結果） */
export const COMPUTER_AVERAGE = 5.3

const round = (x: number) => Math.round(x * 10) / 10

function joinSteps(steps: number[]): string {
  return `第 ${steps.join('、')} 次`
}

export function analyzeStep(clues: Clue[], k: number, pool: number[]): StepAnalysis {
  const { guess, a, b } = clues[k]
  const g = indexOf(guess)
  const fb = fbOf(a, b)
  const inPool = pool.includes(g)
  const after = filterPool(pool, g, fb).length

  const violations: Violation[] = []
  if (!inPool) {
    for (let j = 0; j < k; j++) {
      const expected = feedback(indexOf(clues[j].guess), g)
      const actual = fbOf(clues[j].a, clues[j].b)
      if (expected !== actual)
        violations.push({ step: j + 1, guess: clues[j].guess, expected: fbText(expected), actual: fbText(actual) })
    }
  }

  let possible = 0
  for (const p of pool) possible |= MASK[p]
  const excluded = [...guess].map(Number).filter((d) => !(possible & (1 << d)))

  const base: StepAnalysis = {
    step: k + 1,
    guess,
    result: fbText(fb),
    before: pool.length,
    after,
    inPool,
    violations,
    excluded,
    mine: null,
    worst: null,
    best: null,
    bestIn: null,
    verdict: 'first',
  }
  if (k === 0 || pool.length === TOTAL) return base

  const n = pool.length
  const mine = evaluate(g, pool, inPool)
  const { overall, inPool: bestIn } = bestGuesses(pool)
  const mineExp = mine.sumSq / n
  const bestExp = overall.sumSq / n

  let verdict: Verdict
  if (inPool) {
    if (mine.sumSq <= bestIn.sumSq || mine.sumSq <= overall.sumSq) verdict = 'best'
    else if (mineExp <= bestExp * 1.6 + 0.2) verdict = 'good'
    else verdict = 'fair'
  } else verdict = mine.sumSq <= bestIn.sumSq ? 'probe' : 'wasted'

  return {
    ...base,
    mine: round(mineExp),
    worst: mine.worst,
    best: { guess: CODES[overall.guess], expected: round(bestExp), worst: overall.worst, inPool: overall.inPool },
    bestIn: { guess: CODES[bestIn.guess], expected: round(bestIn.sumSq / n), worst: bestIn.worst },
    verdict,
  }
}

/** 整局分析；solved 表示最後一次是 4A0B，否則是放棄 */
export function summarize(steps: StepAnalysis[], solved: boolean, hidden: boolean): Summary {
  const total = steps.length
  const outOfPool = steps.filter((s) => !s.inPool).map((s) => s.step)
  const wasted = steps.filter((s) => s.verdict === 'wasted').map((s) => s.step)
  const probes = steps.filter((s) => s.verdict === 'probe').map((s) => s.step)
  const fair = steps.filter((s) => s.verdict === 'fair').map((s) => s.step)
  const remaining = total ? steps[total - 1].after : TOTAL
  const tips: string[] = []

  if (wasted.length) {
    tips.push(
      `${joinSteps(wasted)}猜了不可能是答案的數字，而且切分效果也不如當時的可能組合。` +
        (hidden ? '可以打開「可能組合」清單參考，' : '建議參考右側的可能組合，') +
        '或在送出前先確認新的猜測跟之前每一次的提示都對得上。',
    )
  }
  const lateMiss = steps.filter((s) => !s.inPool && s.before <= 2)
  const sure = lateMiss.filter((s) => s.before === 1).map((s) => s.step)
  const coin = lateMiss.filter((s) => s.before === 2).map((s) => s.step)
  if (coin.length) tips.push(`${joinSteps(coin)}時只剩 2 種可能，直接猜其中一個就有一半機會當場猜中。`)
  if (sure.length) tips.push(`${joinSteps(sure)}時答案已經確定只剩 1 種，直接猜它就贏了。`)
  const excludedSteps = steps.filter((s) => s.verdict === 'wasted' && s.excluded.length)
  if (excludedSteps.length) {
    const parts = excludedSteps.map((s) => `第 ${s.step} 次的 ${s.excluded.join('、')}`)
    tips.push(`${parts.join('，')} 當時已經確定不在答案裡，用它們換不到新資訊。`)
  }
  if (fair.length) {
    const worstFair = steps.find((s) => s.step === fair[0])!
    tips.push(
      `${joinSteps(fair)}雖然可能是答案，但分組效果較差（例如第 ${worstFair.step} 次期望還剩 ` +
        `${worstFair.mine} 種，最佳可剩 ${worstFair.best?.expected} 種）。挑選會讓各種 A／B 結果分布更平均的組合，` +
        '每一步能排除更多可能。',
    )
  }
  if (probes.length) {
    tips.push(`${joinSteps(probes)}雖然不可能是答案，但把可能組合切得跟池內任何猜測一樣好甚至更好，是聰明的探測。`)
  }
  if (!solved) {
    tips.push(`放棄時還剩 ${remaining} 種可能${remaining <= 10 ? '，其實已經很接近了，下次再撐一下！' : '。'}`)
  } else if (total > 7) {
    tips.push(`這局用了 ${total} 次；照「期望剩餘數最小」的策略，平均大約 ${COMPUTER_AVERAGE} 次就能猜中。`)
  }
  if (solved && !wasted.length && !fair.length && !lateMiss.length) {
    tips.push('每一步都有效縮小範圍，推理很紮實！')
  }

  // 一半看結果（次數），一半看過程（有沒有浪費步數）
  const outcome = total <= 5 ? 5 : total === 6 ? 4 : total === 7 ? 3 : total <= 9 ? 2 : 1
  const process = Math.max(1, 5 - wasted.length - 0.5 * fair.length)
  let stars = Math.round((outcome + process) / 2)
  if (!solved) stars = Math.min(stars, process >= 4 ? 2 : 1)

  return { total, solved, outOfPool, wasted, probes, fair, stars, tips, remaining }
}

/** 完整分析（同步版，測試用；畫面上走 Worker 逐步算） */
export function analyze(clues: Clue[], solved = true, hidden = false): Analysis {
  const steps: StepAnalysis[] = []
  let pool = allIndices()
  clues.forEach((c, k) => {
    steps.push(analyzeStep(clues, k, pool))
    pool = filterPool(pool, indexOf(c.guess), fbOf(c.a, c.b))
  })
  return { steps, summary: summarize(steps, solved, hidden) }
}

export function randomCode(random: () => number = Math.random): string {
  return CODES[Math.floor(random() * TOTAL)]
}

/** 實際比對兩組數字 */
export function score(guess: string, answer: string): { a: number; b: number } {
  const fb = feedback(indexOf(guess), indexOf(answer))
  return { a: fbA(fb), b: fbB(fb) }
}
