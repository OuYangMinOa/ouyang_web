import { useCallback, useMemo, useState } from 'react'
import Ladder from './Ladder'
import MarbleRace from './MarbleRace'
import { load, parseNames, save, type Entry } from './pool'
import Slips from './Slips'
import Wheel from './Wheel'
import './lottery.css'

type Mode = 'slips' | 'wheel' | 'marble' | 'ladder'
type Round = { id: number; mode: Mode; lines: string[] }

const MODES: { value: Mode; icon: string; label: string; blurb: string }[] = [
  { value: 'slips', icon: '🎋', label: '籤筒', blurb: '直接從籤筒裡抽出幾支籤' },
  { value: 'wheel', icon: '🎡', label: '轉盤', blurb: '圓盤轉起來，指針停在誰身上' },
  { value: 'marble', icon: '🔮', label: '彈珠', blurb: '挑一條賽道，彈珠滾下去分名次' },
  { value: 'ladder', icon: '🪜', label: '鬼腳圖', blurb: '鬼腳圖走線，一人一線對到一個獎項' },
]

const REPLACE_HINT: Record<Exclude<Mode, 'ladder'>, [string, string]> = {
  slips: ['抽中的放回籤筒，同一次也可能抽到同一個人', '抽中的不放回，之後不會再抽到'],
  wheel: ['每次都用整個轉盤，可能重複轉到同一個人', '轉中的那格會拿掉，之後不會再轉到'],
  marble: ['每一場都是全員上場', '中籤的人下一場不再上場'],
}

const DEFAULT_NAMES = '小明\n小華\n阿美\n志強\n雅婷\n家豪'
const MAX_ENTRIES = 200
const MAX_COUNT = 100

const isText = (v: unknown): v is string => typeof v === 'string'
const isMode = (v: unknown): v is Mode => MODES.some((m) => m.value === v)
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_COUNT
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

let roundId = 0

export default function Lottery() {
  const [text, setText] = useState(() => load('names', DEFAULT_NAMES, isText))
  const [mode, setMode] = useState(() => load('mode', 'wheel', isMode))
  const [count, setCount] = useState(() => load('count', 1, isCount))
  const [countText, setCountText] = useState(String(count))
  const [replace, setReplace] = useState(() => load('replace', false, isBool))
  /** 不放回時已經抽走的人（名單裡的 id） */
  const [taken, setTaken] = useState<ReadonlySet<number>>(() => new Set())
  /** 名單被改過或全部放回時加一，讓抽籤畫面整個重來 */
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<Round[]>([])

  const parsed = useMemo(() => parseNames(text), [text])
  const entries = useMemo(() => parsed.slice(0, MAX_ENTRIES), [parsed])
  const pool = useMemo(() => entries.filter((e) => !taken.has(e.id)), [entries, taken])
  const isLadder = mode === 'ladder'

  function changeText(value: string) {
    setText(value)
    save('names', value)
    setTaken(new Set())
    setVersion((v) => v + 1)
  }

  function putBack() {
    setTaken(new Set())
    setVersion((v) => v + 1)
  }

  function changeMode(m: Mode) {
    setMode(m)
    save('mode', m)
  }

  function changeCount(value: string) {
    setCountText(value)
    const n = Number(value)
    if (isCount(n)) {
      setCount(n)
      save('count', n)
    }
  }

  function changeReplace(v: boolean) {
    setReplace(v)
    save('replace', v)
  }

  const record = useCallback((m: Mode, lines: string[]) => {
    setHistory((h) => [{ id: ++roundId, mode: m, lines }, ...h].slice(0, 50))
  }, [])

  const handleDone = useCallback(
    (winners: Entry[]) => {
      record(mode, winners.map((w) => w.name))
      if (!replace) setTaken((t) => new Set([...t, ...winners.map((w) => w.id)]))
    },
    [mode, replace, record],
  )
  const handleLadder = useCallback((lines: string[]) => record('ladder', lines), [record])

  const current = MODES.find((m) => m.value === mode) ?? MODES[0]
  const drawProps = { pool, count, replace, onBusy: setBusy, onDone: handleDone }
  const emptyPool = !isLadder && entries.length > 0 && pool.length === 0

  return (
    <div className="lot">
      <section className="card lot-setup">
        <label>
          名單（一行一個，也可以用逗號分隔；重複的名字算多支籤）
          <textarea rows={5} value={text} onChange={(e) => changeText(e.target.value)} disabled={busy} spellCheck={false} />
        </label>
        <div className="lot-meta">
          <span className="muted">
            共 {entries.length} 人{!isLadder && !replace && taken.size > 0 && `，還剩 ${pool.length} 人`}
            {parsed.length > MAX_ENTRIES && `（最多 ${MAX_ENTRIES} 人，後面的沒有算進去）`}
          </span>
          {!isLadder && taken.size > 0 && (
            <button type="button" className="secondary" onClick={putBack} disabled={busy}>
              全部放回
            </button>
          )}
        </div>
      </section>

      <div className="lot-modes" role="radiogroup" aria-label="抽籤方式">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={m.value === mode}
            className={m.value === mode ? 'active' : ''}
            onClick={() => changeMode(m.value)}
            disabled={busy && m.value !== mode}
          >
            <span className="lot-mode-icon" aria-hidden="true">
              {m.icon}
            </span>
            {m.label}
          </button>
        ))}
      </div>
      <p className="muted">{current.blurb}</p>

      {isLadder ? (
        <p className="lot-note">爬梯子是一人一條線、全員一次分出完整對應，「抽幾名」與「放回」都不適用；名單裡重複的人會有多條線，可能對到多個獎項。</p>
      ) : (
        <div className="lot-options">
          <label className="lot-count">
            {mode === 'marble' ? '前幾名中籤' : '抽幾名'}
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_COUNT}
              value={countText}
              onChange={(e) => changeCount(e.target.value)}
              onBlur={() => setCountText(String(count))}
              disabled={busy}
            />
          </label>
          <label className="lot-check">
            <input type="checkbox" checked={replace} onChange={(e) => changeReplace(e.target.checked)} disabled={busy} />
            <span>
              抽中的放回
              <span className="muted">{REPLACE_HINT[mode][replace ? 0 : 1]}</span>
            </span>
          </label>
        </div>
      )}

      {!isLadder && !replace && count > pool.length && pool.length > 0 && (
        <p className="lot-warn">只剩 {pool.length} 人，這次全部抽出。</p>
      )}
      {mode === 'marble' && replace && count > pool.length && pool.length > 0 && (
        <p className="lot-warn">只有 {pool.length} 顆彈珠，最多 {pool.length} 名。</p>
      )}

      <section className="card lot-stage">
        {entries.length === 0 ? (
          <p className="muted">先在上面填入名單。</p>
        ) : emptyPool ? (
          <div className="stack">
            <p className="muted">全部的人都抽過了。</p>
            <button type="button" onClick={putBack}>
              全部放回
            </button>
          </div>
        ) : mode === 'slips' ? (
          <Slips key={version} {...drawProps} />
        ) : mode === 'wheel' ? (
          <Wheel key={version} {...drawProps} />
        ) : mode === 'marble' ? (
          <MarbleRace key={version} {...drawProps} />
        ) : (
          <Ladder key={version} entries={entries} onBusy={setBusy} onDone={handleLadder} />
        )}
      </section>

      {history.length > 0 && (
        <section className="card lot-history">
          <div className="lot-history-head">
            <h3>這次的紀錄</h3>
            <button type="button" className="secondary" onClick={() => setHistory([])}>
              清除
            </button>
          </div>
          <ol>
            {history.map((r) => {
              const m = MODES.find((x) => x.value === r.mode) ?? MODES[0]
              return (
                <li key={r.id}>
                  <span className="lot-history-mode">
                    <span aria-hidden="true">{m.icon}</span> {m.label}
                  </span>
                  <span className="lot-history-lines">{r.lines.join('、')}</span>
                </li>
              )
            })}
          </ol>
        </section>
      )}
    </div>
  )
}
