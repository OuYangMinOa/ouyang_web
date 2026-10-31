import { useEffect, useState } from 'react'
import { SLOTS, bind, bindable, isDefault, keyName, unbind, type KeySettings } from './keys'

/** 自訂快捷鍵：點一格，再按想要的鍵 */
export function KeyEditor<A extends string>({ settings, onDone }: { settings: KeySettings<A>; onDone: () => void }) {
  const { scheme, keys, change, error, synced } = settings
  /** 正在等使用者按鍵的那一格 */
  const [capturing, setCapturing] = useState<{ action: A; slot: number } | null>(null)

  useEffect(() => {
    if (!capturing) return
    // 在捕獲階段先攔下來，按的鍵不會被遊戲拿去用
    const down = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      if (e.code === 'Backspace') change(unbind(keys, capturing.action, capturing.slot))
      else if (bindable(e.code)) change(bind(scheme, keys, capturing.action, capturing.slot, e.code))
      else return
      setCapturing(null)
      // 焦點留在按鈕上的話，空白鍵放開時會再按一次
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [capturing, keys, change, scheme])

  return (
    <>
      <ul className="game-keys">
        {scheme.actions.map(({ action, label }) => (
          <li key={action}>
            <span>{label}</span>
            {Array.from({ length: SLOTS }, (_, slot) => {
              const code = keys[action][slot]
              const active = capturing?.action === action && capturing.slot === slot
              return (
                <button
                  key={slot}
                  type="button"
                  className={active ? 'game-key capturing' : 'secondary game-key'}
                  aria-label={`${label}的第 ${slot + 1} 個鍵`}
                  aria-pressed={active}
                  onClick={() => setCapturing(active ? null : { action, slot })}
                  onBlur={() => active && setCapturing(null)}
                >
                  {active ? '按下按鍵…' : code ? keyName(code) : '—'}
                </button>
              )
            })}
          </li>
        ))}
      </ul>
      <p className="muted">
        點一格再按想要的鍵，按 Backspace 清除那一格；同一個鍵只能做一件事。
        {synced ? '設定存在你的帳號，換裝置也一樣。' : '設定存在這個瀏覽器，登入後會存到帳號。'}
      </p>
      {error && <p className="error">{error}</p>}
      <div className="game-keys-actions">
        <button type="button" className="secondary" onClick={() => change(null)} disabled={isDefault(scheme, keys)}>
          恢復預設
        </button>
        <button type="button" onClick={onDone}>
          完成
        </button>
      </div>
    </>
  )
}
