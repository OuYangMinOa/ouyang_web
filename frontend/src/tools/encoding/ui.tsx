import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { CodecOptions, OptionKey } from './codecs'

/** 一排互斥的選項，窄螢幕會換行 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label?: ReactNode
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  className?: string
}) {
  const id = useId()
  return (
    <div className={`enc-seg ${className}`}>
      {label && (
        <span className="enc-seg-label" id={id}>
          {label}
        </span>
      )}
      <div className="enc-seg-buttons" role="radiogroup" aria-labelledby={label ? id : undefined}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? 'active' : ''}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function CopyButton({ text, disabled }: { text: string; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setState('done')
    } catch {
      setState('fail')
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1500)
  }

  return (
    <button type="button" className="secondary enc-copy" onClick={copy} disabled={disabled || !text} aria-live="polite">
      {state === 'done' ? '✓ 已複製' : state === 'fail' ? '複製失敗' : '複製'}
    </button>
  )
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="enc-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

const ALL_KEYS: OptionKey[] = ['b64Url', 'pad', 'hexUpper', 'hexSep', 'urlMode', 'htmlAll', 'uniBraces', 'uniAll']

/** 編碼選項；keys 沒給就全部列出 */
export function OptionsForm({
  options,
  onChange,
  keys = ALL_KEYS,
}: {
  options: CodecOptions
  onChange: (o: CodecOptions) => void
  keys?: OptionKey[]
}) {
  if (!keys.length) return null
  const set = <K extends OptionKey>(k: K, v: CodecOptions[K]) => onChange({ ...options, [k]: v })
  const has = (k: OptionKey) => keys.includes(k)
  // 全部列出時標上是哪個格式的選項
  const tag = (s: string) => (keys === ALL_KEYS ? `${s}：` : '')

  return (
    <div className="enc-options">
      {has('b64Url') && (
        <Check checked={options.b64Url} onChange={(v) => set('b64Url', v)}>
          {tag('Base64')}網址安全（- _）
        </Check>
      )}
      {has('pad') && (
        <Check checked={options.pad} onChange={(v) => set('pad', v)}>
          {tag('Base64/32')}補上結尾的 =
        </Check>
      )}
      {has('hexUpper') && (
        <Check checked={options.hexUpper} onChange={(v) => set('hexUpper', v)}>
          {tag('Hex')}大寫
        </Check>
      )}
      {has('hexSep') && (
        <label className="enc-inline">
          <span>{tag('Hex')}分隔</span>
          <select className="enc-select" value={options.hexSep} onChange={(e) => set('hexSep', e.target.value as CodecOptions['hexSep'])}>
            <option value="">不分隔</option>
            <option value=" ">空白</option>
            <option value=":">冒號</option>
          </select>
        </label>
      )}
      {has('urlMode') && (
        <label className="enc-inline">
          <span>{tag('URL')}方式</span>
          <select className="enc-select" value={options.urlMode} onChange={(e) => set('urlMode', e.target.value as CodecOptions['urlMode'])}>
            <option value="component">元件（encodeURIComponent）</option>
            <option value="uri">完整網址（encodeURI）</option>
            <option value="form">表單（空白變 +）</option>
          </select>
        </label>
      )}
      {has('htmlAll') && (
        <Check checked={options.htmlAll} onChange={(v) => set('htmlAll', v)}>
          {tag('HTML')}非 ASCII 也轉成 &amp;#…;
        </Check>
      )}
      {has('uniBraces') && (
        <Check checked={options.uniBraces} onChange={(v) => set('uniBraces', v)}>
          {tag('Unicode')}用 \u{'{…}'} 格式
        </Check>
      )}
      {has('uniAll') && (
        <Check checked={options.uniAll} onChange={(v) => set('uniAll', v)}>
          {tag('Unicode')}英數字也跳脫
        </Check>
      )}
    </div>
  )
}
