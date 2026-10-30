import type { Entry } from './pool'

/** 籤筒、轉盤、彈珠共用：從 pool 抽 count 個，抽完呼叫 onDone */
export type DrawProps = {
  /** 還能抽的人（不放回時，抽中過的已經拿掉） */
  pool: Entry[]
  count: number
  replace: boolean
  /** 動畫進行中，外面的名單和選項先鎖住 */
  onBusy: (busy: boolean) => void
  onDone: (winners: Entry[]) => void
}
