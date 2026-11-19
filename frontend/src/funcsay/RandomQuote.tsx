import { useMemo, useState } from 'react'
import { useFuncSay } from './context'
import Icon from './Icon'
import QuoteCard from './QuoteCard'
import { byPolitics, POLITICS, type Politics, type Quote } from './quotes'

function pick(pool: Quote[], except?: number) {
  const choices = pool.length > 1 ? pool.filter((q) => q.id !== except) : pool
  return choices[Math.floor(Math.random() * choices.length)]?.id ?? null
}

/** 隨機抽一則，照「全部語錄」那邊選的政治類篩選 */
export default function RandomQuote() {
  const { quotes, loadError, reload, politics, setPolitics } = useFuncSay()
  const pool = useMemo(() => byPolitics(quotes ?? [], politics), [quotes, politics])
  const [picked, setPicked] = useState<number | null>(null)

  // 還沒抽，或抽到的那則被篩選掉了，就重抽；票數更新時同一則不會換掉
  const quote = pool.find((q) => q.id === picked) ?? null
  if (!quote && pool.length > 0) setPicked(pick(pool))

  function next() {
    setPicked(pick(pool, quote?.id))
  }

  return (
    <div className="funcsay-random">
      <h1>隨機一則</h1>

      {loadError && (
        <div className="funcsay-error">
          <p className="error">載入失敗：{loadError}</p>
          <button type="button" className="secondary" onClick={reload}>
            重試
          </button>
        </div>
      )}
      {!quotes && !loadError && <p className="muted">載入中…</p>}
      {quotes && !quote && <p className="muted funcsay-empty">這個分類沒有語錄。</p>}
      {quote && <QuoteCard quote={quote} large />}

      <div className="funcsay-random-controls">
        <button type="button" onClick={next} disabled={pool.length === 0}>
          <Icon name="shuffle" /> 再來一則
        </button>
        <select value={politics} onChange={(e) => setPolitics(e.target.value as Politics)} aria-label="政治類語錄">
          {POLITICS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
