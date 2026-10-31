// 掃描槍讀的內容：欄位用 { 分隔，每一段是 KEY=VALUE

export type Mode = 'slot' | 'item'
export type FieldId = 'sloc' | 'bin' | 'styp' | 'model' | 'mo' | 'qty' | 'dc'
export type Fields = Record<FieldId, string>

export const pad5 = (n: number) => String(n).padStart(5, '0')

export function encode(mode: Mode, fields: Fields, serNum: number): string {
  const v = (id: FieldId) => fields[id].trim().toUpperCase()
  if (mode === 'slot') return `SLOC=${v('sloc')}{BIN=${v('bin')}{STYP=${v('styp')}`
  const dc = fields.dc.trim().replace(/-/g, '')
  return `MO=${v('mo')}{ITEM={MODEL=${v('model')}{BX={QTY=${v('qty')}{LOT=${v('mo')}{DC=${dc}{SER=${pad5(serNum)}`
}

/** 掃到的倉位或料件條碼，轉回要填進欄位的值；兩種都不像就回 null */
export function parseScanned(raw: string): { mode: Mode; values: Partial<Fields> } | null {
  const parts: Record<string, string> = {}
  for (const segment of raw.split('{')) {
    const eq = segment.indexOf('=')
    if (eq > 0) parts[segment.slice(0, eq)] = segment.slice(eq + 1)
  }

  if ('SLOC' in parts || 'BIN' in parts || 'STYP' in parts) {
    const values: Partial<Fields> = {}
    if ('SLOC' in parts) values.sloc = parts.SLOC
    if ('BIN' in parts) values.bin = parts.BIN
    if ('STYP' in parts) values.styp = parts.STYP
    return { mode: 'slot', values }
  }

  const mo = parts.MO || parts.LOT || ''
  const model = parts.MODEL || ''
  const qty = parts.QTY || ''
  if (!mo && !model && !qty) return null
  const values: Partial<Fields> = {}
  if (mo) values.mo = mo
  if (model) values.model = model
  if (qty) values.qty = qty
  const dc = parts.DC ?? ''
  if (/^\d{8}$/.test(dc)) values.dc = `${dc.slice(0, 4)}-${dc.slice(4, 6)}-${dc.slice(6)}`
  return { mode: 'item', values }
}
