import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react'
import { CopyButton } from '../encoding/ui'
import { createStore } from '../encoding/util'
import { findMode, getConverter, MODES, type Converter, type ModeId } from './opencc'
import '../encoding/encoding.css'
import './zh-convert.css'

const store = createStore('tools:zh-convert:')

/** 以字元計：代理對（罕用字、emoji）只算一個 */
const countChars = (s: string) => Array.from(s).length

export default function ZhConvertTool() {
  const id = useId()
  const [modeId, setModeId] = useState<ModeId>(() => findMode(store.load('mode', 's2twp')).id)
  const [text, setText] = useState('')
  // 字典載好的轉換函式；換方向時先清掉，避免拿舊的方向轉
  const [conv, setConv] = useState<{ id: ModeId; fn: Converter } | null>(null)
  const [error, setError] = useState('')
  const mode = findMode(modeId)

  useEffect(() => {
    let alive = true
    getConverter(modeId).then(
      (fn) => alive && setConv({ id: modeId, fn }),
      () => alive && setError('字典下載失敗，請檢查網路後重新整理。'),
    )
    return () => {
      alive = false
    }
  }, [modeId])

  const ready = conv?.id === modeId ? conv.fn : null
  // 打字時先更新輸入框，轉換晚一點跟上
  const input = useDeferredValue(text)
  const output = useMemo(() => (ready && input ? ready(input) : ''), [ready, input])

  function changeMode(m: ModeId) {
    setError('')
    setModeId(m)
    store.save('mode', m)
  }

  function swap() {
    // 結果搬回左邊，方向反過來，可以來回確認轉得對不對
    if (output) setText(output)
    changeMode(mode.reverse)
  }

  const changed = useMemo(() => {
    if (!output || output.length !== input.length) return null
    let n = 0
    const a = Array.from(input)
    const b = Array.from(output)
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
    return n
  }, [input, output])

  return (
    <div className="enc zhc">
      <div className="zhc-bar">
        <label className="enc-field zhc-mode">
          轉換方向
          <select className="enc-select" value={modeId} onChange={(e) => changeMode(e.target.value as ModeId)}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.from} → {m.to}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary zhc-swap" onClick={swap} title="把結果搬到左邊，並反轉方向">
          ⇄ 交換方向
        </button>
      </div>
      <p className="muted enc-note zhc-note">{mode.note}</p>

      <div className="zhc-panes">
        <div className="enc-field">
          <div className="enc-field-head">
            <label htmlFor={`${id}-in`}>{mode.from}</label>
            <span className="zhc-tools">
              <span className="muted">{countChars(text).toLocaleString()} 字</span>
              <button type="button" className="secondary enc-copy" onClick={() => setText('')} disabled={!text}>
                清除
              </button>
            </span>
          </div>
          <textarea
            id={`${id}-in`}
            className="enc-textarea zhc-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="貼上或輸入要轉換的文字…"
            spellCheck={false}
            lang={modeId.startsWith('s') ? 'zh-CN' : modeId.startsWith('hk') ? 'zh-HK' : 'zh-TW'}
          />
        </div>

        <div className="enc-field">
          <div className="enc-field-head">
            <label htmlFor={`${id}-out`}>{mode.to}</label>
            <span className="zhc-tools">
              {changed !== null && input && <span className="muted">改了 {changed.toLocaleString()} 字</span>}
              <CopyButton text={output} />
            </span>
          </div>
          <textarea
            id={`${id}-out`}
            className="enc-textarea zhc-text"
            value={output}
            readOnly
            placeholder={error ? '' : ready ? '結果會即時顯示在這裡' : '下載字典中…'}
            spellCheck={false}
          />
          {error && (
            <p className="error enc-msg" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>

      <p className="muted enc-note">
        使用 OpenCC 開放中文轉換的詞庫，全部在瀏覽器裡處理。一字多義（例如「后」→「後／后」）會依前後文的詞判斷，少數情況仍可能轉錯，重要文件請再看一遍。
      </p>
    </div>
  )
}
