import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import Gallery from './Gallery'
import {
  COMMENTS,
  DEFAULT_FONT,
  FONTS,
  LAYOUTS,
  isLoaded,
  missingChars,
  renderArt,
  resolveFont,
  withComment,
} from './fonts'
import { useFont } from './useFont'
import './ascii-art.css'

type Settings = {
  text: string
  font: string
  h: number
  v: number
  /** 輸入框裡的字串；空白或 0 表示不限寬度 */
  width: string
  wsBreak: boolean
  comment: string
}

const DEFAULTS: Settings = {
  text: 'Hello',
  font: DEFAULT_FONT,
  h: 0,
  v: 0,
  width: '80',
  wsBreak: false,
  comment: 'none',
}

const MAX_SIZE = 28
const MIN_FIT_SIZE = 5
// 可印出的 ASCII 以外的字元（換行除外）
const NON_ASCII = /[^\x20-\x7e\r\n]/

function layoutIndex(raw: string | null): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n < LAYOUTS.length ? n : 0
}

// 網址參數沿用 TAAG 的命名：f 字型、t 文字、h/v 排列、w 寬度、we 只在空白換行、x 註解
function fromParams(p: URLSearchParams): Settings {
  const comment = p.get('x')
  return {
    text: p.get('t') ?? DEFAULTS.text,
    font: resolveFont(p.get('f')) ?? DEFAULTS.font,
    h: layoutIndex(p.get('h')),
    v: layoutIndex(p.get('v')),
    width: (p.get('w') ?? DEFAULTS.width).replace(/\D/g, '').slice(0, 4),
    wsBreak: p.get('we') === 'true',
    comment: COMMENTS.some((c) => c.id === comment) ? comment! : DEFAULTS.comment,
  }
}

// 只寫跟預設不同的，網址短一點
function toQuery(s: Settings): string {
  const p = new URLSearchParams()
  if (s.font !== DEFAULTS.font) p.set('f', s.font)
  if (s.text !== DEFAULTS.text) p.set('t', s.text)
  if (s.h !== DEFAULTS.h) p.set('h', String(s.h))
  if (s.v !== DEFAULTS.v) p.set('v', String(s.v))
  if (s.width !== DEFAULTS.width) p.set('w', s.width)
  if (s.wsBreak) p.set('we', 'true')
  if (s.comment !== DEFAULTS.comment) p.set('x', s.comment)
  return p.toString()
}

function matches(font: string, query: string): boolean {
  return font.toLowerCase().includes(query.trim().toLowerCase())
}

/** 等寬字型每個字元寬幾 em；量不到就用常見的 0.6 */
function monoRatio(el: HTMLElement): number {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0.6
  ctx.font = `100px ${getComputedStyle(el).fontFamily}`
  return ctx.measureText('M'.repeat(50)).width / 5000 || 0.6
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 不支援 Clipboard API（例如非 https）時退回舊方法
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

export default function AsciiArt() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [s, setS] = useState(() => fromParams(searchParams))
  const update = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }))

  const fontId = useId()
  const [filter, setFilter] = useState('')
  const [mode, setMode] = useState<'single' | 'gallery'>('single')
  const [size, setSize] = useState(14)
  const [fit, setFit] = useState(true)
  const [copied, setCopied] = useState<'art' | 'link' | 'failed' | null>(null)

  // 設定寫回網址（replace，不會塞滿上一頁）；打字時稍等一下再寫
  const query = toQuery(s)
  useEffect(() => {
    if (query === searchParams.toString()) return
    const timer = setTimeout(() => setSearchParams(new URLSearchParams(query), { replace: true }), 300)
    return () => clearTimeout(timer)
  }, [query, searchParams, setSearchParams])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  // ---- 字型 ----

  const filtered = useMemo(() => (filter.trim() ? FONTS.filter((f) => matches(f, filter)) : FONTS), [filter])
  // 上一個／下一個：目前字型在篩選結果裡就在結果裡切，不然在全部字型裡切
  const browseList = filtered.includes(s.font) ? filtered : FONTS
  const step = (delta: number) => {
    const list = browseList.length ? browseList : FONTS
    const i = list.indexOf(s.font)
    const next = i < 0 ? 0 : (i + delta + list.length) % list.length
    update({ font: list[next] })
  }
  const random = () => {
    const list = filtered.length > 1 ? filtered : FONTS
    let next = s.font
    while (next === s.font) next = list[Math.floor(Math.random() * list.length)]
    update({ font: next })
  }

  // 新字型下載完之前先顯示舊的，切換時不會閃一下空白
  const status = useFont(s.font)
  const [shownFont, setShownFont] = useState(s.font)
  if (status === 'ready' && shownFont !== s.font) setShownFont(s.font)
  const shownReady = isLoaded(shownFont)

  // ---- 產生 ----

  const width = Number.parseInt(s.width, 10) || 0
  const options = useMemo(
    () => ({ h: s.h, v: s.v, width, whitespaceBreak: s.wsBreak }),
    [s.h, s.v, width, s.wsBreak],
  )

  const result = useMemo((): { art: string } | { error: true } | null => {
    if (!shownReady) return null
    try {
      return { art: renderArt(s.text, { font: shownFont, ...options }) }
    } catch {
      return { error: true }
    }
  }, [shownReady, shownFont, s.text, options])

  const art = result && 'art' in result ? result.art : ''
  const output = withComment(art, s.comment)
  const missing = shownReady ? missingChars(s.text, shownFont) : []

  // ---- 預覽字級：自動縮小到放得下 ----

  const preRef = useRef<HTMLPreElement>(null)
  const [boxWidth, setBoxWidth] = useState(0)
  const [ratio, setRatio] = useState(0.6)

  // 依賴 mode：從總覽切回來時 <pre> 是新的元素，要重新量
  useEffect(() => {
    const el = preRef.current
    if (!el) return
    let alive = true
    setRatio(monoRatio(el))
    // 網頁字型下載完寬度可能不一樣，再量一次
    document.fonts?.ready.then(() => alive && setRatio(monoRatio(el)))
    const ro = new ResizeObserver(([entry]) => setBoxWidth(entry.contentRect.width))
    ro.observe(el)
    return () => {
      alive = false
      ro.disconnect()
    }
  }, [mode])

  const cols = output.split('\n').reduce((max, line) => Math.max(max, line.length), 0)
  const fitted =
    fit && cols > 0 && boxWidth > 0
      ? Math.max(MIN_FIT_SIZE, Math.min(size, Math.floor(((boxWidth * 0.98) / (cols * ratio)) * 10) / 10))
      : size

  // ---- 輸出 ----

  const copy = async (text: string, kind: 'art' | 'link') => {
    setCopied((await copyText(text)) ? kind : 'failed')
  }
  const shareLink = () => {
    const url = `${location.origin}${location.pathname}${query ? `?${query}` : ''}`
    copy(url, 'link')
  }
  const download = () => {
    const blob = new Blob([output + '\n'], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `ascii-${shownFont.replace(/[^\w-]+/g, '-')}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const pick = (font: string) => {
    update({ font })
    setMode('single')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const galleryText = useDeferredValue(s.text)

  return (
    <div className="aa">
      <section className="card aa-controls">
        <label>
          文字
          <textarea
            className="aa-textarea"
            value={s.text}
            rows={3}
            spellCheck={false}
            onChange={(e) => update({ text: e.target.value })}
          />
        </label>

        <div className="row aa-font-row">
          {/* 不用 <label> 包住：裡面有按鈕，點標籤文字會誤觸「上一個」 */}
          <div className="aa-font-field">
            <label htmlFor={fontId}>字型</label>
            <div className="aa-font-picker">
              <button type="button" className="secondary aa-icon" aria-label="上一個字型" onClick={() => step(-1)}>
                ‹
              </button>
              <select id={fontId} className="aa-select" value={s.font} onChange={(e) => update({ font: e.target.value })}>
                {!filtered.includes(s.font) && <option value={s.font}>{s.font}</option>}
                {filtered.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <button type="button" className="secondary aa-icon" aria-label="下一個字型" onClick={() => step(1)}>
                ›
              </button>
              <button type="button" className="secondary aa-icon" aria-label="隨機字型" title="隨機字型" onClick={random}>
                🎲
              </button>
            </div>
          </div>
          <label className="aa-filter-field">
            篩選字型
            <input
              type="search"
              value={filter}
              placeholder={`${FONTS.length} 個字型`}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
        </div>

        <div className="row aa-opts">
          <label>
            水平排列
            <select className="aa-select" value={s.h} onChange={(e) => update({ h: Number(e.target.value) })}>
              {LAYOUTS.map((l, i) => (
                <option key={l.value} value={i}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            垂直排列
            <select className="aa-select" value={s.v} onChange={(e) => update({ v: Number(e.target.value) })}>
              {LAYOUTS.map((l, i) => (
                <option key={l.value} value={i}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            寬度（0 為不限）
            <input
              type="text"
              inputMode="numeric"
              value={s.width}
              onChange={(e) => update({ width: e.target.value.replace(/\D/g, '').slice(0, 4) })}
            />
          </label>
          <label>
            註解格式
            <select className="aa-select" value={s.comment} onChange={(e) => update({ comment: e.target.value })}>
              {COMMENTS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="checks">
          <label className="aa-check">
            <input type="checkbox" checked={s.wsBreak} onChange={(e) => update({ wsBreak: e.target.checked })} />
            超過寬度時只在空白處換行
          </label>
        </div>
      </section>

      <div className="aa-tabs">
        <button
          type="button"
          aria-pressed={mode === 'single'}
          className={mode === 'single' ? 'active' : ''}
          onClick={() => setMode('single')}
        >
          預覽
        </button>
        <button
          type="button"
          aria-pressed={mode === 'gallery'}
          className={mode === 'gallery' ? 'active' : ''}
          onClick={() => setMode('gallery')}
        >
          字型總覽（{filtered.length}）
        </button>
      </div>

      {mode === 'single' && missing.length > 0 && (
        <p className="aa-hint">
          {shownFont} 沒有「{missing.slice(0, 8).join('')}
          {missing.length > 8 ? '…' : ''}」的字形，這些字會被略過。FIGlet 字型大多只有英文字母、數字和符號。
        </p>
      )}
      {mode === 'gallery' && NON_ASCII.test(s.text) && (
        <p className="aa-hint">FIGlet 字型大多只有英文字母、數字和符號，中文等其他字元會被略過。</p>
      )}

      {mode === 'single' ? (
        <section className="aa-result">
          <div className="aa-toolbar">
            <div className="aa-actions">
              <button type="button" disabled={!output} onClick={() => copy(output, 'art')}>
                {copied === 'art' ? '已複製 ✓' : '複製'}
              </button>
              <button type="button" className="secondary" disabled={!output} onClick={download}>
                下載 .txt
              </button>
              <button type="button" className="secondary" onClick={shareLink}>
                {copied === 'link' ? '已複製連結 ✓' : '複製連結'}
              </button>
            </div>
            <div className="aa-size">
              <label className="aa-range">
                <span>
                  字級 <span className="aa-num">{fitted}px</span>
                </span>
                <input
                  type="range"
                  min={8}
                  max={MAX_SIZE}
                  step={1}
                  value={size}
                  onChange={(e) => setSize(Number(e.target.value))}
                />
              </label>
              <label className="aa-check">
                <input type="checkbox" checked={fit} onChange={(e) => setFit(e.target.checked)} />
                自動縮小
              </label>
            </div>
          </div>
          {copied === 'failed' && <p className="error">複製失敗，請手動選取文字複製。</p>}

          <pre
            ref={preRef}
            className={status === 'loading' ? 'aa-art aa-output busy' : 'aa-art aa-output'}
            style={{ fontSize: `${fitted}px` }}
          >
            {status === 'error' ? (
              <span className="aa-dim">字型載入失敗，請檢查網路後再選一次。</span>
            ) : result === null ? (
              <span className="aa-dim">載入字型中…</span>
            ) : 'error' in result ? (
              <span className="aa-dim">這個字型產生失敗，換一個試試。</span>
            ) : output ? (
              output
            ) : (
              <span className="aa-dim">{s.text.trim() ? '這個字型畫不出這段文字。' : '在上面輸入文字。'}</span>
            )}
          </pre>
        </section>
      ) : s.text.trim() ? (
        // key：換篩選條件就從第一批重新載入
        <Gallery key={filter} fonts={filtered} text={galleryText} options={options} current={s.font} onPick={pick} />
      ) : (
        <p className="muted">先在上面輸入文字。</p>
      )}
    </div>
  )
}
