// 各類單位與換算。每個單位都換成該類的基準單位（公尺、平方公尺、公斤…）再換回來。
// 台制單位沿用日治時期的定義：1 台尺 = 10/33 公尺，1 坪 = 6 × 6 台尺 = 400/121 平方公尺，
// 1 甲 = 2,934 坪，1 台斤 = 600 公克 = 16 台兩，1 台兩 = 10 錢。

export type Unit = {
  id: string
  name: string
  symbol: string
  /** 換成基準單位 */
  to: (v: number) => number
  /** 從基準單位換回來 */
  from: (v: number) => number
}

export type Category = {
  id: string
  name: string
  units: Unit[]
  /** 是否可以輸入負數（溫度） */
  signed?: boolean
  note?: string
}

/** 線性單位：1 個這種單位 = factor 個基準單位 */
function lin(id: string, name: string, symbol: string, factor: number): Unit {
  return { id, name, symbol, to: (v) => v * factor, from: (v) => v / factor }
}

const TAI_CHI = 10 / 33 // 台尺（公尺）
const PING = 400 / 121 // 坪（平方公尺）
const JIA = 2934 * PING // 甲（平方公尺）
const TAI_SHENG = 2401 / 1331 // 台升（公升）：沿用日本的升，64.827 立方台寸 ≈ 1.8039 公升

export const CATEGORIES: Category[] = [
  {
    id: 'length',
    name: '長度',
    units: [
      lin('mm', '公釐', 'mm', 0.001),
      lin('cm', '公分', 'cm', 0.01),
      lin('m', '公尺', 'm', 1),
      lin('km', '公里', 'km', 1000),
      lin('in', '英寸', 'in', 0.0254),
      lin('ft', '英尺', 'ft', 0.3048),
      lin('yd', '碼', 'yd', 0.9144),
      lin('mi', '英里', 'mi', 1609.344),
      lin('nmi', '海里', 'nmi', 1852),
      lin('taicun', '台寸', '台寸', TAI_CHI / 10),
      lin('taichi', '台尺', '台尺', TAI_CHI),
    ],
    note: '1 台尺 = 10/33 公尺 ≈ 30.3 公分；1 英寸 = 2.54 公分。',
  },
  {
    id: 'area',
    name: '面積',
    units: [
      lin('cm2', '平方公分', 'cm²', 1e-4),
      lin('m2', '平方公尺', 'm²', 1),
      lin('ping', '坪', '坪', PING),
      lin('a', '公畝', 'a', 100),
      lin('ha', '公頃', 'ha', 10_000),
      lin('km2', '平方公里', 'km²', 1e6),
      lin('li', '厘（台）', '厘', JIA / 100),
      lin('fen', '分（台）', '分', JIA / 10),
      lin('jia', '甲', '甲', JIA),
      lin('ft2', '平方英尺', 'ft²', 0.09290304),
      lin('acre', '英畝', 'ac', 4046.8564224),
    ],
    note: '1 坪 ≈ 3.3058 平方公尺；1 甲 = 10 分 = 2,934 坪 ≈ 0.9699 公頃。',
  },
  {
    id: 'weight',
    name: '重量',
    units: [
      lin('mg', '毫克', 'mg', 1e-6),
      lin('g', '公克', 'g', 0.001),
      lin('kg', '公斤', 'kg', 1),
      lin('t', '公噸', 't', 1000),
      lin('qian', '錢', '錢', 0.00375),
      lin('liang', '台兩', '兩', 0.0375),
      lin('jin', '台斤', '斤', 0.6),
      lin('ct', '克拉', 'ct', 0.0002),
      lin('oz', '盎司', 'oz', 0.028349523125),
      lin('lb', '磅', 'lb', 0.45359237),
    ],
    note: '1 台斤 = 16 台兩 = 600 公克；1 台兩 = 10 錢 = 37.5 公克。',
  },
  {
    id: 'volume',
    name: '體積',
    units: [
      lin('ml', '毫升（c.c.）', 'mL', 0.001),
      lin('l', '公升', 'L', 1),
      lin('m3', '立方公尺', 'm³', 1000),
      lin('tsp', '小匙', 'tsp', 0.005),
      lin('tbsp', '大匙', 'Tbsp', 0.015),
      lin('cup', '杯（美制）', 'cup', 0.2365882365),
      lin('floz', '液量盎司（美制）', 'fl oz', 0.0295735295625),
      lin('gal', '加侖（美制）', 'gal', 3.785411784),
      lin('ukgal', '加侖（英制）', 'imp gal', 4.54609),
      lin('ft3', '立方英尺', 'ft³', 28.316846592),
      lin('taisheng', '台升', '升', TAI_SHENG),
    ],
    note: '1 毫升 = 1 c.c. = 1 立方公分；大匙、小匙用公制的 15、5 毫升。',
  },
  {
    id: 'temperature',
    name: '溫度',
    signed: true,
    units: [
      { id: 'c', name: '攝氏', symbol: '°C', to: (v) => v, from: (v) => v },
      { id: 'f', name: '華氏', symbol: '°F', to: (v) => ((v - 32) * 5) / 9, from: (v) => (v * 9) / 5 + 32 },
      { id: 'k', name: '克氏（絕對溫度）', symbol: 'K', to: (v) => v - 273.15, from: (v) => v + 273.15 },
    ],
    note: '°F = °C × 9/5 + 32；K = °C + 273.15。',
  },
  {
    id: 'speed',
    name: '速度',
    units: [
      lin('mps', '公尺／秒', 'm/s', 1),
      lin('kmh', '公里／小時', 'km/h', 1 / 3.6),
      lin('mph', '英里／小時', 'mph', 0.44704),
      lin('fps', '英尺／秒', 'ft/s', 0.3048),
      lin('kn', '節', 'kn', 1852 / 3600),
      lin('mach', '馬赫（海平面 15°C）', 'Ma', 340.294),
    ],
    note: '1 節 = 1 海里／小時 ≈ 1.852 公里／小時；馬赫數隨溫度改變，這裡用海平面 15°C 的音速。',
  },
  {
    id: 'data',
    name: '資料大小',
    units: [
      lin('bit', '位元', 'bit', 1 / 8),
      lin('B', '位元組', 'B', 1),
      lin('KB', 'KB（千）', 'KB', 1e3),
      lin('MB', 'MB', 'MB', 1e6),
      lin('GB', 'GB', 'GB', 1e9),
      lin('TB', 'TB', 'TB', 1e12),
      lin('PB', 'PB', 'PB', 1e15),
      lin('KiB', 'KiB（1024）', 'KiB', 1024),
      lin('MiB', 'MiB', 'MiB', 1024 ** 2),
      lin('GiB', 'GiB', 'GiB', 1024 ** 3),
      lin('TiB', 'TiB', 'TiB', 1024 ** 4),
      lin('PiB', 'PiB', 'PiB', 1024 ** 5),
    ],
    note: 'KB、MB、GB 是 1000 進位（硬碟廠商用）；KiB、MiB、GiB 是 1024 進位（Windows 顯示的「GB」其實是 GiB）。',
  },
]

/** 輸入文字轉數字：可以有千分位逗號；看不懂回傳 null */
export function parseNumber(text: string): number | null {
  const s = text.replace(/[,\s，]/g, '').replace(/^[−–]/, '-')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 顯示用：最多 10 位有效數字，太大或太小改用科學記號 */
export function formatNumber(n: number): string {
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 1e15 || abs < 1e-6) {
    return n
      .toExponential(6)
      .replace(/\.?0+e/, 'e')
      .replace('e+', 'e')
  }
  const rounded = Number(n.toPrecision(10))
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 10 })
}
