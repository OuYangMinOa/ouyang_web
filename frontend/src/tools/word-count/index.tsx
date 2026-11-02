import { useDeferredValue, useId, useMemo, useState, type SyntheticEvent } from 'react'
import { analyze, formatMinutes } from './count'
import '../encoding/encoding.css'
import './word-count.css'

const n = (v: number) => v.toLocaleString()

export default function WordCountTool() {
  const id = useId()
  const [text, setText] = useState('')
  // 有選取文字時改統計選取的部分
  const [sel, setSel] = useState<[number, number]>([0, 0])
  const selected = sel[1] > sel[0] ? text.slice(sel[0], sel[1]) : ''
  const target = useDeferredValue(selected || text)
  const s = useMemo(() => analyze(target), [target])

  function onSelect(e: SyntheticEvent<HTMLTextAreaElement>) {
    const t = e.currentTarget
    setSel([t.selectionStart, t.selectionEnd])
  }

  const main = [
    { label: '字數', value: n(s.words), hint: '中文字、英文單字、數字各算一個' },
    { label: '字元（含空白）', value: n(s.chars), hint: '不含換行' },
    { label: '字元（不含空白）', value: n(s.charsNoSpace) },
    { label: '閱讀時間', value: formatMinutes(s.readMinutes), hint: `朗讀約 ${formatMinutes(s.speakMinutes)}` },
  ]
  const detail = [
    { label: '中文字', value: s.han },
    { label: '英文單字', value: s.latinWords },
    { label: '數字', value: s.numbers, hint: '連在一起的算一組' },
    { label: '標點', value: s.punctuation },
    { label: '符號與 emoji', value: s.symbols },
    { label: '日文假名／韓文', value: s.kanaHangul },
    { label: '空白', value: s.spaces },
    { label: '行數', value: s.lines },
    { label: '段落', value: s.paragraphs, hint: '有字的行' },
    { label: 'UTF-8 位元組', value: s.bytes },
  ]

  return (
    <div className="enc wc">
      <div className="enc-field">
        <div className="enc-field-head">
          <label htmlFor={`${id}-t`}>文字</label>
          <button
            type="button"
            className="secondary enc-copy"
            onClick={() => {
              setText('')
              setSel([0, 0])
            }}
            disabled={!text}
          >
            清除
          </button>
        </div>
        <textarea
          id={`${id}-t`}
          className="enc-textarea wc-text"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            onSelect(e)
          }}
          onSelect={onSelect}
          placeholder="貼上或輸入文字，下面會即時統計。選取一部分文字就只統計選取的範圍。"
        />
      </div>

      <p className="wc-scope" aria-live="polite">
        {selected ? <span className="chip">只統計選取的 {n(Array.from(selected).length)} 個字元</span> : <span className="muted">統計全文</span>}
      </p>

      <ul className="wc-main">
        {main.map((m) => (
          <li key={m.label} className="wc-card">
            <span className="wc-label">{m.label}</span>
            <strong className="wc-value">{m.value}</strong>
            {m.hint && <span className="muted wc-hint">{m.hint}</span>}
          </li>
        ))}
      </ul>

      <dl className="wc-detail">
        {detail.map((d) => (
          <div key={d.label} className="wc-row">
            <dt>
              {d.label}
              {d.hint && <span className="muted wc-hint">（{d.hint}）</span>}
            </dt>
            <dd>{n(d.value)}</dd>
          </div>
        ))}
      </dl>

      <p className="muted enc-note">閱讀時間以中文每分鐘 400 字、英文每分鐘 230 字估算；朗讀以中文每分鐘 200 字、英文 140 字估算。</p>
    </div>
  )
}
