import type { Chime } from './alert'

/** 三種計時器共用：由外層統一處理鈴聲、通知和分頁標題 */
export type TimerProps = {
  /** 按下開始時呼叫：解鎖音效、第一次會詢問通知權限 */
  prepare: () => void
  /** 時間到 */
  alarm: (kind: Chime, title: string, body: string) => void
  /** 分頁標題要顯示的文字；沒在跑就給 null */
  onTitle: (text: string | null) => void
}
