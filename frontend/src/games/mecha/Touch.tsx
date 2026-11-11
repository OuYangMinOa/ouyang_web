import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { DroneMode, MechGame } from './game'
import type { TouchState } from './input'
import { MECHS, type MechKind } from './spec'

/**
 * 手機觸控：左下是移動的搖桿（從按下去的地方算），右半邊拖曳瞄準；
 * 右下的按鈕：開火（按著也能拖曳瞄準）、瞄準（按一下放大、再按一下收回；狙擊型是狙擊鏡）、衝刺（沒有推進器的是快跑）、
 * 跳躍（按住往上飛）、飛彈、換彈；偵察型多一顆「偵察機」，堡壘型、砲擊型多一顆「變身」「架砲」（變身後是「收回」，衝刺和跳躍收起來）。
 * 操控偵察機時（`drone` 是 fly）：搖桿和拖曳照樣用，開火變成引爆、「偵察機」變成回到機甲、跳躍和衝刺變成上升和下降，其他按鈕收起來；
 * 偵察機停在原地時（parked）按鈕和平常一樣，「偵察機」變成回去操控。
 */
export function TouchControls({ game, kind, drone, deployed }: { game: MechGame | null; kind: MechKind; drone: DroneMode; deployed: boolean }) {
  const spec = MECHS[kind]
  const flying = drone === 'fly'
  const dep = spec.deploy
  const stick = useRef<{ id: number; x: number; y: number } | null>(null)
  const look = useRef<Map<number, { x: number; y: number }>>(new Map())
  const [knob, setKnob] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null)
  const [held, setHeld] = useState<Record<string, boolean>>({})
  const [zoom, setZoom] = useState(false)

  const set = (patch: Partial<TouchState>) => game?.setTouch(patch)

  // 按鈕收起來（倒下、打開選單）時把放大瞄準關掉，不然復活後還開著、按鈕卻是關的
  useEffect(() => () => game?.setTouch({ zoom: false }), [game])

  function stickDown(e: PointerEvent<HTMLDivElement>) {
    if (stick.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    stick.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    setKnob({ x: e.clientX, y: e.clientY, dx: 0, dy: 0 })
  }
  function stickMove(e: PointerEvent<HTMLDivElement>) {
    const s = stick.current
    if (!s || s.id !== e.pointerId) return
    const r = 50
    let dx = e.clientX - s.x
    let dy = e.clientY - s.y
    const len = Math.hypot(dx, dy)
    if (len > r) {
      dx = (dx / len) * r
      dy = (dy / len) * r
    }
    set({ moveX: dx / r, moveY: -dy / r })
    setKnob({ x: s.x, y: s.y, dx, dy })
  }
  function stickUp(e: PointerEvent<HTMLDivElement>) {
    if (stick.current?.id !== e.pointerId) return
    stick.current = null
    set({ moveX: 0, moveY: 0 })
    setKnob(null)
  }

  function lookDown(e: PointerEvent<HTMLElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    look.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  function lookMove(e: PointerEvent<HTMLElement>) {
    const last = look.current.get(e.pointerId)
    if (!last) return
    game?.touchLook(e.clientX - last.x, e.clientY - last.y)
    look.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  function lookUp(e: PointerEvent<HTMLElement>) {
    look.current.delete(e.pointerId)
  }

  /** 按住的按鈕；開火鍵按著也能拖曳瞄準 */
  function hold(key: 'fire' | 'boost' | 'jump') {
    return {
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
        e.stopPropagation()
        if (key === 'fire') lookDown(e)
        else e.currentTarget.setPointerCapture(e.pointerId)
        set({ [key]: true })
        setHeld((h) => ({ ...h, [key]: true }))
      },
      onPointerMove: key === 'fire' ? lookMove : undefined,
      onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
        if (key === 'fire') lookUp(e)
        set({ [key]: false })
        setHeld((h) => ({ ...h, [key]: false }))
      },
      onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => {
        if (key === 'fire') lookUp(e)
        set({ [key]: false })
        setHeld((h) => ({ ...h, [key]: false }))
      },
    }
  }

  return (
    <div className="mecha-touch">
      <div className="mecha-touch-move" onPointerDown={stickDown} onPointerMove={stickMove} onPointerUp={stickUp} onPointerCancel={stickUp}>
        {knob ? (
          <span className="mecha-stick" style={{ left: knob.x, top: knob.y }}>
            <span style={{ transform: `translate(${knob.dx}px, ${knob.dy}px)` }} />
          </span>
        ) : (
          <span className="mecha-stick-hint">移動</span>
        )}
      </div>
      <div className="mecha-touch-look" onPointerDown={lookDown} onPointerMove={lookMove} onPointerUp={lookUp} onPointerCancel={lookUp} />
      <div className="mecha-touch-buttons">
        <button type="button" className={`mecha-btn fire${held.fire ? ' on' : ''}${flying ? ' boom' : ''}`} {...hold('fire')}>
          {flying ? '引爆' : '開火'}
        </button>
        {spec.drones > 0 && (
          <button
            type="button"
            className={`mecha-btn drone${drone !== 'none' ? ' on' : ''}`}
            onPointerDown={(e) => {
              e.stopPropagation()
              game?.press('ability')
            }}
          >
            {flying ? '回到機甲' : drone === 'parked' ? '操控偵察機' : '偵察機'}
          </button>
        )}
        {dep && (
          <button
            type="button"
            className={`mecha-btn drone${deployed ? ' on' : ''}`}
            aria-pressed={deployed}
            onPointerDown={(e) => {
              e.stopPropagation()
              game?.press('ability')
            }}
          >
            {deployed ? '收回' : dep.verb}
          </button>
        )}
        {!flying && (
          <button
            type="button"
            className={`mecha-btn zoom${zoom ? ' on' : ''}`}
            aria-pressed={zoom}
            onPointerDown={(e) => {
              e.stopPropagation()
              set({ zoom: !zoom })
              setZoom(!zoom)
            }}
          >
            {kind === 'sniper' ? '狙擊鏡' : '瞄準'}
          </button>
        )}
        {!deployed && (
          <button type="button" className={`mecha-btn boost${held.boost ? ' on' : ''}`} {...hold('boost')}>
            {flying ? '下降' : spec.jets ? '衝刺' : '快跑'}
          </button>
        )}
        {!deployed && (
          <button type="button" className={`mecha-btn jump${held.jump ? ' on' : ''}`} {...hold('jump')}>
            {flying ? '上升' : '跳躍'}
          </button>
        )}
        {!flying && (
          <button
            type="button"
            className="mecha-btn missile"
            onPointerDown={(e) => {
              e.stopPropagation()
              game?.press('missile')
            }}
          >
            飛彈
          </button>
        )}
        {!flying && (
          <button
            type="button"
            className="mecha-btn reload"
            onPointerDown={(e) => {
              e.stopPropagation()
              game?.press('reload')
            }}
          >
            換彈
          </button>
        )}
      </div>
    </div>
  )
}
