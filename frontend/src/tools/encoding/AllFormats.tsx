import { useDeferredValue, useId, useMemo } from 'react'
import { CODECS, type CodecOptions } from './codecs'
import { CopyButton, OptionsForm } from './ui'

export default function AllFormats({
  text,
  onText,
  options,
  onOptions,
}: {
  text: string
  onText: (t: string) => void
  options: CodecOptions
  onOptions: (o: CodecOptions) => void
}) {
  const id = useId()
  const input = useDeferredValue(text)
  const results = useMemo(
    () => (input === '' ? [] : CODECS.map((codec) => ({ codec, result: codec.encode(input, options) }))),
    [input, options],
  )

  return (
    <div className="enc">
      <div className="enc-field">
        <label htmlFor={id}>原始文字</label>
        <textarea
          id={id}
          className="enc-textarea"
          rows={4}
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder="輸入文字，一次看所有編碼…"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
      </div>

      <details className="enc-more">
        <summary>格式選項</summary>
        <OptionsForm options={options} onChange={onOptions} />
      </details>

      {results.length === 0 ? (
        <p className="muted">輸入文字後，這裡會列出每一種編碼的結果。</p>
      ) : (
        <ul className="enc-grid">
          {results.map(({ codec, result }) => (
            <li key={codec.id} className="enc-card">
              <div className="enc-card-head">
                <h3>{codec.name}</h3>
                <CopyButton text={result.ok ? result.text : ''} />
              </div>
              {result.ok ? (
                <div className="enc-value">{result.text}</div>
              ) : (
                <p className="error enc-msg">{result.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
