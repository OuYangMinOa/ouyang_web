import { diffArrays } from 'diff'

// 比對引擎：先把文字切成「單位」（行、字、詞），比對正規化後的單位，再把結果對回原文。
// 這樣忽略大小寫或空白時，畫面上顯示的還是原本的文字

export type Granularity = 'line' | 'word' | 'char'
export type DiffOptions = { ignoreCase: boolean; ignoreSpace: boolean }

/** 一段比對結果；相同的部分 a、b 都有（忽略大小寫時兩邊可能不一樣），刪除只有 a，新增只有 b */
export type Part = { type: 'eq' | 'del' | 'ins'; a: string; b: string }

export type Row =
  | { kind: 'eq'; aNo: number; bNo: number; a: string; b: string }
  | { kind: 'del'; aNo: number; a: string }
  | { kind: 'ins'; bNo: number; b: string }
  /** 修改過的一行：左右各一行，行內再逐字比對 */
  | { kind: 'mod'; aNo: number; bNo: number; parts: Part[] }

export type LineResult = { kind: 'line'; rows: Row[]; added: number; removed: number; same: boolean }
export type InlineResult = { kind: 'inline'; parts: Part[]; added: number; removed: number; same: boolean }
export type DiffResult = LineResult | InlineResult

/** 比對太久就放棄（兩段完全不同的長文字），交給畫面提示 */
const TIMEOUT = 1500
/** 太長的行不做行內逐字比對，避免卡住 */
const MAX_INLINE = 2000

const isSpace = (s: string) => /^\s+$/u.test(s)

function keyOf(token: string, opt: DiffOptions, stripSpace: boolean): string {
  let k = opt.ignoreCase ? token.toLowerCase() : token
  if (stripSpace) k = k.replace(/\s+/gu, '')
  return k
}

const wordSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh-Hant', { granularity: 'word' }) : null

export function tokenize(text: string, g: Exclude<Granularity, 'line'>): string[] {
  if (g === 'char') return Array.from(text)
  // 逐詞：中文用瀏覽器內建的斷詞，英文以單字為單位
  if (wordSegmenter) return Array.from(wordSegmenter.segment(text), (s) => s.segment)
  return text.match(/[\p{L}\p{N}_]+|\s+|[^]/gu) ?? []
}

export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/\r\n|\r|\n/)
}

/**
 * 比對兩串單位。skipSpace 時空白不參與比對，但仍保留在結果裡當作相同的部分。
 * 超過時間回傳 null
 */
export function diffTokens(A: string[], B: string[], opt: DiffOptions, skipSpace: boolean): Part[] | null {
  const pick = (T: string[]) => (skipSpace ? T.flatMap((t, i) => (isSpace(t) ? [] : [i])) : T.map((_, i) => i))
  const idxA = pick(A)
  const idxB = pick(B)
  const changes = diffArrays(
    idxA.map((i) => keyOf(A[i], opt, false)),
    idxB.map((i) => keyOf(B[i], opt, false)),
    { timeout: TIMEOUT },
  )
  if (!changes) return null

  const parts: Part[] = []
  const push = (type: Part['type'], a: string, b: string) => {
    const last = parts[parts.length - 1]
    if (last?.type === type) {
      last.a += a
      last.b += b
    } else parts.push({ type, a, b })
  }
  let pa = 0
  let pb = 0
  let ia = 0
  let ib = 0
  // 把下一個要比對的單位之前的空白補進結果
  const flushSpace = () => {
    const ea = ia < idxA.length ? idxA[ia] : A.length
    const eb = ib < idxB.length ? idxB[ib] : B.length
    const wa = A.slice(pa, ea).join('')
    const wb = B.slice(pb, eb).join('')
    pa = ea
    pb = eb
    if (wa || wb) push('eq', wa, wb)
  }

  for (const c of changes) {
    for (let k = 0; k < c.count; k++) {
      flushSpace()
      if (c.removed) {
        push('del', A[pa++], '')
        ia++
      } else if (c.added) {
        push('ins', '', B[pb++])
        ib++
      } else {
        push('eq', A[pa++], B[pb++])
        ia++
        ib++
      }
    }
  }
  flushSpace()
  return parts
}

function sum(parts: Part[], type: 'del' | 'ins'): number {
  let n = 0
  for (const p of parts) if (p.type === type) n += Array.from(type === 'del' ? p.a : p.b).length
  return n
}

/** 行內逐字比對；兩行幾乎完全不同時標示整行就好，免得畫面一片花 */
function inlineParts(a: string, b: string, opt: DiffOptions): Part[] | null {
  if (a.length > MAX_INLINE || b.length > MAX_INLINE) return null
  const parts = diffTokens(Array.from(a), Array.from(b), opt, opt.ignoreSpace)
  if (!parts) return null
  let same = 0
  for (const p of parts) if (p.type === 'eq') same += p.a.length + p.b.length
  return same / (a.length + b.length || 1) < 0.35 ? null : parts
}

export function diffText(a: string, b: string, g: Granularity, opt: DiffOptions): DiffResult | null {
  if (g !== 'line') {
    const parts = diffTokens(tokenize(a, g), tokenize(b, g), opt, opt.ignoreSpace)
    if (!parts) return null
    const added = sum(parts, 'ins')
    const removed = sum(parts, 'del')
    return { kind: 'inline', parts, added, removed, same: added === 0 && removed === 0 }
  }

  const A = splitLines(a)
  const B = splitLines(b)
  const changes = diffArrays(
    A.map((l) => keyOf(l, opt, opt.ignoreSpace)),
    B.map((l) => keyOf(l, opt, opt.ignoreSpace)),
    { timeout: TIMEOUT },
  )
  if (!changes) return null

  const rows: Row[] = []
  let ia = 0
  let ib = 0
  let added = 0
  let removed = 0
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]
    if (!c.added && !c.removed) {
      for (let k = 0; k < c.count; k++, ia++, ib++) rows.push({ kind: 'eq', aNo: ia + 1, bNo: ib + 1, a: A[ia], b: B[ib] })
      continue
    }
    // 一段刪除緊接一段新增，就是「修改」：一行對一行，行內再逐字比對
    const del = c.removed ? c.count : 0
    const next = changes[i + 1]
    const ins = c.added ? c.count : next?.added ? next.count : 0
    if (c.removed && next?.added) i++
    removed += del
    added += ins
    const pairs = Math.min(del, ins)
    // 差太多的行當成一行刪除加一行新增，連續幾行的刪除排在新增前面
    const dels: Row[] = []
    const inss: Row[] = []
    const flush = () => {
      rows.push(...dels, ...inss)
      dels.length = 0
      inss.length = 0
    }
    for (let k = 0; k < pairs; k++) {
      const parts = inlineParts(A[ia + k], B[ib + k], opt)
      if (parts) {
        flush()
        rows.push({ kind: 'mod', aNo: ia + k + 1, bNo: ib + k + 1, parts })
      } else {
        dels.push({ kind: 'del', aNo: ia + k + 1, a: A[ia + k] })
        inss.push({ kind: 'ins', bNo: ib + k + 1, b: B[ib + k] })
      }
    }
    for (let k = pairs; k < del; k++) dels.push({ kind: 'del', aNo: ia + k + 1, a: A[ia + k] })
    for (let k = pairs; k < ins; k++) inss.push({ kind: 'ins', bNo: ib + k + 1, b: B[ib + k] })
    flush()
    ia += del
    ib += ins
  }
  return { kind: 'line', rows, added, removed, same: added === 0 && removed === 0 }
}
