// 成績、顏色的顯示格式（選單、成績表共用）

/** 1:23.45 */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–:––.––'
  const cs = Math.floor(ms / 10)
  const m = Math.floor(cs / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** 0xe0393e → #e0393e */
export const hexColor = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`
