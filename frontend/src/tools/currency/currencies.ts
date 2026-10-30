// 貨幣的中文名稱、國旗、數字格式，以及金額算式

/** 加入貨幣時排在最前面的常用貨幣 */
export const POPULAR = ['TWD', 'USD', 'JPY', 'EUR', 'CNY', 'HKD', 'KRW', 'GBP', 'SGD', 'THB', 'AUD', 'CAD', 'VND', 'MYR']

/** 不列出的代碼：加密貨幣、貴金屬（單位是盎司），還有沒有中文名稱的區域記帳單位 */
const EXCLUDED = new Set(['BTC', 'BCH', 'ETH', 'LTC', 'XRP', 'XAU', 'XAG', 'XPT', 'XPD', 'CMD'])

export function isListed(code: string) {
  return !EXCLUDED.has(code)
}

// Intl 沒有中文名稱的幾個
const FALLBACK_NAMES: Record<string, string> = {
  GGP: '根西鎊',
  IMP: '曼島鎊',
  JEP: '澤西鎊',
  ZWG: '辛巴威金',
  XCG: '加勒比盾',
}

let displayNames: Intl.DisplayNames | null = null
try {
  displayNames = new Intl.DisplayNames(['zh-TW'], { type: 'currency' })
} catch {
  // 舊瀏覽器沒有 DisplayNames，就只顯示代碼
}

export function currencyName(code: string): string {
  const name = displayNames?.of(code)
  if (name && name !== code) return name
  return FALLBACK_NAMES[code] ?? ''
}

// 貨幣代碼前兩碼通常就是國家代碼；X 開頭是區域或特殊單位，不放國旗
const FLAG_REGION: Record<string, string> = { EUR: 'EU', ANG: 'CW', XCG: 'CW' }

export function flag(code: string): string {
  const region = FLAG_REGION[code] ?? (code.startsWith('X') ? '' : code.slice(0, 2))
  if (!/^[A-Z]{2}$/.test(region)) return ''
  return String.fromCodePoint(...[...region].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}

/** 選單用的標籤：🇺🇸 USD 美元 */
export function optionLabel(code: string) {
  return [flag(code), code, currencyName(code)].filter(Boolean).join(' ')
}

const formatters = new Map<string, Intl.NumberFormat>()
function nf(key: string, options: Intl.NumberFormatOptions) {
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.NumberFormat('zh-TW', options)
    formatters.set(key, f)
  }
  return f
}

/** 貨幣的標準小數位數：日圓、韓元 0 位，大多數 2 位 */
function currencyDigits(code: string): number {
  try {
    return nf(`cur:${code}`, { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** 換算後的金額 */
export function formatAmount(value: number, code: string): string {
  const abs = Math.abs(value)
  // 不到 1 的金額改用有效位數，不然 0.0307 美元會被四捨五入成 0.03
  if (abs > 0 && abs < 1) return nf('sig4', { maximumSignificantDigits: 4 }).format(value)
  const d = currencyDigits(code)
  return nf(`amt:${d}`, { minimumFractionDigits: d, maximumFractionDigits: d }).format(value)
}

/** 匯率：大約保留 5 位有效數字，大數字至少 2 位小數 */
export function formatRate(value: number): string {
  if (value < 1) return nf('sig4', { maximumSignificantDigits: 4 }).format(value)
  const d = Math.max(2, 4 - Math.floor(Math.log10(value)))
  return nf(`rate:${d}`, { maximumFractionDigits: d }).format(value)
}

export function formatPercent(value: number): string {
  return nf('pct', { style: 'percent', maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(value)
}

/**
 * 解析金額：可以有千分位逗號，也可以是簡單算式，例如 100*3、(1200+800)/4。
 * 不是合法的數字或算式就回傳 null。
 */
export function evaluate(input: string): number | null {
  const s = input
    .replace(/[,，\s]/g, '')
    .replace(/[×xX＊]/g, '*')
    .replace(/[÷／]/g, '/')
    .replace(/＋/g, '+')
    .replace(/[－−]/g, '-')
  if (!s) return null
  let i = 0

  const expr = (): number => {
    let v = term()
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++]
      const r = term()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  const term = (): number => {
    let v = factor()
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++]
      const r = factor()
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  const factor = (): number => {
    if (s[i] === '-') {
      i++
      return -factor()
    }
    if (s[i] === '+') {
      i++
      return factor()
    }
    if (s[i] === '(' || s[i] === '（') {
      i++
      const v = expr()
      if (s[i] !== ')' && s[i] !== '）') throw new Error('缺少右括號')
      i++
      return v
    }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i))
    if (!m) throw new Error('不是數字')
    i += m[0].length
    return Number(m[0])
  }

  try {
    const v = expr()
    return i === s.length && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** 是不是算式（而不是單純的數字），用來決定要不要顯示「= 結果」 */
export function isExpression(input: string) {
  return /\d\s*[-+*/×xX÷＊／＋－−]\s*[\d(（.]/.test(input) || /[()（）]/.test(input)
}
