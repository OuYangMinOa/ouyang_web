import { convert, DecodeError, supportedFormats, type ConvertOptions, type Converted, type OutFormat, type Source } from './convert'
import type { FromWorker, ToWorker } from './protocol'

type Job = {
  source: Source
  options: ConvertOptions
  resolve: (r: Converted) => void
  reject: (err: Error) => void
}

type Slot = { worker: Worker; job: Job | null; req: number }

/** 被 clear() 取消的工作 */
export class CancelError extends Error {
  constructor() {
    super('cancel')
  }
}

/**
 * 幾個 worker 輪流轉檔；同時只處理 size 張，記憶體才不會爆。
 * 瀏覽器沒有 OffscreenCanvas（舊版 Safari）或開不了 worker 時，改在主執行緒一張一張做。
 */
export class ConvertPool {
  /** 可以輸出的格式；啟動完才知道 */
  readonly ready: Promise<OutFormat[]>
  #slots: Slot[] = []
  #queue: Job[] = []
  #mainBusy = false
  #useMain = false
  #nextReq = 0
  #closed = false

  constructor(size: number) {
    this.ready = this.#start(size)
  }

  async #start(size: number): Promise<OutFormat[]> {
    let first: Worker
    try {
      first = this.#spawn()
    } catch {
      this.#useMain = true
      return supportedFormats()
    }
    const probe = await new Promise<FromWorker | null>((resolve) => {
      first.onmessage = (e: MessageEvent<FromWorker>) => resolve(e.data)
      first.onerror = () => resolve(null)
      first.postMessage({ type: 'probe' } satisfies ToWorker)
    })
    if (!probe || probe.type !== 'probe' || !probe.ok) {
      first.terminate()
      this.#useMain = true
      return supportedFormats()
    }
    if (this.#closed) {
      first.terminate()
      return probe.formats
    }
    this.#adopt(first)
    for (let i = 1; i < size; i++) this.#adopt(this.#spawn())
    this.#pump()
    return probe.formats
  }

  #spawn() {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  }

  #adopt(worker: Worker) {
    const slot: Slot = { worker, job: null, req: 0 }
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data
      if (msg.type === 'probe' || msg.req !== slot.req || !slot.job) return
      const job = slot.job
      slot.job = null
      if (msg.type === 'done') {
        const { blob, width, height, srcWidth, srcHeight } = msg
        job.resolve({ blob, width, height, srcWidth, srcHeight })
      } else {
        job.reject(msg.decode ? new DecodeError() : new Error(msg.message))
      }
      this.#pump()
    }
    worker.onerror = (e) => {
      console.error(e)
      const job = slot.job
      slot.job = null
      job?.reject(new Error('背景執行緒發生錯誤'))
      this.#pump()
    }
    this.#slots.push(slot)
  }

  convert(source: Source, options: ConvertOptions): Promise<Converted> {
    return new Promise((resolve, reject) => {
      if (this.#closed) return reject(new CancelError())
      this.#queue.push({ source, options, resolve, reject })
      this.#pump()
    })
  }

  /** 取消還在排隊的；正在做的會做完，結果由呼叫的人自己丟掉 */
  clear() {
    for (const job of this.#queue.splice(0)) job.reject(new CancelError())
  }

  destroy() {
    this.#closed = true
    this.clear()
    for (const s of this.#slots) {
      s.worker.terminate()
      s.job?.reject(new CancelError())
    }
    this.#slots = []
  }

  #pump() {
    if (this.#closed) return
    if (this.#useMain) {
      if (this.#mainBusy) return
      const job = this.#queue.shift()
      if (!job) return
      this.#mainBusy = true
      // 讓畫面先更新「處理中」再開始
      setTimeout(() => {
        convert(job.source, job.options)
          .then(job.resolve, job.reject)
          .finally(() => {
            this.#mainBusy = false
            this.#pump()
          })
      }, 0)
      return
    }
    for (const slot of this.#slots) {
      if (slot.job) continue
      const job = this.#queue.shift()
      if (!job) return
      slot.job = job
      slot.req = ++this.#nextReq
      void this.#send(slot, job)
    }
  }

  async #send(slot: Slot, job: Job) {
    const req = slot.req
    let source = job.source
    try {
      // 解碼好的圖轉移過去就不能再用，所以送一份複本，原本的留著下次改設定再用
      if (!(source instanceof Blob)) source = await createImageBitmap(source)
    } catch {
      slot.job = null
      job.reject(new Error('記憶體不足，無法處理這張圖'))
      this.#pump()
      return
    }
    if (slot.req !== req || this.#closed) {
      if (!(source instanceof Blob)) source.close()
      return
    }
    const msg: ToWorker = { type: 'convert', req, source, options: job.options }
    slot.worker.postMessage(msg, source instanceof Blob ? [] : [source])
  }
}
