import { useEffect, useRef, useState } from 'react'
import { animate, colorVar, randInt, reducedMotion, wait, type Entry } from './pool'
import type { DrawProps } from './types'

const R = 100

/** 從正上方順時針量的角度（度）轉成座標 */
function point(deg: number, radius = R): [number, number] {
  const a = (deg * Math.PI) / 180
  return [Math.sin(a) * radius, -Math.cos(a) * radius]
}

function slicePath(from: number, to: number): string {
  const [x1, y1] = point(from)
  const [x2, y2] = point(to)
  const large = to - from > 180 ? 1 : 0
  return `M0 0L${x1.toFixed(3)} ${y1.toFixed(3)}A${R} ${R} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}Z`
}

/** 先快後慢停下來 */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4)

/** 轉到第 index 格停在指針下：至少多轉幾圈，停在格子中間附近的隨機位置 */
function targetRotation(from: number, index: number, n: number): number {
  const size = 360 / n
  const land = index * size + size * (0.15 + Math.random() * 0.7)
  // 轉了 rot 度後，指針（正上方）指著輪盤上 -rot 的位置
  const base = from + 360 * (5 + randInt(3))
  const want = (((360 - land) % 360) + 360) % 360
  return base + ((want - (base % 360)) + 360) % 360
}

export default function Wheel({ pool, count, replace, onBusy, onDone }: DrawProps) {
  // 轉的過程中顯示的格子；不放回時每轉完一次就拿掉中籤的那格
  const [slices, setSlices] = useState<Entry[] | null>(null)
  const [winner, setWinner] = useState<Entry | null>(null)
  const [round, setRound] = useState<{ at: number; of: number } | null>(null)
  const [busy, setBusy] = useState(false)
  /** 停下來時的角度；轉動中直接改 DOM，不經過 React */
  const [rest, setRest] = useState(0)

  const groupRef = useRef<SVGGElement>(null)
  const rotRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const skipRef = useRef(false)

  useEffect(() => () => abortRef.current?.abort(), [])

  const list = slices ?? pool
  const n = list.length
  const rotate = (deg: number) => groupRef.current?.setAttribute('transform', `rotate(${deg})`)

  async function spin() {
    if (!pool.length) return
    const ac = new AbortController()
    abortRef.current = ac
    skipRef.current = false
    setBusy(true)
    onBusy(true)
    let local = [...pool]
    const winners: Entry[] = []
    const rounds = replace ? count : Math.min(count, local.length)
    try {
      for (let i = 0; i < rounds; i++) {
        if (i > 0 && !replace) local = local.filter((e) => e.id !== winners[winners.length - 1].id)
        setSlices(local)
        setWinner(null)
        setRound(rounds > 1 ? { at: i + 1, of: rounds } : null)
        const pick = randInt(local.length)
        const from = rotRef.current
        const to = targetRotation(from, pick, local.length)
        const ms = reducedMotion() ? 400 : 4200 + randInt(800)
        await animate(ms, ac.signal, (t) => rotate(from + (to - from) * easeOut(t)), skipRef)
        rotRef.current = to % 360
        rotate(rotRef.current)
        setRest(rotRef.current)
        winners.push(local[pick])
        setWinner(local[pick])
        if (i < rounds - 1) await wait(skipRef.current ? 150 : 1100, ac.signal)
      }
    } catch {
      return
    }
    setBusy(false)
    onBusy(false)
    onDone(winners)
  }

  const font = Math.min(11, Math.max(4, (2 * Math.PI * 62) / Math.max(n, 1) * 0.55))
  const labels = font >= 4.5
  const maxChars = n <= 8 ? 7 : 5

  return (
    <div className="lot-wheel">
      <div className="lot-wheel-stage">
        <svg viewBox="-108 -114 216 224" className="lot-wheel-svg" role="img" aria-label={`轉盤，共 ${n} 格`}>
          <g ref={groupRef} transform={`rotate(${rest})`}>
            {n === 0 && <circle r={R} className="lot-wheel-empty" />}
            {n === 1 && <circle r={R} style={{ fill: colorVar(0, 1) }} className={winner ? 'lot-slice win' : 'lot-slice'} />}
            {n > 1 &&
              list.map((e, i) => (
                <path
                  key={`${e.id}-${i}`}
                  d={slicePath((i * 360) / n, ((i + 1) * 360) / n)}
                  style={{ fill: colorVar(i, n) }}
                  className={`lot-slice${winner?.id === e.id ? ' win' : ''}`}
                />
              ))}
            {labels &&
              list.map((e, i) => {
                const mid = ((i + 0.5) * 360) / n
                const text = e.name.length > maxChars ? `${e.name.slice(0, maxChars - 1)}…` : e.name
                return (
                  <text
                    key={`t${e.id}-${i}`}
                    transform={`rotate(${mid - 90})`}
                    x={R - 8}
                    y={0}
                    className="lot-wheel-label"
                    style={{ fontSize: font }}
                  >
                    {text}
                  </text>
                )
              })}
          </g>
          <circle r={12} className="lot-wheel-hub" />
          <path d={`M-9 ${-R - 12}L9 ${-R - 12}L0 ${-R + 8}Z`} className="lot-wheel-pointer" />
        </svg>
      </div>

      <div className="lot-wheel-side">
        <p className="lot-wheel-result" aria-live="polite">
          {winner ? (
            <>
              {round && <span className="muted">第 {round.at} / {round.of} 次　</span>}
              🎉 <strong>{winner.name}</strong>
            </>
          ) : busy ? (
            <span className="muted">{round ? `第 ${round.at} / ${round.of} 次，轉動中…` : '轉動中…'}</span>
          ) : (
            <span className="muted">{n ? `${n} 格，按下去轉轉看` : '名單是空的'}</span>
          )}
        </p>
        <div className="lot-actions">
          {busy ? (
            <button type="button" className="secondary" onClick={() => (skipRef.current = true)}>
              跳過動畫
            </button>
          ) : (
            <button type="button" onClick={spin} disabled={!pool.length}>
              {count > 1 ? `轉 ${replace ? count : Math.min(count, pool.length)} 次` : '轉！'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
