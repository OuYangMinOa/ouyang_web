import { useDeferredValue, useId, useMemo } from 'react'
import { CODECS, findCodec, utf8, type CodecOptions } from './codecs'
import { CopyButton, OptionsForm, Segmented } from './ui'

export type Direction = 'encode' | 'decode'

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: 'encode', label: '編碼' },
  { value: 'decode', label: '解碼' },
]

const BYTE_CODECS = CODECS.filter((c) => c.kind === 'bytes')
const TEXT_CODECS = CODECS.filter((c) => c.kind === 'text')

function count(text: string): string {
  // 以字元計：代理對（emoji 等）只算一個
  let chars = text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) chars--
  }
  return `${chars.toLocaleString()} 字元・${utf8(text).length.toLocaleString()} 位元組`
}

export default function ConvertPanel({
  text,
  onText,
  codecId,
  onCodec,
  dir,
  onDir,
  options,
  onOptions,
}: {
  text: string
  onText: (t: string) => void
  codecId: string
  onCodec: (id: string) => void
  dir: Direction
  onDir: (d: Direction) => void
  options: CodecOptions
  onOptions: (o: CodecOptions) => void
}) {
  const id = useId()
  const codec = findCodec(codecId)
  // 打字時先更新輸入框，轉換晚一點跟上
  const input = useDeferredValue(text)
  const result = useMemo(() => {
    if (input === '') return null
    return dir === 'encode' ? codec.encode(input, options) : codec.decode(input, options)
  }, [codec, dir, input, options])
  const output = result?.ok ? result.text : ''
  const canSwap = !!result?.ok && !result.binary && output !== ''

  function swap() {
    if (!canSwap) return
    onText(output)
    onDir(dir === 'encode' ? 'decode' : 'encode')
  }

  return (
    <div className="enc">
      <div className="enc-controls">
        <label className="enc-field">
          格式
          <select className="enc-select" value={codec.id} onChange={(e) => onCodec(e.target.value)}>
            <optgroup label="位元組編碼（UTF-8）">
              {BYTE_CODECS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="文字跳脫">
              {TEXT_CODECS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <Segmented label="方向" value={dir} options={DIRECTIONS} onChange={onDir} />
      </div>

      <OptionsForm options={options} onChange={onOptions} keys={codec.options ?? []} />

      <div className="enc-field">
        <div className="enc-field-head">
          <label htmlFor={`${id}-in`}>{dir === 'encode' ? '原始文字' : `${codec.name} 內容`}</label>
          <span className="muted">{count(text)}</span>
        </div>
        <textarea
          id={`${id}-in`}
          className="enc-textarea"
          rows={6}
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder={dir === 'encode' ? '輸入要編碼的文字…' : `貼上要解碼的 ${codec.name}…`}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
      </div>

      <div className="enc-actions">
        <button type="button" onClick={swap} disabled={!canSwap} title="把輸出搬到輸入，並切換編碼／解碼">
          ⇅ 對調
        </button>
        <button type="button" className="secondary" onClick={() => onText('')} disabled={!text}>
          清除
        </button>
      </div>

      <div className="enc-field">
        <div className="enc-field-head">
          <label htmlFor={`${id}-out`}>{dir === 'encode' ? `${codec.name} 結果` : '解碼結果'}</label>
          <CopyButton text={output} />
        </div>
        <textarea
          id={`${id}-out`}
          className={`enc-textarea${result && !result.ok ? ' bad' : ''}`}
          rows={6}
          value={output}
          readOnly
          placeholder="結果會顯示在這裡"
          spellCheck={false}
        />
        {result && !result.ok && (
          <p className="error enc-msg" role="alert">
            {result.error}
          </p>
        )}
        {result?.ok && result.note && <p className="enc-msg enc-warn">{result.note}</p>}
      </div>

      {codec.note && <p className="muted enc-note">{codec.note}</p>}
    </div>
  )
}
