import { useId, useState } from 'react'
import { Check, CopyButton, Segmented } from '../encoding/ui'
import NumberInput from './NumberInput'
import { inspectUuid, uuidV4, uuidV7 } from './random'
import { store } from './store'
import { isoIn, LOCAL_TZ } from './time'

type Version = 'v4' | 'v7'

const VERSIONS: { value: Version; label: string }[] = [
  { value: 'v4', label: 'v4（隨機）' },
  { value: 'v7', label: 'v7（依時間排序）' },
]

type Format = { upper: boolean; noDash: boolean; braces: boolean }

function generate(v: Version, count: number): string[] {
  return Array.from({ length: count }, v === 'v4' ? uuidV4 : uuidV7)
}

function apply(u: string, f: Format): string {
  let s = f.upper ? u.toUpperCase() : u
  if (f.noDash) s = s.replace(/-/g, '')
  return f.braces ? `{${s}}` : s
}

const clampCount = (n: number) => Math.min(500, Math.max(1, Math.floor(n) || 1))

export default function UuidPanel() {
  const id = useId()
  const [version, setVersion] = useState<Version>(() => (store.load<string>('uuidVer', 'v4') === 'v7' ? 'v7' : 'v4'))
  const [count, setCount] = useState(() => clampCount(store.load('uuidCount', 5)))
  const [fmt, setFmt] = useState<Format>(() => {
    const f = store.load<Partial<Format>>('uuidFmt', {})
    return { upper: f?.upper === true, noDash: f?.noDash === true, braces: f?.braces === true }
  })
  const [list, setList] = useState(() => generate(version, count))
  const [probe, setProbe] = useState('')

  function regen(v = version, n = count) {
    setList(generate(v, n))
  }
  const setF = (k: keyof Format) => (on: boolean) => {
    const next = { ...fmt, [k]: on }
    setFmt(next)
    store.save('uuidFmt', next)
  }

  const shown = list.map((u) => apply(u, fmt))
  const info = probe.trim() ? inspectUuid(probe) : null

  return (
    <div className="enc">
      <div className="enc-controls">
        <Segmented
          label="版本"
          value={version}
          options={VERSIONS}
          onChange={(v) => {
            setVersion(v)
            store.save('uuidVer', v)
            regen(v)
          }}
        />
        <div className="enc-field">
          <label htmlFor={`${id}-n`}>數量（1–500）</label>
          <NumberInput
            id={`${id}-n`}
            min={1}
            max={500}
            value={count}
            onChange={(n) => {
              setCount(n)
              store.save('uuidCount', n)
              regen(version, n)
            }}
          />
        </div>
      </div>
      <div className="enc-options">
        <Check checked={fmt.upper} onChange={setF('upper')}>
          大寫
        </Check>
        <Check checked={fmt.noDash} onChange={setF('noDash')}>
          不要連字號
        </Check>
        <Check checked={fmt.braces} onChange={setF('braces')}>
          加上大括號 {'{}'}
        </Check>
      </div>
      <div className="enc-actions">
        <button type="button" onClick={() => regen()}>
          🔄 重新產生
        </button>
        <CopyButton text={shown.join('\n')} />
      </div>

      <ol className="gen-list">
        {shown.map((u, i) => (
          <li key={i}>
            <code>{u}</code>
            <CopyButton text={u} />
          </li>
        ))}
      </ol>

      <h2 className="gen-h">解析 UUID</h2>
      <div className="enc-field">
        <label htmlFor={`${id}-probe`}>貼上 UUID 查看版本與時間</label>
        <input
          id={`${id}-probe`}
          value={probe}
          onChange={(e) => setProbe(e.target.value)}
          placeholder="例如 0190f4a2-8b5c-7d3e-9f01-23456789abcd"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
      </div>
      {probe.trim() &&
        (info ? (
          <ul className="enc-rows">
            <li className="enc-row">
              <span className="enc-row-name">版本</span>
              <span className="enc-row-value">{info.version ? `v${info.version}` : '—'}</span>
            </li>
            <li className="enc-row">
              <span className="enc-row-name">變體</span>
              <span className="enc-row-value">{info.variant}</span>
            </li>
            {info.time !== undefined && Number.isFinite(info.time) && Math.abs(info.time) < 8.64e15 && (
              <li className="enc-row">
                <span className="enc-row-name">產生時間</span>
                <span className="enc-row-value">{isoIn(info.time, LOCAL_TZ)}</span>
                <CopyButton text={String(info.time)} />
              </li>
            )}
          </ul>
        ) : (
          <p className="error enc-msg">不是有效的 UUID（需要 32 個十六進位字元）。</p>
        ))}
      <p className="muted enc-note">
        v4 完全隨機；v7 前 48 位元是毫秒時間戳，依產生順序排序，適合當資料庫主鍵。全部用瀏覽器的 crypto 亂數產生。
      </p>
    </div>
  )
}
