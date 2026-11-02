// QR Code 的內容格式：產生 Wi-Fi、vCard 字串，以及解析掃到的內容

export type WifiAuth = 'WPA' | 'WEP' | 'nopass'
export type Wifi = { ssid: string; password: string; auth: WifiAuth; hidden: boolean }

export type Contact = {
  lastName: string
  firstName: string
  phone: string
  email: string
  org: string
  title: string
  url: string
  address: string
  note: string
}

/** Wi-Fi 格式裡 \ ; , : " 前面要加反斜線 */
const wifiEscape = (s: string) => s.replace(/([\\;,:"])/g, '\\$1')

export function wifiText(w: Wifi) {
  let s = `WIFI:T:${w.auth};S:${wifiEscape(w.ssid)};`
  if (w.auth !== 'nopass') s += `P:${wifiEscape(w.password)};`
  if (w.hidden) s += 'H:true;'
  return s + ';'
}

const vEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n/g, '\\n')

/** vCard 3.0；手機的相機 App 掃到會問要不要加入聯絡人 */
export function vcardText(c: Contact) {
  const name = [c.lastName, c.firstName].map((s) => s.trim())
  // 中文名字姓在前、不加空格；英文名字名在前
  const cjk = /[㐀-鿿]/.test(name.join(''))
  const fn = (cjk ? name.join('') : [name[1], name[0]].filter(Boolean).join(' ')) || c.org.trim()
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${vEscape(name[0])};${vEscape(name[1])};;;`, `FN:${vEscape(fn)}`]
  if (c.org.trim()) lines.push(`ORG:${vEscape(c.org.trim())}`)
  if (c.title.trim()) lines.push(`TITLE:${vEscape(c.title.trim())}`)
  if (c.phone.trim()) lines.push(`TEL;TYPE=CELL:${c.phone.trim()}`)
  if (c.email.trim()) lines.push(`EMAIL:${c.email.trim()}`)
  if (c.url.trim()) lines.push(`URL:${c.url.trim()}`)
  if (c.address.trim()) lines.push(`ADR:;;${vEscape(c.address.trim())};;;;`)
  if (c.note.trim()) lines.push(`NOTE:${vEscape(c.note.trim())}`)
  lines.push('END:VCARD')
  return lines.join('\r\n')
}

// ---- 解析 ----

export type Field = { label: string; value: string; copy?: boolean; href?: string }

export type Parsed =
  | { kind: 'url'; url: string }
  /** type：原本寫的加密方式，例如 WPA2、SAE */
  | { kind: 'wifi'; wifi: Wifi; type: string }
  | { kind: 'fields'; title: string; fields: Field[] }
  | { kind: 'text' }

/** 用沒被反斜線跳脫的分隔字元切開，順便去掉跳脫 */
function splitEscaped(s: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i]
    } else if (ch === sep) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

/** WIFI:T:WPA;S:名稱;P:密碼;H:true;; 的欄位順序不固定 */
function parseKeyValues(body: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  // 先依 ; 切，但值裡的 \; 要保留給後面去跳脫，所以這裡自己處理
  let cur = ''
  const parts: string[] = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && i + 1 < body.length) {
      cur += body[i] + body[i + 1]
      i++
    } else if (body[i] === ';') {
      parts.push(cur)
      cur = ''
    } else {
      cur += body[i]
    }
  }
  parts.push(cur)
  for (const p of parts) {
    const colon = p.indexOf(':')
    if (colon <= 0) continue
    const key = p.slice(0, colon).toUpperCase()
    const value = splitEscaped(p.slice(colon + 1), '\u0000')[0]
    map.set(key, [...(map.get(key) ?? []), value])
  }
  return map
}

function parseWifi(text: string): { wifi: Wifi; type: string } | null {
  if (!/^WIFI:/i.test(text)) return null
  const kv = parseKeyValues(text.slice(5))
  const type = kv.get('T')?.[0] ?? ''
  const t = type.toUpperCase()
  const password = kv.get('P')?.[0] ?? ''
  const wifi: Wifi = {
    ssid: kv.get('S')?.[0] ?? '',
    password,
    auth: t === 'WEP' ? 'WEP' : (t === '' || t === 'NOPASS') && !password ? 'nopass' : 'WPA',
    hidden: /^true$/i.test(kv.get('H')?.[0] ?? ''),
  }
  return { wifi, type }
}

const VCARD_LABEL: Record<string, string> = {
  FN: '姓名',
  ORG: '公司',
  TITLE: '職稱',
  TEL: '電話',
  EMAIL: 'Email',
  URL: '網址',
  ADR: '地址',
  NOTE: '備註',
  BDAY: '生日',
}

function linkFor(key: string, value: string): string | undefined {
  if (key === 'TEL') return `tel:${value.replace(/[^\d+]/g, '')}`
  if (key === 'EMAIL') return `mailto:${value}`
  if (key === 'URL' && /^https?:\/\//i.test(value)) return value
  return undefined
}

function parseVcard(text: string): Field[] {
  // 折行：下一行開頭是空白就接到上一行
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const fields: Field[] = []
  let n: string[] | null = null
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).split(';')[0].toUpperCase().replace(/^ITEM\d+\./, '')
    const raw = line.slice(colon + 1)
    if (key === 'N') {
      n = splitEscaped(raw, ';')
      continue
    }
    const label = VCARD_LABEL[key]
    if (!label) continue
    const value = splitEscaped(raw.replace(/\\n/gi, '\n'), ';')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(key === 'ADR' ? ' ' : '；')
    if (value) fields.push({ label, value, copy: true, href: linkFor(key, value) })
  }
  if (!fields.some((f) => f.label === '姓名') && n) {
    const name = [n[0], n[1]].filter(Boolean).join(' ')
    if (name) fields.unshift({ label: '姓名', value: name, copy: true })
  }
  return fields
}

/** MECARD:N:王,小明;TEL:0912345678;EMAIL:a@b.c;; */
function parseMecard(text: string): Field[] {
  const kv = parseKeyValues(text.slice(7))
  const map: Record<string, string> = { N: 'FN', TEL: 'TEL', EMAIL: 'EMAIL', URL: 'URL', ADR: 'ADR', NOTE: 'NOTE', ORG: 'ORG' }
  const fields: Field[] = []
  for (const [k, values] of kv) {
    const key = map[k]
    if (!key) continue
    for (const v of values) {
      const value = key === 'FN' ? v.split(',').join(' ') : v
      if (value) fields.push({ label: VCARD_LABEL[key], value, copy: true, href: linkFor(key, value) })
    }
  }
  return fields
}

function decode(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function safeUrl(text: string): string | null {
  if (!/^https?:\/\/\S+$/i.test(text)) return null
  try {
    return new URL(text).href
  } catch {
    return null
  }
}

export function parseScanned(raw: string): Parsed {
  const text = raw.trim()
  const url = safeUrl(text)
  if (url) return { kind: 'url', url }

  const wifi = parseWifi(text)
  if (wifi) return { kind: 'wifi', ...wifi }

  if (/^BEGIN:VCARD/i.test(text)) return { kind: 'fields', title: '聯絡人（vCard）', fields: parseVcard(text) }
  if (/^MECARD:/i.test(text)) return { kind: 'fields', title: '聯絡人（MECARD）', fields: parseMecard(text) }

  let m = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(text)
  if (m) {
    const q = new URLSearchParams(m[2] ?? '')
    const fields: Field[] = [{ label: '收件人', value: decode(m[1]), copy: true, href: text }]
    if (q.get('subject')) fields.push({ label: '主旨', value: q.get('subject')!, copy: true })
    if (q.get('body')) fields.push({ label: '內容', value: q.get('body')!, copy: true })
    return { kind: 'fields', title: 'Email', fields }
  }
  m = /^tel:(.+)$/i.exec(text)
  if (m) return { kind: 'fields', title: '電話', fields: [{ label: '號碼', value: m[1], copy: true, href: text }] }
  m = /^(?:smsto|sms):([^:?]*)[:?]?(?:body=)?(.*)$/i.exec(text)
  if (m) {
    const fields: Field[] = [{ label: '號碼', value: m[1], copy: true, href: `sms:${m[1]}` }]
    if (m[2]) fields.push({ label: '內容', value: decode(m[2]), copy: true })
    return { kind: 'fields', title: '簡訊', fields }
  }
  m = /^geo:(-?[\d.]+),(-?[\d.]+)/i.exec(text)
  if (m) {
    return {
      kind: 'fields',
      title: '地點',
      fields: [
        {
          label: '座標',
          value: `${m[1]}, ${m[2]}`,
          copy: true,
          href: `https://www.openstreetmap.org/?mlat=${m[1]}&mlon=${m[2]}#map=17/${m[1]}/${m[2]}`,
        },
      ],
    }
  }
  return { kind: 'text' }
}
