import { useCallback, useEffect, useRef, useState } from 'react'
import { DT, Race, SETTLE_TIME, marbleRadius, type Marble } from './marble/physics'
import { GATE_Y, SEG_R, TRACKS, WORLD_W, findTrack } from './marble/tracks'
import { COLORS, entryColor, load, save, type Entry } from './pool'
import type { DrawProps } from './types'

type Phase = 'idle' | 'running' | 'done'
type Speed = 'normal' | 'fast' | 'instant'
type Row = { id: number; name: string; rank: number }

type Palette = {
  surface: string
  text: string
  textH: string
  accent: string
  ink: string
  lots: string[]
  font: string
}

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    surface: v('--surface'),
    text: v('--text'),
    textH: v('--text-h'),
    accent: v('--accent'),
    ink: v('--lot-ink'),
    lots: Array.from({ length: COLORS }, (_, i) => v(`--lot-${i + 1}`)),
    font: css.fontFamily,
  }
}

const marbleColor = (p: Palette, id: number) => p.lots[id % COLORS]

/** 字太長就截斷，名牌才不會蓋住半個畫面 */
const short = (name: string, max = 6) => (name.length > max ? `${name.slice(0, max - 1)}…` : name)

const isTrackId = (v: unknown): v is string => typeof v === 'string' && TRACKS.some((t) => t.id === v)

export default function MarbleRace({ pool, count, onBusy, onDone }: DrawProps) {
  const [trackId, setTrackId] = useState(() => load('track', TRACKS[0].id, isTrackId))
  const [phase, setPhase] = useState<Phase>('idle')
  const [board, setBoard] = useState<Row[]>([])
  const [arrived, setArrived] = useState(0)
  const [winCount, setWinCount] = useState(0)
  const [speed, setSpeed] = useState<Speed>('normal')

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raceRef = useRef<Race | null>(null)
  const camRef = useRef(0)
  const sizeRef = useRef({ w: 0, h: 0 })
  const paletteRef = useRef<Palette | null>(null)
  const speedRef = useRef<Speed>('normal')
  const rafRef = useRef(0)

  const track = findTrack(trackId)
  const total = pool.length

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const race = raceRef.current
    if (!canvas || !race) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const p = (paletteRef.current ??= readPalette(canvas))
    const { w, h } = sizeRef.current
    if (!w || !h) return
    const dpr = window.devicePixelRatio || 1
    const scale = w / WORLD_W
    const viewH = h / scale
    const top = camRef.current
    const visible = (y1: number, y2: number) => y2 >= top - 20 && y1 <= top + viewH + 20

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = p.surface
    ctx.fillRect(0, 0, w, h)
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, -top * dpr * scale)

    const { track: tr, r } = race

    // 終點線：黑白格
    const sq = 10
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col * sq < WORLD_W; col++) {
        ctx.fillStyle = (row + col) % 2 ? p.textH : p.surface
        ctx.fillRect(col * sq, tr.finishY + row * sq, sq, sq)
      }
    }

    ctx.lineCap = 'round'
    ctx.lineWidth = SEG_R * 2
    ctx.strokeStyle = p.textH
    ctx.beginPath()
    for (const s of tr.segs) {
      if (!visible(Math.min(s.y1, s.y2), Math.max(s.y1, s.y2))) continue
      ctx.moveTo(s.x1, s.y1)
      ctx.lineTo(s.x2, s.y2)
    }
    ctx.stroke()

    ctx.fillStyle = p.text
    ctx.beginPath()
    for (const peg of tr.pegs) {
      if (!visible(peg.y - peg.r, peg.y + peg.r)) continue
      ctx.moveTo(peg.x + peg.r, peg.y)
      ctx.arc(peg.x, peg.y, peg.r, 0, Math.PI * 2)
    }
    ctx.fill()

    const raceTime = Math.max(0, race.t - SETTLE_TIME)
    ctx.strokeStyle = p.accent
    ctx.fillStyle = p.accent
    for (const sp of tr.spinners) {
      if (!visible(sp.y - sp.len, sp.y + sp.len)) continue
      const angle = sp.phase + sp.speed * raceTime
      ctx.beginPath()
      for (let k = 0; k < sp.arms; k++) {
        const a = angle + (k * 2 * Math.PI) / sp.arms
        ctx.moveTo(sp.x, sp.y)
        ctx.lineTo(sp.x + Math.cos(a) * sp.len, sp.y + Math.sin(a) * sp.len)
      }
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2)
      ctx.fill()
    }

    if (!race.gateOpen) {
      ctx.setLineDash([8, 6])
      ctx.beginPath()
      ctx.moveTo(0, GATE_Y)
      ctx.lineTo(WORLD_W, GATE_Y)
      ctx.stroke()
      ctx.setLineDash([])
    }

    const running = race.running()
    const font = Math.max(7, r * 1.15)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `600 ${font}px ${p.font}`
    for (const m of running) {
      if (!visible(m.y - r, m.y + r)) continue
      ctx.fillStyle = marbleColor(p, m.id)
      ctx.beginPath()
      ctx.arc(m.x, m.y, r, 0, Math.PI * 2)
      ctx.fill()
      if (r >= 6) {
        ctx.fillStyle = p.ink
        ctx.fillText(Array.from(m.name)[0] ?? '', m.x, m.y + 0.5)
      }
    }

    // 名牌：人少就全部標，人多只標跑在前面的三顆
    const tagged = running.length <= 12 ? running : [...running].sort((a, b) => b.y - a.y).slice(0, 3)
    ctx.font = `600 11px ${p.font}`
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.strokeStyle = p.surface
    for (const m of tagged) {
      if (!visible(m.y - r - 14, m.y)) continue
      const label = short(m.name)
      ctx.strokeText(label, m.x, m.y - r - 8)
      ctx.fillStyle = p.textH
      ctx.fillText(label, m.x, m.y - r - 8)
    }

    // 倒數
    if (race.t > 0 && race.t < SETTLE_TIME + 0.6) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const text = race.gateOpen ? '衝！' : String(Math.ceil(((SETTLE_TIME - race.t) / SETTLE_TIME) * 3))
      ctx.font = `700 48px ${p.font}`
      ctx.lineWidth = 6
      ctx.strokeStyle = p.surface
      ctx.strokeText(text, w / 2, h / 2)
      ctx.fillStyle = p.accent
      ctx.fillText(text, w / 2, h / 2)
    }
  }, [])

  // 名單或賽道換了就重新擺好起跑位置（比賽結果還在顯示時不動，等下一場）
  useEffect(() => {
    if (phase !== 'idle') return
    const r = marbleRadius(pool.length)
    raceRef.current = new Race(track.build(r), pool, r)
    camRef.current = 0
    draw()
  }, [pool, track, phase, draw])

  // 依容器寬度調整畫布；主題切換時重讀顏色
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ro = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { w: rect.width, h: rect.height }
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      draw()
    })
    ro.observe(canvas)
    const repaint = () => {
      paletteRef.current = null
      draw()
    }
    const mo = new MutationObserver(repaint)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', repaint)
    return () => {
      ro.disconnect()
      mo.disconnect()
      mq.removeEventListener('change', repaint)
    }
  }, [draw])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const snapshot = (race: Race): Row[] => race.standings().map((m: Marble) => ({ id: m.id, name: m.name, rank: m.rank }))

  function start() {
    if (!pool.length) return
    const k = Math.min(count, pool.length)
    const r = marbleRadius(pool.length)
    const race = new Race(track.build(r), pool, r)
    raceRef.current = race
    camRef.current = 0
    changeSpeed('normal')
    setBoard([])
    setArrived(0)
    setWinCount(k)
    setPhase('running')
    onBusy(true)

    let last = performance.now()
    let acc = 0
    let lastBoard = 0
    const frame = (now: number) => {
      const elapsed = Math.min(0.1, (now - last) / 1000)
      last = now
      const speed = speedRef.current
      if (speed === 'instant') {
        // 盡量多算，但每個畫面最多佔 25ms，頁面不會卡住
        const until = performance.now() + 25
        while (!race.over && performance.now() < until) for (let i = 0; i < 40 && !race.over; i++) race.step()
      } else {
        acc += elapsed * (speed === 'fast' ? 4 : 1)
        while (acc >= DT && !race.over) {
          race.step()
          acc -= DT
        }
      }

      // 鏡頭跟著跑最前面的彈珠
      const { w, h } = sizeRef.current
      const viewH = w ? h / (w / WORLD_W) : 0
      const target = race.gateOpen ? race.leaderY() - viewH * 0.55 : 0
      const clamped = Math.max(0, Math.min(race.track.height - viewH, target))
      camRef.current = speed === 'instant' ? clamped : camRef.current + (clamped - camRef.current) * Math.min(1, elapsed * 5)
      draw()

      if (race.over || now - lastBoard > 200) {
        lastBoard = now
        setBoard(snapshot(race))
        setArrived(race.finished.length)
      }
      if (race.over) {
        setPhase('done')
        onBusy(false)
        onDone(race.finished.slice(0, k).map((m): Entry => ({ id: m.id, name: m.name })))
        return
      }
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
  }

  function changeSpeed(s: Speed) {
    speedRef.current = s
    setSpeed(s)
  }

  function pickTrack(id: string) {
    setTrackId(id)
    save('track', id)
    setPhase('idle')
  }

  const running = phase === 'running'
  const shown = phase === 'idle' ? [] : board
  const visibleRows = running ? shown.slice(0, 10) : shown

  return (
    <div className="lot-race">
      <div className="lot-tracks" role="radiogroup" aria-label="賽道">
        {TRACKS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={t.id === trackId}
            className={t.id === trackId ? 'active' : ''}
            onClick={() => pickTrack(t.id)}
            disabled={running}
          >
            <span aria-hidden="true">{t.icon}</span> {t.name}
          </button>
        ))}
      </div>
      <p className="muted">{track.blurb}</p>

      <div className="lot-race-body">
        <div className="lot-race-stage" ref={wrapRef}>
          <canvas ref={canvasRef} className="lot-race-canvas" role="img" aria-label={`${track.name}賽道，${total} 顆彈珠`} />
          <div className="lot-actions">
            {running ? (
              <>
                <button type="button" className="secondary" aria-pressed={speed === 'fast'} onClick={() => changeSpeed(speed === 'fast' ? 'normal' : 'fast')} disabled={speed === 'instant'}>
                  {speed === 'fast' ? '▶ 正常速度' : '⏩ 快轉'}
                </button>
                <button type="button" className="secondary" onClick={() => changeSpeed('instant')} disabled={speed === 'instant'}>
                  直接看結果
                </button>
              </>
            ) : (
              <button type="button" onClick={start} disabled={!total}>
                {phase === 'done' ? '再跑一場' : '開跑'}
              </button>
            )}
          </div>
        </div>

        <div className="lot-board-wrap">
          <h3>{running ? `比賽中 · 已抵達 ${arrived} / ${board.length || total}` : '名次'}</h3>
          {shown.length === 0 ? (
            <p className="muted">按「開跑」，最先衝過終點的前 {Math.min(count, total) || 0} 名中籤。</p>
          ) : (
            <ol className="lot-board" aria-live={running ? 'off' : 'polite'}>
              {visibleRows.map((row, i) => (
                <li key={row.id} className={!running && i < winCount ? 'win' : ''}>
                  <span className="lot-rank">{i + 1}</span>
                  <span className="lot-dot" style={{ background: entryColor(row.id) }} aria-hidden="true" />
                  <span className="lot-board-name">{row.name}</span>
                  {row.rank > 0 && running && <span className="lot-flag">🏁</span>}
                  {!running && i < winCount && <span className="lot-flag">中籤</span>}
                </li>
              ))}
            </ol>
          )}
          {running && shown.length > visibleRows.length && <p className="muted">還有 {shown.length - visibleRows.length} 顆…</p>}
        </div>
      </div>
    </div>
  )
}
