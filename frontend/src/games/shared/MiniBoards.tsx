import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { stars } from './badges'
import { drawMinis, miniAt, miniLayout, type MiniInfo, type MiniPalette, type MiniShape } from './minis'
import type { ArenaPlayer } from './useArena'

/** 從 CSS 變數讀盤面的顏色，切換主題（手動或跟隨系統）時重讀 */
function usePalette(readPalette: () => MiniPalette): MiniPalette {
  const [palette, setPalette] = useState(readPalette)
  useEffect(() => {
    const refresh = () => setPalette(readPalette())
    const mo = new MutationObserver(refresh)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', refresh)
    return () => {
      mo.disconnect()
      mq.removeEventListener('change', refresh)
    }
  }, [readPalette])
  return palette
}

/**
 * 其他玩家的小盤面，全部畫在同一張 canvas 上（最多 98 個）。`readPalette` 從 CSS 變數讀顏色，主題切換時重讀。
 * `fill`：塞滿容器的高度（桌機放在主盤面兩側）；否則用固定大小往下排（手機放在主盤面下面）。
 */
export function MiniBoards({
  minis,
  boards,
  version,
  fill,
  shape,
  readPalette,
  onPick,
  label,
}: {
  minis: MiniInfo[]
  boards: Map<number, string>
  /** 盤面有更新時會變，用來觸發重畫 */
  version: number
  fill: boolean
  shape: MiniShape
  readPalette: () => MiniPalette
  onPick?: (pid: number) => void
  label: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const palette = usePalette(readPalette)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = useMemo(
    () => miniLayout(box.width, minis.length, fill ? box.height : null),
    [box.width, box.height, minis.length, fill],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || box.width === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(box.width * dpr)
    canvas.height = Math.round(Math.max(layout.height, 1) * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawMinis(ctx, box.width, layout, minis, boards, shape, palette)
  }, [box.width, layout, minis, boards, version, shape, palette])

  function pick(e: PointerEvent<HTMLCanvasElement>) {
    if (!onPick) return
    const rect = e.currentTarget.getBoundingClientRect()
    const i = miniAt(layout, minis.length, e.clientX - rect.left, e.clientY - rect.top)
    if (i >= 0) onPick(minis[i].pid)
  }

  return (
    <div ref={boxRef} className={`arena-minis${fill ? ' fill' : ''}`}>
      <canvas
        ref={canvasRef}
        className="arena-minis-canvas"
        style={{ height: layout.height }}
        onPointerDown={pick}
        aria-label={label}
      />
    </div>
  )
}

/**
 * 觀戰時上場的人的盤面：每個人一張放大的盤面，下面是名字、KO 數和徽章（出局的蓋上名次）。
 * 人少時（朋友 PK）盤面很大，人多時自動縮小排滿。
 */
export function WatchBoards({
  players,
  boards,
  version,
  shape,
  readPalette,
}: {
  players: ArenaPlayer[]
  boards: Map<number, string>
  version: number
  shape: MiniShape
  readPalette: () => MiniPalette
}) {
  const palette = usePalette(readPalette)
  // 人數寫進 --n：整排的寬度上限照人數算，人少時盤面大、置中
  return (
    <ul className="arena-watch" style={{ '--n': players.length } as CSSProperties} aria-label="上場的人">
      {players.map((p) => (
        <WatchBoard key={p.pid} player={p} boards={boards} version={version} shape={shape} palette={palette} />
      ))}
    </ul>
  )
}

function WatchBoard({
  player,
  boards,
  version,
  shape,
  palette,
}: {
  player: ArenaPlayer
  boards: Map<number, string>
  version: number
  shape: MiniShape
  palette: MiniPalette
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const { pid, alive, place } = player

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || width === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(width * 2 * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const mini: MiniInfo = { pid, alive, place, targeted: false, attacker: false, waiting: false }
    drawMinis(ctx, width, { cols: 1, size: width, gap: 0, height: width * 2 }, [mini], boards, shape, palette)
  }, [width, pid, alive, place, boards, version, shape, palette])

  return (
    <li className={alive ? '' : 'out'}>
      <canvas ref={canvasRef} className="arena-watch-canvas" aria-label={`${player.name} 的盤面`} />
      <span className="arena-watch-name">
        <strong>{player.name}</strong>
        {!player.online && <span className="chip subtle">離線</span>}
      </span>
      <span className="arena-watch-stats">
        {alive || place === null ? `KO ${player.kos}` : `第 ${place} 名 · KO ${player.kos}`} ·{' '}
        <span className="arena-stars">{stars(player.badges)}</span>
      </span>
    </li>
  )
}
