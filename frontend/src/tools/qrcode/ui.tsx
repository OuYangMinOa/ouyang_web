import { useEffect, useRef, useState, type ReactNode } from 'react'
import { copyToClipboard } from '../../clipboard'

/** 一排互斥的選項，窄螢幕會換行 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label?: string
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={`qr-field ${className}`}>
      {label && <span className="qr-label">{label}</span>}
      <div className="qr-seg" role="radiogroup" aria-label={label}>
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

export function CopyButton({ text, label = '複製', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={`secondary ${className}`}
      disabled={!text}
      aria-live="polite"
      onClick={async () => {
        await copyToClipboard(text)
        setDone(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? '✓ 已複製' : label}
    </button>
  )
}
