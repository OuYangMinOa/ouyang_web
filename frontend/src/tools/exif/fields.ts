// 把 EXIF 標籤整理成看得懂的欄位
import type { Tags, Value } from './tiff'

export type Gps = { lat: number; lon: number; alt?: number; time?: string; direction?: number }

const num = (v: Value | undefined): number | undefined =>
  typeof v === 'number' ? v : Array.isArray(v) && typeof v[0] === 'number' ? v[0] : undefined
const str = (v: Value | undefined): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** "2024:05:01 12:34:56" → "2024/05/01 12:34:56" */
const date = (v: string | undefined) => v?.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1/$2/$3')

/** 度分秒（三個有理數）→ 十進位度數 */
function dms(v: Value | undefined, ref: Value | undefined): number | undefined {
  if (!Array.isArray(v) || v.length < 3) return num(v)
  const d = v[0] + v[1] / 60 + v[2] / 3600
  return ref === 'S' || ref === 'W' ? -d : d
}

export function gpsOf(tags: Tags | null): Gps | null {
  const g = tags?.gps
  if (!g) return null
  const lat = dms(g.get(2), g.get(1))
  const lon = dms(g.get(4), g.get(3))
  // 0,0 通常是沒定位到時寫入的預設值
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0))
    return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const altRaw = num(g.get(6))
  const alt = altRaw === undefined ? undefined : g.get(5) instanceof Uint8Array && (g.get(5) as Uint8Array)[0] === 1 ? -altRaw : altRaw
  const ts = g.get(7)
  const ds = str(g.get(29))
  let time: string | undefined
  if (Array.isArray(ts) && ts.length >= 3) {
    const hms = ts.map((n) => String(Math.floor(n)).padStart(2, '0')).join(':')
    time = `${ds ? date(ds) + ' ' : ''}${hms} UTC`
  }
  return { lat, lon, alt, time, direction: num(g.get(17)) }
}

/** 快門：1/250 s、2 s */
function exposure(v: number) {
  if (v >= 1) return `${+v.toFixed(1)} 秒`
  return `1/${Math.round(1 / v)} 秒`
}

const ORIENTATION: Record<number, string> = {
  1: '正常',
  2: '水平翻轉',
  3: '旋轉 180°',
  4: '垂直翻轉',
  5: '翻轉並旋轉 90°',
  6: '順時針旋轉 90°',
  7: '翻轉並旋轉 270°',
  8: '逆時針旋轉 90°',
}

/** 重點欄位（照片的「摘要」） */
export function summary(tags: Tags | null): { label: string; value: string }[] {
  if (!tags) return []
  const { ifd0, exif } = tags
  const rows: { label: string; value: string }[] = []
  const add = (label: string, value: string | undefined) => value && rows.push({ label, value })

  const taken = date(str(exif.get(0x9003)) ?? str(exif.get(0x9004)) ?? str(ifd0.get(0x0132)))
  const offset = str(exif.get(0x9011)) ?? str(exif.get(0x9010))
  add('拍攝時間', taken && (offset ? `${taken}（UTC${offset}）` : taken))

  const make = str(ifd0.get(0x010f))
  const model = str(ifd0.get(0x0110))
  add('相機', model && make && !model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? `${make} ${model}` : (model ?? make))

  const lensMake = str(exif.get(0xa433))
  const lens = str(exif.get(0xa434))
  add('鏡頭', lens && lensMake && !lens.startsWith(lensMake) ? `${lensMake} ${lens}` : (lens ?? lensMake))

  const focal = num(exif.get(0x920a))
  const focal35 = num(exif.get(0xa405))
  add('焦距', focal ? `${+focal.toFixed(1)} mm${focal35 ? `（等效 ${focal35} mm）` : ''}` : undefined)

  const f = num(exif.get(0x829d))
  add('光圈', f ? `f/${+f.toFixed(1)}` : undefined)
  const t = num(exif.get(0x829a))
  add('快門', t ? exposure(t) : undefined)
  const iso = num(exif.get(0x8827))
  add('ISO', iso ? String(iso) : undefined)
  const ev = num(exif.get(0x9204))
  add('曝光補償', ev !== undefined && ev !== 0 ? `${ev > 0 ? '+' : ''}${+ev.toFixed(2)} EV` : undefined)
  const flash = num(exif.get(0x9209))
  add('閃光燈', flash !== undefined ? (flash & 1 ? '有閃' : '沒閃') : undefined)
  const o = num(ifd0.get(0x0112))
  add('方向', o && o !== 1 ? ORIENTATION[o] : undefined)
  add('軟體', str(ifd0.get(0x0131)))
  add('作者', str(ifd0.get(0x013b)))
  add('版權', str(ifd0.get(0x8298)))
  add('說明', str(ifd0.get(0x010e)))
  add('機身序號', str(exif.get(0xa431)))
  add('鏡頭序號', str(exif.get(0xa435)))
  add('相機擁有者', str(exif.get(0xa430)))
  return rows
}

// ---- 全部欄位 ----

const NAMES: Record<number, string> = {
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x0128: 'ResolutionUnit',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x0201: 'ThumbnailOffset',
  0x0202: 'ThumbnailLength',
  0x0213: 'YCbCrPositioning',
  0x8298: 'Copyright',
  0x8769: 'ExifIFD',
  0x8825: 'GPSIFD',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8822: 'ExposureProgram',
  0x8827: 'ISO',
  0x9000: 'ExifVersion',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9010: 'OffsetTime',
  0x9011: 'OffsetTimeOriginal',
  0x9012: 'OffsetTimeDigitized',
  0x9101: 'ComponentsConfiguration',
  0x9201: 'ShutterSpeedValue',
  0x9202: 'ApertureValue',
  0x9203: 'BrightnessValue',
  0x9204: 'ExposureBiasValue',
  0x9205: 'MaxApertureValue',
  0x9207: 'MeteringMode',
  0x9208: 'LightSource',
  0x9209: 'Flash',
  0x920a: 'FocalLength',
  0x9214: 'SubjectArea',
  0x927c: 'MakerNote',
  0x9286: 'UserComment',
  0x9290: 'SubSecTime',
  0x9291: 'SubSecTimeOriginal',
  0x9292: 'SubSecTimeDigitized',
  0xa000: 'FlashpixVersion',
  0xa001: 'ColorSpace',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa005: 'InteropIFD',
  0xa217: 'SensingMethod',
  0xa301: 'SceneType',
  0xa401: 'CustomRendered',
  0xa402: 'ExposureMode',
  0xa403: 'WhiteBalance',
  0xa404: 'DigitalZoomRatio',
  0xa405: 'FocalLengthIn35mmFilm',
  0xa406: 'SceneCaptureType',
  0xa420: 'ImageUniqueID',
  0xa430: 'CameraOwnerName',
  0xa431: 'BodySerialNumber',
  0xa432: 'LensSpecification',
  0xa433: 'LensMake',
  0xa434: 'LensModel',
  0xa435: 'LensSerialNumber',
}

const GPS_NAMES: Record<number, string> = {
  0: 'GPSVersionID',
  1: 'GPSLatitudeRef',
  2: 'GPSLatitude',
  3: 'GPSLongitudeRef',
  4: 'GPSLongitude',
  5: 'GPSAltitudeRef',
  6: 'GPSAltitude',
  7: 'GPSTimeStamp',
  9: 'GPSStatus',
  12: 'GPSSpeedRef',
  13: 'GPSSpeed',
  16: 'GPSImgDirectionRef',
  17: 'GPSImgDirection',
  23: 'GPSDestBearingRef',
  24: 'GPSDestBearing',
  29: 'GPSDateStamp',
  31: 'GPSHPositioningError',
}

function format(v: Value): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(+v.toFixed(6))
  if (Array.isArray(v)) return v.map((n) => +n.toFixed(6)).join(', ')
  // 位元組：看起來是文字就顯示文字（例如 ExifVersion 的 "0232"），否則只顯示長度
  if (v.length <= 64 && v.every((c) => c === 0 || (c >= 0x20 && c < 0x7f))) {
    const s = String.fromCharCode(...v).replace(/\0+$/, '')
    if (s && !s.includes('\0')) return s
  }
  return `（${v.length} bytes）`
}

export type RawRow = { group: string; name: string; value: string }

export function allFields(tags: Tags | null): RawRow[] {
  if (!tags) return []
  const rows: RawRow[] = []
  const hex = (t: number) => `0x${t.toString(16).padStart(4, '0')}`
  const push = (group: string, map: Map<number, Value>, names: Record<number, string>) => {
    for (const [tag, v] of map) rows.push({ group, name: names[tag] ?? hex(tag), value: format(v) })
  }
  push('主圖', tags.ifd0, NAMES)
  push('拍攝', tags.exif, NAMES)
  push('GPS', tags.gps, GPS_NAMES)
  push('縮圖', tags.ifd1, NAMES)
  return rows
}
