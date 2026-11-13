import type { ComponentType, LazyExoticComponent } from 'react'
import { lazyPage } from '../lazyPage'

/** 側邊欄的分組，順序就是顯示順序 */
export const TOOL_CATEGORIES = ['圖片', '影音', '文字', '計算', '生活', '娛樂'] as const

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
    component: lazyPage(() => import('./remove-bg')),
  },
  {
    id: 'id-photo',
    name: '證件照產生器',
    icon: '🪪',
    blurb: '自動去背換底色，依護照、身分證、1 吋、2 吋等規格裁切，排進 4×6 相紙直接沖印。',
    tags: ['AI', '本機處理'],
    category: '圖片',
    component: lazyPage(() => import('./id-photo')),
  },
  {
    id: 'watermark',
    name: '證件影本浮水印',
    icon: '🔏',
    blurb: '身分證、存摺影本蓋上「僅供某某用途」的斜向浮水印，敏感資料可以打馬賽克或塗黑。',
    tags: ['隱私', '本機處理'],
    category: '圖片',
    component: lazyPage(() => import('./watermark')),
  },
  {
    id: 'exif',
    name: '照片 EXIF 檢視與清除',
    icon: '📷',
    blurb: '查看拍攝時間、相機、GPS 位置，一鍵移除全部中繼資料或只移除定位，不重新壓縮。',
    tags: ['隱私', '多張'],
    category: '圖片',
    component: lazyPage(() => import('./exif')),
  },
  {
    id: 'image-convert',
    name: '圖片壓縮與轉檔',
    icon: '🔄',
    blurb: '多張圖片一次轉成 JPG、PNG、WebP，可調品質與尺寸，支援 iPhone 的 HEIC。圖片不會上傳。',
    tags: ['批次', 'HEIC', '本機處理'],
    category: '圖片',
    component: lazyPage(() => import('./image-convert')),
  },
  {
    id: 'qrcode',
    name: 'QR Code',
    icon: '🔳',
    blurb: '產生網址、Wi-Fi、聯絡人 QR Code，下載 PNG／SVG；也能用相機或圖片掃描。',
    tags: ['產生', '掃描'],
    category: '圖片',
    component: lazyPage(() => import('./qrcode')),
  },
  {
    id: 'color-picker',
    name: '圖片取色',
    icon: '🎨',
    blurb: '從圖片點選取色、自動萃取主要顏色調色盤，附 WCAG 對比檢查。',
    tags: ['調色盤', '對比'],
    category: '圖片',
    component: lazyPage(() => import('./color-picker')),
  },
  {
    id: 'video-convert',
    name: '影片轉 MP3／GIF／WebP',
    icon: '🎬',
    blurb: '取出影片的聲音存成 MP3，或剪一段做成 GIF、WebP 動圖，可調寬度、格數與品質。影片不會上傳。',
    tags: ['ffmpeg', '本機處理'],
    category: '影音',
    component: lazyPage(() => import('./video-convert')),
  },
  {
    id: 'emoji',
    name: 'Emoji 選擇器',
    icon: '😀',
    blurb: '用中文或英文搜尋，點一下就複製。',
    tags: ['複製'],
    category: '文字',
    component: lazyPage(() => import('./emoji')),
  },
  {
    id: 'ascii-art',
    name: 'ASCII 藝術字',
    icon: '🔤',
    blurb: '把文字變成 FIGlet 大字，上百種字型。',
    tags: ['FIGlet'],
    category: '文字',
    component: lazyPage(() => import('./ascii-art')),
  },
  {
    id: 'encoding',
    name: '編碼與雜湊',
    icon: '🔐',
    blurb: 'Base64、Base62、URL、Hex 等互轉，以及 MD5、SHA 系列雜湊。',
    tags: ['編碼', '雜湊'],
    category: '文字',
    component: lazyPage(() => import('./encoding')),
  },
  {
    id: 'zh-convert',
    name: '簡繁轉換',
    icon: '🀄',
    blurb: '簡體、台灣正體、香港繁體互轉，連「軟件→軟體」這類用語也一起換。',
    tags: ['OpenCC', '本機處理'],
    category: '文字',
    component: lazyPage(() => import('./zh-convert')),
  },
  {
    id: 'word-count',
    name: '字數統計',
    icon: '🔢',
    blurb: '中文字、英文單字、標點、行數與段落分開算，附預估閱讀時間。',
    tags: ['即時'],
    category: '文字',
    component: lazyPage(() => import('./word-count')),
  },
  {
    id: 'diff',
    name: '文字比對',
    icon: '🆚',
    blurb: '找出兩段文字的差異，逐行、逐詞或逐字比對，可忽略空白與大小寫。',
    tags: ['逐字', '並排'],
    category: '文字',
    component: lazyPage(() => import('./diff')),
  },
  {
    id: 'json',
    name: 'JSON / YAML 格式化',
    icon: '📋',
    blurb: '格式化、壓縮、驗證並指出錯誤位置，JSON 與 YAML 互轉，可摺疊的樹狀檢視。',
    tags: ['JSON', 'YAML'],
    category: '文字',
    component: lazyPage(() => import('./json')),
  },
  {
    id: 'regex',
    name: '正規表示式測試',
    icon: '🔍',
    blurb: '即時標示符合處、列出群組、預覽取代，附台灣常用格式範例與語法速查。',
    tags: ['RegExp'],
    category: '文字',
    component: lazyPage(() => import('./regex')),
  },
  {
    id: 'generator',
    name: '時間戳與產生器',
    icon: '🎟️',
    blurb: 'Unix 時間戳與日期互轉（含時區），產生 UUID v4／v7 與隨機密碼。',
    tags: ['UUID', '密碼'],
    category: '文字',
    component: lazyPage(() => import('./generator')),
  },
  {
    id: 'currency',
    name: '匯率計算機',
    icon: '💱',
    blurb: '各國央行每日參考匯率，含新台幣，多種貨幣一次換算。',
    tags: ['Frankfurter'],
    category: '計算',
    component: lazyPage(() => import('./currency')),
  },
  {
    id: 'date-calc',
    name: '日期計算',
    icon: '📅',
    blurb: '民國西元互轉、日期加減、相差天數、年齡，以及扣掉國定假日的工作天。',
    tags: ['民國年', '工作天'],
    category: '計算',
    component: lazyPage(() => import('./date-calc')),
  },
  {
    id: 'split-bill',
    name: '分帳計算機',
    icon: '💸',
    blurb: '多筆支出、不同人分攤，用最少的轉帳次數算出誰該給誰多少。',
    tags: ['分攤', '可複製'],
    category: '計算',
    component: lazyPage(() => import('./split-bill')),
  },
  {
    id: 'unit-convert',
    name: '單位換算',
    icon: '📏',
    blurb: '長度、面積（坪、甲）、重量（台斤）、體積、溫度、速度、資料大小。',
    tags: ['台制', '公制'],
    category: '計算',
    component: lazyPage(() => import('./unit-convert')),
  },
  {
    id: 'salary',
    name: '薪資試算',
    icon: '💰',
    blurb: '依 2026 年勞健保級距算出自付額、雇主負擔與實領，加上綜所稅概算。',
    tags: ['勞健保', '所得稅'],
    category: '計算',
    component: lazyPage(() => import('./salary')),
  },
  {
    id: 'mortgage',
    name: '房貸試算',
    icon: '🏠',
    blurb: '分段利率、寬限期，比較本息與本金平均攤還的月付金和總利息。',
    tags: ['攤還表', '圖表'],
    category: '計算',
    component: lazyPage(() => import('./mortgage')),
  },
  {
    id: 'invoice',
    name: '統一發票對獎',
    icon: '🧾',
    blurb: '輸入末 3 碼快速對獎，或用相機掃電子發票 QR Code 自動對獎。',
    tags: ['掃描', '財政部'],
    category: '生活',
    component: lazyPage(() => import('./invoice')),
  },
  {
    id: 'timer',
    name: '計時器',
    icon: '⏱️',
    blurb: '番茄鐘、碼表分圈、倒數計時，時間到會響鈴並通知。',
    tags: ['番茄鐘', '碼表'],
    category: '生活',
    component: lazyPage(() => import('./timer')),
  },
  {
    id: 'lottery',
    name: '抽籤',
    icon: '🎲',
    blurb: '籤筒、轉盤、彈珠賽跑、鬼腳圖公平抽出結果，也能隨機分組。',
    tags: ['轉盤', '鬼腳圖', '分組'],
    category: '娛樂',
    component: lazyPage(() => import('./lottery')),
  },
]

export function findTool(id: string | undefined): ToolInfo | undefined {
  return TOOLS.find((t) => t.id === id)
}
