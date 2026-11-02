/** 後端 invoice.rs 的 Period：一期的中獎號碼 */
export type Period = {
  /** 民國年＋起始月，例如 11507 */
  id: string
  year: number
  months: [number, number]
  draw_date: string
  claim_start: string
  claim_end: string
  special: string
  grand: string
  first: string[]
  /** 增開六獎（三碼） */
  extra: string[]
  link: string
}

export type InvoiceReport = { updated_at: string; periods: Period[] }

export type Prize = { name: string; amount: number }

const SPECIAL: Prize = { name: '特別獎', amount: 10_000_000 }
const GRAND: Prize = { name: '特獎', amount: 2_000_000 }
const EXTRA: Prize = { name: '增開六獎', amount: 200 }
/** 跟頭獎比對：末幾碼相同 → 獎項 */
const BY_SUFFIX: Record<number, Prize> = {
  8: { name: '頭獎', amount: 200_000 },
  7: { name: '二獎', amount: 40_000 },
  6: { name: '三獎', amount: 10_000 },
  5: { name: '四獎', amount: 4_000 },
  4: { name: '五獎', amount: 1_000 },
  3: { name: '六獎', amount: 200 },
}

/** 給畫面上的獎項說明用 */
export const PRIZE_TABLE: { name: string; rule: string; amount: number }[] = [
  { name: '特別獎', rule: '8 碼與特別獎相同', amount: SPECIAL.amount },
  { name: '特獎', rule: '8 碼與特獎相同', amount: GRAND.amount },
  ...[8, 7, 6, 5, 4, 3].map((n) => ({
    name: BY_SUFFIX[n].name,
    rule: n === 8 ? '8 碼與頭獎相同' : `末 ${n} 碼與頭獎相同`,
    amount: BY_SUFFIX[n].amount,
  })),
]

export const periodLabel = (p: Pick<Period, 'year' | 'months'>) => `${p.year} 年 ${p.months[0]}～${p.months[1]} 月`

export function formatMoney(amount: number): string {
  if (amount >= 10_000 && amount % 10_000 === 0) return `${(amount / 10_000).toLocaleString('zh-TW')} 萬元`
  return `${amount.toLocaleString('zh-TW')} 元`
}

function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

/** 完整 8 碼對獎；同時對中多個獎項只能領一個，回傳最大的 */
export function checkFull(number: string, period: Period): Prize | null {
  if (number === period.special) return SPECIAL
  if (number === period.grand) return GRAND
  let best: Prize | null = null
  for (const first of period.first) {
    const n = commonSuffix(number, first)
    const prize = BY_SUFFIX[Math.min(n, 8)]
    if (n >= 3 && (!best || prize.amount > best.amount)) best = prize
  }
  if (!best && period.extra.includes(number.slice(-3))) best = EXTRA
  return best
}

export type QuickResult = {
  /** 末三碼就能確定的獎（六獎、增開六獎） */
  sure: Prize | null
  /** 還要核對完整號碼的獎項名稱 */
  maybe: string[]
}

/** 只看末 3 碼：跟頭獎末 3 碼相同至少是六獎，跟特別獎、特獎相同要再看完整號碼 */
export function checkLast3(last3: string, period: Period): QuickResult {
  const maybe: string[] = []
  if (period.special.endsWith(last3)) maybe.push('特別獎')
  if (period.grand.endsWith(last3)) maybe.push('特獎')
  let sure: Prize | null = null
  if (period.first.some((f) => f.endsWith(last3))) {
    sure = BY_SUFFIX[3]
    maybe.push('頭獎～五獎')
  } else if (period.extra.includes(last3)) {
    sure = EXTRA
  }
  return { sure, maybe }
}

/** 民國年月 → 期別 id（單月開頭） */
export function periodIdOf(year: number, month: number): string {
  const start = month % 2 === 1 ? month : month - 1
  return `${year}${String(start).padStart(2, '0')}`
}

export type ScannedInvoice = { track: string; number: string; periodId: string; date: string }

/**
 * 電子發票證明聯左邊的 QR Code：前 10 碼是字軌＋號碼，接著 7 碼是民國年月日。
 * 右邊那個以 `**` 開頭，是品名明細，讀到它就回 null。
 */
export function parseInvoiceQr(raw: string): ScannedInvoice | null {
  const m = /^([A-Z]{2})(\d{8})(\d{3})(\d{2})(\d{2})/.exec(raw.trim())
  if (!m) return null
  const [, track, number, y, mo, d] = m
  const year = Number(y)
  const month = Number(mo)
  if (month < 1 || month > 12 || Number(d) < 1 || Number(d) > 31) return null
  return { track, number, periodId: periodIdOf(year, month), date: `${year}/${mo}/${d}` }
}

/** 下一次開獎：單月 25 日，開的是前兩個月那期 */
export function nextDraw(today: Date): { label: string; date: Date } {
  let y = today.getFullYear()
  let m = today.getMonth() + 1
  // 單月 25 日當天下午才開，當天之後就看下一次
  if (m % 2 === 0 || today.getDate() > 25) m += m % 2 === 0 ? 1 : 2
  if (m > 12) {
    m -= 12
    y += 1
  }
  const start = m - 2 <= 0 ? m - 2 + 12 : m - 2
  const roc = (m - 2 <= 0 ? y - 1 : y) - 1911
  return { label: periodLabel({ year: roc, months: [start, start + 1] }), date: new Date(y, m - 1, 25) }
}
