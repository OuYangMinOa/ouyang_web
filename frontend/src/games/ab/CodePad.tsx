import { useEffect } from 'react'

/** 筆記：這個數字確定不在（out）或確定在（in）對方的答案裡；沒標是 undefined */
export type Mark = 'out' | 'in' | undefined

/**
 * 四格數字＋數字鍵盤（對戰模式藏數字、猜數字共用）。不用 <input>，手機不會跳出系統鍵盤擋住畫面；
 * 實體鍵盤也能打數字、Backspace、Enter。`marks` 是筆記，標過的數字在鍵盤上會變淡或變綠。
 */
export function CodePad({
  value,
  onChange,
  onSubmit,
  submitLabel,
  disabled,
  marks,
  label,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  submitLabel: string
  disabled?: boolean
  marks?: readonly Mark[]
  label: string
}) {
  function press(d: string) {
    if (disabled || value.length >= 4 || value.includes(d)) return
    onChange(value + d)
  }

  function backspace() {
    if (!disabled) onChange(value.slice(0, -1))
  }

  function submit() {
    if (!disabled && value.length === 4) onSubmit()
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (/^[0-9]$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') backspace()
      else if (e.key === 'Enter') {
        // 焦點在按鈕上時 Enter 會觸發按鈕本身，不要重複送出
        if (target?.tagName === 'BUTTON') return
        submit()
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
      <div className={`ab-slots${disabled ? ' idle' : ''}`} aria-label={label}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`ab-slot${i === value.length && !disabled ? ' cursor' : ''}`}>
            {value[i] ?? ''}
          </span>
        ))}
      </div>
      <div className="ab-keypad">
        {'1234567890'.split('').map((d) => {
          const mark = marks?.[Number(d)]
          return (
            <button
              key={d}
              type="button"
              className={`secondary${mark ? ` mark-${mark}` : ''}`}
              disabled={disabled || value.includes(d) || value.length >= 4}
              onClick={() => press(d)}
            >
              {d}
            </button>
          )
        })}
        <button type="button" className="secondary ab-wide" disabled={disabled || !value} onClick={backspace}>
          ⌫ 退格
        </button>
        <button type="button" className="ab-wide" disabled={disabled || value.length < 4} onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </>
  )
}
