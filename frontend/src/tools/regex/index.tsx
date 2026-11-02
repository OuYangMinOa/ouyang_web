import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, CopyButton } from '../encoding/ui'
import { createStore } from '../encoding/util'
import { CHEATSHEET, EXAMPLES, explainError, groupNames, supportsV } from './data'
import type { FromWorker, Match, ToWorker } from './protocol'
import { MAX_MATCHES } from './protocol'
import '../encoding/encoding.css'
import './regex.css'

const store = createStore('tools:regex:')

/** 執行超過這個時間就當成災難性回溯，直接停掉 worker */
const TIMEOUT = 1500
/** 畫面上最多列出幾個符合結果的細節 */
const LIST_LIMIT = 200

const FLAGS: { flag: string; label: string }[] = [
  { flag: 'g', label: '全部 g' },
  { flag: 'i', label: '不分大小寫 i' },
  { flag: 'm', label: '多行 m' },
  { flag: 's', label: '. 含換行 s' },
  { flag: 'u', label: 'Unicode u' },
  { flag: 'v', label: '集合 v' },
  { flag: 'y', label: '黏著 y' },
]
const FLAG_ORDER = 'dgimsuvy'

type Run =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'timeout' }
  | { state: 'error'; message: string }
  | { state: 'done'; matches: Match[]; truncated: boolean; replaced: string | null; ms: number }

/** 在 worker 裡跑，太久就停掉重開 */
function useRegexRunner(job: Omit<ToWorker, 'id'> | null): Run {
  const [run, setRun] = useState<Run>({ state: 'idle' })
  const worker = useRef<Worker | null>(null)
  const current = useRef(0)
  const busy = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const key = job && JSON.stringify(job)
  useEffect(() => {
    if (!key) return
    // 打字時等一下再跑，不要每個字都丟給 worker
    const wait = setTimeout(() => {
      // 上一個還沒跑完（可能卡在回溯）就直接換一個新的 worker
      if (busy.current && worker.current) {
        worker.current.terminate()
        worker.current = null
      }
      if (!worker.current) {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
        w.onmessage = (e: MessageEvent<FromWorker>) => {
          const msg = e.data
          if (msg.id !== current.current) return
          busy.current = false
          clearTimeout(timer.current)
          setRun(msg.ok ? { state: 'done', ...msg } : { state: 'error', message: explainError(msg.error) })
        }
        worker.current = w
      }
      const id = ++current.current
      busy.current = true
      setRun((r) => (r.state === 'done' ? r : { state: 'running' }))
      worker.current.postMessage({ id, ...JSON.parse(key) } satisfies ToWorker)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        if (current.current !== id || !busy.current) return
        worker.current?.terminate()
        worker.current = null
        busy.current = false
        setRun({ state: 'timeout' })
      }, TIMEOUT)
    }, 150)
    return () => clearTimeout(wait)
  }, [key])

  useEffect(
    () => () => {
      clearTimeout(timer.current)
      worker.current?.terminate()
    },
    [],
  )
  return key ? run : { state: 'idle' }
}

/** 測試文字加上符合處的標示；空字串的符合畫成一條細線 */
function Highlighted({ text, matches }: { text: string; matches: Match[] }) {
  const out: ReactNode[] = []
  let pos = 0
  matches.forEach((m, i) => {
    if (m.start < pos) return
    out.push(text.slice(pos, m.start))
    out.push(
      m.end === m.start ? (
        <span key={i} className="rx-empty" title={`第 ${i + 1} 個（空字串）`} />
      ) : (
        <mark key={i} className={i % 2 ? 'alt' : ''} title={`第 ${i + 1} 個`}>
          {text.slice(m.start, m.end)}
        </mark>
      ),
    )
    pos = m.end
  })
  out.push(text.slice(pos))
  return <>{out}</>
}

/** 把字串裡看不見的字元顯示出來 */
const visible = (s: string) => (s === '' ? '（空字串）' : s.replace(/\n/g, '↵').replace(/\t/g, '⇥'))

function normalizeFlags(flags: string): string {
  return [...new Set(flags)].sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b)).join('')
}

export default function RegexTool() {
  const id = useId()
  const [pattern, setPattern] = useState(() => store.load('pattern', EXAMPLES[1].pattern))
  const [flags, setFlags] = useState(() => normalizeFlags(store.load('flags', EXAMPLES[1].flags)))
  const [text, setText] = useState(() => store.load('text', EXAMPLES[1].text))
  const [replacement, setReplacement] = useState(() => store.load('replacement', EXAMPLES[1].replacement ?? ''))
  const [useReplace, setUseReplace] = useState(() => store.load('useReplace', true) === true)
  const [note, setNote] = useState<string | undefined>(() => (store.load('pattern', null) === null ? EXAMPLES[1].note : undefined))
  const vOk = supportsV()

  // 記住最後一次的內容，下次打開接著用
  useEffect(() => {
    const t = setTimeout(() => {
      store.save('pattern', pattern)
      store.save('flags', flags)
      store.save('text', text.length > 20000 ? '' : text)
      store.save('replacement', replacement)
      store.save('useReplace', useReplace)
    }, 500)
    return () => clearTimeout(t)
  }, [pattern, flags, text, replacement, useReplace])

  // 語法錯誤在主執行緒先檢查：編譯不會執行比對，不會卡
  const compileError = useMemo(() => {
    if (!pattern) return null
    try {
      new RegExp(pattern, flags)
      return null
    } catch (e) {
      return explainError(e instanceof Error ? e.message : String(e))
    }
  }, [pattern, flags])

  const job = pattern && !compileError ? { pattern, flags, text, replacement: useReplace ? replacement : null } : null
  const run = useRegexRunner(job)
  const names = useMemo(() => groupNames(pattern), [pattern])
  const done = run.state === 'done' ? run : null
  const replaced = done?.replaced ?? null

  function toggleFlag(f: string, on: boolean) {
    let next = on ? flags + f : flags.replace(f, '')
    // u 和 v 不能同時開
    if (on && f === 'u') next = next.replace('v', '')
    if (on && f === 'v') next = next.replace('u', '')
    setFlags(normalizeFlags(next))
  }

  function applyExample(i: number) {
    const ex = EXAMPLES[i]
    if (!ex) return
    setPattern(ex.pattern)
    setFlags(ex.flags)
    setText(ex.text)
    setReplacement(ex.replacement ?? '')
    if (ex.replacement !== undefined) setUseReplace(true)
    setNote(ex.note)
  }

  return (
    <div className="enc rx">
      <div className="enc-controls">
        <label className="enc-field enc-grow">
          常用範例
          <select className="enc-select" value="" onChange={(e) => applyExample(Number(e.target.value))}>
            <option value="" disabled>
              選一個範例套用…
            </option>
            {EXAMPLES.map((ex, i) => (
              <option key={ex.name} value={i}>
                {ex.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="enc-field">
        <label htmlFor={`${id}-p`}>正規表示式</label>
        <div className={`rx-pattern${compileError ? ' bad' : ''}`}>
          <span aria-hidden="true">/</span>
          <input
            id={`${id}-p`}
            value={pattern}
            onChange={(e) => {
              setPattern(e.target.value)
              setNote(undefined)
            }}
            placeholder="例如 \d{4}-\d{2}-\d{2}"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
          />
          <span aria-hidden="true">/{flags}</span>
        </div>
        {compileError && (
          <p className="error enc-msg" role="alert">
            語法錯誤：{compileError}
          </p>
        )}
        {note && <p className="muted enc-msg">💡 {note}</p>}
      </div>

      <div className="enc-options rx-flags" role="group" aria-label="旗標">
        {FLAGS.filter((f) => f.flag !== 'v' || vOk).map((f) => (
          <Check key={f.flag} checked={flags.includes(f.flag)} onChange={(on) => toggleFlag(f.flag, on)}>
            {f.label}
          </Check>
        ))}
      </div>

      <div className="enc-field">
        <div className="enc-field-head">
          <label htmlFor={`${id}-t`}>測試文字</label>
          <button type="button" className="secondary enc-copy" onClick={() => setText('')} disabled={!text}>
            清除
          </button>
        </div>
        <textarea
          id={`${id}-t`}
          className="enc-textarea"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="輸入要測試的文字…"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
      </div>

      <section className="enc-field" aria-label="符合結果">
        <div className="enc-field-head">
          <span className="rx-status" aria-live="polite">
            {!pattern ? (
              <span className="muted">輸入正規表示式開始測試</span>
            ) : compileError ? null : run.state === 'timeout' ? (
              <span className="error">
                ⚠️ 執行超過 {TIMEOUT / 1000} 秒已停止：可能是巢狀量詞造成的災難性回溯，例如 (a+)+、(.*)*。試著拿掉重複的量詞或改寫得更明確。
              </span>
            ) : run.state === 'error' ? (
              <span className="error">{run.message}</span>
            ) : done ? (
              <>
                <strong className={done.matches.length ? 'rx-count' : ''}>
                  {done.matches.length ? `${done.matches.length.toLocaleString()} 個符合` : '沒有符合'}
                  {done.truncated && `（只列出前 ${MAX_MATCHES.toLocaleString()} 個）`}
                </strong>
                <span className="muted">・{done.ms < 1 ? '< 1' : Math.round(done.ms)} ms</span>
                {!flags.includes('g') && done.matches.length > 0 && <span className="muted">・沒開 g 只找第一個</span>}
              </>
            ) : (
              <span className="muted">執行中…</span>
            )}
          </span>
        </div>
        <div className={`rx-preview${run.state === 'running' ? ' stale' : ''}`}>
          {done && text ? <Highlighted text={text} matches={done.matches} /> : text || <span className="muted">（沒有測試文字）</span>}
        </div>
      </section>

      {done && done.matches.length > 0 && (
        <details className="rx-details" open={done.matches.length <= 20}>
          <summary>
            符合的內容與群組
            {done.matches.length > LIST_LIMIT && `（列出前 ${LIST_LIMIT} 個）`}
          </summary>
          <ol className="rx-matches">
            {done.matches.slice(0, LIST_LIMIT).map((m, i) => (
              <li key={i} className="rx-match">
                <div className="rx-match-head">
                  <span className="chip">#{i + 1}</span>
                  <span className="muted rx-pos">
                    位置 {m.start}–{m.end}
                  </span>
                </div>
                <code className="rx-value">{visible(m.value)}</code>
                {m.groups.length > 0 && (
                  <dl className="rx-groups">
                    {m.groups.map((g, k) => (
                      <Fragment key={k}>
                        <dt>
                          ${k + 1}
                          {names[k] && <span className="rx-name">{`<${names[k]}>`}</span>}
                        </dt>
                        <dd>{g.value === undefined ? <span className="muted">（沒有參與比對）</span> : <code>{visible(g.value)}</code>}</dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}

      <div className="enc-field">
        <div className="enc-field-head">
          <Check checked={useReplace} onChange={setUseReplace}>
            取代預覽
          </Check>
          {useReplace && replaced !== null && <CopyButton text={replaced} />}
        </div>
        {useReplace && (
          <>
            <input
              aria-label="取代成"
              className="rx-replace"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="取代成…（$1、$<name>、$& 可以引用符合的內容）"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
            />
            <div className="rx-preview rx-replaced">
              {replaced !== null ? replaced || <span className="muted">（空字串）</span> : <span className="muted">—</span>}
            </div>
          </>
        )}
      </div>

      <details className="rx-details rx-cheat">
        <summary>語法速查</summary>
        <div className="rx-cheat-grid">
          {CHEATSHEET.map((sec) => (
            <section key={sec.title}>
              <h3>{sec.title}</h3>
              <dl>
                {sec.items.map(([k, v]) => (
                  <Fragment key={k}>
                    <dt>
                      <code>{k}</code>
                    </dt>
                    <dd>{v}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </details>
    </div>
  )
}
