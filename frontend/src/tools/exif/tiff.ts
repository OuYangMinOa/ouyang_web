// EXIF 本體是一段 TIFF 結構：檔頭（II／MM、42、第一個 IFD 的位置），之後是一串 IFD（標籤目錄）。
// 這裡只讀，以及在原地把 GPS 目錄清成零（長度不變，其他位置都不用動）。

export type Value = number | number[] | string | Uint8Array

/** 各目錄的標籤：ifd0 是主圖、exif 是拍攝參數、gps 是定位、ifd1 是內嵌縮圖 */
export type Tags = {
  ifd0: Map<number, Value>
  exif: Map<number, Value>
  gps: Map<number, Value>
  ifd1: Map<number, Value>
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }

export const EXIF_IFD = 0x8769
export const GPS_IFD = 0x8825

type Entry = { tag: number; type: number; count: number; /** 值所在位置（相對 TIFF 開頭） */ at: number; size: number }

class Reader {
  readonly buf: Uint8Array
  readonly view: DataView
  readonly le: boolean
  constructor(buf: Uint8Array) {
    this.buf = buf
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const order = String.fromCharCode(buf[0], buf[1])
    if (order !== 'II' && order !== 'MM') throw new Error('不是 TIFF')
    this.le = order === 'II'
    if (this.u16(2) !== 42) throw new Error('不是 TIFF')
  }
  u16(o: number) {
    return this.view.getUint16(o, this.le)
  }
  u32(o: number) {
    return this.view.getUint32(o, this.le)
  }
  /** 讀一個 IFD；超出範圍的條目略過 */
  ifd(o: number): { entries: Entry[]; next: number; end: number } | null {
    if (o < 8 || o + 2 > this.buf.length) return null
    const n = this.u16(o)
    const end = o + 2 + n * 12
    if (end + 4 > this.buf.length) return null
    const entries: Entry[] = []
    for (let k = 0; k < n; k++) {
      const p = o + 2 + k * 12
      const type = this.u16(p + 2)
      const count = this.u32(p + 4)
      const size = (TYPE_SIZE[type] ?? 0) * count
      if (!size) continue
      const at = size <= 4 ? p + 8 : this.u32(p + 8)
      if (at + size > this.buf.length) continue
      entries.push({ tag: this.u16(p), type, count, at, size })
    }
    return { entries, next: this.u32(end), end }
  }
  value(e: Entry): Value {
    const { type, count, at } = e
    const v = this.view
    const many = (f: (i: number) => number) => {
      const out: number[] = []
      for (let i = 0; i < Math.min(count, 256); i++) out.push(f(i))
      return count === 1 ? out[0] : out
    }
    switch (type) {
      case 2: {
        // ASCII：去掉結尾的 \0；裡面是 UTF-8 的也照樣解得出來
        let end = at + count
        while (end > at && this.buf[end - 1] === 0) end--
        return new TextDecoder().decode(this.buf.subarray(at, end)).trim()
      }
      case 1:
      case 7:
        return this.buf.slice(at, at + count)
      case 3:
        return many((i) => v.getUint16(at + i * 2, this.le))
      case 8:
        return many((i) => v.getInt16(at + i * 2, this.le))
      case 4:
        return many((i) => v.getUint32(at + i * 4, this.le))
      case 9:
        return many((i) => v.getInt32(at + i * 4, this.le))
      case 5:
        return many((i) => {
          const d = v.getUint32(at + i * 8 + 4, this.le)
          return d ? v.getUint32(at + i * 8, this.le) / d : 0
        })
      case 10:
        return many((i) => {
          const d = v.getInt32(at + i * 8 + 4, this.le)
          return d ? v.getInt32(at + i * 8, this.le) / d : 0
        })
      case 11:
        return many((i) => v.getFloat32(at + i * 4, this.le))
      case 12:
        return many((i) => v.getFloat64(at + i * 8, this.le))
      default:
        return this.buf.slice(at, at + e.size)
    }
  }
  map(o: number): { tags: Map<number, Value>; next: number } {
    const tags = new Map<number, Value>()
    const ifd = this.ifd(o)
    if (!ifd) return { tags, next: 0 }
    for (const e of ifd.entries) tags.set(e.tag, this.value(e))
    return { tags, next: ifd.next }
  }
}

const ptr = (v: Value | undefined) => (typeof v === 'number' ? v : Array.isArray(v) ? v[0] : 0)

/** 解析一段 TIFF；壞掉的部分略過，整段讀不了就丟錯 */
export function parseTiff(buf: Uint8Array): Tags {
  const r = new Reader(buf)
  const first = r.map(r.u32(4))
  const exif = r.map(ptr(first.tags.get(EXIF_IFD))).tags
  const gps = r.map(ptr(first.tags.get(GPS_IFD))).tags
  const ifd1 = first.next ? r.map(first.next).tags : new Map<number, Value>()
  return { ifd0: first.tags, exif, gps, ifd1 }
}

/**
 * 在原地清掉 GPS：GPS 目錄裡每個標籤的值（座標、高度、時間…）和目錄本身都寫成 0，
 * 主目錄裡指向它的標籤保留（指到一個空目錄），長度不變，所以檔案其他部分的位移都不受影響。
 * 回傳有沒有清到東西。
 */
export function zeroGps(buf: Uint8Array): boolean {
  let r: Reader
  try {
    r = new Reader(buf)
  } catch {
    return false
  }
  const first = r.ifd(r.u32(4))
  const gpsEntry = first?.entries.find((e) => e.tag === GPS_IFD)
  if (!gpsEntry) return false
  const o = ptr(r.value(gpsEntry))
  const gps = r.ifd(o)
  if (!gps) return false
  for (const e of gps.entries) if (e.size > 4) buf.fill(0, e.at, e.at + e.size)
  // 條目數、條目、下一個目錄的位置都歸零
  buf.fill(0, o, gps.end + 4)
  return gps.entries.length > 0
}

/** 只有 Orientation 一個標籤的最小 EXIF（APP1 的內容，含 "Exif\0\0"），清除全部時保留照片方向用 */
export function orientationOnlyExif(orientation: number): Uint8Array {
  const out = new Uint8Array(6 + 8 + 2 + 12 + 4)
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0)
  const v = new DataView(out.buffer, 6)
  v.setUint16(0, 0x4d4d) // MM，大端
  v.setUint16(2, 42)
  v.setUint32(4, 8)
  v.setUint16(8, 1) // 一個條目
  v.setUint16(10, 0x0112)
  v.setUint16(12, 3) // SHORT
  v.setUint32(14, 1)
  v.setUint16(18, orientation)
  v.setUint32(22, 0) // 沒有下一個目錄
  return out
}
