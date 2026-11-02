// 各種圖檔裡中繼資料放的位置，以及不重新壓縮的移除方式：
// - JPEG：APPn／COM 區段。整段拿掉，影像資料（掃描段）原封不動複製
// - PNG：eXIf 與文字區塊（tEXt／iTXt／zTXt）
// - WebP：RIFF 裡的 EXIF 與 XMP 區塊
import { orientationOnlyExif, parseTiff, zeroGps, type Tags } from './tiff'

export type Format = 'jpeg' | 'png' | 'webp' | 'heic' | 'other'

export type Inspection = {
  format: Format
  /** 主圖的 EXIF；沒有或讀不到是 null */
  tags: Tags | null
  /** EXIF 以外的中繼資料，給使用者看檔案裡還有什麼 */
  extras: string[]
  /** XMP 裡也有 GPS（例如 Lightroom 匯出的檔案） */
  xmpGps: boolean
}

// 一個 byte 對一個字元（windows-1252），字串的索引就是 byte 的位置；大段資料也不會爆堆疊
const latin1 = new TextDecoder('latin1')
const ascii = (b: Uint8Array, start: number, len: number) => latin1.decode(b.subarray(start, start + Math.max(0, len)))
const startsWith = (b: Uint8Array, at: number, s: string) => ascii(b, at, s.length) === s
const kb = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`)

const EXIF_HEAD = 'Exif\0\0'
const XMP_HEAD = 'http://ns.adobe.com/xap/1.0/\0'
const XMP_EXT_HEAD = 'http://ns.adobe.com/xmp/extension/\0'

export function detect(b: Uint8Array): Format {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  // 0x89 在 windows-1252 解出來不是 \x89，PNG 簽名的第一個 byte 直接比
  if (b[0] === 0x89 && startsWith(b, 1, 'PNG\r\n\x1a\n')) return 'png'
  if (startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return 'webp'
  if (startsWith(b, 4, 'ftyp') && /^(heic|heix|hevc|mif1|msf1|avif)/.test(ascii(b, 8, 4))) return 'heic'
  return 'other'
}

// ---- XMP 裡的 GPS ----

/** XMP 裡 exif:GPS… 的屬性或元素，原地換成等長的空白（XML 仍然合法、長度不變） */
const XMP_GPS = [/\sexif:GPS\w+\s*=\s*"[^"]*"/g, /\sexif:GPS\w+\s*=\s*'[^']*'/g, /<exif:(GPS\w+)\b[^>]*?(?:\/>|>[\s\S]*?<\/exif:\1\s*>)/g]

function hasXmpGps(text: string) {
  return XMP_GPS.some((re) => new RegExp(re.source).test(text))
}

/** 把 b[start, end) 當 latin1 文字，清掉 XMP 的 GPS；回傳有沒有改 */
function blankXmpGps(b: Uint8Array, start: number, end: number): boolean {
  const text = ascii(b, start, end - start)
  let changed = false
  for (const re of XMP_GPS) {
    for (const m of text.matchAll(re)) {
      b.fill(0x20, start + m.index, start + m.index + m[0].length)
      changed = true
    }
  }
  return changed
}

// ---- JPEG ----

type Piece = { marker: number; start: number; end: number; /** 區段內容的開頭（長度欄位之後） */ data: number }

/** 拆成一段段：區段（含 SOS 檔頭）與掃描資料（marker = -1）；trailer 是 EOI 之後附加的東西 */
function jpegPieces(b: Uint8Array): { pieces: Piece[]; eoi: number } {
  const pieces: Piece[] = []
  let pos = 2
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) throw new Error('JPEG 結構錯誤')
    // 區段之間可以有多個 0xFF 填充
    while (b[pos + 1] === 0xff) pos++
    const marker = b[pos + 1]
    if (marker === 0xd9) return { pieces, eoi: pos + 2 }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pieces.push({ marker, start: pos, end: pos + 2, data: pos + 2 })
      pos += 2
      continue
    }
    const len = (b[pos + 2] << 8) | b[pos + 3]
    const end = pos + 2 + len
    if (len < 2 || end > b.length) throw new Error('JPEG 結構錯誤')
    pieces.push({ marker, start: pos, end, data: pos + 4 })
    pos = end
    if (marker === 0xda) {
      // 掃描資料：遇到 0xFF 後面不是 00（跳脫）或 RSTn 的，就是下一個區段
      let i = pos
      while (i + 1 < b.length) {
        if (b[i] === 0xff) {
          const n = b[i + 1]
          if (n === 0 || (n >= 0xd0 && n <= 0xd7)) {
            i += 2
            continue
          }
          if (n !== 0xff) break
        }
        i++
      }
      pieces.push({ marker: -1, start: pos, end: i, data: pos })
      pos = i
    }
  }
  // 沒有 EOI（檔案被截斷）：整個檔案都當成影像
  return { pieces, eoi: b.length }
}

const isExif = (b: Uint8Array, p: Piece) => p.marker === 0xe1 && startsWith(b, p.data, EXIF_HEAD)
const isXmp = (b: Uint8Array, p: Piece) => p.marker === 0xe1 && (startsWith(b, p.data, XMP_HEAD) || startsWith(b, p.data, XMP_EXT_HEAD))

function inspectJpeg(b: Uint8Array): Inspection {
  const { pieces, eoi } = jpegPieces(b)
  let tags: Tags | null = null
  const extras = new Set<string>()
  let xmpGps = false
  for (const p of pieces) {
    if (isExif(b, p)) {
      if (!tags) {
        try {
          tags = parseTiff(b.subarray(p.data + 6, p.end))
        } catch {
          extras.add('EXIF（讀不到內容）')
        }
      }
    } else if (isXmp(b, p)) {
      extras.add('XMP')
      if (hasXmpGps(ascii(b, p.data, p.end - p.data))) xmpGps = true
    } else if (p.marker === 0xe2 && startsWith(b, p.data, 'ICC_PROFILE\0')) extras.add('ICC 色彩描述檔（會保留）')
    else if (p.marker === 0xe2 && startsWith(b, p.data, 'MPF\0')) extras.add('MPF 多張影像（例如景深圖、HDR 增益圖）')
    else if (p.marker === 0xed) extras.add('IPTC／Photoshop 資訊')
    else if (p.marker === 0xfe) extras.add('註解')
    else if (p.marker === 0xe0 && startsWith(b, p.data, 'JFIF\0')) continue
    else if (p.marker === 0xee) continue
    else if (p.marker >= 0xe0 && p.marker <= 0xef) extras.add(`APP${p.marker - 0xe0} 區段`)
  }
  if (eoi < b.length) {
    extras.add(`檔尾附加資料 ${kb(b.length - eoi)}`)
    if (hasXmpGps(ascii(b, eoi, b.length - eoi))) xmpGps = true
  }
  return { format: 'jpeg', tags, extras: [...extras], xmpGps }
}

/** 留下的區段：JFIF、ICC 色彩描述檔、Adobe（CMYK 解碼要用），以及所有非 APPn／COM 的影像區段 */
function keepJpegPiece(b: Uint8Array, p: Piece) {
  if (p.marker === 0xfe) return false
  if (p.marker < 0xe0 || p.marker > 0xef) return true
  if (p.marker === 0xe0) return startsWith(b, p.data, 'JFIF\0')
  if (p.marker === 0xe2) return startsWith(b, p.data, 'ICC_PROFILE\0')
  return p.marker === 0xee
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function stripJpeg(b: Uint8Array, orientation: number | undefined): Uint8Array {
  const { pieces } = jpegPieces(b)
  const parts: Uint8Array[] = [b.subarray(0, 2)]
  const kept = pieces.filter((p) => keepJpegPiece(b, p))
  // 照片方向寫在 EXIF 裡，整段拿掉手機直拍的照片會躺下來，所以補一個只有方向的 EXIF
  let i = 0
  if (kept[0]?.marker === 0xe0) {
    parts.push(b.subarray(kept[0].start, kept[0].end))
    i++
  }
  if (orientation && orientation !== 1) {
    const body = orientationOnlyExif(orientation)
    parts.push(new Uint8Array([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body)
  }
  for (; i < kept.length; i++) parts.push(b.subarray(kept[i].start, kept[i].end))
  // EOI 之後附加的資料（多張影像、廠商資料）一併丟掉
  parts.push(new Uint8Array([0xff, 0xd9]))
  return concat(parts)
}

/** 在一段資料裡找所有 EXIF 區段（FF E1 len "Exif\0\0"），原地清掉 GPS。用在 EOI 之後內嵌的其他 JPEG */
function zeroEmbeddedExifGps(b: Uint8Array, from: number) {
  for (let i = from; i + 10 < b.length; i++) {
    if (b[i] !== 0xff || b[i + 1] !== 0xe1 || !startsWith(b, i + 4, EXIF_HEAD)) continue
    const end = Math.min(b.length, i + 2 + ((b[i + 2] << 8) | b[i + 3]))
    zeroGps(b.subarray(i + 10, end))
    i = end - 1
  }
}

function stripJpegGps(src: Uint8Array): Uint8Array {
  const b = src.slice()
  const { pieces, eoi } = jpegPieces(b)
  for (const p of pieces) {
    if (isExif(b, p)) zeroGps(b.subarray(p.data + 6, p.end))
    else if (isXmp(b, p)) blankXmpGps(b, p.data, p.end)
  }
  if (eoi < b.length) {
    zeroEmbeddedExifGps(b, eoi)
    blankXmpGps(b, eoi, b.length)
  }
  return b
}

// ---- PNG ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(b: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

type Chunk = { type: string; start: number; data: number; end: number; len: number }

function pngChunks(b: Uint8Array): Chunk[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: Chunk[] = []
  let pos = 8
  while (pos + 12 <= b.length) {
    const len = v.getUint32(pos)
    const end = pos + 12 + len
    if (end > b.length) throw new Error('PNG 結構錯誤')
    const type = ascii(b, pos + 4, 4)
    out.push({ type, start: pos, data: pos + 8, end, len })
    pos = end
    if (type === 'IEND') break
  }
  return out
}

const PNG_TEXT = new Set(['tEXt', 'iTXt', 'zTXt'])

/** PNG 的 eXIf 內容就是 TIFF；有些程式多寫了 "Exif\0\0"，跳過它 */
const exifBody = (b: Uint8Array, start: number, end: number) =>
  startsWith(b, start, EXIF_HEAD) ? b.subarray(start + 6, end) : b.subarray(start, end)

function inspectPng(b: Uint8Array): Inspection {
  let tags: Tags | null = null
  const extras: string[] = []
  let xmpGps = false
  for (const c of pngChunks(b)) {
    if (c.type === 'eXIf') {
      try {
        tags = parseTiff(exifBody(b, c.data, c.data + c.len))
      } catch {
        extras.push('EXIF（讀不到內容）')
      }
    } else if (PNG_TEXT.has(c.type)) {
      const keyEnd = b.indexOf(0, c.data)
      const key = ascii(b, c.data, Math.max(0, Math.min(keyEnd, c.data + 80) - c.data))
      extras.push(key === 'XML:com.adobe.xmp' ? 'XMP' : `文字欄位「${key}」`)
      if (c.type !== 'zTXt' && hasXmpGps(ascii(b, c.data, c.len))) xmpGps = true
    } else if (c.type === 'tIME') extras.push('修改時間')
    else if (c.type === 'iCCP') extras.push('ICC 色彩描述檔（會保留）')
  }
  return { format: 'png', tags, extras, xmpGps }
}

/** 重新組 PNG：drop 回傳 true 的區塊拿掉；edit 可以改內容（長度不變），改過的會重算 CRC */
function rebuildPng(src: Uint8Array, drop: (b: Uint8Array, c: Chunk) => boolean, edit?: (b: Uint8Array, c: Chunk) => boolean) {
  const b = src.slice()
  const parts: Uint8Array[] = [b.subarray(0, 8)]
  for (const c of pngChunks(b)) {
    if (drop(b, c)) continue
    if (edit?.(b, c)) new DataView(b.buffer).setUint32(c.end - 4, crc32(b.subarray(c.start + 4, c.end - 4)))
    parts.push(b.subarray(c.start, c.end))
  }
  return concat(parts)
}

const stripPng = (b: Uint8Array) => rebuildPng(b, (_, c) => c.type === 'eXIf' || c.type === 'tIME' || PNG_TEXT.has(c.type))

function stripPngGps(b: Uint8Array) {
  return rebuildPng(
    b,
    // 壓縮過的文字區塊（例如 ImageMagick 的 "Raw profile type exif"）沒辦法原地改，含 exif／xmp 的整塊拿掉
    (b, c) => c.type === 'zTXt' && /exif|xmp/i.test(ascii(b, c.data, Math.min(80, c.len))),
    (b, c) => {
      if (c.type === 'eXIf') return zeroGps(exifBody(b, c.data, c.data + c.len))
      if (c.type === 'tEXt' || c.type === 'iTXt') return blankXmpGps(b, c.data, c.data + c.len)
      return false
    },
  )
}

// ---- WebP ----

type RiffChunk = { id: string; start: number; data: number; len: number; end: number }

function webpChunks(b: Uint8Array): RiffChunk[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: RiffChunk[] = []
  let pos = 12
  while (pos + 8 <= b.length) {
    const len = v.getUint32(pos + 4, true)
    // 區塊長度是奇數時後面補一個 byte
    const end = Math.min(b.length, pos + 8 + len + (len & 1))
    out.push({ id: ascii(b, pos, 4), start: pos, data: pos + 8, len, end })
    pos = end
  }
  return out
}

function inspectWebp(b: Uint8Array): Inspection {
  let tags: Tags | null = null
  const extras: string[] = []
  let xmpGps = false
  for (const c of webpChunks(b)) {
    if (c.id === 'EXIF') {
      try {
        tags = parseTiff(exifBody(b, c.data, c.data + c.len))
      } catch {
        extras.push('EXIF（讀不到內容）')
      }
    } else if (c.id === 'XMP ') {
      extras.push('XMP')
      if (hasXmpGps(ascii(b, c.data, c.len))) xmpGps = true
    } else if (c.id === 'ICCP') extras.push('ICC 色彩描述檔（會保留）')
  }
  return { format: 'webp', tags, extras, xmpGps }
}

function stripWebp(src: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [src.slice(0, 12)]
  for (const c of webpChunks(src)) {
    if (c.id === 'EXIF' || c.id === 'XMP ') continue
    const chunk = src.slice(c.start, c.end)
    // VP8X 的旗標：0x08 有 EXIF、0x04 有 XMP
    if (c.id === 'VP8X') chunk[8] &= ~0x0c
    parts.push(chunk)
  }
  const out = concat(parts)
  new DataView(out.buffer).setUint32(4, out.length - 8, true)
  return out
}

function stripWebpGps(src: Uint8Array): Uint8Array {
  const b = src.slice()
  for (const c of webpChunks(b)) {
    if (c.id === 'EXIF') zeroGps(exifBody(b, c.data, c.data + c.len))
    else if (c.id === 'XMP ') blankXmpGps(b, c.data, c.data + c.len)
  }
  return b
}

// ---- 對外 ----

export function inspect(b: Uint8Array): Inspection {
  const format = detect(b)
  switch (format) {
    case 'jpeg':
      return inspectJpeg(b)
    case 'png':
      return inspectPng(b)
    case 'webp':
      return inspectWebp(b)
    default:
      return { format, tags: null, extras: [], xmpGps: false }
  }
}

export const canStrip = (f: Format) => f === 'jpeg' || f === 'png' || f === 'webp'

/** 移除全部中繼資料（JPEG 保留照片方向） */
export function stripAll(b: Uint8Array): Uint8Array {
  switch (detect(b)) {
    case 'jpeg': {
      const o = inspectJpeg(b).tags?.ifd0.get(0x0112)
      return stripJpeg(b, typeof o === 'number' ? o : undefined)
    }
    case 'png':
      return stripPng(b)
    case 'webp':
      return stripWebp(b)
    default:
      throw new Error('不支援這個格式')
  }
}

/** 只移除 GPS 定位，其他資料（拍攝時間、相機…）保留 */
export function stripGps(b: Uint8Array): Uint8Array {
  switch (detect(b)) {
    case 'jpeg':
      return stripJpegGps(b)
    case 'png':
      return stripPngGps(b)
    case 'webp':
      return stripWebpGps(b)
    default:
      throw new Error('不支援這個格式')
  }
}
