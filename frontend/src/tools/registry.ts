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
    id: 'currency',
    name: '匯率計算機',
    icon: '💱',
    blurb: '各國央行每日參考匯率，含新台幣，多種貨幣一次換算。',
    tags: ['Frankfurter'],
    category: '計算',
    component: lazy(() => import('./currency')),
  },
  {
    id: 'date-calc',
    name: '日期計算',
    icon: '📅',
    blurb: '民國西元互轉、日期加減、相差天數、年齡，以及扣掉國定假日的工作天。',
    tags: ['民國年', '工作天'],
    category: '計算',
    component: lazy(() => import('./date-calc')),
  },
  {
    id: 'split-bill',
    name: '分帳計算機',
    icon: '🧾',
    blurb: '多筆支出、不同人分攤，用最少的轉帳次數算出誰該給誰多少。',
    tags: ['分攤', '可複製'],
    category: '計算',
    component: lazy(() => import('./split-bill')),
  },
  {
    id: 'unit-convert',
    name: '單位換算',
    icon: '📏',
    blurb: '長度、面積（坪、甲）、重量（台斤）、體積、溫度、速度、資料大小。',
    tags: ['台制', '公制'],
    category: '計算',
    component: lazy(() => import('./unit-convert')),
  },
  {
    id: 'salary',
    name: '薪資試算',
    icon: '💰',
    blurb: '依 2026 年勞健保級距算出自付額、雇主負擔與實領，加上綜所稅概算。',
    tags: ['勞健保', '所得稅'],
    category: '計算',
    component: lazy(() => import('./salary')),
  },
  {
    id: 'mortgage',
    name: '房貸試算',
    icon: '🏠',
    blurb: '分段利率、寬限期，比較本息與本金平均攤還的月付金和總利息。',
    tags: ['攤還表', '圖表'],
    category: '計算',
    component: lazy(() => import('./mortgage')),
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
