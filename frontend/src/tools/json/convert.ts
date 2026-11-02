import type { JNode } from './parse'

type Yaml = typeof import('yaml')

export function sortKeys(n: JNode): JNode {
  if (n.t === 'object') {
    const entries = n.entries.map(([k, v]): [string, JNode] => [k, sortKeys(v)])
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return { t: 'object', entries }
  }
  if (n.t === 'array') return { t: 'array', items: n.items.map(sortKeys) }
  return n
}

/** 輸出 JSON；indent 是空字串時壓縮成一行 */
export function stringify(n: JNode, indent: string): string {
  const out: string[] = []
  const nl = indent ? '\n' : ''
  const colon = indent ? ': ' : ':'
  const walk = (n: JNode, pad: string) => {
    switch (n.t) {
      case 'string':
        out.push(JSON.stringify(n.v))
        return
      case 'number':
        out.push(n.raw)
        return
      case 'boolean':
        out.push(String(n.v))
        return
      case 'null':
        out.push('null')
        return
      case 'array': {
        if (!n.items.length) return void out.push('[]')
        const inner = pad + indent
        out.push('[' + nl)
        n.items.forEach((v, i) => {
          out.push(inner)
          walk(v, inner)
          out.push(i < n.items.length - 1 ? ',' + nl : nl)
        })
        out.push(pad + ']')
        return
      }
      case 'object': {
        if (!n.entries.length) return void out.push('{}')
        const inner = pad + indent
        out.push('{' + nl)
        n.entries.forEach(([k, v], i) => {
          out.push(inner + JSON.stringify(k) + colon)
          walk(v, inner)
          out.push(i < n.entries.length - 1 ? ',' + nl : nl)
        })
        out.push(pad + '}')
      }
    }
  }
  walk(n, '')
  return out.join('')
}

/** 轉成 yaml 套件吃的值：物件用 Map 保留順序，大整數用 BigInt 保留精度 */
function toPlain(n: JNode): unknown {
  switch (n.t) {
    case 'object':
      return new Map(n.entries.map(([k, v]) => [k, toPlain(v)]))
    case 'array':
      return n.items.map(toPlain)
    case 'number': {
      if (/^-?\d+$/.test(n.raw)) {
        const big = BigInt(n.raw)
        return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big
      }
      return Number(n.raw)
    }
    case 'null':
      return null
    default:
      return n.v
  }
}

export function toYaml(yaml: Yaml, n: JNode, indent: number): string {
  // lineWidth 0：長字串不要自動折行
  return yaml.stringify(toPlain(n), { indent, lineWidth: 0, minContentWidth: 0 })
}

/** 有些 YAML 的值 JSON 表示不了（.nan、.inf、二進位、時間），轉換時給個提醒 */
export type YamlWarning = string

function fromPlain(v: unknown, warn: (w: YamlWarning) => void): JNode {
  if (v === null || v === undefined) return { t: 'null' }
  if (typeof v === 'string') return { t: 'string', v }
  if (typeof v === 'boolean') return { t: 'boolean', v }
  if (typeof v === 'bigint') return { t: 'number', raw: v.toString() }
  if (typeof v === 'number') {
    if (Number.isFinite(v)) return { t: 'number', raw: String(v) }
    warn('.nan／.inf 在 JSON 裡沒有對應的寫法，已改成 null')
    return { t: 'null' }
  }
  if (v instanceof Date) return { t: 'string', v: v.toISOString() }
  if (v instanceof Uint8Array) {
    warn('二進位資料（!!binary）已轉成 Base64 字串')
    let s = ''
    for (const b of v) s += String.fromCharCode(b)
    return { t: 'string', v: btoa(s) }
  }
  if (Array.isArray(v) || v instanceof Set) return { t: 'array', items: [...v].map((x) => fromPlain(x, warn)) }
  if (v instanceof Map) {
    return {
      t: 'object',
      entries: [...v].map(([k, x]): [string, JNode] => {
        if (k !== null && typeof k === 'object') warn('YAML 的複合鍵在 JSON 裡只能變成字串')
        return [typeof k === 'string' ? k : k !== null && typeof k === 'object' ? JSON.stringify(k) : String(k), fromPlain(x, warn)]
      }),
    }
  }
  if (typeof v === 'object') return fromPlain(new Map(Object.entries(v)), warn)
  return { t: 'string', v: String(v) }
}

export type YamlParsed = { ok: true; node: JNode; warnings: string[] } | { ok: false; message: string; line?: number; col?: number }

export function parseYaml(yaml: Yaml, text: string): YamlParsed {
  // 多份文件（---）只取第一份；別名展開數量設上限，防止「億萬笑聲」攻擊吃光記憶體
  const docs = yaml.parseAllDocuments(text, { prettyErrors: true, intAsBigInt: true })
  const list = Array.isArray(docs) ? docs : [docs]
  const doc = list[0]
  if (!doc) return { ok: true, node: { t: 'null' }, warnings: [] }
  const err = doc.errors[0]
  if (err) {
    const pos = err.linePos?.[0]
    // 錯誤訊息的第一行是說明，後面是 yaml 套件畫的程式碼片段，畫面上另外顯示
    return { ok: false, message: translateYamlError(err.message.split('\n')[0]), line: pos?.line, col: pos?.col }
  }
  const warnings = new Set<string>()
  if (list.length > 1) warnings.add(`有 ${list.length} 份 YAML 文件（以 --- 分隔），只轉換第一份`)
  try {
    const js = doc.toJS({ mapAsMap: true, maxAliasCount: 1000 })
    return { ok: true, node: fromPlain(js, (w) => warnings.add(w)), warnings: [...warnings] }
  } catch (e) {
    return { ok: false, message: translateYamlError(e instanceof Error ? e.message : String(e)) }
  }
}

/** 把常見的 YAML 錯誤翻成中文；看不懂的保留原文 */
function translateYamlError(msg: string): string {
  const rules: [RegExp, string][] = [
    [/^Map keys must be unique/, '同一層有重複的鍵'],
    [/^Implicit keys need to be on a single line/, '鍵名不能跨行，可能是縮排或冒號的位置不對'],
    [/^Nested mappings are not allowed in compact mappings/, '同一行不能再接一層對應，可能少了換行或縮排'],
    [/^All mapping items must start at the same column/, '同一層的項目要對齊在同一欄（縮排不一致）'],
    [/^All sequence items must start at the same column/, '同一層的清單項目要對齊在同一欄（縮排不一致）'],
    [/^Tabs are not allowed as indentation/, 'YAML 不能用 Tab 縮排，請改用空白'],
    [/^Missing closing "quote/, '字串缺少結尾的雙引號'],
    [/^Missing closing 'quote/, "字串缺少結尾的單引號"],
    [/^Unexpected end of flow/, '括號沒有結束（缺少 ] 或 }）'],
    [/^Excessive alias count/, '別名（*）展開太多次，可能是惡意構造的內容'],
    [/^Unresolved alias/, '找不到別名指向的錨點（&）'],
    [/^Block scalar header includes extra characters/, '多行字串的標記（| 或 >）後面有多餘的字'],
    [/^Unexpected (.+) at node end/, '這裡多了不該出現的內容'],
    [/^Unexpected scalar at node end/, '這裡多了不該出現的內容'],
  ]
  for (const [re, zh] of rules) if (re.test(msg)) return `${zh}（${msg}）`
  return msg
}
