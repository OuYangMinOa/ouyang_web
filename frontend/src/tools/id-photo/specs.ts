// 證件照規格與相紙尺寸（單位都是 mm）

export type Spec = {
  id: string
  name: string
  /** 相片寬、高 */
  w: number
  h: number
  /** 頭頂到下巴的長度範圍 */
  head: [number, number]
  /** 頭頂到相片上緣的留白範圍 */
  top: [number, number]
  note: string
}

export const SPECS: Spec[] = [
  {
    id: 'tw-passport',
    name: '護照／身分證',
    w: 35,
    h: 45,
    head: [32, 36],
    top: [3, 5],
    note: '內政部與外交部規格（2 吋）：頭頂到下巴 3.2–3.6 cm，白色或淺色素色背景，正面、露耳、不戴帽。',
  },
  {
    id: 'tw-2inch',
    name: '2 吋大頭照',
    w: 35,
    h: 45,
    head: [26, 31],
    top: [4, 7],
    note: '履歷、證照、報名用的一般 2 吋大頭照，頭部比例比護照小一點、多露一點肩膀。',
  },
  {
    id: 'tw-2inch-half',
    name: '2 吋半身照',
    w: 42,
    h: 47,
    head: [21, 25],
    top: [4, 7],
    note: '常見的 2 吋半身照（4.2×4.7 cm），拍到胸口。',
  },
  {
    id: 'tw-1inch',
    name: '1 吋大頭照',
    w: 28,
    h: 35,
    head: [21, 25],
    top: [3, 5],
    note: '1 吋大頭照（2.8×3.5 cm），例如健保卡、學生證、部分報名表。',
  },
  {
    id: 'mtp',
    name: '台胞證',
    w: 33,
    h: 48,
    head: [28, 33],
    top: [3, 5],
    note: '台胞證規格：3.3×4.8 cm，頭頂到下巴 2.8–3.3 cm，白色背景。',
  },
  {
    id: 'us-visa',
    name: '美國簽證（2×2 吋）',
    w: 51,
    h: 51,
    head: [25, 35],
    top: [5, 8],
    note: '美國簽證：5.1×5.1 cm，頭頂到下巴 2.5–3.5 cm，眼睛距下緣 2.8–3.5 cm，白色背景。',
  },
]

/** 自訂尺寸：頭部約佔高度的七成五 */
export function customSpec(w: number, h: number): Spec {
  const head = h * 0.75
  return {
    id: 'custom',
    name: '自訂尺寸',
    w,
    h,
    head: [head - h * 0.05, head + h * 0.05],
    top: [h * 0.07, h * 0.11],
    note: '自訂尺寸的輔助線只是參考：頭部約佔相片高度的 70–80%。',
  }
}

export type Paper = { id: string; name: string; w: number; h: number }

export const PAPERS: Paper[] = [
  { id: '4x6', name: '4×6 吋（4R，10.2×15.2 cm）', w: 101.6, h: 152.4 },
  { id: '3x5', name: '3×5 吋（3R，8.9×12.7 cm）', w: 88.9, h: 127 },
]

/** 輸出解析度 */
export const DPI = 300
export const PX_PER_MM = DPI / 25.4

export const mmToPx = (mm: number) => Math.round(mm * PX_PER_MM)
