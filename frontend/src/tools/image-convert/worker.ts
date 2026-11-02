// 轉檔在背景執行緒用 OffscreenCanvas 做，大圖也不會卡住畫面
import { convert, DecodeError, hasOffscreen2d, supportedFormats } from './convert'
import type { FromWorker, ToWorker } from './protocol'

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer })
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  if (msg.type === 'probe') {
    const ok = hasOffscreen2d()
    post({ type: 'probe', ok, formats: ok ? await supportedFormats() : [] })
    return
  }
  try {
    const r = await convert(msg.source, msg.options)
    post({ type: 'done', req: msg.req, ...r })
  } catch (err) {
    post({
      type: 'error',
      req: msg.req,
      decode: err instanceof DecodeError,
      message: err instanceof Error ? err.message : String(err),
    })
  } finally {
    if (!(msg.source instanceof Blob)) msg.source.close()
  }
}
