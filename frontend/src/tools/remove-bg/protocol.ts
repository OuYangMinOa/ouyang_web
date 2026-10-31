// 主執行緒與 worker 之間的訊息格式

export type Backend = 'webgpu' | 'wasm'
export type Task = 'isnet' | 'sam'

export type ToWorker =
  /** 換一張圖並自動去背；bitmap 已經縮到編輯解析度 */
  | { type: 'remove'; id: number; bitmap: ImageBitmap }
  /** 點選：座標是編輯解析度的像素；label 1 = 要、0 = 不要 */
  | { type: 'segment'; id: number; req: number; points: [number, number][]; labels: number[] }

export type FromWorker =
  | { type: 'backend'; backend: Backend }
  /** 下載模型的進度（bytes） */
  | { type: 'download'; task: Task; loaded: number; total: number }
  /** 模型載好、開始算 */
  | { type: 'analyze'; task: Task; id: number }
  /** 去背結果：模型的柔和遮罩，0–255，已經縮放到 w×h */
  | { type: 'mask'; id: number; w: number; h: number; data: Uint8Array }
  /** 點選結果：1 = 選到 */
  | { type: 'segment'; id: number; req: number; data: Uint8Array }
  | { type: 'error'; task: Task; id: number; req?: number; message: string }
