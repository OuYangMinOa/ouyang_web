import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { copyToClipboard } from '../../clipboard'
import { formatGroups, makeGroups, parseApart } from './grouping'
import { animate, colorVar, load, reducedMotion, save, wait, type Entry } from './pool'

type By = 'count' | 'size'

const MAX_GROUPS = 50
const isBy = (v: unknown): v is By => v === 'count' || v === 'size'
const isNum = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 200
const isText = (v: unknown): v is string => typeof v === 'string'

/** 發牌的順序：一輪發給每組一張，像真的在發牌 */
function dealOrder(groups: Entry[][]): Map<number, number> {
  const order = new Map<number, number>()
  const rounds = Math.max(0, ...groups.map((g) => g.length))
  let i = 0
  for (let r = 0; r < rounds; r++) {
    for (const g of groups) if (g[r]) order.set(g[r].id, i++)
  }
  return order
}

/** 隨機分組：平均分成 N 組或每組 M 人，可以指定某些人一定要分開；牌先洗一洗，再一張張翻開 */
export default function Groups({ entries, onBusy, onDone }: { entries: Entry[]; onBusy: (busy: boolean) => void; onDone: (lines: string[]) => void }) {
  const [by, setBy] = useState<By>(() => load('groupBy', 'count', isBy))
  const [num, setNum] = useState(() => load('groupNum', 2, isNum))
  const [numText, setNumText] = useState(String(num))
  const [apartText, setApartText] = useState(() => load('apart', '', isText))
  const [groups, setGroups] = useState<Entry[][] | null>(null)
  /** 翻開了幾張（依發牌順序） */
  const [revealed, setRevealed] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'shuffle' | 'flip' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const skipRef = useRef(false)
  const copiedTimer = useRef(0)

  useEffect(
    () => () => {
      abortRef.current?.abort()
      clearTimeout(copiedTimer.current)
    },
    [],
  )

  const n = entries.length
  const k = Math.max(1, Math.min(MAX_GROUPS, n, by === 'count' ? num : Math.ceil(n / num)))
  const apart = useMemo(() => parseApart(apartText), [apartText])
  const unknown = useMemo(() => {
    const names = new Set(entries.map((e) => e.name))
    return [...new Set(apart.flat())].filter((name) => !names.has(name))
  }, [apart, entries])
  const order = useMemo(() => (groups ? dealOrder(groups) : new Map<number, number>()), [groups])
  const busy = phase === 'shuffle' || phase === 'flip'
  const small = Math.floor(n / k)
  const sizeText = n % k === 0 ? `每組 ${small} 人` : `每組 ${small}～${small + 1} 人`

  function changeBy(v: By) {
    setBy(v)
    save('groupBy', v)
  }

  function changeNum(value: string) {
    setNumText(value)
    const v = Number(value)
    if (isNum(v)) {
      setNum(v)
      save('groupNum', v)
    }
  }

  function changeApart(value: string) {
    setApartText(value)
    save('apart', value)
  }

  async function run() {
    const result = makeGroups(entries, k, apart)
    if ('error' in result) {
      setError(result.error)
      return
    }
    setError(null)
    setCopied(false)
    const ac = new AbortController()
    abortRef.current = ac
    skipRef.current = false
    onBusy(true)
    setGroups(result.groups)
    setRevealed(0)
    try {
      if (!reducedMotion()) {
        // 先洗牌（CSS 動畫），再依發牌順序一張張翻開
        setPhase('shuffle')
        await wait(700, ac.signal)
        setPhase('flip')
        const ms = Math.min(4000, 400 + n * 120)
        await animate(ms, ac.signal, (t) => setRevealed(Math.ceil(t * n)), skipRef)
      }
    } catch {
      return
    }
    setRevealed(n)
    setPhase('done')
    onBusy(false)
    onDone(result.groups.map((g, i) => `第 ${i + 1} 組：${g.map((e) => e.name).join('、')}`))
  }

  function skip() {
    skipRef.current = true
    // 洗牌階段沒有 animate，直接跳到翻牌結束
    if (phase === 'shuffle') {
      abortRef.current?.abort()
      setRevealed(n)
      setPhase('done')
      onBusy(false)
      if (groups) onDone(groups.map((g, i) => `第 ${i + 1} 組：${g.map((e) => e.name).join('、')}`))
    }
  }

  async function copy() {
    if (!groups) return
    await copyToClipboard(formatGroups(groups))
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="lot-groups">
      <div className="lot-options">
        <div className="lot-by" role="radiogroup" aria-label="分組方式">
          <button type="button" role="radio" aria-checked={by === 'count'} className={by === 'count' ? 'active' : ''} onClick={() => changeBy('count')} disabled={busy}>
            分成幾組
          </button>
          <button type="button" role="radio" aria-checked={by === 'size'} className={by === 'size' ? 'active' : ''} onClick={() => changeBy('size')} disabled={busy}>
            每組幾人
          </button>
        </div>
        <label className="lot-count">
          {by === 'count' ? '組數' : '每組人數'}
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={by === 'count' ? MAX_GROUPS : 200}
            value={numText}
            onChange={(e) => changeNum(e.target.value)}
            onBlur={() => setNumText(String(num))}
            disabled={busy}
          />
        </label>
        <span className="muted lot-group-summary">
          {n} 人分成 {k} 組，{sizeText}
        </span>
      </div>

      <label>
        一定要分開（選填，一行一組，同一行的人不會同組，例如「小明、小華」）
        <textarea rows={2} value={apartText} onChange={(e) => changeApart(e.target.value)} disabled={busy} spellCheck={false} />
      </label>
      {unknown.length > 0 && <p className="lot-warn">名單裡沒有：{unknown.join('、')}</p>}
      {error && <p className="lot-warn">{error}</p>}

      {groups && (
        <ol className={`lot-group-list ${phase === 'shuffle' ? 'shuffling' : ''}`} aria-live="polite" aria-busy={busy}>
          {groups.map((g, gi) => (
            <li key={gi} className="lot-group" style={{ borderColor: colorVar(gi, groups.length) }}>
              <h4>
                <span className="lot-dot" style={{ background: colorVar(gi, groups.length) }} />第 {gi + 1} 組
                <span className="muted">{g.length} 人</span>
              </h4>
              <ul>
                {g.map((e) => {
                  const shown = (order.get(e.id) ?? 0) < revealed
                  return (
                    <li key={e.id} className={`lot-card ${shown ? 'flipped' : ''}`} style={{ '--i': order.get(e.id) ?? 0 } as CSSProperties}>
                      <span className="lot-card-inner">
                        <span className="lot-card-back" aria-hidden="true">
                          ?
                        </span>
                        <span className="lot-card-front" aria-hidden={!shown}>
                          {e.name}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}

      <div className="lot-actions">
        {busy ? (
          <button type="button" className="secondary" onClick={skip}>
            跳過動畫
          </button>
        ) : (
          <>
            <button type="button" onClick={run} disabled={n < 2}>
              {groups ? '重新分組' : '開始分組'}
            </button>
            {groups && phase === 'done' && (
              <button type="button" className="secondary" onClick={copy}>
                {copied ? '已複製 ✓' : '複製結果'}
              </button>
            )}
          </>
        )}
      </div>
      {n < 2 && <p className="muted">至少要有 2 個人才能分組。</p>}
    </div>
  )
}
