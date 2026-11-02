// 字數統計：全部用 Unicode 屬性判斷，中文、日文、韓文、emoji 都能正確歸類

export type Stats = {
  /** 「字數」：中文字、其他 CJK 字（假名、諺文）、英文單字、數字各算一個，跟 Word 的算法相同 */
  words: number
  han: number
  /** 日文假名、韓文諺文 */
  kanaHangul: number
  latinWords: number
  numbers: number
  punctuation: number
  /** 符號與 emoji */
  symbols: number
  spaces: number
  /** 字元數（含空白，不含換行）；emoji 組合、帶聲調的字母都算一個 */
  chars: number
  charsNoSpace: number
  lines: number
  paragraphs: number
  bytes: number
  /** 預估閱讀與朗讀時間，單位分鐘 */
  readMinutes: number
  speakMinutes: number
}

const HAN = /\p{Script=Han}/gu
const KANA_HANGUL = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
// 英文單字可以帶撇號或連字號：don't、e-mail
const LATIN_WORD = /[\p{Script=Latin}\p{M}]+(?:['’-][\p{Script=Latin}\p{M}]+)*/gu
// 數字一組算一個：2026、3.14、1,000
const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu
const PUNCT = /\p{P}/gu
const SYMBOL = /\p{S}|\p{Extended_Pictographic}/gu
const SPACE = /[^\S\r\n]/gu

const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh-Hant', { granularity: 'grapheme' }) : null

/** 字元數以使用者看到的「一個字」計算（grapheme），沒有 Intl.Segmenter 時退回以碼位計算 */
function graphemes(s: string): number {
  if (!segmenter) return Array.from(s).length
  let n = 0
  for (const g of segmenter.segment(s)) if (g.segment) n++
  return n
}

// 一般人默讀中文每分鐘約 400 字、英文約 230 字；朗讀（演講）大約是一半
const READ_HAN = 400
const READ_EN = 230
const SPEAK_HAN = 200
const SPEAK_EN = 140

export function analyze(text: string): Stats {
  const han = count(text, HAN)
  const kanaHangul = count(text, KANA_HANGUL)
  const latinWords = count(text, LATIN_WORD)
  const numbers = count(text, NUMBER)
  // 標點和符號裡也包含全形的，例如「，」「。」「％」；數字裡的小數點、don't 的撇號不算
  const rest = text.replace(NUMBER, ' ').replace(LATIN_WORD, ' ')
  const punctuation = count(rest, PUNCT)
  const symbols = count(rest, SYMBOL)
  const spaces = count(text, SPACE)
  const noBreaks = text.replace(/\r?\n|\r/g, '')
  const chars = graphemes(noBreaks)
  const charsNoSpace = graphemes(noBreaks.replace(/\s/g, ''))
  const lineList = text === '' ? [] : text.split(/\r?\n|\r/)
  const paragraphs = lineList.filter((l) => l.trim() !== '').length
  const cjk = han + kanaHangul
  const enWords = latinWords + numbers

  return {
    words: cjk + enWords,
    han,
    kanaHangul,
    latinWords,
    numbers,
    punctuation,
    symbols,
    spaces,
    chars,
    charsNoSpace,
    lines: lineList.length,
    paragraphs,
    bytes: new TextEncoder().encode(text).length,
    readMinutes: cjk / READ_HAN + enWords / READ_EN,
    speakMinutes: cjk / SPEAK_HAN + enWords / SPEAK_EN,
  }
}

export function formatMinutes(m: number): string {
  if (m === 0) return '0 秒'
  const sec = Math.max(1, Math.round(m * 60))
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  const rest = sec % 60
  if (min < 60) return rest ? `${min} 分 ${rest} 秒` : `${min} 分鐘`
  return `${Math.floor(min / 60)} 小時 ${min % 60} 分`
}
