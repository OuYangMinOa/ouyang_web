// 去背與點選的推論都在這個 worker 裡跑，主畫面不會被卡住
import {
  AutoProcessor,
  PreTrainedModel,
  RawImage,
  SamModel,
  Tensor,
  env,
  type ProgressInfo,
  type SamProcessor,
} from '@huggingface/transformers'
// transformers.js 自己用的那份 onnxruntime-web，版本一定對得上
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import type { Backend, FromWorker, Task, ToWorker } from './protocol'

// onnxruntime 的 wasm（約 27 MB）跟著網站部署，不從 jsdelivr 下載。
// 舊版 Safari 沒有 WebGPU 時 transformers.js 會改用非 asyncify 版，那種情況維持 CDN，不多帶一份 wasm
const ortPaths = env.backends.onnx.wasm?.wasmPaths
if (env.backends.onnx.wasm && typeof ortPaths === 'object' && String(ortPaths.wasm).includes('.asyncify')) {
  env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm }
}

/*
 * 模型（都是 Apache-2.0，第一次用時從 Hugging Face 下載，之後留在瀏覽器的 Cache API）：
 * - 去背：Ko033/isnet-general-use-onnx — DIS 的 ISNet general-use，transformers.js 格式
 *   onnx/model_fp16.onnx（88 MB，WebGPU）、onnx/model_quantized.onnx（46 MB，q8，CPU）
 *   輸入 input_image [1,3,1024,1024]（x/255 − 0.5），輸出 output_image [1,1,1024,1024] 的 sigmoid 機率
 * - 點選：Xenova/slimsam-77-uniform — SlimSAM-77
 *   vision_encoder / prompt_encoder_mask_decoder 各一個檔；WebGPU 用 _fp16（約 21 MB），CPU 用 _quantized（約 14 MB）
 */
const ISNET = 'Ko033/isnet-general-use-onnx'
const SAM = 'Xenova/slimsam-77-uniform'
/** ISNet 的推論解析度 */
const SIZE = 1024

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, { transfer })
}

type GpuNavigator = Navigator & {
  gpu?: { requestAdapter(): Promise<{ features: { has(name: string): boolean } } | null> }
}

let backend: Promise<Backend> | null = null

/** 有 WebGPU 而且顯示卡支援 fp16（shader-f16）才用 GPU，否則用 CPU（WASM） */
function getBackend(): Promise<Backend> {
  backend ??= (async () => {
    let b: Backend = 'wasm'
    try {
      const adapter = await (navigator as GpuNavigator).gpu?.requestAdapter()
      if (adapter?.features.has('shader-f16')) b = 'webgpu'
    } catch {
      // 取不到 adapter 就用 CPU
    }
    post({ type: 'backend', backend: b })
    return b
  })()
  return backend
}

/** GPU 跑不動（驅動問題、記憶體不足…）時改用 CPU */
function fallbackToWasm() {
  backend = Promise.resolve('wasm')
  post({ type: 'backend', backend: 'wasm' })
}

const dtypeFor = (b: Backend) => (b === 'webgpu' ? 'fp16' : 'q8')

/** 把各檔案的下載進度加總後回報（最多每 100ms 一次） */
function tracker(task: Task) {
  const files = new Map<string, { loaded: number; total: number }>()
  let last = 0
  return (p: ProgressInfo) => {
    if (p.status !== 'progress') return
    files.set(p.file, { loaded: p.loaded, total: p.total })
    let loaded = 0
    let total = 0
    for (const f of files.values()) {
      loaded += f.loaded
      total += f.total
    }
    const now = performance.now()
    if (now - last < 100 && loaded < total) return
    last = now
    post({ type: 'download', task, loaded, total })
  }
}

// ---- 去背（ISNet） ----

let isnet: Promise<PreTrainedModel> | null = null

function loadIsnet(b: Backend) {
  isnet ??= PreTrainedModel.from_pretrained(ISNET, {
    device: b,
    dtype: dtypeFor(b),
    progress_callback: tracker('isnet'),
  }).catch((err: unknown) => {
    isnet = null
    throw err
  })
  return isnet
}

async function runIsnet(id: number, input: Tensor): Promise<Tensor> {
  const b = await getBackend()
  try {
    const model = await loadIsnet(b)
    post({ type: 'analyze', task: 'isnet', id })
    return (await model({ input_image: input })).output_image
  } catch (err) {
    if (b !== 'webgpu') throw err
    console.warn('WebGPU 失敗，改用 CPU', err)
    void isnet?.then((m) => m.dispose()).catch(() => {})
    isnet = null
    fallbackToWasm()
    const model = await loadIsnet('wasm')
    post({ type: 'analyze', task: 'isnet', id })
    return (await model({ input_image: input })).output_image
  }
}

/** 目前這張圖（編輯解析度），點選要用 */
let current: { id: number; w: number; h: number; pixels: Uint8ClampedArray } | null = null
/** 最新收到的圖；排隊中的舊工作就跳過 */
let latest = 0

function context2d(w: number, h: number) {
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('無法建立畫布')
  return ctx
}

async function remove(id: number, bitmap: ImageBitmap) {
  const w = bitmap.width
  const h = bitmap.height
  const full = context2d(w, h)
  full.drawImage(bitmap, 0, 0)
  current = { id, w, h, pixels: full.getImageData(0, 0, w, h).data }
  sam.cache = null

  // 模型輸入：直接拉成 1024×1024（不保持比例，跟 rembg 一樣）
  const small = context2d(SIZE, SIZE)
  small.imageSmoothingQuality = 'high'
  small.drawImage(bitmap, 0, 0, SIZE, SIZE)
  bitmap.close()
  const px = small.getImageData(0, 0, SIZE, SIZE).data
  const n = SIZE * SIZE
  const input = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    input[i] = px[i * 4] / 255 - 0.5
    input[n + i] = px[i * 4 + 1] / 255 - 0.5
    input[2 * n + i] = px[i * 4 + 2] / 255 - 0.5
  }
  const out = await runIsnet(id, new Tensor('float32', input, [1, 3, SIZE, SIZE]))

  // 依 rembg 的作法做 min-max 正規化，再縮放回編輯解析度
  const [oh, ow] = out.dims.slice(-2)
  const d = out.data as Float32Array
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < d.length; i++) {
    if (d[i] < min) min = d[i]
    if (d[i] > max) max = d[i]
  }
  const scale = max > min ? 255 / (max - min) : 0
  const rgba = new Uint8ClampedArray(ow * oh * 4)
  for (let i = 0; i < ow * oh; i++) {
    rgba[i * 4] = (d[i] - min) * scale
    rgba[i * 4 + 3] = 255
  }
  const m = context2d(ow, oh)
  m.putImageData(new ImageData(rgba, ow, oh), 0, 0)
  const big = context2d(w, h)
  big.imageSmoothingQuality = 'high'
  big.drawImage(m.canvas, 0, 0, w, h)
  const bd = big.getImageData(0, 0, w, h).data
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) mask[i] = bd[i * 4]
  post({ type: 'mask', id, w, h, data: mask }, [mask.buffer])
}

// ---- 點選（SlimSAM） ----

type SamParts = { model: SamModel; processor: SamProcessor }
type SamCache = {
  id: number
  embeddings: Record<string, Tensor>
  original_sizes: [number, number][]
  reshaped_input_sizes: [number, number][]
}

const sam: { parts: Promise<SamParts> | null; cache: SamCache | null } = { parts: null, cache: null }

function loadSam(b: Backend) {
  sam.parts ??= (async () => {
    const progress_callback = tracker('sam')
    const [model, processor] = await Promise.all([
      SamModel.from_pretrained(SAM, { device: b, dtype: dtypeFor(b), progress_callback }),
      AutoProcessor.from_pretrained(SAM, { progress_callback }),
    ])
    return { model: model as SamModel, processor: processor as SamProcessor }
  })().catch((err: unknown) => {
    sam.parts = null
    throw err
  })
  return sam.parts
}

/** 每張圖第一次點選時算一次影像特徵，之後點選只跑很小的解碼器 */
async function embed(id: number, b: Backend): Promise<SamParts & { cache: SamCache }> {
  const parts = await loadSam(b)
  if (sam.cache?.id !== id) {
    if (!current) throw new Error('沒有圖片')
    post({ type: 'analyze', task: 'sam', id })
    const raw = new RawImage(current.pixels, current.w, current.h, 4)
    const inputs = await parts.processor(raw)
    sam.cache = {
      id,
      embeddings: await parts.model.get_image_embeddings(inputs),
      original_sizes: inputs.original_sizes,
      reshaped_input_sizes: inputs.reshaped_input_sizes,
    }
  }
  return { ...parts, cache: sam.cache }
}

async function segment(id: number, req: number, points: [number, number][], labels: number[]) {
  if (current?.id !== id) return
  const b = await getBackend()
  let ready: SamParts & { cache: SamCache }
  try {
    ready = await embed(id, b)
  } catch (err) {
    if (b !== 'webgpu') throw err
    console.warn('WebGPU 失敗，改用 CPU', err)
    void sam.parts?.then((p) => p.model.dispose()).catch(() => {})
    sam.parts = null
    sam.cache = null
    fallbackToWasm()
    ready = await embed(id, 'wasm')
  }
  const { model, processor, cache } = ready

  const input_points = processor.reshape_input_points([points], cache.original_sizes, cache.reshaped_input_sizes)
  // 形狀 [batch, point_batch, 點數]，1 = 要、0 = 不要
  const input_labels = new Tensor('int64', BigInt64Array.from(labels, (l) => BigInt(l)), [1, 1, labels.length])
  const out = await model({ ...cache.embeddings, input_points, input_labels })

  // 三個候選遮罩取 IoU 分數最高的，只把那一個放大回原尺寸
  const scores = out.iou_scores.data as Float32Array
  let best = 0
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i
  const chosen = out.pred_masks.slice(null, null, [best, best + 1])
  const [masks] = await processor.post_process_masks(chosen, cache.original_sizes, cache.reshaped_input_sizes)
  const data = new Uint8Array(masks.data as Uint8Array)
  post({ type: 'segment', id, req, data }, [data.buffer])
}

// ---- 訊息：一次處理一件，GPU 不會同時跑兩個模型 ----

let queue = Promise.resolve()

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  if (msg.type === 'remove') latest = msg.id
  queue = queue.then(() => handle(msg))
}

async function handle(msg: ToWorker) {
  const task: Task = msg.type === 'remove' ? 'isnet' : 'sam'
  try {
    if (msg.type === 'remove') {
      if (msg.id !== latest) {
        msg.bitmap.close()
        return
      }
      await remove(msg.id, msg.bitmap)
    } else {
      if (msg.id !== latest) return
      await segment(msg.id, msg.req, msg.points, msg.labels)
    }
  } catch (err) {
    console.error(err)
    post({
      type: 'error',
      task,
      id: msg.id,
      req: msg.type === 'segment' ? msg.req : undefined,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
