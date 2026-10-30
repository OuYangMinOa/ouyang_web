import { useDeferredValue, useId, useMemo, useState } from 'react'
import { baseName, formatNumber, parseNumber } from './numbase'
import { load, save } from './util'
import { Check, CopyButton } from './ui'

const BASES = Array.from({ length: 61 }, (_, i) => i + 2)
const SHOWN = [2, 8, 10, 16, 32, 36, 62]
const NAMED = [2, 8, 10, 16]

/** 存檔的值可能被改壞，不在範圍內就用預設值 */
const loadBase = (key: string, fallback: number) => {
  const b = load(key, fallback)
  return BASES.includes(b) ? b : fallback
}

function BaseSelect({ value, onChange, id, label }: { value: number; onChange: (b: number) => void; id?: string; label?: string }) {
  return (
    <select id={id} aria-label={label} className="enc-select" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {BASES.map((b) => (
        <option key={b} value={b}>
          {baseName(b)}
          {NAMED.includes(b) ? `（${b}）` : ''}
        </option>
      ))}
    </select>
  )
}

export default function NumberPanel() {
  const id = useId()
  const [text, setText] = useState('')
  const [from, setFrom] = useState(() => loadBase('numFrom', 10))
  const [custom, setCustom] = useState(() => loadBase('numCustom', 58))
  const [upper, setUpper] = useState(() => load('numUpper', false))
  const input = useDeferredValue(text)
  const parsed = useMemo(() => (input.trim() ? parseNumber(input, from) : null), [input, from])
  const value = parsed?.ok ? parsed.value : null

  function changeFrom(b: number) {
    // 換進位時把目前的數字一起換過去，輸入框不會突然變成錯的
    if (value !== null) setText(formatNumber(value, b, upper))
    setFrom(b)
    save('numFrom', b)
  }

  const rows = [...SHOWN.map((b) => ({ base: b, custom: false })), { base: custom, custom: true }]

  return (
    <div className="enc">
      <div className="enc-controls">
        <div className="enc-field enc-grow">
          <label htmlFor={`${id}-n`}>數字</label>
          <input
            id={`${id}-n`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如 255、-1024、ff"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
        </div>
        <div className="enc-field">
          <label htmlFor={`${id}-from`}>輸入的進位</label>
          <BaseSelect id={`${id}-from`} value={from} onChange={changeFrom} />
        </div>
      </div>

      <div className="enc-options">
        <Check
          checked={upper}
          onChange={(v) => {
            setUpper(v)
            save('numUpper', v)
          }}
        >
          字母用大寫（36 進位以內）
        </Check>
      </div>

      {parsed && !parsed.ok && (
        <p className="error enc-msg" role="alert">
          {parsed.error}
        </p>
      )}

      <ul className="enc-rows">
        {rows.map((row) => {
          const out = value === null ? '' : formatNumber(value, row.base, upper)
          return (
            <li key={row.custom ? 'custom' : row.base} className={`enc-row${row.base === from && value !== null ? ' current' : ''}`}>
              <span className="enc-row-name">
                {row.custom ? (
                  <BaseSelect
                    label="自訂進位"
                    value={custom}
                    onChange={(b) => {
                      setCustom(b)
                      save('numCustom', b)
                    }}
                  />
                ) : (
                  baseName(row.base)
                )}
              </span>
              <span className="enc-row-value">{out || <span className="muted">—</span>}</span>
              <CopyButton text={out} />
            </li>
          )
        })}
      </ul>

      <p className="muted enc-note">
        不限位數，可以有負號；空白、底線和逗號會略過，0x、0o、0b 開頭也可以。36 進位以內用 0-9a-z、不分大小寫；37 進位以上用
        0-9A-Za-z，大小寫不同（例如 62 進位的 A 是 10、a 是 36）。
      </p>
    </div>
  )
}
