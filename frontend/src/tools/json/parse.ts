// 自己寫的 JSON 解析器：
// 1. 錯誤訊息用中文，並指出確切的位置（各瀏覽器 JSON.parse 的訊息格式都不一樣，Safari 甚至沒有位置）
// 2. 保留鍵的原始順序（JS 物件會把數字鍵排到最前面）和數字的原始寫法（大整數不會失去精度）

export type JNode =
  | { t: 'object'; entries: [string, JNode][] }
  | { t: 'array'; items: JNode[] }
  | { t: 'string'; v: string }
  | { t: 'number'; raw: string }
  | { t: 'boolean'; v: boolean }
  | { t: 'null' }

export class JsonError extends Error {
  offset: number
  constructor(message: string, offset: number) {
    super(message)
    this.offset = offset
  }
}

const LITERALS: [string, JNode][] = [
  ['true', { t: 'boolean', v: true }],
  ['false', { t: 'boolean', v: false }],
  ['null', { t: 'null' }],
]

const WS = new Set([' ', '\t', '\n', '\r'])
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const WORD = /[A-Za-z_$][\w$]*/y

/** 錯誤訊息裡顯示的字元：看不見的字元改用說明 */
function show(c: string | undefined): string {
  if (c === undefined) return '結尾'
  if (c === '\n' || c === '\r') return '換行'
  if (c === '\t') return 'Tab'
  if (c.charCodeAt(0) < 0x20) return `控制字元 U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  if (c === ' ' || c === '　') return '全形或不換行空白'
  return `「${c}」`
}

export function parseJson(text: string): JNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0

  function fail(msg: string, at = i): never {
    throw new JsonError(msg, at)
  }
  const skip = () => {
    while (i < text.length && WS.has(text[i])) i++
    // 註解是最常見的錯誤之一，特別提示
    if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) fail('JSON 不支援註解（// 或 /* */）')
  }

  /** 遇到不該出現的字元時，盡量猜出原因 */
  function unexpected(expect: string): never {
    const c = text[i]
    if (c === undefined) fail(`內容不完整：${expect}`)
    if (c === "'") fail('字串要用雙引號 "，不能用單引號')
    if (c === '“' || c === '”') fail('這是全形的引號，要改成半形的 "')
    if (c === '，') fail('這是全形逗號「，」，要改成半形的 ,')
    if (c === '：') fail('這是全形冒號「：」，要改成半形的 :')
    WORD.lastIndex = i
    const w = WORD.exec(text)?.[0]
    if (w === 'undefined' || w === 'NaN' || w === 'Infinity') fail(`JSON 不支援 ${w}，可以改用 null`)
    if (w === 'True' || w === 'False' || w === 'None' || w === 'NULL' || w === 'Null')
      fail(`JSON 的布林值和空值要用小寫：true、false、null`)
    fail(`${expect}，但這裡是${show(c)}`)
  }

  function value(depth: number): JNode {
    if (depth > 2000) fail('巢狀層數太深（超過 2000 層）')
    skip()
    const c = text[i]
    if (c === '{') return object(depth)
    if (c === '[') return array(depth)
    if (c === '"') return { t: 'string', v: string() }
    if (c === '-' || (c >= '0' && c <= '9')) return number()
    for (const [word, node] of LITERALS) {
      if (text.startsWith(word, i)) {
        i += word.length
        return node
      }
    }
    return unexpected('這裡應該是一個值（字串、數字、物件、陣列、true、false 或 null）')
  }

  function object(depth: number): JNode {
    const start = i++
    const entries: [string, JNode][] = []
    let comma = -1
    skip()
    if (text[i] === '}') {
      i++
      return { t: 'object', entries }
    }
    for (;;) {
      skip()
      if (text[i] === '}' && entries.length) fail('最後一個屬性後面多了逗號', comma)
      if (text[i] !== '"') {
        WORD.lastIndex = i
        if (WORD.exec(text)) fail('鍵名要用雙引號括起來，例如 "name"')
        if (text[i] === undefined) fail('物件沒有結束，缺少 }', start)
        unexpected('這裡應該是用雙引號括起來的鍵名')
      }
      const key = string()
      skip()
      if (text[i] !== ':') unexpected('鍵名後面缺少冒號 :')
      i++
      entries.push([key, value(depth + 1)])
      skip()
      if (text[i] === ',') {
        comma = i++
        continue
      }
      if (text[i] === '}') {
        i++
        return { t: 'object', entries }
      }
      if (text[i] === undefined) fail('物件沒有結束，缺少 }', start)
      if (text[i] === '"') fail('上一個屬性後面缺少逗號')
      unexpected('這裡應該是逗號 , 或 }')
    }
  }

  function array(depth: number): JNode {
    const start = i++
    const items: JNode[] = []
    let comma = -1
    skip()
    if (text[i] === ']') {
      i++
      return { t: 'array', items }
    }
    for (;;) {
      skip()
      if (text[i] === ']' && items.length) fail('最後一個元素後面多了逗號', comma)
      if (text[i] === ',') fail('多了一個逗號（陣列裡不能有空的元素）')
      items.push(value(depth + 1))
      skip()
      if (text[i] === ',') {
        comma = i++
        continue
      }
      if (text[i] === ']') {
        i++
        return { t: 'array', items }
      }
      if (text[i] === undefined) fail('陣列沒有結束，缺少 ]', start)
      if ('"{[-0123456789tfn'.includes(text[i])) fail('上一個元素後面缺少逗號')
      unexpected('這裡應該是逗號 , 或 ]')
    }
  }

  function string(): string {
    const start = i++
    let out = ''
    let from = i
    for (;;) {
      const c = text[i]
      if (c === undefined) fail('字串沒有結尾的雙引號', start)
      if (c === '"') {
        out += text.slice(from, i++)
        return out
      }
      if (c === '\n' || c === '\r') fail('字串不能直接換行，要寫成 \\n')
      if (c.charCodeAt(0) < 0x20) fail(`字串裡不能直接放${show(c)}，要用 \\u 跳脫`)
      if (c === '\\') {
        out += text.slice(from, i)
        const e = text[i + 1]
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (e in map) {
          out += map[e]
          i += 2
        } else if (e === 'u') {
          const hex = text.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('\\u 後面要接 4 位十六進位數字')
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
        } else {
          fail(e === undefined ? '字串沒有結尾的雙引號' : `無效的跳脫字元 \\${e}`)
        }
        from = i
        continue
      }
      i++
    }
  }

  function number(): JNode {
    NUMBER.lastIndex = i
    const m = NUMBER.exec(text)
    const raw = m?.[0] ?? ''
    const next = text[i + raw.length]
    // 「01」「1.」「.5」「1e」「-」這類寫法
    if (!raw || (next !== undefined && /[\d.eE+-]/.test(next))) {
      if (text[i] === '0' && next !== undefined && /\d/.test(next)) fail('數字不能以 0 開頭')
      fail('數字格式不正確')
    }
    i += raw.length
    return { t: 'number', raw }
  }

  skip()
  if (i >= text.length) fail('沒有內容')
  const root = value(0)
  skip()
  if (i < text.length) fail(`JSON 已經結束，後面還有多餘的內容（${show(text[i])}）`)
  return root
}

/** 把字元位置換成行、欄（都從 1 開始） */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1
  let last = -1
  for (let k = 0; k < offset && k < text.length; k++) {
    if (text[k] === '\n') {
      line++
      last = k
    }
  }
  return { line, col: offset - last }
}
