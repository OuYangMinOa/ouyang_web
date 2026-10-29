import { useId, type ReactNode } from 'react'

export type Option<T> = { value: T; label: ReactNode; disabled?: boolean }

/** 一排互斥的選項（速度、難度、模式…），窄螢幕會自動換行 */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label?: ReactNode
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <div className="segmented-field">
      {label && (
        <span className="segmented-label" id={id}>
          {label}
        </span>
      )}
      <div className="segmented" role="radiogroup" aria-labelledby={label ? id : undefined}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={option.value === value ? 'active' : ''}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 遊戲主畫面 + 側邊欄；桌機並排，手機上下排（側邊欄在下面） */
export function GameLayout({ children, side }: { children: ReactNode; side?: ReactNode }) {
  return (
    <div className={`game-layout${side ? '' : ' single'}`}>
      <div className="game-main">{children}</div>
      {side && <aside className="game-side">{side}</aside>}
    </div>
  )
}

/** 棋盤上方的狀態列：輪到誰、勝負訊息 */
export function StatusLine({ children, tone }: { children: ReactNode; tone?: 'ok' | 'danger' | 'accent' }) {
  return (
    <p className={`game-status${tone ? ` ${tone}` : ''}`} role="status" aria-live="polite">
      {children}
    </p>
  )
}

/** 一排按鈕（悔棋、重新開始…），窄螢幕換行 */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="game-toolbar">{children}</div>
}

/** 對局結束時蓋在遊戲畫面上的訊息 */
export function Overlay({ children }: { children: ReactNode }) {
  return <div className="game-overlay">{children}</div>
}
