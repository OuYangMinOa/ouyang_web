// 常用範例、語法速查，以及 pattern 的小工具

export type Example = {
  name: string
  pattern: string
  flags: string
  text: string
  replacement?: string
  note?: string
}

export const EXAMPLES: Example[] = [
  {
    name: 'Email',
    pattern: String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`,
    flags: 'g',
    text: '聯絡我們：service@example.com.tw，或 john.doe+news@gmail.com。\n錯誤的：abc@、@example.com',
  },
  {
    name: '手機號碼（09xx）',
    pattern: String.raw`(?:\+886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}`,
    flags: 'g',
    text: '0912-345-678\n0987654321\n0912 345 678\n+886 912 345 678\n+886-912345678\n02-2345-6789（市話，不符合）',
    replacement: '[手機]',
    note: '允許中間用 - 或空白分隔，也接受 +886 開頭。',
  },
  {
    name: '市話',
    pattern: String.raw`\(?0[2-8]\d?\)?[-\s]?\d{3,4}[-\s]?\d{4}`,
    flags: 'g',
    text: '台北 (02)2345-6789\n台中 04-2234-5678\n高雄 07 123 4567\n手機 0912-345-678（不符合）',
  },
  {
    name: '身分證字號／居留證',
    pattern: String.raw`\b[A-Z][1289]\d{8}\b`,
    flags: 'g',
    text: 'A123456789\nF223456789\n新式居留證 A800000014\na123456789（小寫不符合）\nA323456789（第二碼錯誤）',
    note: '第一碼是縣市英文字母，第二碼 1、2 是身分證（男、女），8、9 是新式居留證。正規表示式只檢查格式，最後一碼的檢查碼要另外驗算。',
  },
  {
    name: '統一編號',
    pattern: String.raw`(?<!\d)\d{8}(?!\d)`,
    flags: 'g',
    text: '統一編號：12345675\n發票號碼 AB-12345678 裡的數字也會符合\n123456789（9 碼不符合）',
    note: '統一編號是 8 碼數字；正規表示式無法驗證檢查碼。',
  },
  {
    name: '郵遞區號',
    pattern: String.raw`(?<!\d)\d{3}(?:\d{2,3})?(?!\d)`,
    flags: 'g',
    text: '100 台北市中正區\n10058 台北市中正區（3+2 碼）\n100012 台北市中正區（3+3 碼）',
  },
  {
    name: '日期（具名群組）',
    pattern: String.raw`(?<year>\d{4})[-/.](?<month>1[0-2]|0?[1-9])[-/.](?<day>3[01]|[12]\d|0?[1-9])(?!\d)`,
    flags: 'g',
    text: '2026-11-02、2026/1/5、2026.12.31\n2026-13-01（月份錯誤）',
    replacement: '$<year> 年 $<month> 月 $<day> 日',
    note: '用 $<名稱> 在取代時引用具名群組。選擇（|）會照順序嘗試，所以較長的寫法要放前面，例如 3[01] 放在 0?[1-9] 前面。',
  },
  {
    name: '民國日期',
    pattern: String.raw`民國\s*(?<year>\d{2,3})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})\s*日`,
    flags: 'g',
    text: '中華民國 115 年 11 月 2 日\n民國99年1月1日',
    replacement: '$<year>/$<month>/$<day>',
  },
  {
    name: '網址',
    pattern: String.raw`https?:\/\/[^\s"'<>，。、）]+`,
    flags: 'g',
    text: '官網 https://example.com/path?q=1&lang=zh-TW，文件在 http://docs.example.org。',
    replacement: '<$&>',
  },
  {
    name: 'IPv4',
    pattern: String.raw`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`,
    flags: 'g',
    text: '192.168.1.1\n8.8.8.8\n256.1.1.1（不符合）\n10.0.0.255',
  },
  {
    name: '中文字',
    pattern: String.raw`\p{Script=Han}+`,
    flags: 'gu',
    text: 'Hello 世界！這是 React 與 TypeScript 的範例。',
    note: '\\p{…} 需要開啟 u 旗標。',
  },
  {
    name: '全形英數字',
    pattern: String.raw`[Ａ-Ｚａ-ｚ０-９]+`,
    flags: 'g',
    text: 'ＡＢＣ１２３ 混著 abc123',
  },
  {
    name: '重複的字詞',
    pattern: String.raw`\b(\w+)\s+\1\b`,
    flags: 'gi',
    text: 'This is is a test.\nThe the cat sat on the mat.',
    replacement: '$1',
    note: '\\1 是反向參照，代表跟第 1 組一樣的內容。',
  },
  {
    name: '金額',
    pattern: String.raw`(?:NT\$|\$)\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?`,
    flags: 'g',
    text: '原價 NT$1,280，特價 $990，運費 $ 60.5',
  },
  {
    name: 'HTML 標籤',
    pattern: String.raw`<\/?([a-z][a-z0-9-]*)\b[^>]*>`,
    flags: 'gi',
    text: '<p class="intro">你好，<strong>世界</strong></p><br/>',
    replacement: '',
    note: '取代成空字串可以去掉標籤；複雜的 HTML 請用真正的解析器。',
  },
  {
    name: '災難性回溯（示範）',
    pattern: String.raw`^(a+)+$`,
    flags: '',
    text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!',
    note: '巢狀的量詞遇到不符合的字串時，嘗試次數會指數成長。這裡在背景執行，超過時間會自動停止，不會卡住頁面。',
  },
]

export const CHEATSHEET: { title: string; items: [string, string][] }[] = [
  {
    title: '字元',
    items: [
      ['.', '任意字元（不含換行，開 s 旗標才包含）'],
      ['\\d  \\D', '數字／非數字'],
      ['\\w  \\W', '英數字與底線／其他'],
      ['\\s  \\S', '空白／非空白'],
      ['[abc]', 'a、b、c 其中一個'],
      ['[^abc]', '不是 a、b、c'],
      ['[a-z]', 'a 到 z'],
      ['\\p{Script=Han}', '中文字（需 u 旗標）'],
      ['\\t  \\n', 'Tab／換行'],
      ['\\u4e00', 'Unicode 字元'],
    ],
  },
  {
    title: '位置',
    items: [
      ['^  $', '開頭／結尾（開 m 旗標時是每一行）'],
      ['\\b  \\B', '單字邊界／非邊界'],
      ['(?=…)', '後面要接著 …'],
      ['(?!…)', '後面不能接著 …'],
      ['(?<=…)', '前面要是 …'],
      ['(?<!…)', '前面不能是 …'],
    ],
  },
  {
    title: '次數',
    items: [
      ['*', '0 次以上'],
      ['+', '1 次以上'],
      ['?', '0 或 1 次'],
      ['{3}', '剛好 3 次'],
      ['{2,5}', '2 到 5 次'],
      ['{2,}', '2 次以上'],
      ['*?  +?', '加上 ? 變成「越少越好」'],
    ],
  },
  {
    title: '群組與取代',
    items: [
      ['(…)', '捕獲群組，取代時用 $1'],
      ['(?<name>…)', '具名群組，取代時用 $<name>'],
      ['(?:…)', '只分組、不捕獲'],
      ['a|b', 'a 或 b'],
      ['\\1', '反向參照：跟第 1 組一樣'],
      ['$&', '取代時代表整個符合的內容'],
      ['$`  $\'', '取代時代表符合處之前／之後'],
      ['$$', '取代時的 $ 字元'],
    ],
  },
  {
    title: '旗標',
    items: [
      ['g', '全部找出來，不只第一個'],
      ['i', '不分大小寫'],
      ['m', '^ $ 對每一行有效'],
      ['s', '. 也包含換行'],
      ['u', 'Unicode 模式（\\p{…}、emoji 算一個字）'],
      ['v', 'Unicode 集合模式（u 的進階版，可以做集合運算）'],
      ['y', '黏著：只從上一個結束的位置開始找'],
    ],
  },
]

/**
 * 找出 pattern 裡每個捕獲群組的名稱（沒有名稱的是 null），順序跟 $1、$2… 一樣。
 * 只需要大致正確：pattern 能編譯過才會用到
 */
export function groupNames(pattern: string): (string | null)[] {
  const names: (string | null)[] = []
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '(') {
      if (pattern[i + 1] !== '?') names.push(null)
      else if (pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!') {
        const end = pattern.indexOf('>', i)
        names.push(pattern.slice(i + 3, end))
      }
    }
  }
  return names
}

/** 把瀏覽器的錯誤訊息翻成中文提示；看不懂的保留原文 */
export function explainError(msg: string): string {
  const m = msg.replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, '').replace(/^SyntaxError: /, '')
  const rules: [RegExp, string][] = [
    [/unterminated group|missing \)|unterminated parenthetical/i, '括號沒有成對，少了 )'],
    [/unmatched '\)'|unmatched parentheses|unmatched \)/i, '多了一個 )，或是前面少了 ('],
    [/unterminated character class|missing \]|unterminated character class/i, '方括號沒有結束，少了 ]'],
    [/nothing to repeat|quantifier.*nothing|nothing to repeat/i, '量詞（* + ? {}）前面沒有可以重複的東西；要比對這些符號本身請加反斜線，例如 \\+'],
    [/numbers out of order|out of order in \{\}/i, '{} 裡的次數順序反了，例如 {5,2} 要寫成 {2,5}'],
    [/range out of order/i, '字元範圍反了，例如 [z-a] 要寫成 [a-z]'],
    [/invalid group|invalid regexp group/i, '(? 後面的寫法不正確'],
    [/invalid capture group name|invalid group name/i, '具名群組的名稱不正確'],
    [/duplicate capture group name/i, '具名群組的名稱重複了'],
    [/invalid named reference|invalid named capture referenced/i, '\\k<…> 引用了不存在的具名群組'],
    [/\\ at end of pattern|trailing backslash/i, 'pattern 最後多了一個反斜線'],
    [/invalid escape|invalid unicode escape|invalid identity escape/i, '無效的跳脫字元（u 模式下比較嚴格）'],
    [/invalid property name/i, '\\p{…} 裡的屬性名稱不正確'],
    [/invalid flags|invalid regular expression flags/i, '旗標不正確（u 和 v 不能同時使用）'],
    [/lone quantifier brackets/i, '多了 { 或 }；要比對大括號本身請加反斜線'],
  ]
  for (const [re, zh] of rules) if (re.test(m)) return `${zh}（${m}）`
  return m
}

let vFlag: boolean | null = null
/** v 旗標（Unicode 集合）只有比較新的瀏覽器支援 */
export function supportsV(): boolean {
  if (vFlag === null) {
    try {
      new RegExp('', 'v')
      vFlag = true
    } catch {
      vFlag = false
    }
  }
  return vFlag
}
