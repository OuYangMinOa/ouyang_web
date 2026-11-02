import { Trie } from 'opencc-js/core'
// 簡轉繁的詞庫將近 1 MB，當成靜態檔案原封不動放出去，用到時瀏覽器再直接 import，
// 不進 Vite 的打包（否則會超過 chunk 大小警告的上限）
import stPhrasesUrl from 'opencc-js/dict/STPhrases?url'

// 字典按需載入：只在選到那個方向時才下載。
// 轉換流程照 OpenCC 官方設定（s2twp.json 等）：先把相容字統一，再用詞庫斷詞，最後逐段套用每一層字典

const DICTS = {
  CJK_Compatibility_Ideographs: () => import('opencc-js/dict/CJK_Compatibility_Ideographs'),
  STPhrases: () => import(/* @vite-ignore */ stPhrasesUrl) as Promise<{ default: string }>,
  STPhrases_GeneratedFromRegionalPhrases: () => import('opencc-js/dict/STPhrases_GeneratedFromRegionalPhrases'),
  STCharacters: () => import('opencc-js/dict/STCharacters'),
  TSPhrases: () => import('opencc-js/dict/TSPhrases'),
  TSCharacters: () => import('opencc-js/dict/TSCharacters'),
  TWPhrases: () => import('opencc-js/dict/TWPhrases'),
  TWPhrasesRev: () => import('opencc-js/dict/TWPhrasesRev'),
  TWVariants: () => import('opencc-js/dict/TWVariants'),
  TWVariantsPhrases: () => import('opencc-js/dict/TWVariantsPhrases'),
  TWVariantsRev: () => import('opencc-js/dict/TWVariantsRev'),
  TWVariantsRevPhrases: () => import('opencc-js/dict/TWVariantsRevPhrases'),
  HKVariants: () => import('opencc-js/dict/HKVariants'),
  HKVariantsPhrases: () => import('opencc-js/dict/HKVariantsPhrases'),
  HKVariantsRev: () => import('opencc-js/dict/HKVariantsRev'),
  HKVariantsRevPhrases: () => import('opencc-js/dict/HKVariantsRevPhrases'),
}

type DictName = keyof typeof DICTS

/** 一段轉換：segmentation 是斷詞用的詞庫，chain 是依序套用的字典組（同一組裡長詞優先） */
type Stage = { segmentation?: DictName[]; chain: DictName[][] }

const ST: DictName[] = ['STPhrases', 'STPhrases_GeneratedFromRegionalPhrases', 'STCharacters']
const ST_SEG: DictName[] = ['STPhrases', 'STPhrases_GeneratedFromRegionalPhrases']
const TS: DictName[] = ['TSPhrases', 'TSCharacters']

export type ModeId = 's2twp' | 's2tw' | 's2hk' | 'tw2sp' | 'tw2s' | 'hk2s' | 'tw2hk' | 'hk2tw'

export type Mode = {
  id: ModeId
  from: string
  to: string
  /** 交換方向時換成哪一個 */
  reverse: ModeId
  note: string
  stages: Stage[]
}

export const MODES: Mode[] = [
  {
    id: 's2twp',
    from: '簡體',
    to: '台灣正體（含用語）',
    reverse: 'tw2sp',
    note: '連同用語一起換成台灣的說法，例如 软件→軟體、信息→資訊、鼠标→滑鼠。',
    stages: [{ segmentation: ST_SEG, chain: [ST, ['TWPhrases', 'TWVariantsPhrases', 'TWVariants']] }],
  },
  {
    id: 's2tw',
    from: '簡體',
    to: '台灣正體（只轉字）',
    reverse: 'tw2s',
    note: '只把字換成台灣的正體字形，用語不變，例如 软件→軟件。',
    stages: [{ segmentation: ST_SEG, chain: [ST, ['TWVariantsPhrases', 'TWVariants']] }],
  },
  {
    id: 's2hk',
    from: '簡體',
    to: '香港繁體',
    reverse: 'hk2s',
    note: '換成香港的繁體字形，例如 里面→裏面、卫生→衞生。',
    stages: [{ segmentation: ST_SEG, chain: [ST, ['HKVariantsPhrases', 'HKVariants']] }],
  },
  {
    id: 'tw2sp',
    from: '台灣正體',
    to: '簡體（含用語）',
    reverse: 's2twp',
    note: '連同用語一起換成大陸的說法，例如 軟體→软件、資訊→信息。',
    stages: [{ segmentation: ['TSPhrases'], chain: [['TWPhrasesRev', 'TWVariantsRevPhrases', 'TWVariantsRev'], TS] }],
  },
  {
    id: 'tw2s',
    from: '台灣正體',
    to: '簡體（只轉字）',
    reverse: 's2tw',
    note: '只把字換成簡體，用語不變，例如 軟體→软体。',
    stages: [{ segmentation: ['TSPhrases'], chain: [['TWVariantsRevPhrases', 'TWVariantsRev'], TS] }],
  },
  {
    id: 'hk2s',
    from: '香港繁體',
    to: '簡體',
    reverse: 's2hk',
    note: '香港繁體換成簡體。',
    stages: [{ segmentation: ['TSPhrases'], chain: [['HKVariantsRevPhrases', 'HKVariantsRev'], TS] }],
  },
  {
    id: 'tw2hk',
    from: '台灣正體',
    to: '香港繁體',
    reverse: 'hk2tw',
    note: '只換字形，例如 裡→裏、著→着、衛→衞；用語不變。',
    stages: [{ chain: [['TWVariantsRevPhrases', 'TWVariantsRev']] }, { chain: [['HKVariantsPhrases', 'HKVariants']] }],
  },
  {
    id: 'hk2tw',
    from: '香港繁體',
    to: '台灣正體',
    reverse: 'tw2hk',
    note: '只換字形，例如 裏→裡、着→著、衞→衛；用語不變。',
    stages: [{ chain: [['HKVariantsRevPhrases', 'HKVariantsRev']] }, { chain: [['TWVariantsPhrases', 'TWVariants']] }],
  },
]

export function findMode(id: string): Mode {
  return MODES.find((m) => m.id === id) ?? MODES[0]
}

export type Converter = (text: string) => string

const dictCache = new Map<DictName, Promise<string>>()
function loadDict(name: DictName): Promise<string> {
  let p = dictCache.get(name)
  if (!p) {
    p = DICTS[name]().then((m) => m.default)
    // 載入失敗（斷線等）不要快取，下次再試
    p.catch(() => dictCache.delete(name))
    dictCache.set(name, p)
  }
  return p
}

function trieOf(dicts: string[]): Trie {
  const t = new Trie()
  t.loadDictGroup(dicts)
  return t
}

const converterCache = new Map<ModeId, Promise<Converter>>()

/** 取得某個方向的轉換函式；第一次會下載字典並建好查詢樹，之後直接用快取 */
export function getConverter(id: ModeId): Promise<Converter> {
  let p = converterCache.get(id)
  if (!p) {
    p = build(findMode(id))
    p.catch(() => converterCache.delete(id))
    converterCache.set(id, p)
  }
  return p
}

async function build(mode: Mode): Promise<Converter> {
  const names = new Set<DictName>(['CJK_Compatibility_Ideographs'])
  for (const s of mode.stages) {
    s.segmentation?.forEach((n) => names.add(n))
    s.chain.flat().forEach((n) => names.add(n))
  }
  const loaded = new Map<DictName, string>()
  await Promise.all([...names].map(async (n) => loaded.set(n, await loadDict(n))))
  const get = (list: DictName[]) => list.map((n) => loaded.get(n)!)

  const normalize = trieOf(get(['CJK_Compatibility_Ideographs']))
  const stages = mode.stages.map((s) => ({
    seg: s.segmentation ? trieOf(get(s.segmentation)) : null,
    chain: s.chain.map((group) => trieOf(get(group))),
  }))

  return (text) => {
    let out = normalize.convert(text)
    for (const s of stages) {
      const segments = s.seg ? s.seg.segment(out) : [out]
      out = segments.map((seg) => s.chain.reduce((acc, t) => t.convert(acc), seg)).join('')
    }
    return out
  }
}
