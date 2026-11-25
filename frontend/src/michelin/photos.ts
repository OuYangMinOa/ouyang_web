// 從照片找吃過的米其林：讀照片 EXIF 裡的拍攝地點和日期，看是在哪一家附近拍的。
// 全部在瀏覽器裡做，照片不會上傳。只讀檔案開頭（EXIF 在前面），幾百張也很快。
// 支援 JPEG 和 iPhone 的 HEIC（EXIF 解析沿用 tools/exif 的 tiff.ts）。

import { gpsOf } from '../tools/exif/fields'
import { parseTiff, type Tags } from '../tools/exif/tiff'
import { RESTAURANTS, distanceMeters, type Restaurant } from './data'

/** 照片離店多近才算在那家拍的；官網沒給座標、位置是估的店放寬一點 */
const MATCH_METERS = 80
const MATCH_APPROX_METERS = 200
const JPEG_HEAD = 256 * 1024
const HEIC_HEAD = 512 * 1024

export type PhotoSpot = { lat: number; lng: number; /** YYYY-MM-DD，讀不到是 null */ date: string | null }

export type PhotoMatch = {
  restaurant: Restaurant
  photos: number
  /** 最早、最晚的拍攝日期 */
  first: string | null
  last: string | null
  /** 最近的一張離店多遠（公尺） */
  meters: number
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n))

async function head(file: Blob, start: number, length: number) {
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer())
}

/** JPEG：從開頭一段一段找 APP1 的 Exif，遇到影像資料就停 */
function jpegExif(b: Uint8Array): Uint8Array | null {
  let pos = 2
  while (pos + 4 <= b.length && b[pos] === 0xff) {
    const marker = b[pos + 1]
    if (marker === 0xd9 || marker === 0xda) return null
    const len = (b[pos + 2] << 8) | b[pos + 3]
    const end = pos + 2 + len
    if (marker === 0xe1 && ascii(b, pos + 4, 6) === 'Exif\0\0') return end <= b.length ? b.subarray(pos + 10, end) : null
    pos = end
  }
  return null
}

type Box = { type: string; start: number; body: number; end: number }

/** ISO BMFF（HEIC）的方塊；size 0 是到檔尾，1 是 64 位元的長度 */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: Box[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = view.getUint32(pos)
    const type = ascii(b, pos + 4, 4)
    let body = pos + 8
    if (size === 1) {
      if (pos + 16 > end) break
      size = Number(view.getBigUint64(pos + 8))
      body = pos + 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < 8) break
    out.push({ type, start: pos, body, end: Math.min(pos + size, end) })
    pos += size
  }
  return out
}

/** HEIC：meta 裡 iinf 找出 Exif 那一項，iloc 查它在檔案的哪裡 */
function heicExifLocation(b: Uint8Array): { offset: number; length: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta')
  if (!meta) return null
  // meta 是 FullBox：先跳過版本和旗標
  const children = boxes(b, meta.body + 4, meta.end)
  const iinf = children.find((x) => x.type === 'iinf')
  const iloc = children.find((x) => x.type === 'iloc')
  if (!iinf || !iloc) return null

  let exifId: number | null = null
  const iinfVersion = b[iinf.body]
  const entriesAt = iinf.body + 4 + (iinfVersion === 0 ? 2 : 4)
  for (const infe of boxes(b, entriesAt, iinf.end)) {
    if (infe.type !== 'infe') continue
    const version = b[infe.body]
    if (version < 2) continue
    const id = version === 2 ? view.getUint16(infe.body + 4) : view.getUint32(infe.body + 4)
    const typeAt = infe.body + 4 + (version === 2 ? 2 : 4) + 2
    if (ascii(b, typeAt, 4) === 'Exif') {
      exifId = id
      break
    }
  }
  if (exifId === null) return null

  let pos = iloc.body
  const version = b[pos]
  pos += 4
  const offsetSize = b[pos] >> 4
  const lengthSize = b[pos] & 15
  const baseSize = b[pos + 1] >> 4
  const indexSize = version === 1 || version === 2 ? b[pos + 1] & 15 : 0
  pos += 2
  const read = (size: number) => {
    let value = 0
    for (let i = 0; i < size; i++) value = value * 256 + b[pos + i]
    pos += size
    return value
  }
  const count = read(version < 2 ? 2 : 4)
  for (let i = 0; i < count && pos < iloc.end; i++) {
    const id = read(version < 2 ? 2 : 4)
    const method = version === 1 || version === 2 ? read(2) & 15 : 0
    read(2) // data_reference_index
    const base = read(baseSize)
    const extents = read(2)
    let first: { offset: number; length: number } | null = null
    for (let e = 0; e < extents; e++) {
      read(indexSize)
      const offset = read(offsetSize)
      const length = read(lengthSize)
      first ??= { offset: base + offset, length }
    }
    // 只處理資料直接放在檔案裡的（construction_method 0）
    if (id === exifId) return method === 0 ? first : null
  }
  return null
}

function spotOf(tags: Tags | null): PhotoSpot | null {
  const gps = gpsOf(tags)
  if (!gps) return null
  const taken = tags?.exif.get(0x9003) ?? tags?.exif.get(0x9004) ?? tags?.ifd0.get(0x0132)
  const match = typeof taken === 'string' ? /^(\d{4}):(\d{2}):(\d{2})/.exec(taken) : null
  return { lat: gps.lat, lng: gps.lon, date: match ? `${match[1]}-${match[2]}-${match[3]}` : null }
}

/** 一張照片的拍攝地點和日期；不是 JPEG／HEIC、沒有定位資訊或讀不了都是 null */
export async function readPhoto(file: File): Promise<PhotoSpot | null> {
  try {
    const start = await head(file, 0, 12)
    if (start[0] === 0xff && start[1] === 0xd8) {
      const exif = jpegExif(await head(file, 0, JPEG_HEAD))
      return exif ? spotOf(parseTiff(exif)) : null
    }
    if (ascii(start, 4, 4) === 'ftyp') {
      const location = heicExifLocation(await head(file, 0, HEIC_HEAD))
      if (!location || location.length < 10) return null
      const item = await head(file, location.offset, location.length)
      // Exif 項目開頭是 4 個位元組：TIFF 檔頭從哪裡開始（通常跳過 "Exif\0\0"）
      const tiffAt = 4 + new DataView(item.buffer).getUint32(0)
      return spotOf(parseTiff(item.subarray(tiffAt)))
    }
  } catch {
    // 壞掉的檔案就當作沒有位置
  }
  return null
}

/** 照片是在哪一家附近拍的；附近沒有就是 null */
export function nearestRestaurant(spot: PhotoSpot): { restaurant: Restaurant; meters: number } | null {
  let best: { restaurant: Restaurant; meters: number } | null = null
  for (const r of RESTAURANTS) {
    const meters = distanceMeters(spot, r)
    if (meters <= (r.approx ? MATCH_APPROX_METERS : MATCH_METERS) && (!best || meters < best.meters)) best = { restaurant: r, meters }
  }
  return best
}

/** 把每張照片對到的店合在一起，最近去的在前面 */
export function groupMatches(spots: PhotoSpot[]): PhotoMatch[] {
  const byId = new Map<string, PhotoMatch>()
  for (const spot of spots) {
    const hit = nearestRestaurant(spot)
    if (!hit) continue
    const m = byId.get(hit.restaurant.id) ?? { restaurant: hit.restaurant, photos: 0, first: null, last: null, meters: hit.meters }
    m.photos += 1
    m.meters = Math.min(m.meters, hit.meters)
    if (spot.date) {
      if (!m.first || spot.date < m.first) m.first = spot.date
      if (!m.last || spot.date > m.last) m.last = spot.date
    }
    byId.set(hit.restaurant.id, m)
  }
  return [...byId.values()].sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''))
}
