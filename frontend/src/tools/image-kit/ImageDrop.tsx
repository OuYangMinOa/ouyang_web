// 圖片小工具共用的上傳區：拖曳、點選選檔、Ctrl+V 貼上（hooks 在 hooks.tsx）
import type { ReactNode } from 'react'
import './image-kit.css'

/** 還沒選圖時的大上傳區 */
export function DropZone({
  dragging,
  onPick,
  icon = '🖼️',
  title,
  dropTitle = '放開就開始',
  button = '選擇圖片',
  children,
}: {
  dragging: boolean
  onPick: () => void
  icon?: string
  title: string
  dropTitle?: string
  button?: string
  /** 補充說明、錯誤訊息 */
  children?: ReactNode
}) {
  return (
    <div className={`ik-drop${dragging ? ' over' : ''}`} onClick={onPick}>
      <span className="ik-drop-icon" aria-hidden="true">
        {icon}
      </span>
      <strong>{dragging ? dropTitle : title}</strong>
      <span className="muted">或</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onPick()
        }}
      >
        {button}
      </button>
      <span className="muted">也可以直接貼上（Ctrl+V）</span>
      {children}
    </div>
  )
}

/** 編輯中把檔案拖進來時蓋在上面的提示 */
export function DropVeil({ text }: { text: string }) {
  return (
    <div className="ik-veil" aria-hidden="true">
      {text}
    </div>
  )
}
