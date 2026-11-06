import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Icon from '../../music/Icon'
import type { MusicControl } from './music'

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

/** 音量面板的寬度（要和 games.css 的 `.music-volume-panel` 一樣），打開時看靠哪邊對齊放得下 */
const VOLUME_PANEL_W = 220

/**
 * 背景音樂：左邊是開關（也可以按快捷鍵，預設是 M），右邊點開調音量；開關和音量所有遊戲共用（見 `useMusic`）。
 * 音量面板浮在按鈕下面，點外面或按 Esc 收起來。
 */
export function MusicButton({ music }: { music: MusicControl }) {
  const [open, setOpen] = useState(false)
  const [alignLeft, setAlignLeft] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const sliderId = useId()
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const togglePanel = () => {
    // 預設和按鈕右邊對齊往左長；按鈕太靠左、往左會超出畫面時改成左邊對齊
    const rect = wrap.current?.getBoundingClientRect()
    setAlignLeft(!!rect && rect.right < VOLUME_PANEL_W + 8)
    setOpen((o) => !o)
  }
  return (
    <div className="music-control" ref={wrap}>
      <button type="button" className="secondary" onClick={music.toggle} aria-pressed={music.enabled}>
        ♪ <span className="music-label">音樂：</span>
        {music.enabled ? '開' : '關'}
      </button>
      <button
        ref={trigger}
        type="button"
        className="secondary music-volume-toggle"
        onClick={togglePanel}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="調整音樂音量"
        title="調整音樂音量"
      >
        <Icon name={music.enabled ? 'volume' : 'mute'} />
      </button>
      {open && (
        <div id={panelId} className={`music-volume-panel${alignLeft ? ' align-left' : ''}`}>
          <div className="music-volume-head">
            <label htmlFor={sliderId}>音樂音量</label>
            <output htmlFor={sliderId}>{music.volume}%</output>
          </div>
          <input
            id={sliderId}
            type="range"
            min={0}
            max={100}
            step={5}
            value={music.volume}
            onChange={(e) => music.setVolume(Number(e.target.value))}
          />
          <p className="muted">所有小遊戲共用</p>
        </div>
      )}
    </div>
  )
}

/** 音效開關（和背景音樂分開） */
export function SfxButton({ sfx }: { sfx: { enabled: boolean; toggle: () => void } }) {
  return (
    <button type="button" className="secondary" onClick={sfx.toggle} aria-pressed={sfx.enabled}>
      {sfx.enabled ? '🔊 音效：開' : '🔈 音效：關'}
    </button>
  )
}
