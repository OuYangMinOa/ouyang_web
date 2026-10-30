import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/** 側邊欄的分組，順序就是顯示順序 */
export const TOOL_CATEGORIES = ['圖片', '文字', '計算'] as const

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
]

export function findTool(id: string | undefined): ToolInfo | undefined {
  return TOOLS.find((t) => t.id === id)
}
