import {
  EMPLOYMENT_RATE,
  gradeOf,
  HEALTH_EMPLOYER_HEADS,
  HEALTH_GRADES,
  HEALTH_MAX_DEPENDENTS,
  HEALTH_RATE,
  HEALTH_SHARE,
  LABOR_GRADES,
  LABOR_RATE,
  LABOR_SHARE,
  OCC_GRADES,
  PENSION_EMPLOYER_RATE,
  PENSION_GRADES,
  SUPPLEMENT_BONUS_MULTIPLE,
  SUPPLEMENT_RATE,
  TAX,
  WAGE_ARREARS_RATE,
} from './rates'

export type MonthlyInput = {
  /** 月薪 */
  salary: number
  /** 投保薪資：沒填就跟月薪一樣 */
  insured: number
  /** 健保眷屬人數 */
  dependents: number
  /** 勞退自提 % */
  selfPension: number
  /** 職災保險費率（萬分比） */
  occRate: number
}

export type MonthlyResult = {
  grades: { labor: number; health: number; pension: number; occ: number }
  labor: { employee: number; employer: number }
  employment: { employee: number; employer: number }
  occ: number
  arrears: number
  health: { employee: number; employer: number; perHead: number; heads: number }
  pension: { employee: number; employer: number }
  /** 勞工每月自付合計、實領 */
  deductions: number
  net: number
  /** 雇主每月負擔（不含薪水）、總人事成本 */
  employerCost: number
  employerTotal: number
}

// 官方金額表是各項分別四捨五入到元再加總，這裡照做
const round = Math.round

export function monthly(i: MonthlyInput): MonthlyResult {
  const labor = gradeOf(LABOR_GRADES, i.insured)
  const health = gradeOf(HEALTH_GRADES, i.insured)
  const pension = gradeOf(PENSION_GRADES, i.insured)
  const occ = gradeOf(OCC_GRADES, i.insured)

  const laborPart = (share: number) => round((labor * LABOR_RATE * share) / 1e6)
  const empPart = (share: number) => round((labor * EMPLOYMENT_RATE * share) / 1e6)
  const perHead = round((health * HEALTH_RATE * HEALTH_SHARE.employee) / 1e6)
  const heads = 1 + Math.min(Math.max(0, i.dependents), HEALTH_MAX_DEPENDENTS)

  const r = {
    labor: { employee: laborPart(LABOR_SHARE.employee), employer: laborPart(LABOR_SHARE.employer) },
    employment: { employee: empPart(LABOR_SHARE.employee), employer: empPart(LABOR_SHARE.employer) },
    occ: round((occ * i.occRate) / 1e4),
    arrears: round((labor * WAGE_ARREARS_RATE) / 1e4),
    health: {
      employee: perHead * heads,
      employer: round((health * HEALTH_RATE * HEALTH_SHARE.employer * HEALTH_EMPLOYER_HEADS) / 1e8),
      perHead,
      heads,
    },
    pension: { employee: round((pension * i.selfPension) / 100), employer: round((pension * PENSION_EMPLOYER_RATE) / 100) },
  }
  const deductions = r.labor.employee + r.employment.employee + r.health.employee + r.pension.employee
  const employerCost = r.labor.employer + r.employment.employer + r.occ + r.arrears + r.health.employer + r.pension.employer
  return {
    grades: { labor, health, pension, occ },
    ...r,
    deductions,
    net: i.salary - deductions,
    employerCost,
    employerTotal: i.salary + employerCost,
  }
}

/** 二代健保補充保費：全年獎金超過健保投保金額 4 倍的部分（假設一次發放、勞工自付） */
export function supplement(bonus: number, healthGrade: number): { base: number; fee: number } {
  const base = Math.max(0, Math.min(bonus - healthGrade * SUPPLEMENT_BONUS_MULTIPLE, 10_000_000))
  return { base, fee: round((base * SUPPLEMENT_RATE) / 1e4) }
}

export type TaxInput = {
  /** 本人全年薪資（含年終） */
  salary: number
  /** 本人全年勞退自提，不計入薪資所得 */
  selfPension: number
  married: boolean
  spouseSalary: number
  /** 受扶養親屬人數，以及其中年滿 70 歲的人數 */
  dependents: number
  seniors: number
  /** 列舉扣除額，沒有就填 0 */
  itemized: number
}

export type TaxResult = {
  salaryIncome: number
  people: number
  exemption: number
  standard: number
  general: number
  usedItemized: boolean
  basicLiving: number
  basicDiff: number
  net: number
  tax: number
  /** 適用的最高稅率 % */
  marginal: number
}

/** 薪資所得：薪資減掉薪資所得特別扣除額 */
const salaryIncome = (s: number) => Math.max(0, s - Math.min(s, TAX.salaryDeduction))

export function progressiveTax(net: number): { tax: number; marginal: number } {
  let tax = 0
  let lower = 0
  let marginal = TAX.brackets[0][1]
  for (const [upper, rate] of TAX.brackets) {
    if (net <= lower) break
    tax += ((Math.min(net, upper) - lower) * rate) / 100
    marginal = rate
    lower = upper
  }
  return { tax: round(tax), marginal }
}

export function incomeTax(i: TaxInput): TaxResult {
  const income = salaryIncome(Math.max(0, i.salary - i.selfPension)) + (i.married ? salaryIncome(i.spouseSalary) : 0)
  const people = 1 + (i.married ? 1 : 0) + i.dependents
  const seniors = Math.min(i.seniors, i.dependents)
  const exemption = (people - seniors) * TAX.exemption + seniors * TAX.exemptionSenior
  const standard = i.married ? TAX.standardMarried : TAX.standardSingle
  const usedItemized = i.itemized > standard
  const general = usedItemized ? i.itemized : standard
  // 基本生活費差額：每人基本生活費總額超過免稅額＋扣除額的部分可以再減除
  const basicLiving = TAX.basicLiving * people
  const basicDiff = Math.max(0, basicLiving - (exemption + general))
  const net = Math.max(0, income - exemption - general - basicDiff)
  const { tax, marginal } = progressiveTax(net)
  return { salaryIncome: income, people, exemption, standard, general, usedItemized, basicLiving, basicDiff, net, tax, marginal }
}
