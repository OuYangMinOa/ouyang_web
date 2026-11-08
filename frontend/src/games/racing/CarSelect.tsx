import { useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { carProfile } from './car'
import { hexColor } from './format'
import type { Rect } from './game'
import { CAR_COLORS, carSpec, CARS, STAT_NAMES, type CarKind } from './spec'

/** 側面剪影：用選好的車色畫，看得出每種車的外型和大小差多少 */
export function CarSilhouette({ kind, color }: { kind: CarKind; color: number }) {
  const p = carProfile(kind)
  return (
    <svg
      className="race-car-svg"
      viewBox="-2.55 -1.62 5.1 1.72"
      aria-hidden="true"
      style={{ '--car': hexColor(color) } as CSSProperties}
    >
      <path d={p.body} className="race-car-body" />
      <path d={p.cabin} className="race-car-glass" />
      {p.wing && <path d={p.wing} className="race-car-trim" />}
      {p.wheels.map((w) => (
        <circle key={w.x} cx={w.x} cy={-w.r} r={w.r} className="race-car-wheel" />
      ))}
    </svg>
  )
}

/**
 * 選車畫面（單人和線上共用）：左邊（窄螢幕在下面）只有車種和車色，右邊是 3D 預覽。
 * 預覽就是後面的遊戲畫面：`onStage` 告訴遊戲車子要畫在哪一塊，選到的車停在起跑線上、鏡頭繞著轉。
 * 車色是 `CAR_COLORS` 的第幾個；`taken` 是別人選走的（第幾個 → 誰選的），那些不能選。
 * `status` 放在預覽上方（線上的大家選好了沒有），`actions` 是面板底部的按鈕
 */
export function CarSelect({
  title,
  subtitle,
  car,
  color,
  onCar,
  onColor,
  onStage,
  taken,
  disabled = false,
  status,
  note,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  car: CarKind
  color: number
  onCar: (car: CarKind) => void
  onColor: (color: number) => void
  onStage: (rect: Rect | null) => void
  taken?: Map<number, string>
  disabled?: boolean
  status?: ReactNode
  note?: ReactNode
  actions: ReactNode
}) {
  const id = useId()
  const stageRef = useRef<HTMLDivElement>(null)
  const spec = carSpec(car)
  const hex = CAR_COLORS[color]?.hex ?? CAR_COLORS[0].hex

  // 預覽那一塊的位置和大小變了（轉向、面板變高）就告訴遊戲
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      const root = el.closest('.race-root')?.getBoundingClientRect()
      onStage({ x: r.left - (root?.left ?? 0), y: r.top - (root?.top ?? 0), w: r.width, h: r.height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      onStage(null)
    }
  }, [onStage])

  return (
    <div className="race-layer race-select">
      <div className="race-select-stage">
        {status}
        <div className="race-select-car" ref={stageRef} />
        <div className="race-chip race-select-info">
          <h3>{spec.name}</h3>
          <p className="race-select-blurb">{spec.blurb}</p>
          <dl className="race-stats">
            {STAT_NAMES.map((s) => (
              <div key={s.key}>
                <dt>{s.label}</dt>
                <dd>
                  <span
                    className="race-stat"
                    role="meter"
                    aria-valuemin={1}
                    aria-valuemax={5}
                    aria-valuenow={spec.stats[s.key]}
                    aria-label={`${s.label} ${spec.stats[s.key]} / 5`}
                    style={{ '--v': spec.stats[s.key] / 5 } as CSSProperties}
                  />
                </dd>
              </div>
            ))}
          </dl>
          <p className="race-stats-note">重的車撞人比較有利，輕的容易被撞開。</p>
        </div>
      </div>

      <section className="race-panel race-select-panel" aria-labelledby={`${id}-title`}>
        <div className="race-select-head">
          <h2 id={`${id}-title`}>{title}</h2>
          {subtitle && <p className="race-help">{subtitle}</p>}
        </div>
        {note}
        <div className="segmented-field">
          <span className="segmented-label" id={`${id}-car`}>
            車型
          </span>
          <div className="race-cars" role="radiogroup" aria-labelledby={`${id}-car`}>
            {CARS.map((c) => (
              <button
                key={c.kind}
                type="button"
                role="radio"
                aria-checked={c.kind === car}
                className="race-car-option"
                disabled={disabled}
                onClick={() => onCar(c.kind)}
              >
                <CarSilhouette kind={c.kind} color={hex} />
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="segmented-field">
          <span className="segmented-label" id={`${id}-color`}>
            顏色
          </span>
          <div className="race-colors" role="radiogroup" aria-labelledby={`${id}-color`}>
            {CAR_COLORS.map((c, i) => {
              const who = i === color ? undefined : taken?.get(i)
              return (
                <button
                  key={c.hex}
                  type="button"
                  role="radio"
                  aria-checked={color === i}
                  aria-label={who ? `${c.name}（${who} 選了）` : c.name}
                  title={who ? `${c.name}：${who} 選了` : c.name}
                  className={`race-color${who ? ' taken' : ''}`}
                  style={{ '--car': hexColor(c.hex) } as CSSProperties}
                  disabled={disabled || who !== undefined}
                  onClick={() => onColor(i)}
                />
              )
            })}
          </div>
        </div>
        <div className="race-start-bar race-select-actions">{actions}</div>
      </section>
    </div>
  )
}
