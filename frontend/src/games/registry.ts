import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/** 側邊欄的分組，順序就是顯示順序 */
export const GAME_CATEGORIES = ['多人對戰', '棋類對戰', '單人'] as const

export type GameInfo = {
  /** 網址用的 id：/games/<id> */
  id: string
  name: string
  icon: string
  blurb: string
  /** 卡片上的小標籤 */
  tags: string[]
  category: (typeof GAME_CATEGORIES)[number]
  component: LazyExoticComponent<ComponentType>
}

// 每個遊戲各自打包，進到那一頁才下載
export const GAMES: GameInfo[] = [
  {
    id: 'tetris',
    name: '俄羅斯方塊 99',
    icon: '🧱',
    blurb: '最多 99 人同場的大逃殺：消行攻擊、KO 搶徽章，活到最後的人獲勝。人不夠由電腦補位。',
    tags: ['多人', '線上', '練習'],
    category: '多人對戰',
    component: lazy(() => import('./tetris')),
  },
  {
    id: 'puyo',
    name: '魔法氣泡',
    icon: '🫧',
    blurb: '同色四顆連起來就消掉，疊出大連鎖！單人模式衝排行榜、和電腦一對一，或開房間和朋友打最多 99 人的大逃殺。',
    tags: ['單人', '電腦', '多人', '線上'],
    category: '多人對戰',
    component: lazy(() => import('./puyo')),
  },
  {
    id: 'snake',
    name: '貪食蛇',
    icon: '🐍',
    blurb: '三段速度、會跑的蘋果，還有吃到就頭尾互換的「來回」模式。',
    tags: ['單人'],
    category: '單人',
    component: lazy(() => import('./snake')),
  },
  {
    id: 'gomoku',
    name: '五子棋',
    icon: '⚫',
    blurb: '先連成五子的一方獲勝。',
    tags: ['電腦', '本地', '線上'],
    category: '棋類對戰',
    component: lazy(() => import('./gomoku')),
  },
  {
    id: 'xiangqi',
    name: '象棋',
    icon: '🀄',
    blurb: '楚河漢界，將死對方的帥／將。',
    tags: ['電腦', '本地', '線上'],
    category: '棋類對戰',
    component: lazy(() => import('./xiangqi')),
  },
  {
    id: 'chess',
    name: '西洋棋',
    icon: '♟️',
    blurb: '完整規則：入堡、吃過路兵、升變。',
    tags: ['電腦', '本地', '線上'],
    category: '棋類對戰',
    component: lazy(() => import('./chess')),
  },
  {
    id: 'reversi',
    name: '黑白棋',
    icon: '⚪',
    blurb: '夾住就翻面，最後棋子多的一方獲勝。',
    tags: ['電腦', '本地', '線上'],
    category: '棋類對戰',
    component: lazy(() => import('./reversi')),
  },
  {
    id: 'ab',
    name: '1A2B 猜數字',
    icon: '🔢',
    blurb: '根據 A／B 提示推理四位不重複數字，結束後分析你的每一步。',
    tags: ['你猜', '電腦猜'],
    category: '單人',
    component: lazy(() => import('./ab')),
  },
  {
    id: 'sudoku',
    name: '數獨',
    icon: '🔲',
    blurb: '四種難度，支援筆記與提示。',
    tags: ['單人'],
    category: '單人',
    component: lazy(() => import('./sudoku')),
  },
  {
    id: 'minesweeper',
    name: '踩地雷',
    icon: '💣',
    blurb: '第一下保證安全，手機可切換插旗模式。',
    tags: ['單人'],
    category: '單人',
    component: lazy(() => import('./minesweeper')),
  },
]

export function findGame(id: string | undefined): GameInfo | undefined {
  return GAMES.find((g) => g.id === id)
}
