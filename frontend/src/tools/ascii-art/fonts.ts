import figlet, { type FigletOptions } from 'figlet'

// figlet 的 .flf 字型檔當成靜態檔輸出，選到才 fetch。
// 不用 importable-fonts：那會把每個字型包成 JS chunk，最大的超過 1 MB
const URLS = import.meta.glob<string>('../../../node_modules/figlet/fonts/*.flf', {
  // no-inline：小字型也輸出成檔案，不要內嵌成 data URL 塞進 JS
  query: '?url&no-inline',
  import: 'default',
  eager: true,
})

// 內容完全相同、只是檔名不同的字型，對應到保留的那個
const ALIASES: Record<string, string> = {
  'ANSI-Compact': 'ANSI Compact',
  'babyface-lame': 'Babyface Lame',
  'babyface-leet': 'Babyface Leet',
}

const PATHS = new Map<string, string>()
for (const path of Object.keys(URLS)) {
  const name = path.slice(path.lastIndexOf('/') + 1, -'.flf'.length)
  if (!(name in ALIASES)) PATHS.set(name, path)
}

/** 全部字型，依名稱排序（不分大小寫、數字照大小） */
export const FONTS = [...PATHS.keys()].sort((a, b) =>
  a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }),
)

export const DEFAULT_FONT = 'Isometric1'

const LOWER = new Map(FONTS.map((f) => [f.toLowerCase(), f]))

/** 網址上的字型名稱 → 正式名稱（不分大小寫），找不到回傳 null */
export function resolveFont(name: string | null): string | null {
  if (!name) return null
  const canonical = ALIASES[name] ?? name
  return LOWER.get(canonical.toLowerCase()) ?? null
}

export function isLoaded(name: string): boolean {
  return name in figlet.figFonts
}

const loading = new Map<string, Promise<void>>()

/** 下載並註冊字型；同一個字型只下載一次 */
export function loadFont(name: string): Promise<void> {
  let p = loading.get(name)
  if (!p) {
    const path = PATHS.get(name)
    p = path
      ? fetch(URLS[path])
          .then((res) => {
            if (!res.ok) throw new Error(`字型下載失敗（${res.status}）`)
            return res.text()
          })
          .then((data) => {
            figlet.parseFont(name, data)
          })
      : Promise.reject(new Error(`沒有這個字型：${name}`))
    // 失敗（例如網路斷線）就忘掉，下次再試
    p.catch(() => loading.delete(name))
    loading.set(name, p)
  }
  return p
}

type Layout = NonNullable<FigletOptions['horizontalLayout']>

/** 水平／垂直排列；網址上用索引 0–4 */
export const LAYOUTS: { value: Layout; label: string }[] = [
  { value: 'default', label: '預設' },
  { value: 'full', label: '完整' },
  { value: 'fitted', label: '緊密' },
  { value: 'controlled smushing', label: '智慧合併' },
  { value: 'universal smushing', label: '全部合併' },
]

export type ArtOptions = {
  font: string
  h: number
  v: number
  /** 0 表示不限 */
  width: number
  whitespaceBreak: boolean
}

/** 產生藝術字；字型要先載入。去掉行尾空白，空字串時回傳 '' */
export function renderArt(text: string, o: ArtOptions): string {
  const out = figlet.textSync(text, {
    font: o.font,
    horizontalLayout: LAYOUTS[o.h]?.value ?? 'default',
    verticalLayout: LAYOUTS[o.v]?.value ?? 'default',
    width: o.width > 0 ? o.width : undefined,
    whitespaceBreak: o.whitespaceBreak,
  })
  const lines = out.split('\n').map((line) => line.trimEnd())
  return lines.some((line) => line) ? lines.join('\n') : ''
}

/** 字型裡沒有的字元（不重複）；figlet 遇到會直接略過 */
export function missingChars(text: string, font: string): string[] {
  const glyphs = figlet.figFonts[font]
  if (!glyphs) return []
  const out = new Set<string>()
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') continue
    if (!glyphs[ch.codePointAt(0)!]) out.add(ch)
  }
  return [...out]
}

type CommentStyle = { id: string; label: string; line?: string; start?: string; end?: string }

/** 包成程式碼註解，貼進原始碼用 */
export const COMMENTS: CommentStyle[] = [
  { id: 'none', label: '不加' },
  { id: 'slash', label: '// C、JS', line: '// ' },
  { id: 'hash', label: '# Python', line: '# ' },
  { id: 'dash', label: '-- SQL', line: '-- ' },
  { id: 'semi', label: '; Lisp', line: '; ' },
  { id: 'block', label: '/* */', start: '/*', end: '*/' },
  { id: 'html', label: '<!-- -->', start: '<!--', end: '-->' },
]

export function withComment(art: string, id: string): string {
  const c = COMMENTS.find((x) => x.id === id)
  if (!art || !c) return art
  if (c.line) {
    const prefix = c.line
    return art
      .split('\n')
      .map((line) => (prefix + line).trimEnd())
      .join('\n')
  }
  if (c.start && c.end) return `${c.start}\n${art}\n${c.end}`
  return art
}
