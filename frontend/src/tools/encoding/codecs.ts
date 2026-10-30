// 各種編碼的純邏輯：不碰 DOM，錯誤用回傳值表示，不丟例外

export type Result =
  | { ok: true; text: string; note?: string; /** 解出來的不是 UTF-8，text 是十六進位 */ binary?: boolean }
  | Failure

export type Failure = { ok: false; error: string }

export type CodecOptions = {
  /** Base64 用 - _ 取代 + / */
  b64Url: boolean
  /** Base64 / Base32 補上結尾的 = */
  pad: boolean
  hexUpper: boolean
  hexSep: '' | ' ' | ':'
  urlMode: 'component' | 'uri' | 'form'
  /** HTML：非 ASCII 也轉成 &#…; */
  htmlAll: boolean
  /** Unicode 跳脫用 \u{…} */
  uniBraces: boolean
  /** Unicode 跳脫連一般 ASCII 也轉 */
  uniAll: boolean
}

export const DEFAULT_OPTIONS: CodecOptions = {
  b64Url: false,
  pad: true,
  hexUpper: false,
  hexSep: '',
  urlMode: 'component',
  htmlAll: false,
  uniBraces: false,
  uniAll: false,
}

const ok = (text: string, note?: string): Result => ({ ok: true, text, note })
const fail = (error: string): Failure => ({ ok: false, error })

/* ---- 位元組與文字 ---- */

const encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export const utf8 = (text: string): Uint8Array => encoder.encode(text)

const HEX = '0123456789abcdef'

export function toHex(bytes: Uint8Array, sep = '', upper = false): string {
  const parts: string[] = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) parts[i] = HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
  const out = parts.join(sep)
  return upper ? out.toUpperCase() : out
}

/** 解出的位元組轉回文字；不是有效的 UTF-8 就改顯示十六進位 */
export function bytesToText(bytes: Uint8Array): Result {
  try {
    return ok(utf8Decoder.decode(bytes))
  } catch {
    return {
      ok: true,
      text: toHex(bytes, ' '),
      binary: true,
      note: `解出的 ${bytes.length} 個位元組不是有效的 UTF-8 文字，改用十六進位顯示。`,
    }
  }
}

/** 錯誤訊息裡的「第 N 個字元」：從 1 開始，以字元（不是 UTF-16 單位）計算 */
function position(input: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) {
    const c = input.charCodeAt(i)
    if (c < 0xd800 || c > 0xdbff) n++
  }
  return n
}

function showChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0
  if (cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0)) return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
  return `「${ch}」`
}

function badChar(name: string, input: string, index: number, why = ''): Failure {
  const ch = String.fromCodePoint(input.codePointAt(index) ?? 0)
  return fail(`不是有效的 ${name}：第 ${position(input, index)} 個字元 ${showChar(ch)}${why}`)
}

const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\v'

/* ---- 2 的次方進位：Base64、Base32 ---- */

function lookup(alphabet: string, ignoreCase = false): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < alphabet.length; i++) {
    map.set(alphabet[i], i)
    if (ignoreCase) map.set(alphabet[i].toLowerCase(), i)
  }
  return map
}

function bitsEncode(bytes: Uint8Array, alphabet: string, bits: number, groupLen: number, pad: boolean): string {
  const out: string[] = []
  const mask = (1 << bits) - 1
  let acc = 0
  let n = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff
    n += 8
    while (n >= bits) {
      n -= bits
      out.push(alphabet[(acc >> n) & mask])
    }
  }
  if (n > 0) out.push(alphabet[(acc << (bits - n)) & mask])
  if (pad) while (out.length % groupLen) out.push('=')
  return out.join('')
}

function bitsDecode(input: string, table: Map<string, number>, bits: number, name: string): Failure | Uint8Array {
  const out: number[] = []
  let acc = 0
  let n = 0
  let chars = 0
  let padAt = -1
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (isSpace(c)) continue
    if (c === '=') {
      if (padAt < 0) padAt = i
      continue
    }
    const v = table.get(c)
    if (v === undefined) return badChar(name, input, i)
    if (padAt >= 0) return badChar(name, input, i, '出現在結尾的「=」之後')
    chars++
    acc = ((acc << bits) | v) & 0xffff
    n += bits
    if (n >= 8) {
      n -= 8
      out.push((acc >> n) & 0xff)
    }
  }
  // 剩下的位元湊不滿一個字元的長度才合理，否則就是少了或多了字元
  if (n >= bits) return fail(`不是有效的 ${name}：長度不對（${chars} 個字元），可能少複製了一段`)
  return Uint8Array.from(out)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_URL = B64.slice(0, 62) + '-_'
// 解碼時兩種字母表都收
const B64_TABLE = lookup(B64)
B64_TABLE.set('-', 62)
B64_TABLE.set('_', 63)

export function base64Encode(bytes: Uint8Array, url = false, pad = true): string {
  return bitsEncode(bytes, url ? B64_URL : B64, 6, 4, pad)
}
export const base64Decode = (input: string) => bitsDecode(input, B64_TABLE, 6, 'Base64')

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const B32_HEX = '0123456789ABCDEFGHIJKLMNOPQRSTUV'
const B32_TABLE = lookup(B32, true)
const B32_HEX_TABLE = lookup(B32_HEX, true)

/* ---- 大整數進位：Base58、Base62、Base36 ---- */

/** 每次處理 k 位數，讓 base^k 不超過 2^53，減少 BigInt 運算次數 */
function chunkSize(base: number): number {
  let k = 1
  while (base ** (k + 1) <= 2 ** 53) k++
  return k
}

/** 非負大整數轉成指定字母表的字串；用分治法對半拆，長資料也不會太慢 */
export function bigToBase(value: bigint, alphabet: string): string {
  const base = alphabet.length
  if (value === 0n) return alphabet[0]
  const k = chunkSize(base)
  // pows[i] = base^(k·2^i)
  const pows = [BigInt(base) ** BigInt(k)]
  while (pows[pows.length - 1] ** 2n <= value) pows.push(pows[pows.length - 1] ** 2n)
  const parts: string[] = []
  const small = (n: number, fixed: boolean) => {
    let s = ''
    while (n > 0) {
      s = alphabet[n % base] + s
      n = Math.floor(n / base)
    }
    return fixed ? s.padStart(k, alphabet[0]) : s
  }
  // fixed：這段在中間，要補滿位數；最前面那段不補
  const walk = (v: bigint, level: number, fixed: boolean) => {
    if (level < 0) parts.push(small(Number(v), fixed))
    else if (!fixed && v < pows[level]) walk(v, level - 1, false)
    else {
      walk(v / pows[level], level - 1, fixed)
      walk(v % pows[level], level - 1, true)
    }
  }
  walk(value, pows.length - 1, false)
  return parts.join('')
}

/** 每一位的數值（已檢查過範圍）組回大整數，同樣對半拆 */
export function digitsToBig(digits: number[], base: number): bigint {
  const k = chunkSize(base)
  const pows = new Map<number, bigint>()
  const pow = (n: number) => {
    let p = pows.get(n)
    if (p === undefined) pows.set(n, (p = BigInt(base) ** BigInt(n)))
    return p
  }
  const walk = (lo: number, hi: number): bigint => {
    if (hi - lo <= k) {
      let chunk = 0
      for (let i = lo; i < hi; i++) chunk = chunk * base + digits[i]
      return BigInt(chunk)
    }
    // 右半邊取 k·2^j 位，次方值可以重複使用
    let size = k
    while (size * 2 < hi - lo) size *= 2
    return walk(lo, hi - size) * pow(size) + walk(hi - size, hi)
  }
  return digits.length ? walk(0, digits.length) : 0n
}

/** 超過這個長度大整數運算會明顯卡頓（編碼算位元組，解碼算字元） */
export const BIG_LIMIT = 32 * 1024

function tooLong(name: string, size: number, limit: number, unit: string): Failure {
  return fail(`內容太長：${name} 要做大整數運算，最多處理 ${limit.toLocaleString()} ${unit}（目前 ${size.toLocaleString()}）`)
}

export function bigEncode(bytes: Uint8Array, alphabet: string): string {
  // 開頭的 0x00 轉成整數會消失，所以每個各寫成一個「零」字元
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const lead = alphabet[0].repeat(zeros)
  if (zeros === bytes.length) return lead
  return lead + bigToBase(BigInt('0x' + toHex(bytes.subarray(zeros))), alphabet)
}

function bigDecode(input: string, table: Map<string, number>, base: number, name: string): Failure | Uint8Array {
  const digits: number[] = []
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (isSpace(c)) continue
    const v = table.get(c)
    if (v === undefined) return badChar(name, input, i)
    digits.push(v)
  }
  if (digits.length > BIG_LIMIT * 2) return tooLong(name, digits.length, BIG_LIMIT * 2, '個字元')
  // 開頭的「零」字元各代表一個 0x00
  let zeros = 0
  while (zeros < digits.length && digits[zeros] === 0) zeros++
  if (zeros === digits.length) return new Uint8Array(zeros)
  let hex = digitsToBig(digits.slice(zeros), base).toString(16)
  if (hex.length % 2) hex = '0' + hex
  const rest = hexToBytes(hex)
  const bytes = new Uint8Array(zeros + rest.length)
  bytes.set(rest, zeros)
  return bytes
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'
const B58_TABLE = lookup(B58)
const B62_TABLE = lookup(B62)
const B36_TABLE = new Map([...lookup(B36)].concat([...lookup(B36.toUpperCase())]))

/* ---- Ascii85 ---- */

export function ascii85Encode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 4) {
    const m = Math.min(4, bytes.length - i)
    let v = 0
    for (let j = 0; j < 4; j++) v = v * 256 + (j < m ? bytes[i + j] : 0)
    // 一整組都是 0 縮寫成 z
    if (v === 0 && m === 4) {
      out += 'z'
      continue
    }
    let group = ''
    for (let j = 0; j < 5; j++) {
      group = String.fromCharCode(33 + (v % 85)) + group
      v = Math.floor(v / 85)
    }
    out += group.slice(0, m + 1)
  }
  return out
}

export function ascii85Decode(input: string): Failure | Uint8Array {
  const name = 'Ascii85'
  let start = 0
  let end = input.length
  const trimmed = input.trim()
  if (trimmed.startsWith('<~')) start = input.indexOf('<~') + 2
  if (trimmed.endsWith('~>')) end = input.lastIndexOf('~>')
  const out: number[] = []
  let group: number[] = []
  let groupAt = 0
  const flush = (n: number): Failure | null => {
    while (group.length < 5) group.push(84)
    let v = 0
    for (const d of group) v = v * 85 + d
    if (v > 0xffffffff) return badChar(name, input, groupAt, '開始的這一組數值超出範圍')
    for (let j = 0; j < n; j++) out.push(Math.floor(v / 256 ** (3 - j)) % 256)
    group = []
    return null
  }
  for (let i = start; i < end; i++) {
    const c = input[i]
    if (isSpace(c)) continue
    if (c === 'z') {
      if (group.length) return badChar(name, input, i, '只能出現在一組的開頭')
      out.push(0, 0, 0, 0)
      continue
    }
    const code = c.charCodeAt(0)
    if (code < 33 || code > 117) return badChar(name, input, i)
    if (!group.length) groupAt = i
    group.push(code - 33)
    if (group.length === 5) {
      const err = flush(4)
      if (err) return err
    }
  }
  if (group.length === 1) return fail(`不是有效的 ${name}：結尾多出一個字元，長度不對`)
  if (group.length) {
    const err = flush(group.length - 1)
    if (err) return err
  }
  return Uint8Array.from(out)
}

/* ---- 十六進位、二進位、八進位、十進位 ---- */

export function hexDecode(input: string): Failure | Uint8Array {
  const out: number[] = []
  let half = -1
  let digits = 0
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (isSpace(c) || c === ':' || c === '-' || c === ',') continue
    // 每組前面的 0x 略過
    if (c === '0' && (input[i + 1] === 'x' || input[i + 1] === 'X') && half < 0) {
      const prev = input[i - 1]
      if (i === 0 || prev === undefined || isSpace(prev) || prev === ':' || prev === ',' || prev === '-') {
        i++
        continue
      }
    }
    const v = parseInt(c, 16)
    if (Number.isNaN(v)) return badChar('十六進位', input, i)
    digits++
    if (half < 0) half = v
    else {
      out.push(half * 16 + v)
      half = -1
    }
  }
  if (half >= 0) return fail(`不是有效的十六進位：位數要是偶數（目前 ${digits} 位）`)
  return Uint8Array.from(out)
}

/** 用空白（或逗號）分組的數字，每組一個位元組 */
function groupsDecode(input: string, radix: 2 | 8 | 10, name: string): Failure | Uint8Array {
  const out: number[] = []
  const re = /[^\s,]+/g
  let m: RegExpExecArray | null
  let group = 0
  while ((m = re.exec(input))) {
    group++
    const token = m[0]
    for (let i = 0; i < token.length; i++) {
      if (Number.isNaN(parseInt(token[i], radix))) return badChar(name, input, m.index + i)
    }
    // 二進位沒有分隔也可以：每 8 位一組
    if (radix === 2 && token.length > 8) {
      if (token.length % 8) return fail(`不是有效的${name}：第 ${group} 組有 ${token.length} 個位元，不是 8 的倍數`)
      for (let i = 0; i < token.length; i += 8) out.push(parseInt(token.slice(i, i + 8), 2))
      continue
    }
    const v = parseInt(token, radix)
    if (v > 255) return fail(`不是有效的${name}：第 ${group} 組「${token}」超過 255，不是一個位元組`)
    out.push(v)
  }
  return Uint8Array.from(out)
}

/* ---- URL ---- */

const URL_SAFE: Record<CodecOptions['urlMode'], string> = {
  component: "-_.!~*'()",
  uri: "-_.!~*'();/?:@&=+$,#",
  form: '-_.*',
}

export function urlEncode(text: string, mode: CodecOptions['urlMode']): string {
  const safe = URL_SAFE[mode]
  let out = ''
  for (const b of utf8(text)) {
    const c = String.fromCharCode(b)
    if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || (b < 128 && safe.includes(c))) out += c
    else if (mode === 'form' && b === 32) out += '+'
    else out += '%' + HEX[b >> 4].toUpperCase() + HEX[b & 15].toUpperCase()
  }
  return out
}

export function urlDecode(input: string, mode: CodecOptions['urlMode']): Result {
  const bytes: number[] = []
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === '%') {
      const h = input.slice(i + 1, i + 3)
      if (!/^[0-9a-fA-F]{2}$/.test(h)) return badChar('URL 編碼', input, i, '後面要接兩位十六進位')
      bytes.push(parseInt(h, 16))
      i += 2
    } else if (c === '+' && mode === 'form') bytes.push(32)
    else {
      const cp = input.codePointAt(i) ?? 0
      if (cp > 0xffff) i++
      bytes.push(...utf8(String.fromCodePoint(cp)))
    }
  }
  return bytesToText(Uint8Array.from(bytes))
}

/* ---- HTML 實體 ---- */

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', euro: '€', yen: '¥', pound: '£', cent: '¢', deg: '°', plusmn: '±', times: '×', divide: '÷',
  middot: '·', bull: '•', para: '¶', sect: '§', larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥',
}

export function htmlEncode(text: string, all: boolean): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (HTML_ESCAPE[ch]) out += HTML_ESCAPE[ch]
    else if (all && cp > 126) out += `&#${cp};`
    else out += ch
  }
  return out
}

export function htmlDecode(input: string): Result {
  const re = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) {
    const body = m[1]
    let rep: string | undefined
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) {
        return fail(`不是有效的 HTML 實體：第 ${position(input, m.index)} 個字元開始的「${m[0]}」不是有效的字元碼`)
      }
      rep = String.fromCodePoint(cp)
    } else rep = NAMED[body]
    // 不認得的名稱原樣保留
    if (rep === undefined) continue
    out += input.slice(last, m.index) + rep
    last = m.index + m[0].length
  }
  return ok(out + input.slice(last))
}

/* ---- Unicode 跳脫 ---- */

const hex4 = (n: number) => n.toString(16).padStart(4, '0')

export function unicodeEscape(text: string, braces: boolean, all: boolean): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const plain = cp >= 0x20 && cp < 0x7f && ch !== '\\'
    if (plain && !all) out += ch
    else if (braces) out += `\\u{${cp.toString(16)}}`
    else if (cp > 0xffff) {
      const v = cp - 0x10000
      out += `\\u${hex4(0xd800 + (v >> 10))}\\u${hex4(0xdc00 + (v & 0x3ff))}`
    } else out += `\\u${hex4(cp)}`
  }
  return out
}

export function unicodeUnescape(input: string): Result {
  const name = 'Unicode 跳脫'
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c !== '\\' || i + 1 >= input.length) {
      out += c
      continue
    }
    const t = input[i + 1]
    if (t === '\\') {
      out += '\\'
      i++
    } else if (t === 'u' && input[i + 2] === '{') {
      const close = input.indexOf('}', i + 3)
      const h = close < 0 ? '' : input.slice(i + 3, close)
      const cp = parseInt(h, 16)
      if (!/^[0-9a-fA-F]{1,6}$/.test(h) || cp > 0x10ffff) return badChar(name, input, i, '：\\u{…} 裡要是 1～6 位、不超過 10FFFF 的十六進位')
      out += String.fromCodePoint(cp)
      i = close
    } else if (t === 'u' || t === 'x' || t === 'U') {
      const len = t === 'u' ? 4 : t === 'x' ? 2 : 8
      const h = input.slice(i + 2, i + 2 + len)
      const cp = parseInt(h, 16)
      if (h.length < len || !/^[0-9a-fA-F]+$/.test(h) || cp > 0x10ffff) {
        return badChar(name, input, i, `：\\${t} 後面要接 ${len} 位十六進位`)
      }
      out += String.fromCodePoint(cp)
      i += 1 + len
    } else out += c
  }
  return ok(out)
}

/* ---- JSON 字串 ---- */

export function jsonDecode(input: string): Result {
  const name = 'JSON 字串'
  const t = input.trim()
  const quoted = t.length >= 2 && t.startsWith('"') && t.endsWith('"')
  const offset = quoted ? input.indexOf('"') + 1 : 0
  const body = quoted ? input.slice(offset, input.lastIndexOf('"')) : input
  // 先自己找出第一個錯的位置，訊息比 JSON.parse 的清楚
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '"') return badChar(name, input, offset + i, '：雙引號要寫成 \\"')
    if (c.charCodeAt(0) < 0x20) return badChar(name, input, offset + i, '：控制字元要跳脫（例如換行寫成 \\n）')
    if (c !== '\\') continue
    const t2 = body[i + 1]
    if (t2 === 'u') {
      if (!/^[0-9a-fA-F]{4}$/.test(body.slice(i + 2, i + 6))) return badChar(name, input, offset + i, '：\\u 後面要接 4 位十六進位')
      i += 5
    } else if (t2 !== undefined && '"\\/bfnrt'.includes(t2)) i++
    else return badChar(name, input, offset + i, '：不認得的跳脫序列')
  }
  try {
    return ok(JSON.parse(`"${body}"`) as string)
  } catch {
    return fail(`不是有效的 ${name}`)
  }
}

/* ---- ROT13 ---- */

export function rot13(text: string): string {
  return text.replace(/[A-Za-z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}

/* ---- 摩斯電碼 ---- */

const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
  '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', _: '..--.-', '"': '.-..-.',
  $: '...-..-', '@': '.--.-.',
}
const MORSE_BACK = new Map(Object.entries(MORSE).map(([k, v]) => [v, k]))

export function morseEncode(text: string): Result {
  const words: string[] = []
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue
    const codes: string[] = []
    for (const ch of word.toUpperCase()) {
      const code = MORSE[ch]
      if (!code) return fail(`摩斯電碼不支援 ${showChar(ch)}，只能用英文字母、數字和常見標點`)
      codes.push(code)
    }
    words.push(codes.join(' '))
  }
  return ok(words.join(' / '))
}

export function morseDecode(input: string): Result {
  // 各種長得像點和線的符號都收
  const norm = input.replace(/[·•∙]/g, '.').replace(/[−–—_]/g, '-')
  const words: string[] = []
  let group = 0
  for (const word of norm.trim().split(/\s*[/|]\s*|\s{3,}/)) {
    let out = ''
    for (const code of word.split(/\s+/)) {
      if (!code) continue
      group++
      const ch = MORSE_BACK.get(code)
      if (!ch) return fail(`不是有效的摩斯電碼：第 ${group} 組「${code}」對不到字元`)
      out += ch
    }
    if (out) words.push(out)
  }
  return ok(words.join(' '))
}

/* ---- 編碼清單 ---- */

export type OptionKey = keyof CodecOptions

export type Codec = {
  id: string
  name: string
  /** bytes：先把文字轉成 UTF-8 位元組；text：直接處理字元 */
  kind: 'bytes' | 'text'
  encode: (text: string, o: CodecOptions) => Result
  decode: (input: string, o: CodecOptions) => Result
  /** 這個格式會用到的選項 */
  options?: OptionKey[]
  note?: string
}

/** 位元組型的編碼：解碼結果再轉回 UTF-8 文字 */
function bytesCodec(
  id: string,
  name: string,
  encode: (bytes: Uint8Array, o: CodecOptions) => string,
  decode: (input: string, o: CodecOptions) => Failure | Uint8Array,
  extra: Partial<Codec> = {},
  limit = false,
): Codec {
  return {
    id,
    name,
    kind: 'bytes',
    encode: (text, o) => {
      const bytes = utf8(text)
      if (limit && bytes.length > BIG_LIMIT) return tooLong(name, bytes.length, BIG_LIMIT, '位元組')
      return ok(encode(bytes, o))
    },
    decode: (input, o) => {
      const r = decode(input, o)
      return r instanceof Uint8Array ? bytesToText(r) : r
    },
    ...extra,
  }
}

const always = (f: (text: string, o: CodecOptions) => string) => (text: string, o: CodecOptions) => ok(f(text, o))

export const CODECS: Codec[] = [
  bytesCodec('base64', 'Base64', (b, o) => base64Encode(b, o.b64Url, o.pad), base64Decode, {
    options: ['b64Url', 'pad'],
    note: '解碼時標準（+ /）和網址安全（- _）兩種寫法都收，= 可有可無。',
  }),
  bytesCodec('base62', 'Base62', (b) => bigEncode(b, B62), (s) => bigDecode(s, B62_TABLE, 62, 'Base62'), {
    note: 'Base62 沒有統一標準。這裡把位元組當成一個大整數，用 0-9A-Za-z 表示；開頭的每個 0x00 位元組各寫成一個「0」（跟 Base58 的做法一樣），所以解得回來。',
  }, true),
  bytesCodec('base58', 'Base58', (b) => bigEncode(b, B58), (s) => bigDecode(s, B58_TABLE, 58, 'Base58'), {
    note: '比特幣的字母表，去掉容易看錯的 0 O I l。開頭的每個 0x00 位元組寫成一個「1」。',
  }, true),
  bytesCodec('base36', 'Base36', (b) => bigEncode(b, B36), (s) => bigDecode(s, B36_TABLE, 36, 'Base36'), {
    note: '0-9a-z，解碼不分大小寫。跟 Base62 一樣把位元組當成大整數，開頭的 0x00 各寫成一個「0」。',
  }, true),
  bytesCodec('base32', 'Base32', (b, o) => bitsEncode(b, B32, 5, 8, o.pad), (s) => bitsDecode(s, B32_TABLE, 5, 'Base32'), {
    options: ['pad'],
    note: 'RFC 4648 標準字母表 A-Z2-7，解碼不分大小寫。',
  }),
  bytesCodec('base32hex', 'Base32 Hex', (b, o) => bitsEncode(b, B32_HEX, 5, 8, o.pad), (s) => bitsDecode(s, B32_HEX_TABLE, 5, 'Base32 Hex'), {
    options: ['pad'],
    note: 'RFC 4648 的「擴充十六進位」字母表 0-9A-V，排序後順序跟原始資料一致。',
  }),
  bytesCodec('ascii85', 'Ascii85', (b) => ascii85Encode(b), ascii85Decode, {
    note: '每 4 個位元組變 5 個字元，全為 0 的一組寫成 z。解碼時前後的 <~ ~> 可有可無。',
  }),
  bytesCodec('hex', 'Hex', (b, o) => toHex(b, o.hexSep, o.hexUpper), hexDecode, {
    options: ['hexUpper', 'hexSep'],
    note: '解碼時會略過空白、冒號、減號和每組前面的 0x。',
  }),
  bytesCodec('binary', '二進位', (b) => Array.from(b, (x) => x.toString(2).padStart(8, '0')).join(' '), (s) => groupsDecode(s, 2, '二進位'), {
    note: '每個位元組 8 位，用空白分開；解碼時沒分開也可以。',
  }),
  bytesCodec('octal', '八進位', (b) => Array.from(b, (x) => x.toString(8).padStart(3, '0')).join(' '), (s) => groupsDecode(s, 8, '八進位')),
  bytesCodec('decimal', '十進位', (b) => Array.from(b).join(' '), (s) => groupsDecode(s, 10, '十進位'), {
    note: '每個位元組一個 0～255 的數字。',
  }),
  {
    id: 'url',
    name: 'URL 編碼',
    kind: 'bytes',
    encode: always((t, o) => urlEncode(t, o.urlMode)),
    decode: (s, o) => urlDecode(s, o.urlMode),
    options: ['urlMode'],
  },
  {
    id: 'html',
    name: 'HTML 實體',
    kind: 'text',
    encode: always((t, o) => htmlEncode(t, o.htmlAll)),
    decode: htmlDecode,
    options: ['htmlAll'],
    note: '解碼支援 &#數字; &#x十六進位; 和常用的名稱（&amp; &nbsp; &copy; …），不認得的原樣保留。',
  },
  {
    id: 'unicode',
    name: 'Unicode 跳脫',
    kind: 'text',
    encode: always((t, o) => unicodeEscape(t, o.uniBraces, o.uniAll)),
    decode: unicodeUnescape,
    options: ['uniBraces', 'uniAll'],
    note: '解碼支援 \\uXXXX、\\u{…}、\\xXX 和 \\UXXXXXXXX。',
  },
  {
    id: 'json',
    name: 'JSON 字串',
    kind: 'text',
    encode: always((t) => JSON.stringify(t)),
    decode: jsonDecode,
    note: '解碼時前後的雙引號可有可無。',
  },
  { id: 'rot13', name: 'ROT13', kind: 'text', encode: always(rot13), decode: (s) => ok(rot13(s)), note: '英文字母各往後移 13 位，編碼和解碼是同一件事。' },
  {
    id: 'morse',
    name: '摩斯電碼',
    kind: 'text',
    encode: (t) => morseEncode(t),
    decode: morseDecode,
    note: '字母之間空一格，單字之間用 /。解碼結果是大寫。',
  },
]

export function findCodec(id: string): Codec {
  return CODECS.find((c) => c.id === id) ?? CODECS[0]
}
