// 主執行緒與 worker 之間的訊息格式
import type { ConvertOptions, Converted, OutFormat, Source } from './convert'

export type ToWorker =
  /** 啟動時問 worker 能不能用 OffscreenCanvas、能輸出哪些格式 */
  | { type: 'probe' }
  /** source 是 ImageBitmap 的話會轉移過去，worker 用完就關掉 */
  | { type: 'convert'; req: number; source: Source; options: ConvertOptions }

export type FromWorker =
  | { type: 'probe'; ok: boolean; formats: OutFormat[] }
  | ({ type: 'done'; req: number } & Converted)
  /** decode：讀不了這個檔案，主執行緒可以改用 <img> 再試 */
  | { type: 'error'; req: number; decode: boolean; message: string }
