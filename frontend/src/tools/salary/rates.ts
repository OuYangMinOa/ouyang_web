// 薪資試算用到的法定費率與級距，每年更新一次就好。
// 費率一律寫成「萬分比」整數（例如 5.17% 寫 517），計算時用整數乘除，避免浮點數誤差讓四捨五入差 1 元。
//
// 資料年度：2026 年（民國 115 年），2026-11 查核。
//   勞保、就保：勞動部 114-11-21 勞動保2字第1140091863號令「勞工保險投保薪資分級表」（115-01-01 起適用）
//     https://www.bli.gov.tw/0005475.html
//     勞保局「一般單位保險費分擔金額表」115-01-01 起：普通事故 11.5%＋就保 1%，勞工 20%、雇主 70%
//     https://www.bli.gov.tw/0102606.html
//   勞退：勞動部 114-11-24「勞工退休金月提繳分級表」（115-01-01 生效）
//     https://www.bli.gov.tw/0101077.html
//   職災保險：「勞工職業災害保險適用行業別及費率表」（114-01-01 起施行，三年檢討一次）
//     https://www.bli.gov.tw/0107174.html
//     職災投保薪資分級表下限 29,500、上限 72,800，級距同勞退分級表
//   工資墊償基金：勞動基準法第 28 條，雇主按勞保投保薪資萬分之 2.5 提繳
//     https://www.mol.gov.tw/1607/1632/1640/10695/
//   健保：衛福部「全民健康保險投保金額分級表」（115-01-01 生效，58 級）及保險費負擔金額表
//     https://www.nhi.gov.tw/ch/cp-19421-f9533-2569-1.html
//     https://www.nhi.gov.tw/ch/cp-19418-9eefb-2576-1.html
//     費率 5.17%（110 年起），被保險人 30%、投保單位 60%，平均眷口數 0.56（113 年起），眷屬最多計 3 口
//   補充保費：2.11%（110 年起），獎金累計超過投保金額 4 倍的部分
//     https://www.nhi.gov.tw/ch/cp-4516-74b0f-2613-1.html
//   綜所稅：財政部 114-11-27 台財稅字第11404664070號公告 115 年度免稅額、扣除額及課稅級距
//     https://gazette.nat.gov.tw/egFront/detail.do?metaid=161826
//   基本生活費：財政部 114-11-27 台財稅字第11400647270號公告 114 年度每人 213,000 元
//     （115 年度的金額要等 2026 年底公告，先沿用最新一年）
//     https://gazette.nat.gov.tw/egFront/detail.do?metaid=161835

export const DATA_YEAR = 2026

/** 2026 年的基本工資（最低工資），全時勞工的投保薪資不得低於這個數字 */
export const MIN_WAGE = 29_500

/** 勞保（含就保）月投保薪資分級表：全時勞工 11 級 */
export const LABOR_GRADES = [29_500, 30_300, 31_800, 33_300, 34_800, 36_300, 38_200, 40_100, 42_000, 43_900, 45_800]

/** 勞退月提繳分級表：62 級 */
export const PENSION_GRADES = [
  1_500, 3_000, 4_500, 6_000, 7_500, 8_700, 9_900, 11_100, 12_540, 13_500, 15_840, 16_500, 17_280, 17_880, 19_047, 20_008,
  21_009, 22_000, 23_100, 24_000, 25_250, 26_400, 27_600, 28_590, 29_500, 30_300, 31_800, 33_300, 34_800, 36_300, 38_200,
  40_100, 42_000, 43_900, 45_800, 48_200, 50_600, 53_000, 55_400, 57_800, 60_800, 63_800, 66_800, 69_800, 72_800, 76_500,
  80_200, 83_900, 87_600, 92_100, 96_600, 101_100, 105_600, 110_100, 115_500, 120_900, 126_300, 131_700, 137_100, 142_500,
  147_900, 150_000,
]

/** 職災保險投保薪資：29,500 到 72,800，級距同勞退 */
export const OCC_GRADES = PENSION_GRADES.filter((g) => g >= MIN_WAGE && g <= 72_800)

/** 健保投保金額分級表：58 級，150,000（第 38 級）以下比照勞退分級表 */
export const HEALTH_GRADES = [
  ...PENSION_GRADES.filter((g) => g >= MIN_WAGE),
  156_400, 162_800, 169_200, 175_600, 182_000, 189_500, 197_000, 204_500, 212_000, 219_500, 228_200, 236_900, 245_600,
  254_300, 263_000, 273_000, 283_000, 293_000, 303_000, 313_000,
]

/** 勞保普通事故保險費率（已扣掉就保的 1%）、就保費率（萬分比） */
export const LABOR_RATE = 1150
export const EMPLOYMENT_RATE = 100
/** 勞保、就保的負擔比例（%）：勞工 20、雇主 70、政府 10 */
export const LABOR_SHARE = { employee: 20, employer: 70 }

/** 工資墊償基金提繳費率（萬分比，2.5 = 0.025%），雇主全額負擔 */
export const WAGE_ARREARS_RATE = 2.5

/** 職災保險費率（萬分比，行業別＋上下班 0.07%），雇主全額負擔；只列常見的行業，其他見費率表 */
export const OCC_RATES: { label: string; rate: number }[] = [
  { label: '資訊服務、電腦程式設計', rate: 12 },
  { label: '金融、保險', rate: 12 },
  { label: '教育', rate: 12 },
  { label: '醫療保健、社會工作', rate: 12 },
  { label: '電子零組件、電腦及光學製品製造', rate: 12 },
  { label: '出版、影音、電信', rate: 13 },
  { label: '法律會計、管理顧問、設計等專業服務', rate: 15 },
  { label: '不動產', rate: 16 },
  { label: '零售', rate: 17 },
  { label: '批發', rate: 19 },
  { label: '住宿、餐飲', rate: 19 },
  { label: '公共行政', rate: 19 },
  { label: '保全、人力派遣、清潔等支援服務', rate: 25 },
  { label: '陸上運輸', rate: 39 },
  { label: '建築工程', rate: 57 },
]

/** 健保費率（萬分比）與負擔比例（%） */
export const HEALTH_RATE = 517
export const HEALTH_SHARE = { employee: 30, employer: 60 }
/** 雇主負擔的平均眷口數，寫成百分比的整數：1 + 0.56 = 156 */
export const HEALTH_EMPLOYER_HEADS = 156
/** 眷屬最多計算 3 口 */
export const HEALTH_MAX_DEPENDENTS = 3
/** 二代健保補充保費（萬分比），獎金累計超過投保金額 4 倍的部分 */
export const SUPPLEMENT_RATE = 211
export const SUPPLEMENT_BONUS_MULTIPLE = 4

/** 勞退：雇主至少提繳 6%，勞工可自願提繳 0–6% */
export const PENSION_EMPLOYER_RATE = 6
export const PENSION_SELF_MAX = 6

/** 綜所稅（115 年度所得，116 年 5 月申報） */
export const TAX = {
  year: 115,
  /** 免稅額：每人；本人、配偶或受扶養直系尊親屬年滿 70 歲提高 50% */
  exemption: 101_000,
  exemptionSenior: 151_500,
  /** 標準扣除額：單身、有配偶 */
  standardSingle: 136_000,
  standardMarried: 272_000,
  /** 薪資所得特別扣除額：每人上限 */
  salaryDeduction: 227_000,
  /** 基本生活費：每人（114 年度金額，115 年度尚未公告） */
  basicLiving: 213_000,
  basicLivingYear: 114,
  /** 課稅級距：[這一級的上限, 稅率 %]，最後一級沒有上限 */
  brackets: [
    [610_000, 5],
    [1_380_000, 12],
    [2_770_000, 20],
    [5_190_000, 30],
    [Infinity, 40],
  ] as [number, number][],
}

/** 找出薪資對應的級距：第一個不小於 salary 的等級，超過最高級就用最高級 */
export function gradeOf(grades: number[], salary: number): number {
  return grades.find((g) => g >= salary) ?? grades[grades.length - 1]
}
