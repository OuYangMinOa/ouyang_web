import { useState } from 'react'

/** 數字輸入框：打字途中（例如清空後重打）先不套用，超出範圍的值離開時還原 */
export default function NumberInput({
  value,
  onChange,
  min,
  max,
  ...rest
}: {
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  id?: string
  'aria-label'?: string
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      {...rest}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text ?? value}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n)
      }}
      onBlur={() => setText(null)}
    />
  )
}
