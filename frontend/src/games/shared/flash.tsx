import { useEffect, useRef, useState, type ReactNode } from 'react'

/** 盤面上方閃一下的字（TETRIS、3 連鎖…），`sub` 是下面一行小字（送出的攻擊） */
export function useFlash(): [ReactNode, (text: string | null, sub?: string | null) => void] {
  const [flash, setFlash] = useState<{ id: number; text: string | null; sub: string | null } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  function show(text: string | null, sub: string | null = null) {
    clearTimeout(timer.current)
    setFlash({ id: Date.now(), text, sub })
    timer.current = setTimeout(() => setFlash(null), 1200)
  }
  const node = flash && (
    <span key={flash.id} className="game-flash-text">
      {flash.text && <strong>{flash.text}</strong>}
      {flash.sub && <span className="game-flash-sent">{flash.sub}</span>}
    </span>
  )
  return [node, show]
}
