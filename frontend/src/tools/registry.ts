import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/** 側邊欄的分組，順序就是顯示順序 */
export const TOOL_CATEGORIES = ['圖片', '文字', '計算', '娛樂'] as const

export type ToolInfo = {
  /** 網址用的 id：/tools/<id> */
  id: string
  name: string
  icon: string
  blurb: string
  /** 卡片上的小標籤 */
  tags: string[]
  category: (typeof TOOL_CATEGORIES)[number]
  component: LazyExoticComponent<ComponentType>
}

// 每個工具各自打包，進到那一頁才下載
export const TOOLS: ToolInfo[] = [
  {
    id: 'remove-bg',
    name: '圖片去背',
    icon: '✂️',
    blurb: 'AI 自動去背，可以用筆刷或點選修補。全部在瀏覽器裡處理，圖片不會上傳。',
    tags: ['AI', '本機處理'],
    category: '圖片',
    component: lazy(() => import('./remove-bg')),
  },
  {
    id: 'emoji',
    name: 'Emoji 選擇器',
    icon: '😀',
    blurb: '用中文或英文搜尋，點一下就複製。',
    tags: ['複製'],
    category: '文字',
    component: lazy(() => import('./emoji')),
  },
  {
    id: 'ascii-art',
    name: 'ASCII 藝術字',
    icon: '🔤',
    blurb: '把文字變成 FIGlet 大字，上百種字型。',
    tags: ['FIGlet'],
    category: '文字',
    component: lazy(() => import('./ascii-art')),
  },
  {
    id: 'encoding',
    name: '編碼與雜湊',
    icon: '🔐',
    blurb: 'Base64、Base62、URL、Hex 等互轉，以及 MD5、SHA 系列雜湊。',
    tags: ['編碼', '雜湊'],
    category: '文字',
    component: lazy(() => import('./encoding')),
  },
  {
    id: 'zh-convert',
    name: '簡繁轉換',
    icon: '🀄',
    blurb: '簡體、台灣正體、香港繁體互轉，連「軟件→軟體」這類用語也一起換。',
    tags: ['OpenCC', '本機處理'],
    category: '文字',
    component: lazy(() => import('./zh-convert')),
  },
  {
    id: 'word-count',
    name: '字數統計',
    icon: '🔢',
    blurb: '中文字、英文單字、標點、行數與段落分開算，附預估閱讀時間。',
    tags: ['即時'],
    category: '文字',
    component: lazy(() => import('./word-count')),
  },
  {
    id: 'diff',
    name: '文字比對',
    icon: '🆚',
    blurb: '找出兩段文字的差異，逐行、逐詞或逐字比對，可忽略空白與大小寫。',
    tags: ['逐字', '並排'],
    category: '文字',
    component: lazy(() => import('./diff')),
  },
  {
    id: 'json',
    name: 'JSON / YAML 格式化',
    icon: '🧾',
    blurb: '格式化、壓縮、驗證並指出錯誤位置，JSON 與 YAML 互轉，可摺疊的樹狀檢視。',
    tags: ['JSON', 'YAML'],
    category: '文字',
    component: lazy(() => import('./json')),
  },
  {
    id: 'regex',
    name: '正規表示式測試',
    icon: '🔍',
    blurb: '即時標示符合處、列出群組、預覽取代，附台灣常用格式範例與語法速查。',
    tags: ['RegExp'],
    category: '文字',
    component: lazy(() => import('./regex')),
  },
  {
    id: 'generator',
    name: '時間戳與產生器',
    icon: '🎟️',
    blurb: 'Unix 時間戳與日期互轉（含時區），產生 UUID v4／v7 與隨機密碼。',
    tags: ['UUID', '密碼'],
    category: '文字',
    component: lazy(() => import('./generator')),
  },
  {
    id: 'currency',
    name: '匯率計算機',
    icon: '💱',
    blurb: '各國央行每日參考匯率，含新台幣，多種貨幣一次換算。',
    tags: ['Frankfurter'],
    category: '計算',
    component: lazy(() => import('./currency')),
  },
  {
    id: 'lottery',
    name: '抽籤',
    icon: '🎲',
    blurb: '籤筒、轉盤、彈珠賽跑、鬼腳圖，四種方式公平抽出結果。',
    tags: ['轉盤', '鬼腳圖'],
    category: '娛樂',
    component: lazy(() => import('./lottery')),
  },
]

export function findTool(id: string | undefined): ToolInfo | undefined {
  return TOOLS.find((t) => t.id === id)
}
