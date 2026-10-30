// 任意進位（2～62）的整數換算，用 BigInt 不限位數

import { B62, bigToBase, digitsToBig } from './codecs'

/** 36 進位以內用 0-9a-z 不分大小寫；超過 36 用 0-9A-Za-z，大小寫不同 */
function digitValue(c: string, base: number): number {
  const code = c.charCodeAt(0)
  let v = -1
  if (code >= 48 && code <= 57) v = code - 48
  else if (base <= 36) {
    if (code >= 97 && code <= 122) v = code - 87
    else if (code >= 65 && code <= 90) v = code - 55
  } else v = B62.indexOf(c)
  return v >= 0 && v < base ? v : -1
}

const PREFIX: Record<string, number> = { '0x': 16, '0o': 8, '0b': 2 }

export type Parsed = { ok: true; value: bigint } | { ok: false; error: string }

export function parseNumber(input: string, base: number): Parsed {
  let s = input.trim()
  let negative = false
  if (s[0] === '-' || s[0] === '+') {
    negative = s[0] === '-'
    s = s.slice(1)
  }
  // 0x、0o、0b 開頭而且跟目前進位相符就略過
  const prefix = s.slice(0, 2).toLowerCase()
  if (PREFIX[prefix] === base) s = s.slice(2)
  const digits: number[] = []
  for (const c of s) {
    // 千分位、底線、空白當作分隔，略過
    if (c === ',' || c === '_' || c === ' ') continue
    const v = digitValue(c, base)
    if (v < 0) return { ok: false, error: `「${c}」不是 ${base} 進位的數字` }
    digits.push(v)
  }
  if (!digits.length) return { ok: false, error: '請輸入數字' }
  const value = digitsToBig(digits, base)
  return { ok: true, value: negative ? -value : value }
}

export function formatNumber(value: bigint, base: number, upper = false): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  let s: string
  if (base <= 36) {
    s = abs.toString(base)
    if (upper) s = s.toUpperCase()
  } else s = bigToBase(abs, B62.slice(0, base))
  return negative ? '-' + s : s
}

export const BASE_NAMES: Record<number, string> = {
  2: '二進位',
  8: '八進位',
  10: '十進位',
  16: '十六進位',
  32: '32 進位',
  36: '36 進位',
  58: '58 進位',
  62: '62 進位',
}

export const baseName = (base: number) => BASE_NAMES[base] ?? `${base} 進位`
