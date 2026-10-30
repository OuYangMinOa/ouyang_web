import { useEffect, useRef, useState } from 'react'
import { animate, entryColor, randInt, reducedMotion, shuffle, type Entry } from './pool'
import type { DrawProps } from './types'

type Slot = { name: string; settled: boolean; color: string }

/** 籤筒：一次抽出 count 支籤，每支先亂跳一陣子再依序停下 */
export default function Slips({ pool, count, replace, onBusy, onDone }: DrawProps) {
  const [slots, setSlots] = useState<Slot[]>([])
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const skipRef = useRef(false)

  useEffect(() => () => abortRef.current?.abort(), [])

  async function draw() {
    if (!pool.length) return
    const k = replace ? count : Math.min(count, pool.length)
    // 結果先決定好，動畫只是表演
    const winners: Entry[] = replace ? Array.from({ length: k }, () => pool[randInt(pool.length)]) : shuffle(pool).slice(0, k)
    const ac = new AbortController()
    abortRef.current = ac
    skipRef.current = false
    setBusy(true)
    onBusy(true)
    const stagger = Math.min(350, 1800 / k)
    const ms = reducedMotion() ? 300 : 900 + stagger * (k - 1)
    let lastTick = -1
    try {
      await animate(
        ms,
        ac.signal,
        (t) => {
          const now = t * ms
          // 每 70ms 換一次名字就好，太快看不清楚
          const tick = Math.floor(now / 70)
          if (tick === lastTick && t < 1) return
          lastTick = tick
          setSlots(
            winners.map((w, i) => {
              const settled = t >= 1 || now >= ms - stagger * (k - 1 - i)
              if (settled) return { name: w.name, settled, color: entryColor(w.id) }
              const other = pool[randInt(pool.length)]
              return { name: other.name, settled, color: 'var(--border)' }
            }),
          )
        },
        skipRef,
      )
    } catch {
      return
    }
    setBusy(false)
    onBusy(false)
    onDone(winners)
  }

  const k = replace ? count : Math.min(count, pool.length)

  return (
    <div className="lot-slips">
      {slots.length > 0 ? (
        <ol className="lot-slip-list" aria-live="polite" aria-busy={busy}>
          {slots.map((s, i) => (
            <li key={i} className={s.settled ? 'settled' : ''} style={{ borderColor: s.color }}>
              <span className="lot-rank">{i + 1}</span>
              <span className="lot-slip-name">{s.name}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="lot-slip-empty" aria-hidden="true">
          🎋
        </div>
      )}
      <div className="lot-actions">
        {busy ? (
          <button type="button" className="secondary" onClick={() => (skipRef.current = true)}>
            跳過動畫
          </button>
        ) : (
          <button type="button" onClick={draw} disabled={!pool.length}>
            抽 {k || ''} 支
          </button>
        )}
      </div>
    </div>
  )
}
