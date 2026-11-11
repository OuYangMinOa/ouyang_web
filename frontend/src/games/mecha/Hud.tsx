import { useEffect, useMemo, useRef } from 'react'
import type { HudFrame } from './game'
import { BASE, MAP_X, MAP_Z, RIVER, type MapData, type Team } from './map'
import { DRONE, MECH, MECHS, SHELL, teamClass, type MechKind } from './spec'

/**
 * 每一格的儀表：準星、狙擊鏡、偵察機的畫面、血量、能量、彈藥、飛彈、偵察機、變身的狀態、迫擊砲的落點距離、砲擊警告、
 * 鎖定框、小地圖、名牌（被偵察機標記的敵人多一個記號）。全部直接改 DOM，不經過 React
 */

export type HudSeat = { name: string; team: Team }

const RADAR_STATE = ['hidden', 'ally', 'enemy', 'me', 'spotted'] as const

/** 小地圖上偵察機的掃描範圍：半徑 1、朝 +y（往南，方向角 0）的扇形，再照鏡頭方向轉、照看得多遠放大 */
const WEDGE = (() => {
  const a = (DRONE.viewH * Math.PI) / 180
  const x = Math.sin(a).toFixed(3)
  const y = Math.cos(a).toFixed(3)
  return `M0 0 L-${x} ${y} A1 1 0 0 0 ${x} ${y} Z`
})()

/** 偵察機訊號差時的雜訊畫面：小張的畫布拉滿整個畫面（一格一格的雜訊） */
const STATIC_W = 160
const STATIC_H = 100
let staticData: ImageData | null = null

/** 畫一格雜訊：`noise` 越大越不透明（一開始慢慢多，快斷的時候很快糊掉）、橫的干擾條越多；0 就不畫 */
function paintStatic(canvas: HTMLCanvasElement | null, noise: number) {
  if (!canvas) return
  const on = noise > 0.01
  canvas.style.opacity = on ? String(Math.min(1, 0.05 + noise ** 1.4)) : '0'
  if (!on) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  if (!staticData) staticData = ctx.createImageData(STATIC_W, STATIC_H)
  const px = staticData.data
  // 橫的干擾條：雜訊越多越常出現、越亮
  let band = -1
  let bandEnd = -1
  for (let y = 0; y < STATIC_H; y++) {
    if (y > bandEnd && Math.random() < noise * 0.06) {
      band = y
      bandEnd = y + 1 + Math.floor(Math.random() * 4)
    }
    const lift = y >= band && y <= bandEnd ? 70 : 0
    for (let x = 0; x < STATIC_W; x++) {
      const v = Math.min(255, Math.random() * 200 + lift)
      const i = (y * STATIC_W + x) * 4
      px[i] = v
      px[i + 1] = v
      px[i + 2] = v
      px[i + 3] = 255
    }
  }
  ctx.putImageData(staticData, 0, 0)
}

export function Hud({
  register,
  map,
  seats,
  me,
  kind,
  touch,
}: {
  /** 登記每一格要呼叫的函式（index.tsx 把遊戲的每一格交過來），回傳取消登記 */
  register: (draw: ((f: HudFrame) => void) | null) => void
  map: MapData | null
  seats: HudSeat[]
  /** 自己（或觀戰時鏡頭跟著的人）是哪一隊、開哪一種機甲 */
  me: Team
  kind: MechKind
  /** 觸控版面（偵察機的操作說明不一樣） */
  touch: boolean
}) {
  const spec = MECHS[kind]
  const hpRef = useRef<HTMLDivElement>(null)
  const hpText = useRef<HTMLSpanElement>(null)
  const energyRef = useRef<HTMLDivElement>(null)
  const ammoText = useRef<HTMLSpanElement>(null)
  const magText = useRef<HTMLSpanElement>(null)
  const modeRef = useRef<HTMLDivElement>(null)
  const mortarRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const reloadRef = useRef<HTMLDivElement>(null)
  const missileRefs = useRef<(HTMLSpanElement | null)[]>([])
  const rackRefs = useRef<(HTMLSpanElement | null)[]>([])
  const rackRef = useRef<HTMLDivElement>(null)
  const flightRef = useRef<HTMLDivElement>(null)
  const farText = useRef<HTMLSpanElement>(null)
  const signalRef = useRef<HTMLSpanElement>(null)
  const droneHpRef = useRef<HTMLSpanElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const reachText = useRef<HTMLSpanElement>(null)
  const staticRef = useRef<HTMLCanvasElement>(null)
  const signalMsg = useRef<HTMLDivElement>(null)
  const wedgeRefs = useRef<(SVGPathElement | null)[]>([])
  const scannedRef = useRef<HTMLDivElement>(null)
  const droneRefs = useRef<(SVGGElement | null)[]>([])
  const crossRef = useRef<HTMLDivElement>(null)
  const scopeRef = useRef<HTMLDivElement>(null)
  const rangeRef = useRef<HTMLSpanElement>(null)
  const hitRef = useRef<HTMLDivElement>(null)
  const lockRef = useRef<HTMLDivElement>(null)
  const warnRef = useRef<HTMLDivElement>(null)
  const safeRef = useRef<HTMLDivElement>(null)
  const hurtRef = useRef<HTMLDivElement>(null)
  const arrowRef = useRef<HTMLDivElement>(null)
  const dotRefs = useRef<(SVGGElement | null)[]>([])
  const labelRefs = useRef<(HTMLDivElement | null)[]>([])
  const barRefs = useRef<(HTMLSpanElement | null)[]>([])
  const last = useRef({ hp: -1, ammo: -1, mag: -1, missiles: -1, reload: -2, range: -1, rack: -1, far: -1, reach: -1, signal: '', mortar: '' })

  useEffect(() => {
    // 換了機甲（觀戰換人）：每一格都重畫
    last.current = { hp: -1, ammo: -1, mag: -1, missiles: -1, reload: -2, range: -1, rack: -1, far: -1, reach: -1, signal: '', mortar: '' }
    register((f) => {
      const now = performance.now()
      const l = last.current
      if (f.hp !== l.hp) {
        l.hp = f.hp
        if (hpRef.current) hpRef.current.style.width = `${(Math.max(0, f.hp) / spec.hp) * 100}%`
        if (hpRef.current) hpRef.current.dataset.low = String(f.hp < spec.hp * 0.3)
        if (hpText.current) hpText.current.textContent = String(Math.max(0, Math.round(f.hp)))
      }
      if (energyRef.current) {
        energyRef.current.style.width = `${f.energy * 100}%`
        energyRef.current.dataset.drained = String(f.drained)
      }
      if (f.ammo !== l.ammo || (f.reload >= 0) !== (l.reload >= 0)) {
        l.ammo = f.ammo
        if (ammoText.current) ammoText.current.textContent = f.reload >= 0 ? '換彈' : String(f.ammo)
      }
      if (f.magazine !== l.mag) {
        l.mag = f.magazine
        if (magText.current) magText.current.textContent = `/ ${f.magazine}`
      }
      if (reloadRef.current) reloadRef.current.style.width = `${f.reload >= 0 ? f.reload * 100 : (f.ammo / Math.max(1, f.magazine)) * 100}%`
      l.reload = f.reload
      if (modeRef.current) modeRef.current.dataset.state = String(f.deploy)
      // 迫擊砲的落點：多遠、要飛幾秒；超出射程改打最遠那一點，太近打不到
      const m = f.mortar
      const mortar = !m || !f.alive ? '' : m.state === 'near' ? `太近了：要 ${SHELL.min} m 以外` : `${m.state === 'far' ? '最遠 ' : ''}${Math.round(m.range)} m・飛 ${m.time.toFixed(1)} 秒`
      if (mortar !== l.mortar) {
        l.mortar = mortar
        if (mortarRef.current) {
          mortarRef.current.textContent = mortar
          mortarRef.current.dataset.on = String(mortar !== '')
          mortarRef.current.dataset.state = m?.state ?? 'ok'
        }
      }
      if (shellRef.current) shellRef.current.dataset.on = String(f.shelled && f.alive)
      if (f.missiles !== l.missiles) {
        l.missiles = f.missiles
        missileRefs.current.forEach((el, i) => el && (el.dataset.on = String(i < f.missiles)))
      }
      if (f.rack !== l.rack) {
        l.rack = f.rack
        rackRefs.current.forEach((el, i) => el && (el.dataset.on = String(i < f.rack)))
      }
      // 偵察機的畫面：訊號（離機甲越遠雜訊越多）、掃描範圍；停在原地時武器欄寫「偵測中」
      const flight = f.flight
      if (flightRef.current) flightRef.current.dataset.on = String(flight !== null && f.alive)
      if (rackRef.current) rackRef.current.dataset.out = String(f.parked && f.alive)
      if (flight) {
        const noise = flight.noise
        if (signalRef.current) {
          signalRef.current.style.width = `${(1 - noise) * 100}%`
          signalRef.current.dataset.low = String(noise > 0.5)
        }
        if (frameRef.current) {
          frameRef.current.style.setProperty('--fw', flight.fw.toFixed(3))
          frameRef.current.style.setProperty('--fh', flight.fh.toFixed(3))
        }
        const reach = Math.round(flight.reach)
        if (reach !== l.reach) {
          l.reach = reach
          if (reachText.current) reachText.current.textContent = reach > 0 ? `掃描範圍 ${reach} m` : '掃描不到'
        }
        const signal = noise >= 1 ? 'lost' : noise > 0.35 ? 'weak' : 'ok'
        if (signal !== l.signal) {
          l.signal = signal
          if (signalMsg.current) signalMsg.current.dataset.state = signal
        }
        paintStatic(staticRef.current, noise)
        if (droneHpRef.current) {
          droneHpRef.current.style.width = `${flight.hp * 100}%`
          droneHpRef.current.dataset.low = String(flight.hp < 0.4)
        }
        const far = Math.round(flight.far)
        if (far !== l.far) {
          l.far = far
          if (farText.current) farText.current.textContent = `${far} m`
        }
      }
      if (scannedRef.current) scannedRef.current.dataset.on = String(f.scanned)
      if (crossRef.current) {
        crossRef.current.style.setProperty('--spread', String(f.spread))
        crossRef.current.dataset.hidden = String(!f.alive || f.zoom > 0.98 || flight !== null)
        crossRef.current.dataset.zoom = String(f.zoom > 0.5)
        crossRef.current.dataset.scope = String(f.scope)
      }
      if (scopeRef.current) scopeRef.current.dataset.on = String(f.scope && f.alive)
      const range = f.scope ? Math.round(f.range) : -1
      if (range !== l.range) {
        l.range = range
        if (rangeRef.current) rangeRef.current.textContent = range >= 0 ? `${range} m` : ''
      }
      if (hitRef.current) hitRef.current.dataset.on = String(now - f.hitAt < 160)
      if (lockRef.current) {
        const lk = f.lock
        lockRef.current.dataset.state = lk ? (lk.done ? 'locked' : 'locking') : 'none'
        if (lk) {
          lockRef.current.style.left = `${lk.x * 100}%`
          lockRef.current.style.top = `${lk.y * 100}%`
          lockRef.current.style.setProperty('--lock', String(1 - lk.progress))
        }
      }
      if (warnRef.current) warnRef.current.dataset.on = String(f.warn && f.alive)
      if (safeRef.current) safeRef.current.dataset.on = String(f.safe && f.alive && f.clock > 0)
      const hurt = Math.max(0, 1 - (now - f.hurtAt) / 700)
      if (hurtRef.current) hurtRef.current.style.opacity = String(hurt * 0.8 + (f.alive && f.hp < spec.hp * 0.3 ? 0.25 : 0))
      if (arrowRef.current) {
        arrowRef.current.style.opacity = String(hurt)
        arrowRef.current.style.transform = `translate(-50%, -50%) rotate(${(-f.hurtDir * 180) / Math.PI}deg)`
      }
      for (let i = 0; i < dotRefs.current.length; i++) {
        const dot = dotRefs.current[i]
        if (!dot) continue
        const state = f.radar[i * 4 + 3]
        dot.dataset.state = RADAR_STATE[state] ?? 'hidden'
        if (state > 0) {
          const deg = (-f.radar[i * 4 + 2] * 180) / Math.PI
          dot.setAttribute('transform', `translate(${f.radar[i * 4].toFixed(1)} ${f.radar[i * 4 + 1].toFixed(1)}) rotate(${deg.toFixed(0)}) scale(1.8)`)
        }
      }
      for (let i = 0; i < droneRefs.current.length; i++) {
        const g = droneRefs.current[i]
        if (!g) continue
        const on = f.drones[i * 5 + 2] > 0
        g.dataset.on = String(on)
        if (!on) continue
        g.setAttribute('transform', `translate(${f.drones[i * 5].toFixed(1)} ${f.drones[i * 5 + 1].toFixed(1)})`)
        // 掃描範圍：鏡頭前面的扇形，訊號差就縮短
        const wedge = wedgeRefs.current[i]
        if (wedge) {
          const reach = f.drones[i * 5 + 4]
          wedge.dataset.on = String(reach > 1)
          const deg = (-f.drones[i * 5 + 3] * 180) / Math.PI
          wedge.setAttribute('transform', `rotate(${deg.toFixed(0)}) scale(${Math.max(1, reach).toFixed(1)})`)
        }
      }
      for (let i = 0; i < labelRefs.current.length; i++) {
        const el = labelRefs.current[i]
        if (!el) continue
        const show = f.labels[i * 4 + 2] > 0
        el.dataset.on = String(show)
        el.dataset.spotted = String(f.labels[i * 4 + 2] === 2)
        if (show) {
          el.style.left = `${(f.labels[i * 4] * 100).toFixed(2)}%`
          el.style.top = `${(f.labels[i * 4 + 1] * 100).toFixed(2)}%`
          const bar = barRefs.current[i]
          if (bar) bar.style.width = `${f.labels[i * 4 + 3] * 100}%`
        }
      }
    })
    return () => register(null)
  }, [register, spec])

  // 小地圖的底圖：大樓、河、橋（高架的路、坡道、墊高的公園、走得進去的大樓的樓板）和兩邊的重生點，只畫一次
  const blocks = useMemo(() => {
    const solid = new Set(['building', 'tower', 'house', 'warehouse', 'hangar', 'facade'])
    const rect = (b: { x0: number; x1: number; z0: number; z1: number }) => ({ x: b.x0, y: b.z0, w: b.x1 - b.x0, h: b.z1 - b.z0 })
    return {
      solid: map?.boxes.filter((b) => b.y0 === 0 && solid.has(b.kind)).map(rect) ?? [],
      bridges: map?.boxes.filter((b) => b.kind === 'deck' || b.kind === 'ramp' || b.kind === 'mound' || b.kind === 'floor').map(rect) ?? [],
    }
  }, [map])

  return (
    <>
      <div className="mecha-hurt" ref={hurtRef} aria-hidden="true" />
      <div className="mecha-hurt-arrow" ref={arrowRef} aria-hidden="true" />
      <div className="mecha-labels" aria-hidden="true">
        {seats.map((s, i) => (
          <div
            key={i}
            className={`mecha-label ${teamClass(s.team)}${s.team === me ? ' ally' : ''}`}
            ref={(el) => {
              labelRefs.current[i] = el
            }}
            data-on="false"
          >
            <span className="mecha-label-mark">◆ 偵測到</span>
            <span className="mecha-label-name">{s.name}</span>
            <span className="mecha-label-bar">
              <span
                ref={(el) => {
                  barRefs.current[i] = el
                }}
              />
            </span>
          </div>
        ))}
      </div>
      <div className="mecha-scope" ref={scopeRef} data-on="false" aria-hidden="true">
        <div className="mecha-scope-ring">
          <span className="mecha-scope-h" />
          <span className="mecha-scope-v" />
          <span className="mecha-scope-range" ref={rangeRef} />
        </div>
      </div>
      <div className="mecha-flight" ref={flightRef} data-on="false" aria-hidden="true">
        <canvas className="mecha-static" ref={staticRef} width={STATIC_W} height={STATIC_H} />
        <div className="mecha-flight-frame" ref={frameRef}>
          <span ref={reachText} />
        </div>
        <div className="mecha-flight-reticle" />
        <div className="mecha-flight-signal" ref={signalMsg} data-state="ok">
          <span className="weak">
            訊號變弱<em>：畫面越來越糊，看得到的距離變短</em>
          </span>
          <span className="lost">
            訊號中斷<em>：往回飛一點才看得到</em>
          </span>
        </div>
        <div className="mecha-flight-info mecha-chip">
          <strong>偵察機</strong>
          <span className="mecha-flight-row">
            機身
            <span className="mecha-bar flight">
              <span ref={droneHpRef} data-low="false" />
            </span>
            <span />
          </span>
          <span className="mecha-flight-row">
            訊號
            <span className="mecha-bar flight">
              <span ref={signalRef} data-low="false" />
            </span>
            <span ref={farText} className="mecha-flight-secs" />
          </span>
        </div>
        <div className="mecha-flight-hint mecha-chip">
          {touch
            ? '框裡看得到的敵人才掃得到。「上升」「下降」調高度，「引爆」炸掉偵察機；「回到機甲」讓它停在原地繼續偵測'
            : '框裡看得到的敵人才掃得到。WASD 移動、滑鼠轉方向，空白鍵上升、Shift 下降；左鍵引爆，E 回到機甲（停在原地，鏡頭朝同一個方向繼續偵測）'}
        </div>
      </div>
      <div className="mecha-scanned" ref={scannedRef} data-on="false" role="status">
        ◉ 被敵人的偵察機掃到了
      </div>
      <div className="mecha-shelled" ref={shellRef} data-on="false" role="alert">
        ⚠ 砲擊來襲！離開紅圈
      </div>
      <div className="mecha-mortar" ref={mortarRef} data-on="false" aria-live="off" />
      <div className="mecha-cross" ref={crossRef} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <i />
      </div>
      <div className="mecha-hit" ref={hitRef} data-on="false" aria-hidden="true" />
      <div className="mecha-lock" ref={lockRef} data-state="none" aria-hidden="true">
        <span>LOCK</span>
      </div>
      <div className="mecha-warn" ref={warnRef} data-on="false" role="alert">
        ⚠ 飛彈鎖定！
      </div>
      <div className="mecha-safe" ref={safeRef} data-on="false">
        重生點：敵人打不到你，你也不能開火
      </div>

      <div className="mecha-chip mecha-vitals" aria-label="機體狀態">
        <div className="mecha-bar-row">
          <span className="mecha-bar-label">耐久</span>
          <div className="mecha-bar hp">
            <div ref={hpRef} data-low="false" />
          </div>
          <span className="mecha-bar-value" ref={hpText}>
            {spec.hp}
          </span>
        </div>
        <div className="mecha-bar-row">
          <span className="mecha-bar-label">{spec.jets ? '推進' : '能量'}</span>
          <div className="mecha-bar energy">
            <div ref={energyRef} data-drained="false" />
          </div>
        </div>
      </div>

      <div className="mecha-chip mecha-arms" aria-label="武器">
        <div className="mecha-ammo">
          <span className="mecha-ammo-value" ref={ammoText}>
            {spec.magazine}
          </span>
          <span className="mecha-ammo-unit" ref={magText}>
            / {spec.magazine}
          </span>
        </div>
        <div className="mecha-bar ammo">
          <div ref={reloadRef} />
        </div>
        <div className="mecha-missiles" aria-label="飛彈">
          {Array.from({ length: MECH.missiles }, (_, i) => (
            <span
              key={i}
              ref={(el) => {
                missileRefs.current[i] = el
              }}
              data-on="true"
            />
          ))}
          <em>飛彈</em>
        </div>
        {spec.deploy && (
          <div className="mecha-mode" ref={modeRef} data-state="0" aria-label="變身">
            <span className="s0">{touch ? `按「${spec.deploy.verb}」` : `E ${spec.deploy.verb}`}</span>
            <span className="s1">{spec.deploy.verb}中…</span>
            <strong className="s2">
              {spec.deploy.name}
              {touch ? '' : '・E 收回'}
            </strong>
            <span className="s3">收回中…</span>
          </div>
        )}
        {spec.drones > 0 && (
          <div className="mecha-missiles mecha-rack" ref={rackRef} data-out="false" aria-label="偵察機">
            {Array.from({ length: spec.drones }, (_, i) => (
              <span
                key={i}
                ref={(el) => {
                  rackRefs.current[i] = el
                }}
                data-on="true"
              />
            ))}
            <em>{touch ? '偵察機' : '偵察機 E'}</em>
            <strong className="mecha-rack-live">偵測中</strong>
          </div>
        )}
      </div>

      {map && (
        <svg
          className="mecha-chip mecha-radar"
          viewBox={`${-MAP_X} ${-MAP_Z} ${MAP_X * 2} ${MAP_Z * 2}`}
          aria-hidden="true"
        >
          <rect className="mecha-radar-river" x={-RIVER} y={-MAP_Z} width={RIVER * 2} height={MAP_Z * 2} />
          {blocks.bridges.map((b, i) => (
            <rect key={i} className="mecha-radar-bridge" x={b.x} y={b.y} width={b.w} height={b.h} />
          ))}
          <rect className="mecha-radar-base red" x={-MAP_X} y={-BASE.z} width={MAP_X - BASE.x} height={BASE.z * 2} />
          <rect className="mecha-radar-base blue" x={BASE.x} y={-BASE.z} width={MAP_X - BASE.x} height={BASE.z * 2} />
          {blocks.solid.map((b, i) => (
            <rect key={i} className="mecha-radar-block" x={b.x} y={b.y} width={b.w} height={b.h} />
          ))}
          {seats.map((s, i) => (
            <g
              key={i}
              ref={(el) => {
                dotRefs.current[i] = el
              }}
              className={`mecha-radar-dot ${teamClass(s.team)}`}
              data-state="hidden"
            >
              <circle className="mecha-radar-ping" r="13" />
              <path d="M0 12 L8 -7 L0 -3 L-8 -7 Z" />
            </g>
          ))}
          {seats.map((s, i) => (
            <g
              key={`d${i}`}
              ref={(el) => {
                droneRefs.current[i] = el
              }}
              className={`mecha-radar-drone ${teamClass(s.team)}`}
              data-on="false"
            >
              <path
                className="scan"
                d={WEDGE}
                ref={(el) => {
                  wedgeRefs.current[i] = el
                }}
                data-on="false"
              />
              <rect x="-5" y="-5" width="10" height="10" transform="rotate(45)" />
            </g>
          ))}
        </svg>
      )}
    </>
  )
}
