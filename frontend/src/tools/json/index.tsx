import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, CopyButton, Segmented } from '../encoding/ui'
import { createStore } from '../encoding/util'
import { parseYaml, sortKeys, stringify, toYaml } from './convert'
import { JsonError, lineCol, parseJson, type JNode } from './parse'
import Tree from './Tree'
import '../encoding/encoding.css'
import './json.css'

type Yaml = typeof import('yaml')
type InFormat = 'auto' | 'json' | 'yaml'
type View = 'pretty' | 'minify' | 'yaml' | 'tree'
type Indent = '2' | '4' | 'tab'

const store = createStore('tools:json:')

const IN_FORMATS: { value: InFormat; label: string }[] = [
  { value: 'auto', label: '自動' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
]
const VIEWS: { value: View; label: string }[] = [
  { value: 'pretty', label: '格式化' },
  { value: 'minify', label: '壓縮' },
  { value: 'yaml', label: '轉 YAML' },
  { value: 'tree', label: '樹狀' },
]
const INDENTS: { value: Indent; label: string }[] = [
  { value: '2', label: '2 格' },
  { value: '4', label: '4 格' },
  { value: 'tab', label: 'Tab' },
]

const SAMPLE = `{
  "name": "小工具",
  "version": "1.0.0",
  "private": true,
  "tags": ["JSON", "YAML", "格式化"],
  "author": { "name": "OuYang", "url": "https://example.com" },
  "bigNumber": 12345678901234567890,
  "items": [
    { "id": 2, "title": "第二項", "done": false },
    { "id": 1, "title": "第一項", "done": true, "note": null }
  ]
}`

const oneOf = <T extends string>(v: unknown, list: { value: T }[], fallback: T): T =>
  list.some((x) => x.value === v) ? (v as T) : fallback

type Parsed =
  | { ok: true; node: JNode; format: 'json' | 'yaml'; warnings: string[] }
  | { ok: false; format: 'json' | 'yaml'; message: string; line?: number; col?: number }
  | { ok: null; format: 'yaml' } // 還在載入 YAML 模組

/** 自動判斷：以 { 或 [ 開頭的當 JSON，其他當 YAML */
const detect = (text: string, f: InFormat): 'json' | 'yaml' => (f !== 'auto' ? f : /^\s*[[{]/.test(text) ? 'json' : 'yaml')

function parse(text: string, f: InFormat, yaml: Yaml | null): Parsed {
  const format = detect(text, f)
  if (format === 'json') {
    try {
      return { ok: true, node: parseJson(text), format, warnings: [] }
    } catch (e) {
      if (e instanceof JsonError) return { ok: false, format, message: e.message, ...lineCol(text, e.offset) }
      return { ok: false, format, message: e instanceof RangeError ? '巢狀層數太深' : String(e) }
    }
  }
  if (!yaml) return { ok: null, format }
  return { ...parseYaml(yaml, text), format }
}

/** 統計：最深幾層、總共幾個值 */
function measure(n: JNode): { depth: number; count: number } {
  let count = 0
  let depth = 0
  const walk = (n: JNode, d: number) => {
    count++
    if (d > depth) depth = d
    if (n.t === 'object') for (const [, v] of n.entries) walk(v, d + 1)
    else if (n.t === 'array') for (const v of n.items) walk(v, d + 1)
  }
  walk(n, 1)
  return { depth, count }
}

/** 行、欄換回字元位置，用來把游標移到錯誤的地方 */
function offsetOf(text: string, line: number, col: number): number {
  let off = 0
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', off)
    if (nl < 0) return text.length
    off = nl + 1
  }
  return Math.min(text.length, off + col - 1)
}

export default function JsonTool() {
  const id = useId()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [inFmt, setInFmt] = useState(() => oneOf(store.load('in', 'auto'), IN_FORMATS, 'auto'))
  const [view, setView] = useState(() => oneOf(store.load('view', 'pretty'), VIEWS, 'pretty'))
  const [indent, setIndent] = useState(() => oneOf(store.load('indent', '2'), INDENTS, '2'))
  const [sort, setSort] = useState(() => store.load<boolean>('sort', false) === true)
  const [yaml, setYaml] = useState<Yaml | null>(null)
  const [yamlFailed, setYamlFailed] = useState(false)
  // 樹狀：預設展開幾層；換這個數字時整棵樹重畫
  const [openDepth, setOpenDepth] = useState(2)
  const [treeGen, setTreeGen] = useState(0)
  const [selected, setSelected] = useState('')

  const input = useDeferredValue(text)
  const format = detect(input, inFmt)
  const needYaml = format === 'yaml' || view === 'yaml'

  // YAML 套件只在需要時才下載
  useEffect(() => {
    if (!needYaml || yaml) return
    let alive = true
    import('yaml').then(
      (m) => alive && setYaml(m),
      () => alive && setYamlFailed(true),
    )
    return () => {
      alive = false
    }
  }, [needYaml, yaml])

  const parsed = useMemo(() => (input.trim() ? parse(input, inFmt, yaml) : null), [input, inFmt, yaml])
  const node = useMemo(() => (parsed?.ok ? (sort ? sortKeys(parsed.node) : parsed.node) : null), [parsed, sort])
  const stats = useMemo(() => (parsed?.ok ? measure(parsed.node) : null), [parsed])

  const output = useMemo(() => {
    if (!node || view === 'tree') return ''
    const ind = indent === 'tab' ? '\t' : ' '.repeat(Number(indent))
    if (view === 'pretty') return stringify(node, ind)
    if (view === 'minify') return stringify(node, '')
    return yaml ? toYaml(yaml, node, indent === '4' ? 4 : 2) : ''
  }, [node, view, indent, yaml])

  const remember =
    <T,>(key: string, set: (v: T) => void) =>
    (v: T) => {
      set(v)
      store.save(key, v)
    }

  function jumpToError() {
    if (parsed?.ok !== false || parsed.line === undefined) return
    const el = inputRef.current
    if (!el) return
    const off = offsetOf(input, parsed.line, parsed.col ?? 1)
    el.focus()
    el.setSelectionRange(off, Math.min(input.length, off + 1))
  }

  function applyOutput() {
    if (!output) return
    setText(output)
    // 套用 YAML 結果後，輸入格式跟著改，否則「JSON」模式會讀不懂
    if (inFmt !== 'auto') remember('in', setInFmt)(view === 'yaml' ? 'yaml' : 'json')
  }

  const errLine =
    parsed?.ok === false && parsed.line !== undefined ? (input.split(/\r?\n/)[parsed.line - 1] ?? '') : null
  const errCol = parsed?.ok === false ? (parsed.col ?? 1) - 1 : 0
  const formatName = format === 'json' ? 'JSON' : 'YAML'

  return (
    <div className="enc jsn">
      <div className="enc-controls">
        <Segmented label="輸入格式" value={inFmt} options={IN_FORMATS} onChange={remember('in', setInFmt)} />
        <Segmented label="輸出" value={view} options={VIEWS} onChange={remember('view', setView)} />
      </div>
      <div className="enc-options">
        {(view === 'pretty' || view === 'yaml') && (
          <label className="enc-inline">
            <span>縮排</span>
            <select
              className="enc-select"
              value={indent}
              onChange={(e) => remember('indent', setIndent)(e.target.value as Indent)}
            >
              {INDENTS.filter((o) => view !== 'yaml' || o.value !== 'tab').map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <Check checked={sort} onChange={remember('sort', setSort)}>
          鍵值依字母排序
        </Check>
      </div>

      <div className="jsn-panes">
        <div className="enc-field">
          <div className="enc-field-head">
            <label htmlFor={`${id}-in`}>輸入{inFmt === 'auto' && input.trim() ? `（判斷為 ${formatName}）` : ''}</label>
            <span className="jsn-tools">
              <button type="button" className="secondary enc-copy" onClick={() => setText(SAMPLE)}>
                範例
              </button>
              <button type="button" className="secondary enc-copy" onClick={() => setText('')} disabled={!text}>
                清除
              </button>
            </span>
          </div>
          <textarea
            ref={inputRef}
            id={`${id}-in`}
            className={`enc-textarea jsn-text${parsed?.ok === false ? ' bad' : ''}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="貼上 JSON 或 YAML…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
          <div aria-live="polite">
            {parsed?.ok === true && stats && (
              <p className="enc-msg jsn-ok">
                ✓ {formatName} 格式正確・共 {stats.count.toLocaleString()} 個值・最深 {stats.depth} 層
              </p>
            )}
            {parsed?.ok === true && parsed.warnings.map((w) => (
              <p key={w} className="enc-msg enc-warn">
                {w}
              </p>
            ))}
            {parsed?.ok === null && <p className="enc-msg muted">{yamlFailed ? 'YAML 模組下載失敗，請檢查網路。' : '載入 YAML 模組中…'}</p>}
          </div>
          {parsed?.ok === false && (
            <div className="jsn-error" role="alert">
              <p className="error enc-msg">
                {parsed.line !== undefined && (
                  <strong>
                    第 {parsed.line} 行第 {parsed.col} 欄：
                  </strong>
                )}
                {parsed.message}
              </p>
              {errLine !== null && (
                <pre className="jsn-excerpt">
                  {errLine.slice(0, errCol)}
                  <mark>{errLine[errCol] ?? ' '}</mark>
                  {errLine.slice(errCol + 1)}
                </pre>
              )}
              {parsed.line !== undefined && (
                <button type="button" className="secondary enc-copy" onClick={jumpToError}>
                  移到錯誤位置
                </button>
              )}
            </div>
          )}
        </div>

        <div className="enc-field">
          {view === 'tree' ? (
            <>
              <div className="enc-field-head">
                <span>樹狀檢視</span>
                <span className="jsn-tools">
                  <button
                    type="button"
                    className="secondary enc-copy"
                    disabled={!node}
                    onClick={() => {
                      setOpenDepth(Infinity)
                      setTreeGen((g) => g + 1)
                    }}
                  >
                    全部展開
                  </button>
                  <button
                    type="button"
                    className="secondary enc-copy"
                    disabled={!node}
                    onClick={() => {
                      setOpenDepth(1)
                      setTreeGen((g) => g + 1)
                    }}
                  >
                    全部收合
                  </button>
                </span>
              </div>
              {selected && node && (
                <div className="jsn-path">
                  <code>{selected}</code>
                  <CopyButton text={selected} />
                </div>
              )}
              <div className="jsn-tree">
                {node ? (
                  <Tree key={treeGen} node={node} openDepth={openDepth} selected={selected} onSelect={setSelected} />
                ) : (
                  <p className="muted">輸入正確的 JSON 或 YAML 後，這裡會顯示可以摺疊的樹狀結構。點鍵名可以取得路徑。</p>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="enc-field-head">
                <label htmlFor={`${id}-out`}>{view === 'yaml' ? 'YAML' : view === 'minify' ? '壓縮後的 JSON' : '格式化的 JSON'}</label>
                <span className="jsn-tools">
                  <button type="button" className="secondary enc-copy" onClick={applyOutput} disabled={!output} title="把結果放回左邊的輸入框">
                    套用到輸入
                  </button>
                  <CopyButton text={output} />
                </span>
              </div>
              <textarea
                id={`${id}-out`}
                className="enc-textarea jsn-text"
                value={output}
                readOnly
                placeholder="結果會顯示在這裡"
                spellCheck={false}
              />
              {output && (
                <p className="muted enc-msg">
                  {output.length.toLocaleString()} 字元
                  {view === 'minify' && input.length > output.length && `・比原本少 ${Math.round((1 - output.length / input.length) * 100)}%`}
                </p>
              )}
            </>
          )}
        </div>
      </div>
      <p className="muted enc-note">
        保留鍵的原本順序和數字的原始寫法（超過 2⁵³ 的大整數不會失去精度）。YAML 轉 JSON 時，多份文件只取第一份。
      </p>
    </div>
  )
}
