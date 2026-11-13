// 影片轉檔的引擎：ffmpeg.wasm（單執行緒版，不需要 SharedArrayBuffer／跨來源隔離）在 Web Worker 裡跑。
// wasm 約 31 MB（gzip 後約 10 MB），跟著網站部署，不走 CDN；第一次加入檔案時才下載。
import { FFFSType, FFmpeg } from '@ffmpeg/ffmpeg'
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'
import {
  buildPasses,
  clipLength,
  EXT,
  explainFailure,
  PALETTE,
  parseProbe,
  parseTime,
  type Clip,
  type MediaInfo,
  type Settings,
} from './args'

/**
 * @ffmpeg/core 0.12.10 的 wasm 解壓後有多大。伺服器送 gzip 時，fetch 讀到的是解壓後的位元組，
 * 標頭的 Content-Length 卻是壓縮後的，只好用這個當進度條的分母；升級套件後不準也只是進度條不準。
 */
const WASM_BYTES = 32_232_419

/** 使用者按了取消，或換了檔案 */
export class CancelError extends Error {
  constructor() {
    super('已取消')
  }
}

/** 可以直接顯示給使用者看的錯誤 */
export class ConvertError extends Error {}

export type LoadProgress = { loaded: number; total: number }

export class Engine {
  /** 下載轉檔引擎的進度 */
  onLoadProgress: ((p: LoadProgress) => void) | null = null

  #ff: FFmpeg | null = null
  #ready: Promise<FFmpeg> | null = null
  /** 下載過的 wasm，取消後重開 worker 不用再下載一次 */
  #wasm: Blob | null = null
  #download: AbortController | null = null
  #mounted: File | null = null
  #input = ''
  /** 正在跑的指令的輸出 */
  #lines: string[] | null = null
  #onTime: ((sec: number) => void) | null = null
  #queue: Promise<unknown> = Promise.resolve()
  /** 每次取消就加一，舊的工作看到不一樣就知道自己被取消了 */
  #gen = 0
  #destroyed = false

  get loaded() {
    return this.#ff?.loaded ?? false
  }

  /** 先把引擎準備好（下載 + 啟動 worker） */
  load(): Promise<FFmpeg> {
    if (!this.#ready) {
      const p = this.#load()
      this.#ready = p
      // 失敗了下次重來；被取消後別人可能已經開始新的一輪，那就不要動
      p.catch(() => {
        if (this.#ready === p) this.#ready = null
      })
    }
    return this.#ready
  }

  /** 讀出長度、尺寸、有沒有聲音 */
  probe(file: File): Promise<MediaInfo> {
    return this.#op(async (ff) => {
      await this.#mount(ff, file)
      // 沒給輸出檔，ffmpeg 印完檔案資訊就結束（結束碼不是 0，正常）
      const { lines } = await this.#exec(ff, ['-hide_banner', '-i', this.#input])
      const info = parseProbe(lines)
      if (!info.video && !info.audio) throw new ConvertError('讀不懂這個檔案，可能不是影片或音訊，或是檔案不完整。')
      return info
    })
  }

  /** 轉檔；onProgress 收到 0–1（不知道片段多長時不會呼叫），ms 是 ffmpeg 跑了多久 */
  convert(
    file: File,
    clip: Clip,
    info: MediaInfo,
    settings: Settings,
    onProgress?: (done: number) => void,
  ): Promise<{ data: Uint8Array<ArrayBuffer>; ms: number }> {
    return this.#op(async (ff) => {
      await this.#mount(ff, file)
      const out = `/out.${EXT[settings.kind]}`
      const cleanup = () => Promise.all([out, PALETTE].map((p) => ff.deleteFile(p).catch(() => {})))
      const len = clipLength(clip, info)
      const t0 = performance.now()
      let base = 0
      for (const pass of buildPasses(this.#input, out, clip, info, settings)) {
        const report =
          onProgress && len ? (t: number) => onProgress(Math.min(1, base + pass.weight * Math.min(1, t / len))) : undefined
        const { code, lines } = await this.#exec(ff, pass.args, report)
        if (code !== 0) {
          await cleanup()
          throw new ConvertError(explainFailure(lines, settings.kind))
        }
        base += pass.weight
      }
      const ms = performance.now() - t0
      const data = await ff.readFile(out)
      await cleanup()
      if (typeof data === 'string' || data.length === 0) {
        throw new ConvertError('轉出來是空的：片段可能太短，或這一段沒有畫面／聲音。')
      }
      // worker 用 postMessage 轉移過來的，底下一定是一般的 ArrayBuffer
      return { data: data as Uint8Array<ArrayBuffer>, ms }
    })
  }

  /** 中斷正在做的事：ffmpeg 的 exec 停不下來，只能把 worker 整個關掉，下次用到再重開 */
  cancel() {
    this.#gen++
    this.#download?.abort()
    this.#download = null
    this.#ff?.terminate()
    this.#ff = null
    this.#ready = null
    this.#mounted = null
  }

  destroy() {
    this.#destroyed = true
    this.cancel()
    this.#wasm = null
  }

  async #load(): Promise<FFmpeg> {
    const gen = this.#gen
    this.#wasm ??= await this.#fetchWasm()
    if (gen !== this.#gen) throw new CancelError()
    const ff = new FFmpeg()
    this.#ff = ff
    ff.on('log', ({ message }) => {
      this.#lines?.push(message)
      const t = parseTime(message)
      if (t != null) this.#onTime?.(t)
    })
    const url = URL.createObjectURL(this.#wasm)
    try {
      await ff.load({ coreURL, wasmURL: url })
    } catch (err) {
      if (gen !== this.#gen) throw new CancelError()
      console.error(err)
      this.cancel()
      throw new ConvertError('轉檔引擎啟動失敗，這個瀏覽器可能太舊，請換新版的 Chrome、Edge、Firefox 或 Safari。')
    } finally {
      URL.revokeObjectURL(url)
    }
    return ff
  }

  async #fetchWasm(): Promise<Blob> {
    const ctrl = new AbortController()
    this.#download = ctrl
    try {
      const res = await fetch(wasmURL, { signal: ctrl.signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const length = Number(res.headers.get('content-length')) || 0
      const total = !res.headers.get('content-encoding') && length > 0 ? length : WASM_BYTES
      const reader = res.body.getReader()
      const chunks: BlobPart[] = []
      let loaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        loaded += value.length
        this.onLoadProgress?.({ loaded, total: Math.max(total, loaded) })
      }
      return new Blob(chunks, { type: 'application/wasm' })
    } catch (err) {
      if (ctrl.signal.aborted) throw new CancelError()
      console.error(err)
      throw new ConvertError('下載轉檔引擎失敗，請檢查網路後再試一次。')
    } finally {
      if (this.#download === ctrl) this.#download = null
    }
  }

  /** 一次只做一件事；被取消的回報 CancelError，引擎當掉的話關掉，下次重開 */
  #op<T>(fn: (ff: FFmpeg) => Promise<T>): Promise<T> {
    const run = async () => {
      const gen = this.#gen
      if (this.#destroyed) throw new CancelError()
      try {
        return await fn(await this.load())
      } catch (err) {
        if (gen !== this.#gen || this.#destroyed || err instanceof CancelError) throw new CancelError()
        if (err instanceof ConvertError) throw err
        // worker 丟回來的是字串，多半是 wasm 記憶體不夠或當掉，這個 worker 不能再用
        console.error(err)
        this.cancel()
        throw new ConvertError(
          /memory|OOM|allocation/i.test(String(err))
            ? '記憶體不足：試試縮短片段、調低寬度或每秒格數。'
            : '轉檔引擎發生錯誤，請再試一次。',
        )
      }
    }
    const p = this.#queue.then(run, run)
    this.#queue = p.catch(() => {})
    return p
  }

  /** 檔案用 WORKERFS 掛進去，ffmpeg 要讀哪段才讀哪段，不用整個複製進 wasm 的記憶體，幾 GB 的影片也行 */
  async #mount(ff: FFmpeg, file: File) {
    if (this.#mounted === file) return
    if (this.#mounted) {
      await ff.unmount('/in')
      this.#mounted = null
    } else {
      await ff.createDir('/in').catch(() => {})
    }
    // 檔名可能有空白、括號、中文，一律換成固定的名字，只留副檔名給 ffmpeg 參考
    const name = `input${/\.[a-z0-9]{1,5}$/i.exec(file.name)?.[0].toLowerCase() ?? ''}`
    await ff.mount(FFFSType.WORKERFS, { blobs: [{ name, data: file }] }, '/in')
    this.#mounted = file
    this.#input = `/in/${name}`
  }

  async #exec(ff: FFmpeg, args: string[], onTime?: (sec: number) => void) {
    const lines: string[] = []
    this.#lines = lines
    this.#onTime = onTime ?? null
    try {
      const code = await ff.exec(args)
      return { code, lines }
    } finally {
      this.#lines = null
      this.#onTime = null
    }
  }
}
