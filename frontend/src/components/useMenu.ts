import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import { useLocation } from 'react-router'

/** 下拉選單：按 Esc 或點外面關掉，點了裡面的連結或換頁就收起來 */
export function useMenu() {
  const { pathname } = useLocation()
  // 記住是在哪一頁打開的，網址一變（包括上一頁）就算關閉
  const [openOn, setOpenOn] = useState<string | null>(null)
  const open = openOn === pathname
  const ref = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpenOn(null)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setOpenOn(null)
      // 焦點回到展開選單的按鈕（容器裡的第一個按鈕）
      ref.current?.querySelector('button')?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return {
    ref,
    open,
    panelId,
    close: () => setOpenOn(null),
    /** 展開選單的按鈕：直接 {...menu.button} */
    button: {
      type: 'button' as const,
      'aria-expanded': open,
      'aria-controls': panelId,
      onClick: () => setOpenOn(open ? null : pathname),
    },
    /** 放在選單面板上：點到同一頁的連結網址不會變，要自己收 */
    onPanelClick: (e: MouseEvent) => {
      if ((e.target as Element).closest('a')) setOpenOn(null)
    },
  }
}
