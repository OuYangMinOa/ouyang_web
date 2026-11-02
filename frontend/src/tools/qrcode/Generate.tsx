import { useEffect, useMemo, useRef, useState } from 'react'
import { drawQr, encodeQr, qrSvg, qrVersion, type EcLevel, type Matrix, type Style } from './matrix'
import { vcardText, wifiText, type Contact, type Wifi, type WifiAuth } from './payload'
import { CopyButton, Segmented } from './ui'

type Mode = 'text' | 'wifi' | 'vcard'

type Look = { ec: EcLevel; size: number; margin: number; fg: string; bg: string; transparent: boolean }

const LOOK_KEY = 'tool_qrcode_look'
const DEFAULT_LOOK: Look = { ec: 'M', size: 512, margin: 4, fg: '#000000', bg: '#ffffff', transparent: false }

const EC_OPTIONS: { value: EcLevel; label: string }[] = [
  { value: 'L', label: 'L 7%' },
  { value: 'M', label: 'M 15%' },
  { value: 'Q', label: 'Q 25%' },
  { value: 'H', label: 'H 30%' },
]

const CONTACT_FIELDS: { id: keyof Contact; label: string; type?: string; inputMode?: 'tel' | 'email' | 'url'; wide?: boolean }[] = [
  { id: 'lastName', label: '姓' },
  { id: 'firstName', label: '名' },
  { id: 'phone', label: '電話', type: 'tel', inputMode: 'tel' },
  { id: 'email', label: 'Email', type: 'email', inputMode: 'email' },
  { id: 'org', label: '公司' },
  { id: 'title', label: '職稱' },
  { id: 'url', label: '網址', type: 'url', inputMode: 'url', wide: true },
  { id: 'address', label: '地址', wide: true },
  { id: 'note', label: '備註', wide: true },
]

function loadLook(): Look {
  try {
    const s = JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null') as Partial<Look> | null
    return { ...DEFAULT_LOOK, ...(s && typeof s === 'object' ? s : {}) }
  } catch {
    return DEFAULT_LOOK
  }
}

/** WCAG 的相對亮度 */
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const canCopyImage = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write

export default function Generate() {
  const [mode, setMode] = useState<Mode>('text')
  const [text, setText] = useState('')
  const [wifi, setWifi] = useState<Wifi>({ ssid: '', password: '', auth: 'WPA', hidden: false })
  const [showPass, setShowPass] = useState(false)
  const [contact, setContact] = useState<Contact>({
    lastName: '',
    firstName: '',
    phone: '',
    email: '',
    org: '',
    title: '',
    url: '',
    address: '',
    note: '',
  })
  const [look, setLook] = useState(loadLook)
  const [copied, setCopied] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(look))
    } catch {
      // 存不了就只在這次有效
    }
  }, [look])

  const content =
    mode === 'text'
      ? text
      : mode === 'wifi'
        ? wifi.ssid
          ? wifiText(wifi)
          : ''
        : Object.values(contact).some((v) => v.trim())
          ? vcardText(contact)
          : ''

  const encoded = useMemo((): { matrix: Matrix | null; error: string } => {
    if (!content) return { matrix: null, error: '' }
    try {
      return { matrix: encodeQr(content, look.ec), error: '' }
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err)
      return {
        matrix: null,
        error: /NoValidSymbol|TooLong|length|capacity/i.test(msg)
          ? '內容太長，超過 QR Code 的容量。降低容錯等級可以放多一點（L 最多約 2900 個英數字、或 900 個中文字）。'
          : `無法產生：${msg}`,
      }
    }
  }, [content, look.ec])

  const style = useMemo(
    (): Style => ({ fg: look.fg, bg: look.transparent ? null : look.bg, margin: look.margin }),
    [look.fg, look.bg, look.transparent, look.margin],
  )
  const { matrix, error } = encoded

  useEffect(() => {
    if (matrix && canvas.current) drawQr(canvas.current, matrix, look.size, style)
  }, [matrix, look.size, style])

  const set = <K extends keyof Look>(k: K, v: Look[K]) => setLook((l) => ({ ...l, [k]: v }))

  // 掃描器看的是深淺差：對比太低或反白（淺色碼、深色底）都可能讀不到
  const warnings: string[] = []
  if (!look.transparent) {
    const lf = luminance(look.fg)
    const lb = luminance(look.bg)
    const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05)
    if (ratio < 3) warnings.push(`前景和背景的對比只有 ${ratio.toFixed(1)}:1，可能掃不到，建議至少 4:1。`)
    else if (lf > lb) warnings.push('淺色碼配深色底（反白）有些掃描器讀不到。')
  } else {
    warnings.push('透明背景要放在淺色的底上才掃得到。')
  }
  if (look.margin < 2) warnings.push('四周留白太少，貼在其他圖案旁邊時可能掃不到。')

  const fileBase = mode === 'wifi' ? 'qrcode-wifi' : mode === 'vcard' ? 'qrcode-contact' : 'qrcode'

  function pngBlob(): Promise<Blob> {
    return new Promise((resolve, reject) =>
      canvas.current?.toBlob((b) => (b ? resolve(b) : reject(new Error('產生圖片失敗'))), 'image/png'),
    )
  }

  async function copyImage() {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })])
      setCopied('已複製圖片')
    } catch {
      setCopied('複製失敗，請改用下載')
    }
    setTimeout(() => setCopied(''), 1800)
  }

  return (
    <div className="qr-gen">
      <div className="qr-gen-form">
        <Segmented<Mode>
          label="內容"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'text', label: '文字／網址' },
            { value: 'wifi', label: 'Wi-Fi' },
            { value: 'vcard', label: '聯絡人' },
          ]}
        />

        {mode === 'text' && (
          <label>
            文字或網址
            <textarea
              className="qr-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="https://example.com"
            />
          </label>
        )}

        {mode === 'wifi' && (
          <div className="qr-grid">
            <label className="wide">
              網路名稱（SSID）
              <input value={wifi.ssid} onChange={(e) => setWifi({ ...wifi, ssid: e.target.value })} autoComplete="off" />
            </label>
            <label>
              加密方式
              <select value={wifi.auth} onChange={(e) => setWifi({ ...wifi, auth: e.target.value as WifiAuth })}>
                <option value="WPA">WPA／WPA2／WPA3</option>
                <option value="WEP">WEP</option>
                <option value="nopass">沒有密碼</option>
              </select>
            </label>
            {wifi.auth !== 'nopass' && (
              <label>
                密碼
                <span className="qr-pass">
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={wifi.password}
                    onChange={(e) => setWifi({ ...wifi, password: e.target.value })}
                    autoComplete="new-password"
                  />
                  <button type="button" className="secondary" onClick={() => setShowPass((s) => !s)}>
                    {showPass ? '隱藏' : '顯示'}
                  </button>
                </span>
              </label>
            )}
            <label className="qr-check wide">
              <input type="checkbox" checked={wifi.hidden} onChange={(e) => setWifi({ ...wifi, hidden: e.target.checked })} />
              <span>隱藏的網路（不廣播 SSID）</span>
            </label>
          </div>
        )}

        {mode === 'vcard' && (
          <div className="qr-grid">
            {CONTACT_FIELDS.map((f) => (
              <label key={f.id} className={f.wide ? 'wide' : ''}>
                {f.label}
                <input
                  type={f.type ?? 'text'}
                  inputMode={f.inputMode}
                  value={contact[f.id]}
                  onChange={(e) => setContact({ ...contact, [f.id]: e.target.value })}
                />
              </label>
            ))}
          </div>
        )}

        <details className="qr-more" open>
          <summary>樣式</summary>
          <div className="qr-more-body">
            <Segmented<EcLevel> label="容錯等級（可以被遮住或弄髒的比例）" value={look.ec} onChange={(v) => set('ec', v)} options={EC_OPTIONS} />
            <label className="qr-range">
              <span className="qr-range-head">
                <span>圖片大小</span>
                <output>
                  {look.size}×{look.size} px
                </output>
              </span>
              <input
                type="range"
                min={128}
                max={2048}
                step={32}
                value={look.size}
                onChange={(e) => set('size', Number(e.target.value))}
              />
            </label>
            <label className="qr-range">
              <span className="qr-range-head">
                <span>四周留白</span>
                <output>{look.margin} 格</output>
              </span>
              <input type="range" min={0} max={8} value={look.margin} onChange={(e) => set('margin', Number(e.target.value))} />
            </label>
            <div className="qr-colors">
              <label className="qr-color">
                <input type="color" value={look.fg} onChange={(e) => set('fg', e.target.value)} />
                <span>前景</span>
              </label>
              <label className="qr-color">
                <input
                  type="color"
                  value={look.bg}
                  disabled={look.transparent}
                  onChange={(e) => set('bg', e.target.value)}
                />
                <span>背景</span>
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => setLook((l) => ({ ...l, fg: l.bg, bg: l.fg }))}
                disabled={look.transparent}
              >
                對調
              </button>
              <button type="button" className="secondary" onClick={() => setLook((l) => ({ ...l, fg: '#000000', bg: '#ffffff' }))}>
                黑白
              </button>
              <label className="qr-check">
                <input type="checkbox" checked={look.transparent} onChange={(e) => set('transparent', e.target.checked)} />
                <span>透明背景</span>
              </label>
            </div>
          </div>
        </details>
      </div>

      <div className="qr-gen-preview">
        <div className={`qr-preview${look.transparent ? ' transparent' : ''}`}>
          {matrix ? (
            <canvas ref={canvas} className="qr-canvas" role="img" aria-label="QR Code 預覽" />
          ) : (
            <p className={error ? 'error' : 'muted'}>{error || '輸入內容就會產生 QR Code'}</p>
          )}
        </div>
        {matrix && (
          <>
            <p className="muted qr-info">
              版本 {qrVersion(matrix)}（{matrix.n}×{matrix.n} 格）· {new TextEncoder().encode(content).length} bytes
            </p>
            {warnings.map((w) => (
              <p key={w} className="qr-warn">
                {w}
              </p>
            ))}
            <div className="qr-buttons">
              <button type="button" onClick={async () => downloadBlob(await pngBlob(), `${fileBase}.png`)}>
                下載 PNG
              </button>
              <button
                type="button"
                onClick={() =>
                  downloadBlob(new Blob([qrSvg(matrix, look.size, style)], { type: 'image/svg+xml' }), `${fileBase}.svg`)
                }
              >
                下載 SVG
              </button>
              {canCopyImage && (
                <button type="button" className="secondary" onClick={() => void copyImage()} aria-live="polite">
                  {copied || '複製圖片'}
                </button>
              )}
              <CopyButton text={content} label="複製內容文字" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
