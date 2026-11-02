import { useDeferredValue, useId, useMemo, useState, useSyncExternalStore } from 'react'
import { Check, Segmented } from '../encoding/ui'
import { createStore } from '../encoding/util'
import { diffText, type DiffOptions, type Granularity } from './engine'
import DiffView, { type Layout } from './View'
import '../encoding/encoding.css'
import './diff.css'

const store = createStore('tools:diff:')

const GRANULARITY: { value: Granularity; label: string }[] = [
  { value: 'line', label: '逐行' },
  { value: 'word', label: '逐詞' },
  { value: 'char', label: '逐字' },
]
const LAYOUTS: { value: Layout; label: string }[] = [
  { value: 'side', label: '左右並排' },
  { value: 'unified', label: '合併' },
]

/** 窄螢幕放不下左右兩欄，自動改成合併檢視 */
const NARROW = '(max-width: 720px)'
function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(NARROW)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(NARROW).matches,
  )
}

const oneOf = <T extends string>(v: unknown, list: { value: T }[], fallback: T): T =>
  list.some((x) => x.value === v) ? (v as T) : fallback

export default function DiffTool() {
  const id = useId()
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [gran, setGran] = useState(() => oneOf(store.load('gran', 'line'), GRANULARITY, 'line'))
  const [layoutPref, setLayout] = useState(() => oneOf(store.load('layout', 'side'), LAYOUTS, 'side'))
  const [opt, setOpt] = useState<DiffOptions>(() => {
    const o = store.load<Partial<DiffOptions>>('opt', {})
    return { ignoreCase: o?.ignoreCase === true, ignoreSpace: o?.ignoreSpace === true }
  })
  const narrow = useNarrow()
  const layout: Layout = narrow ? 'unified' : layoutPref

  // 打字時先更新輸入框，比對晚一點跟上
  const da = useDeferredValue(a)
  const db = useDeferredValue(b)
  const result = useMemo(() => (da || db ? diffText(da, db, gran, opt) : undefined), [da, db, gran, opt])
  const stale = da !== a || db !== b

  const remember =
    <T,>(key: string, set: (v: T) => void) =>
    (v: T) => {
      set(v)
      store.save(key, v)
    }
  const setOption = (k: keyof DiffOptions) => (v: boolean) => remember('opt', setOpt)({ ...opt, [k]: v })

  const unit = gran === 'line' ? '行' : gran === 'word' ? '詞' : '字'
  const ignored = [opt.ignoreSpace && '空白', opt.ignoreCase && '大小寫'].filter(Boolean).join('和')

  return (
    <div className="enc dif">
      <div className="dif-inputs">
        <div className="enc-field">
          <div className="enc-field-head">
            <label htmlFor={`${id}-a`}>原文</label>
            <button type="button" className="secondary enc-copy" onClick={() => setA('')} disabled={!a}>
              清除
            </button>
          </div>
          <textarea
            id={`${id}-a`}
            className="enc-textarea dif-input"
            value={a}
            onChange={(e) => setA(e.target.value)}
            placeholder="貼上原本的文字…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
        </div>
        <div className="enc-field">
          <div className="enc-field-head">
            <label htmlFor={`${id}-b`}>修改後</label>
            <button type="button" className="secondary enc-copy" onClick={() => setB('')} disabled={!b}>
              清除
            </button>
          </div>
          <textarea
            id={`${id}-b`}
            className="enc-textarea dif-input"
            value={b}
            onChange={(e) => setB(e.target.value)}
            placeholder="貼上修改後的文字…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
        </div>
      </div>

      <div className="enc-controls">
        <Segmented label="比對單位" value={gran} options={GRANULARITY} onChange={remember('gran', setGran)} />
        {narrow ? (
          <p className="muted enc-msg dif-narrow">螢幕較窄，使用合併檢視。</p>
        ) : (
          <Segmented label="檢視方式" value={layoutPref} options={LAYOUTS} onChange={remember('layout', setLayout)} />
        )}
      </div>
      <div className="enc-options">
        <Check checked={opt.ignoreSpace} onChange={setOption('ignoreSpace')}>
          忽略空白
        </Check>
        <Check checked={opt.ignoreCase} onChange={setOption('ignoreCase')}>
          忽略大小寫
        </Check>
        <button
          type="button"
          className="secondary dif-swap"
          onClick={() => {
            setA(b)
            setB(a)
          }}
          disabled={!a && !b}
        >
          ⇄ 對調左右
        </button>
      </div>

      {result === undefined ? (
        <p className="muted">貼上兩段文字，差異會即時標示出來。</p>
      ) : result === null ? (
        <p className="enc-warn" role="alert">
          兩段文字差異太大，比對逾時。可以改用「逐行」或把文字分段比對。
        </p>
      ) : (
        <section className={`dif-result${stale ? ' stale' : ''}`} aria-label="比對結果">
          <div className="dif-summary" aria-live="polite">
            {result.same ? (
              <span className="dif-same">✓ 兩段文字相同{ignored && `（已忽略${ignored}）`}</span>
            ) : (
              <>
                <span className="dif-count ins">
                  +{result.added.toLocaleString()} {unit}
                </span>
                <span className="dif-count del">
                  −{result.removed.toLocaleString()} {unit}
                </span>
                {ignored && <span className="muted">已忽略{ignored}</span>}
              </>
            )}
          </div>
          {!result.same && <DiffView result={result} layout={layout} />}
        </section>
      )}
    </div>
  )
}
