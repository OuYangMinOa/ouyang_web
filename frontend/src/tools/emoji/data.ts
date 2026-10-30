// emojibase 的資料：中文、英文各一份，用 hexcode 合併；JSON 很大，動態載入成獨立的 chunk

type RawEmoji = {
  hexcode: string
  label: string
  unicode: string
  group?: number
  order?: number
  tags?: string[]
  skins?: RawEmoji[]
}

/** 實際要複製的一個字元（基本款或某個膚色） */
export type Variant = {
  hex: string
  char: string
  zh: string
  en: string
  shortcodes: string[]
  emoji: Emoji
}

export type Emoji = {
  group: number
  base: Variant
  /** 依膚色選項排列：0 是預設，1–5 是淺到深；沒有膚色的 emoji 沒有這個欄位 */
  tones?: Variant[]
  /** 小寫的搜尋字串：中英名稱、關鍵字、:shortcode:、字元本身 */
  search: string
}

export type Group = { id: number; name: string; icon: string; emojis: Emoji[] }

export type EmojiData = {
  groups: Group[]
  all: Emoji[]
  /** 任何一個 hexcode（含膚色）都查得到 */
  byHex: Map<string, Variant>
}

/** 膚色修飾字元，順序是淺到深 */
export const TONE_HEX = ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF']

const COMPONENT_GROUP = 2
const GROUP_ICONS: Record<number, string> = {
  0: '😀',
  1: '👋',
  3: '🐻',
  4: '🍔',
  5: '✈️',
  6: '⚽',
  7: '💡',
  8: '🔣',
  9: '🏁',
}

let cache: Promise<EmojiData> | null = null

export function loadEmojiData(): Promise<EmojiData> {
  cache ??= build().catch((err: unknown) => {
    // 失敗了下次重新下載
    cache = null
    throw err
  })
  return cache
}

async function build(): Promise<EmojiData> {
  const [zhMod, enMod, scMod, msgMod] = await Promise.all([
    import('emojibase-data/zh-hant/compact.json'),
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/en/shortcodes/emojibase.json'),
    import('emojibase-data/zh-hant/messages.json'),
  ])
  const zhList = zhMod.default as RawEmoji[]
  const enList = enMod.default as RawEmoji[]
  const shortcodes = scMod.default as Record<string, string | string[]>
  const messages = msgMod.default as { groups: { message: string; order: number }[] }

  const enByHex = new Map<string, RawEmoji>()
  for (const e of enList) {
    enByHex.set(e.hexcode, e)
    for (const s of e.skins ?? []) enByHex.set(s.hexcode, s)
  }
  const codesOf = (hex: string) => {
    const sc = shortcodes[hex]
    return sc === undefined ? [] : Array.isArray(sc) ? sc : [sc]
  }

  const byHex = new Map<string, Variant>()
  const all: Emoji[] = []

  for (const zh of [...zhList].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    // 沒有分類的是區域指標字母，元件是單獨的膚色、髮型，都不顯示
    if (zh.group === undefined || zh.group === COMPONENT_GROUP) continue
    const en = enByHex.get(zh.hexcode)

    const emoji = { group: zh.group } as Emoji
    const makeVariant = (raw: RawEmoji): Variant => {
      const v: Variant = {
        hex: raw.hexcode,
        char: raw.unicode,
        zh: raw.label,
        en: enByHex.get(raw.hexcode)?.label ?? '',
        shortcodes: codesOf(raw.hexcode),
        emoji,
      }
      byHex.set(v.hex, v)
      return v
    }

    emoji.base = makeVariant(zh)
    if (zh.skins?.length) {
      for (const s of zh.skins) makeVariant(s)
      emoji.tones = [emoji.base, ...TONE_HEX.map((t) => byHex.get(pickTone(zh.skins!, t)) ?? emoji.base)]
    }

    const b = emoji.base
    emoji.search = [
      b.zh,
      b.en,
      ...(zh.tags ?? []),
      ...(en?.tags ?? []),
      ...b.shortcodes.map((c) => `:${c}:`),
      b.char,
    ]
      .join('\n')
      .toLowerCase()
    all.push(emoji)
  }

  const groups: Group[] = messages.groups
    .filter((g) => g.order !== COMPONENT_GROUP)
    .map((g) => ({
      id: g.order,
      name: g.message,
      icon: GROUP_ICONS[g.order] ?? '❔',
      emojis: all.filter((e) => e.group === g.order),
    }))
    .filter((g) => g.emojis.length > 0)

  return { groups, all, byHex }
}

/** 找出所有膚色修飾都是 tone 的那一個（雙人 emoji 有混合膚色，只取同色的） */
function pickTone(skins: RawEmoji[], tone: string): string {
  for (const s of skins) {
    const mods = s.hexcode.split('-').filter((h) => TONE_HEX.includes(h))
    if (mods.length > 0 && mods.every((m) => m === tone)) return s.hexcode
  }
  return ''
}

export function withTone(emoji: Emoji, tone: number): Variant {
  return emoji.tones?.[tone] ?? emoji.base
}

/** 每個詞都要出現；完全符合名稱或 shortcode 的排最前面，其次是名稱開頭、名稱含有每個詞 */
export function searchEmojis(all: Emoji[], query: string): Emoji[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/)
  const code = q.replace(/^:|:$/g, '')

  const hits: { e: Emoji; score: number; i: number }[] = []
  all.forEach((e, i) => {
    if (!terms.every((t) => e.search.includes(t))) return
    const b = e.base
    const zh = b.zh.toLowerCase()
    const en = b.en.toLowerCase()
    let score = 3
    if (zh === q || en === q || b.char === q || b.shortcodes.includes(code)) score = 0
    else if (zh.startsWith(q) || en.startsWith(q)) score = 1
    else if (terms.every((t) => zh.includes(t) || en.includes(t))) score = 2
    hits.push({ e, score, i })
  })
  hits.sort((a, b) => a.score - b.score || a.i - b.i)
  return hits.map((h) => h.e)
}

/** 依實際字元算碼位，包含 FE0F 等變體選擇符 */
export function codepoints(char: string): string[] {
  return Array.from(char, (c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'))
}
