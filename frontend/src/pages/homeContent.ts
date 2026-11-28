import { GAMES } from '../games/registry'
import { TOOLS } from '../tools/registry'

// 首頁上的文字。Home.tsx 用它；打包時 scripts/site-catalog.mjs 也用它把同樣的首頁寫進 index.html，
// 不跑 JavaScript 的爬蟲（搜尋引擎、公司防火牆的網站分類）才看得到這個網站在做什麼

export const OWNER = '歐陽明崴'

export const LEAD = `這裡是我順手寫東西的地方：Discord 機器人歐陽小俠、${GAMES.length} 款小遊戲、${TOOLS.length} 個小工具，還有幾個自己每天會用的 APP。`

export const PROFILE = [
  { label: '現在', value: '軟體工程師' },
  { label: '學歷', value: '中央大學物理研究所' },
  { label: '做過', value: '推薦系統、棋牌類強化學習、公司的 AI 管理方案' },
  { label: '擅長', value: 'Claude Code、知識庫、Harness 建置' },
]

export const WORKS = { title: '作品與工具', note: '點進去就能用，大部分不用登入。' }

/** 作品清單的第一項：Discord 機器人不在站上，沒有連結。其他項目來自 apps/registry.ts */
export const BOT = {
  glyph: '俠',
  name: '歐陽小俠',
  desc: 'Discord 機器人：點歌、音效板、AI 聊天，還有台灣天氣和地震速報。',
  tag: '運作中',
  live: true,
}
