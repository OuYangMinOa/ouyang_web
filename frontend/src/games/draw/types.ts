/** 你畫我猜的 view、動作和選項，和 backend/src/draw.rs 對應 */

/** 畫布座標：x 是 0～W、y 是 0～H（4:3），不同大小的螢幕畫出來才一樣 */
export const W = 1000
export const H = 750
/** 一棒最多幾筆、幾個點、倒幾次顏料；一則訊息最多幾個點（和後端一樣，超過伺服器會拒絕） */
export const MAX_STROKES = 1000
export const MAX_POINTS = 30_000
export const MAX_FILLS = 60
export const MAX_BATCH = 200

/**
 * 調色盤：畫布是「紙」，背景固定是白色，顏色是畫的內容，所以不跟著主題變。
 * 第 0 個是白色，橡皮擦就是用它畫。
 */
export const PAPER = '#ffffff'
export const PALETTE = [
  '#ffffff',
  '#1f1f1f',
  '#8a8a8a',
  '#e53935',
  '#fb8c00',
  '#fdd835',
  '#43a047',
  '#00acc1',
  '#1e88e5',
  '#8e24aa',
  '#f48fb1',
  '#8d6e63',
] as const
export const COLOR_NAMES = ['白', '黑', '灰', '紅', '橘', '黃', '綠', '青', '藍', '紫', '粉紅', '咖啡'] as const
/** 粗細（畫布單位） */
export const WIDTHS = [6, 14, 30] as const
export const WIDTH_NAMES = ['細', '中', '粗'] as const
export const ERASER = 0

/** `f` 是倒顏料：`p` 只有一個點，從那裡把相連的同色區域塗滿（見 paper.ts） */
export type Stroke = { c: number; w: number; p: number[]; f?: boolean }
export type CanvasSnapshot = { id: number; v: number; strokes: Stroke[] }

export type DrawOp =
  | { kind: 'begin'; c: number; w: number; p: number[] }
  | { kind: 'more'; p: number[] }
  | { kind: 'fill'; c: number; p: number[] }
  | { kind: 'undo' }
  | { kind: 'clear' }

/** 伺服器轉來的筆畫：畫布 `id` 的第 `v` 個版本 */
export type OpEvent = { type: 'op'; id: number; v: number; op: DrawOp }
/** 只送給自己：猜的答案很接近了（`guess` 是那句話；整句裡有答案但多打了字時是 null） */
export type CloseEvent = { type: 'close'; guess: string | null }
export type DrawEvent = OpEvent | CloseEvent

export type Stage = 'choose' | 'draw' | 'reveal' | 'end'
export type Level = 'easy' | 'medium' | 'hard'
export const LEVEL_NAMES: Record<Level, string> = { easy: '簡單', medium: '普通', hard: '困難' }

export type DrawOptions = {
  /** 每個人畫幾次 */
  cycles: number
  drawSecs: number
  /** 提示裡顯示詞的分類 */
  category: boolean
  /** 只出這些分類的詞；空的是「綜合」（主題以外的所有分類） */
  categories: string[]
}

/** 題庫裡的分類（GET /api/games/draw/categories，不用登入） */
export type CategoryInfo = {
  name: string
  /** 幾個詞（內建的加上投稿通過的） */
  words: number
  /** 主題（例如英雄聯盟）：「綜合」不含，要選了才會出 */
  theme: boolean
}

/** 答案連同別名，例如「影忍至尊（劫）」（別名也算猜對） */
export function wordLabel(word: string, alts: readonly string[] | null | undefined): string {
  return alts?.length ? `${word}（${alts.join('、')}）` : word
}

export type DrawSeat = {
  online: boolean
  guessed: boolean
  /** 這一局的分數 */
  score: number
  /** 同一個房間累計的分數 */
  total: number
  /** 這一棒得的分 */
  turnPoints: number
}

export type DrawView = {
  stage: Stage
  endsIn: number | null
  turn: number
  turns: number
  drawer: number
  you: number | null
  options: DrawOptions
  /** 選題時只有畫的人有；`alts` 是也算猜對的其他寫法 */
  choices: { word: string; alts: string[]; category: string; level: Level }[] | null
  /** 答案：畫的人、猜中的人，以及公布之後所有人 */
  word: string | null
  /** 答案的別名（也算猜對），跟 `word` 一起給 */
  alts: string[] | null
  level: Level | null
  /** 作畫時的提示：每個字揭露了就是那個字，沒有就是 null */
  hint: { chars: (string | null)[]; category: string | null } | null
  /** 畫的人還能給幾次提示（揭露一個字） */
  hintsLeft: number
  ending: 'all' | 'timeout' | 'left' | null
  canvas: CanvasSnapshot
  seats: DrawSeat[]
  /** 畫完的每一棒（`word` 已經接上別名） */
  done: { drawer: number; word: string; guessed: number }[]
}

export type DrawAction =
  | { type: 'choose'; index: number }
  | { type: 'begin'; c: number; w: number; p: number[] }
  | { type: 'more'; p: number[] }
  | { type: 'fill'; c: number; p: number[] }
  | { type: 'undo' }
  | { type: 'clear' }
  | { type: 'hint' }

export type DrawParty = { view: DrawView; action: DrawAction; options: DrawOptions; event: DrawEvent }

// ---- 投稿題目（backend/src/draw_words.rs） ----

/** 資料庫裡的難度編號：1 簡單、2 普通、3 困難 */
export type WordLevel = 1 | 2 | 3
export const WORD_LEVELS: { value: WordLevel; label: string }[] = [
  { value: 1, label: '簡單' },
  { value: 2, label: '普通' },
  { value: 3, label: '困難' },
]
export const WORD_LEVEL_NAMES: Record<WordLevel, string> = { 1: '簡單', 2: '普通', 3: '困難' }

export type WordStatus = 'pending' | 'approved' | 'rejected'
export const WORD_STATUS_NAMES: Record<WordStatus, string> = { pending: '待審核', approved: '已通過', rejected: '沒通過' }

export type SubmittedWord = {
  id: number
  word: string
  category: string
  level: WordLevel
  status: WordStatus
  created_at: string
  reviewed_at: string | null
  /** 投稿和審核的帳號，只在管理頁有（帳號刪掉了也沒有） */
  submitter?: string
  reviewer?: string
}

export type MyWords = {
  /** 現有的分類，投稿時可以挑 */
  categories: string[]
  /** 題庫裡有幾個詞：內建的、投稿通過的 */
  builtin: number
  submitted: number
  /** 投稿直接通過（管理員） */
  trusted: boolean
  words: SubmittedWord[]
}

export type SubmitResult = {
  added: string[]
  skipped: { word: string; reason: string }[]
}

/** 和後端一樣的限制 */
export const WORD_CHARS = { min: 2, max: 8 }
export const CATEGORY_MAX_CHARS = 6
export const MAX_PER_SUBMIT = 50

/**
 * 投稿框裡的字拆成一個個詞：換行、頓號、逗號、分號都算分隔。
 * 空白不算：「冰淇 淋」要整個送出去讓伺服器說「不能有空白」，拆開的話「冰淇」會被當成一個詞收下。
 */
export function splitWords(text: string): string[] {
  return text
    .split(/[\n、，,；;]+/)
    .map((w) => w.trim())
    .filter(Boolean)
}
