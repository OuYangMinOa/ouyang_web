import { useId, useMemo, useState } from 'react'
import { Check, CopyButton } from '../encoding/ui'
import NumberInput from './NumberInput'
import { randomInt } from './random'
import { store } from './store'

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
}
const DEFAULT_SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?/~'
/** 容易看錯的字元：0 O o、1 l I |，以及引號、反引號 */
const AMBIGUOUS = new Set('0Oo1lI|`\'"')

type Options = {
  length: number
  upper: boolean
  lower: boolean
  digits: boolean
  symbols: boolean
  symbolSet: string
  noAmbiguous: boolean
  count: number
}

const DEFAULTS: Options = {
  length: 16,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  symbolSet: DEFAULT_SYMBOLS,
  noAmbiguous: false,
  count: 5,
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n) || lo))

function loadOptions(): Options {
  const saved = store.load<Record<string, unknown>>('pw', {})
  const o: Options = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS) as (keyof Options)[]) {
    if (typeof saved?.[k] === typeof DEFAULTS[k]) Object.assign(o, { [k]: saved[k] })
  }
  o.length = clamp(o.length, 4, 128)
  o.count = clamp(o.count, 1, 50)
  return o
}

/** 每一類實際可用的字元（排除易混字元、去掉重複） */
function pools(o: Options): string[] {
  const raw = [o.upper && SETS.upper, o.lower && SETS.lower, o.digits && SETS.digits, o.symbols && o.symbolSet].filter(
    (s): s is string => !!s,
  )
  return raw
    .map((s) => [...new Set(s.replace(/\s/g, ''))].filter((c) => !o.noAmbiguous || !AMBIGUOUS.has(c)).join(''))
    .filter(Boolean)
}

/** 產生一組密碼，每個勾選的種類至少出現一次 */
function makePassword(length: number, groups: string[]): string {
  const all = [...new Set(groups.join(''))]
  for (let tries = 0; ; tries++) {
    const chars = Array.from({ length }, () => all[randomInt(all.length)])
    // 長度比種類還少時不可能每種都有，就不強求
    if (length < groups.length || tries > 100 || groups.every((g) => chars.some((c) => g.includes(c)))) return chars.join('')
  }
}

function generate(o: Options): string[] {
  const groups = pools(o)
  return groups.length ? Array.from({ length: o.count }, () => makePassword(o.length, groups)) : []
}

function strength(bits: number): { label: string; level: number } {
  if (bits < 40) return { label: '弱', level: 1 }
  if (bits < 60) return { label: '普通', level: 2 }
  if (bits < 80) return { label: '強', level: 3 }
  return { label: '很強', level: 4 }
}

export default function PasswordPanel() {
  const id = useId()
  const [o, setO] = useState(loadOptions)
  const groups = useMemo(() => pools(o), [o])
  const poolSize = new Set(groups.join('')).size
  const [list, setList] = useState(() => generate(o))

  // 選項一改就重新產生
  const set = <K extends keyof Options>(k: K, v: Options[K]) => {
    const next = { ...o, [k]: v }
    setO(next)
    setList(generate(next))
    store.save('pw', next)
  }

  const bits = poolSize > 1 ? o.length * Math.log2(poolSize) : 0
  const s = strength(bits)

  return (
    <div className="enc">
      <div className="enc-field">
        <label htmlFor={`${id}-len`}>長度：{o.length}</label>
        <div className="gen-length">
          <input
            id={`${id}-len`}
            type="range"
            min={4}
            max={64}
            value={Math.min(o.length, 64)}
            onChange={(e) => set('length', Number(e.target.value))}
          />
          <NumberInput aria-label="長度" min={4} max={128} value={o.length} onChange={(n) => set('length', n)} />
        </div>
      </div>

      <div className="enc-options">
        <Check checked={o.upper} onChange={(v) => set('upper', v)}>
          大寫 A–Z
        </Check>
        <Check checked={o.lower} onChange={(v) => set('lower', v)}>
          小寫 a–z
        </Check>
        <Check checked={o.digits} onChange={(v) => set('digits', v)}>
          數字 0–9
        </Check>
        <Check checked={o.symbols} onChange={(v) => set('symbols', v)}>
          符號
        </Check>
        <Check checked={o.noAmbiguous} onChange={(v) => set('noAmbiguous', v)}>
          排除易混字元（0 O o 1 l I | 引號）
        </Check>
      </div>
      {o.symbols && (
        <div className="enc-field">
          <label htmlFor={`${id}-sym`}>可用的符號</label>
          <div className="gen-symbols">
            <input
              id={`${id}-sym`}
              value={o.symbolSet}
              onChange={(e) => set('symbolSet', e.target.value)}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
            />
            <button type="button" className="secondary" onClick={() => set('symbolSet', DEFAULT_SYMBOLS)} disabled={o.symbolSet === DEFAULT_SYMBOLS}>
              還原
            </button>
          </div>
        </div>
      )}

      <div className="enc-controls">
        <div className="enc-field">
          <label htmlFor={`${id}-n`}>數量（1–50）</label>
          <NumberInput id={`${id}-n`} min={1} max={50} value={o.count} onChange={(n) => set('count', n)} />
        </div>
        <div className="enc-actions gen-fit">
          <button type="button" onClick={() => setList(generate(o))} disabled={!groups.length}>
            🔄 重新產生
          </button>
          <CopyButton text={list.join('\n')} />
        </div>
      </div>

      {groups.length ? (
        <>
          <div className="gen-strength" data-level={s.level}>
            <div className="gen-meter" aria-hidden="true">
              {[1, 2, 3, 4].map((l) => (
                <span key={l} className={l <= s.level ? 'on' : ''} />
              ))}
            </div>
            <span>
              強度：<strong>{s.label}</strong>
              <span className="muted">
                （約 {Math.round(bits)} 位元熵，{poolSize} 種字元）
              </span>
            </span>
          </div>
          <ol className="gen-list">
            {list.map((pw, i) => (
              <li key={i}>
                <code>{pw}</code>
                <CopyButton text={pw} />
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="error enc-msg">至少要選一種字元。</p>
      )}
      <p className="muted enc-note">密碼用 crypto.getRandomValues 在瀏覽器裡產生，不會傳到任何地方，也不會被記住。</p>
    </div>
  )
}
