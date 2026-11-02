// 房貸攤還。按月計息：月利率 = 年利率 ÷ 12。
// 寬限期內只繳利息；寬限期後把剩下的本金攤到剩餘期數。
// 本息平均攤還在利率改變時，用當時的剩餘本金與剩餘期數重算月付金（銀行的做法）。

export type Method = 'annuity' | 'principal'

export type RateSegment = {
  /** 這一段有幾期（月）；最後一段不用填，涵蓋剩下的全部 */
  months: number
  /** 年利率 % */
  rate: number
}

export type Row = {
  /** 第幾期，從 1 開始 */
  period: number
  rate: number
  payment: number
  principal: number
  interest: number
  balance: number
}

export type Plan = {
  rows: Row[]
  totalInterest: number
  totalPayment: number
}

/** 第 period 期（1 起算）的年利率 */
export function rateAt(segments: RateSegment[], period: number): number {
  let end = 0
  for (let i = 0; i < segments.length; i++) {
    end += segments[i].months
    if (i === segments.length - 1 || period <= end) return segments[i].rate
  }
  return segments[segments.length - 1]?.rate ?? 0
}

export function schedule(loan: number, months: number, graceMonths: number, segments: RateSegment[], method: Method): Plan {
  const rows: Row[] = []
  let balance = loan
  let payment = 0
  let lastRate = NaN
  const amortMonths = months - graceMonths
  const fixedPrincipal = loan / amortMonths

  for (let k = 1; k <= months; k++) {
    const annual = rateAt(segments, k)
    const r = annual / 100 / 12
    const interest = balance * r
    let principal: number

    if (k <= graceMonths) {
      principal = 0
    } else if (method === 'principal') {
      principal = Math.min(fixedPrincipal, balance)
    } else {
      // 寬限期剛結束或利率改變時重算月付金
      if (k === graceMonths + 1 || annual !== lastRate) {
        const left = months - k + 1
        payment = r === 0 ? balance / left : (balance * r) / (1 - (1 + r) ** -left)
      }
      principal = payment - interest
    }
    // 最後一期把零頭繳清
    if (k === months) principal = balance

    balance = Math.max(0, balance - principal)
    rows.push({ period: k, rate: annual, payment: principal + interest, principal, interest, balance })
    lastRate = annual
  }

  const totalInterest = rows.reduce((a, r) => a + r.interest, 0)
  return { rows, totalInterest, totalPayment: loan + totalInterest }
}

/** 把每月的列合併成每年一列 */
export function yearly(rows: Row[]): (Row & { year: number })[] {
  const out: (Row & { year: number })[] = []
  for (const r of rows) {
    const year = Math.ceil(r.period / 12)
    const last = out[out.length - 1]
    if (last && last.year === year) {
      last.payment += r.payment
      last.principal += r.principal
      last.interest += r.interest
      last.balance = r.balance
      last.period = r.period
    } else {
      out.push({ ...r, year })
    }
  }
  return out
}
