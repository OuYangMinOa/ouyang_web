import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react'
import { formatBytes } from '../image-convert/util'
import { Range, Seg } from '../image-kit/controls'
import { downloadBlob, stem } from '../image-kit/files'
import { useDragFiles } from '../image-kit/hooks'
import { clipLength, EXT, formatClock, MIME, parseClock, type MediaInfo, type OutKind, type Settings } from './args'
import { CancelError, Engine, type LoadProgress } from './engine'
import '../image-kit/image-kit.css'
import './video-convert.css'

const SETTINGS_KEY = 'tool_video_convert'
const DEFAULTS: Settings = { kind: 'mp3', bitrate: 192, fps: 15, width: 480, quality: 75 }

const KIND_LABEL: Record<OutKind, string> = { mp3: 'MP3 音訊', gif: 'GIF 動圖', webp: 'WebP 動圖' }
const BITRATES = [128, 192, 256, 320]
const FPS = [5, 10, 15, 20, 25, 30]
const WIDTHS = [240, 320, 480, 640, 800]
/** 動圖片段超過這麼多秒就提醒 */
const LONG_ANIM = 20

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|amr|aiff?)$/i
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|3g2|mts|m2ts|ts|mpe?g|ogv|vob)$/i

function isMedia(f: File) {
  return /^(video|audio)\//.test(f.type) || VIDEO_EXT.test(f.name) || AUDIO_EXT.test(f.name)
}

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null
    return { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) }
  } catch {
    return DEFAULTS
  }
}

type Source = { file: File; url: string }

type Result = {
  id: number
  kind: OutKind
  name: string
  blob: Blob
  url: string
  width?: number
  height?: number
  /** 片段長度（秒） */
  length: number | null
  /** 轉了幾毫秒 */
  took: number
  /** 可以用系統的分享選單（手機） */
  shareable: boolean
}

type Phase = 'idle' | 'loading' | 'probing' | 'converting'

/** 秒數用中文的說法：「8.2 秒」「1 分 05 秒」 */
function spoken(sec: number) {
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} 秒`
  const m = Math.floor(sec / 60)
  return `${m} 分 ${String(Math.round(sec % 60)).padStart(2, '0')} 秒`
}

/** 動圖的第一格就能知道寬高 */
async function imageSize(blob: Blob) {
  try {
    const bmp = await createImageBitmap(blob)
    const size = { width: bmp.width, height: bmp.height }
    bmp.close()
    return size
  } catch {
    return {}
  }
}

function canShare(file: File) {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
  } catch {
    return false
  }
}

export default function VideoConvert() {
  const [settings, setSettings] = useState(loadSettings)
  const [source, setSource] = useState<Source | null>(null)
  const [info, setInfo] = useState<MediaInfo | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null)
  /** 轉檔進度 0–1；不知道片段多長時是 null */
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [startText, setStartText] = useState('')
  const [endText, setEndText] = useState('')
  const [previewOk, setPreviewOk] = useState(true)
  const [results, setResults] = useState<Result[]>([])

  const engine = useRef<Engine | null>(null)
  const media = useRef<HTMLMediaElement | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  /** 每換一個檔案就加一；舊檔案的分析結果回來時就丟掉 */
  const token = useRef(0)
  const nextId = useRef(0)
  /** 「播放這一段」播到哪裡要停 */
  const stopAt = useRef<number | null>(null)
  const urls = useRef(new Set<string>())
  const ids = useId()

  useEffect(() => {
    const e = new Engine()
    e.onLoadProgress = setLoadProgress
    engine.current = e
    const urlSet = urls.current
    return () => {
      e.destroy()
      engine.current = null
      for (const u of urlSet) URL.revokeObjectURL(u)
      urlSet.clear()
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // 存不了就只在這次有效
    }
  }, [settings])

  const track = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    urls.current.add(url)
    return url
  }
  const untrack = (url: string) => {
    URL.revokeObjectURL(url)
    urls.current.delete(url)
  }

  async function open(file: File) {
    const e = engine.current
    if (!e) return
    e.cancel()
    const my = ++token.current
    if (source) untrack(source.url)
    setSource({ file, url: track(file) })
    setInfo(null)
    setError('')
    setNotice('')
    setStartText('')
    setEndText('')
    setPreviewOk(true)
    setProgress(null)
    stopAt.current = null
    try {
      if (!e.loaded) {
        setPhase('loading')
        await e.load()
        if (my !== token.current) return
      }
      setPhase('probing')
      const found = await e.probe(file)
      if (my !== token.current) return
      setInfo(found)
      setStartText(formatClock(0))
      setEndText(found.duration != null ? formatClock(found.duration) : '')
    } catch (err) {
      if (my !== token.current || err instanceof CancelError) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (my === token.current) setPhase('idle')
    }
  }

  function addFiles(files: File[]) {
    const file = files.find(isMedia)
    if (!file) {
      if (files.length) setNotice('這不是影片或音訊檔。')
      return
    }
    setNotice(files.length > 1 ? `一次只能轉一個檔案，先用「${file.name}」。` : '')
    void open(file)
  }

  const { dragging, handlers } = useDragFiles(addFiles)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }))

  // ---- 片段 ----
  const duration = info?.duration ?? null
  const startRaw = parseClock(startText)
  const endRaw = parseClock(endText)
  const start = startRaw ?? 0
  let clipError = ''
  if (Number.isNaN(start) || Number.isNaN(endRaw)) clipError = '時間看不懂，請輸入像 1:23.5 或 83.5（秒）這樣的格式。'
  else if (duration != null && start >= duration) clipError = '開始時間超過影片長度了。'
  else if (endRaw != null && endRaw <= start) clipError = '結束時間要比開始時間晚。'
  const end = endRaw != null && duration != null ? Math.min(endRaw, duration) : endRaw
  const clip = { start, end }
  const length = info && !clipError ? clipLength(clip, info) : null
  const whole = start === 0 && (end == null || (duration != null && end >= duration - 0.05))

  // ---- 輸出設定：依檔案有沒有畫面／聲音調整 ----
  const hasVideo = info ? !!info.video : true
  const hasAudio = info ? !!info.audio : true
  let kind = settings.kind
  if (kind === 'mp3' && !hasAudio) kind = 'gif'
  if (kind !== 'mp3' && !hasVideo) kind = 'mp3'
  const srcW = info?.video?.width ?? 0
  const srcH = info?.video?.height ?? 0
  const widthOptions = WIDTHS.filter((w) => !srcW || w < srcW)
  const width = widthOptions.includes(settings.width) ? settings.width : 0
  const srcFps = info?.video?.fps ?? null
  const fpsOptions = FPS.filter((f, i) => i === 0 || !srcFps || f <= Math.ceil(srcFps))
  const fps = fpsOptions.includes(settings.fps) ? settings.fps : fpsOptions[fpsOptions.length - 1]
  const effective: Settings = { ...settings, kind, width, fps }
  const outW = width || srcW
  const outH = srcW && srcH ? Math.max(1, Math.round((srcH * outW) / srcW)) : 0

  const audioOnly = info ? !info.video : AUDIO_EXT.test(source?.file.name ?? '') || !!source?.file.type.startsWith('audio/')
  const busy = phase !== 'idle'

  async function convert() {
    const e = engine.current
    if (!e || !source || !info || clipError) return
    const my = token.current
    const len = length
    setPhase('converting')
    setProgress(len ? 0 : null)
    setError('')
    try {
      const { data, ms } = await e.convert(source.file, clip, info, effective, (done) => {
        if (my === token.current) setProgress(done)
      })
      if (my !== token.current) return
      const blob = new Blob([data], { type: MIME[kind] })
      const size = kind === 'mp3' ? {} : await imageSize(blob)
      // 檔名裡的時間：整數秒就不帶小數
      const clock = (s: number) => formatClock(s, Number.isInteger(Math.round(s * 10) / 10) ? 0 : 1).replace(/:/g, '-')
      const part = whole ? '' : `_${clock(start)}~${clock(end ?? duration ?? 0)}`
      const name = `${stem(source.file.name)}${part}.${EXT[kind]}`
      const result: Result = {
        id: ++nextId.current,
        kind,
        name,
        blob,
        url: track(blob),
        ...size,
        length: len,
        took: ms,
        shareable: canShare(new File([blob], name, { type: blob.type })),
      }
      setResults((rs) => [result, ...rs])
    } catch (err) {
      if (my !== token.current || err instanceof CancelError) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (my === token.current) {
        setPhase('idle')
        setProgress(null)
      }
    }
  }

  function remove(r: Result) {
    untrack(r.url)
    setResults((rs) => rs.filter((x) => x.id !== r.id))
  }

  async function share(r: Result) {
    const file = new File([r.blob], r.name, { type: r.blob.type })
    try {
      await navigator.share({ files: [file] })
    } catch {
      // 使用者關掉分享選單
    }
  }

  function takeCurrent(which: 'start' | 'end') {
    const m = media.current
    if (!m) return
    const text = formatClock(m.currentTime)
    if (which === 'start') setStartText(text)
    else setEndText(text)
  }

  const clearStop = () => {
    stopAt.current = null
  }
  const stopIfDone = (ev: SyntheticEvent<HTMLMediaElement>) => {
    const m = ev.currentTarget
    if (stopAt.current != null && m.currentTime >= stopAt.current) m.pause()
  }

  function playClip() {
    const m = media.current
    if (!m || clipError) return
    m.currentTime = start
    stopAt.current = end
    void m.play().catch(() => {})
  }

  const pick = () => fileInput.current?.click()

  return (
    <div className="vc" {...handlers}>
      <input
        ref={fileInput}
        type="file"
        accept="video/*,audio/*,.mkv,.avi,.flv,.wmv,.ts,.mts,.m2ts"
        hidden
        onChange={(ev) => {
          addFiles([...(ev.target.files ?? [])])
          ev.target.value = ''
        }}
      />

      {!source ? (
        <div className={`ik-drop${dragging ? ' over' : ''}`} onClick={pick}>
          <span className="ik-drop-icon" aria-hidden="true">
            🎬
          </span>
          <strong>{dragging ? '放開就開始' : '把影片拖到這裡'}</strong>
          <span className="muted">或</span>
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              pick()
            }}
          >
            選擇影片
          </button>
          <span className="muted">MP4、MOV、WebM、MKV、AVI 都可以；音訊檔也能轉成 MP3</span>
          {notice && <p className="error">{notice}</p>}
        </div>
      ) : (
        <>
          <div className="vc-file">
            <span aria-hidden="true">{audioOnly ? '🎵' : '🎬'}</span>
            <strong className="vc-ellipsis" title={source.file.name}>
              {source.file.name}
            </strong>
            <span className="muted">{formatBytes(source.file.size)}</span>
            <button type="button" className="secondary" onClick={pick}>
              換一個檔案
            </button>
          </div>
          {notice && <p className="error">{notice}</p>}

          <div className="vc-main">
            <section className="vc-preview" aria-label="預覽">
              {audioOnly ? (
                <audio
                  ref={(el) => {
                    media.current = el
                  }}
                  controls
                  src={source.url}
                  onError={() => setPreviewOk(false)}
                  onPause={clearStop}
                  onTimeUpdate={stopIfDone}
                />
              ) : previewOk ? (
                <video
                  ref={(el) => {
                    media.current = el
                  }}
                  controls
                  playsInline
                  preload="metadata"
                  src={source.url}
                  onError={() => setPreviewOk(false)}
                  onPause={clearStop}
                  onTimeUpdate={stopIfDone}
                />
              ) : null}
              {!previewOk && (
                <p className="vc-no-preview muted">
                  瀏覽器沒辦法播放這個格式（例如 MKV、AVI，或部分電腦上 iPhone 的 HEVC），所以不能預覽，但一樣可以轉檔；開始和結束時間請直接輸入。
                </p>
              )}
              {info && (
                <p className="vc-facts">
                  {duration != null && <span>長度 {formatClock(duration)}</span>}
                  {info.video && (
                    <span>
                      {info.video.width}×{info.video.height}
                      {info.video.fps ? ` · ${Math.round(info.video.fps * 100) / 100} fps` : ''} · {info.video.codec}
                    </span>
                  )}
                  <span>{info.audio ? `聲音 ${info.audio.codec}` : '沒有聲音'}</span>
                </p>
              )}
            </section>

            <section className="vc-panel" aria-label="轉檔設定">
              <fieldset className="vc-clip" disabled={!info}>
                <legend>片段</legend>
                <div className="vc-time">
                  <label htmlFor={`${ids}-start`}>開始</label>
                  <div className="vc-time-row">
                    <input
                      id={`${ids}-start`}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0:00.0"
                      value={startText}
                      aria-invalid={Number.isNaN(startRaw) || undefined}
                      onChange={(ev) => setStartText(ev.target.value)}
                      onBlur={() => startRaw != null && !Number.isNaN(startRaw) && setStartText(formatClock(startRaw))}
                    />
                    <button type="button" className="secondary" disabled={!previewOk} onClick={() => takeCurrent('start')}>
                      用目前位置
                    </button>
                  </div>
                </div>
                <div className="vc-time">
                  <label htmlFor={`${ids}-end`}>結束</label>
                  <div className="vc-time-row">
                    <input
                      id={`${ids}-end`}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="到結尾"
                      value={endText}
                      aria-invalid={Number.isNaN(endRaw) || undefined}
                      onChange={(ev) => setEndText(ev.target.value)}
                      onBlur={() => endRaw != null && !Number.isNaN(endRaw) && setEndText(formatClock(endRaw))}
                    />
                    <button type="button" className="secondary" disabled={!previewOk} onClick={() => takeCurrent('end')}>
                      用目前位置
                    </button>
                  </div>
                </div>
                {clipError ? (
                  <p className="error">{clipError}</p>
                ) : (
                  <div className="vc-clip-foot">
                    <span className="muted">{length != null ? `片段長度 ${spoken(length)}` : '到檔案結尾'}</span>
                    {previewOk && (
                      <button type="button" className="secondary" onClick={playClip}>
                        ▶ 播放這一段
                      </button>
                    )}
                    {!whole && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setStartText(formatClock(0))
                          setEndText(duration != null ? formatClock(duration) : '')
                        }}
                      >
                        整段
                      </button>
                    )}
                  </div>
                )}
              </fieldset>

              <Seg<OutKind>
                label="轉成"
                value={kind}
                onChange={(v) => set('kind', v)}
                options={(['mp3', 'gif', 'webp'] as const).map((k) => {
                  const off = k === 'mp3' ? !hasAudio : !hasVideo
                  return {
                    value: k,
                    label: KIND_LABEL[k],
                    disabled: off,
                    title: off ? (k === 'mp3' ? '這個檔案沒有聲音' : '這個檔案沒有畫面') : undefined,
                  }
                })}
              />

              {kind === 'mp3' ? (
                <Seg
                  label="位元率（越高音質越好、檔案越大）"
                  value={String(settings.bitrate)}
                  onChange={(v) => set('bitrate', Number(v))}
                  options={BITRATES.map((b) => ({ value: String(b), label: `${b} kbps` }))}
                />
              ) : (
                <>
                  <Seg
                    label="寬度（px）"
                    value={String(width)}
                    onChange={(v) => set('width', Number(v))}
                    options={[
                      ...widthOptions.map((w) => ({ value: String(w), label: String(w) })),
                      { value: '0', label: srcW ? `原尺寸 ${srcW}` : '原尺寸' },
                    ]}
                  />
                  <Seg
                    label="每秒格數（越多越順、檔案越大）"
                    value={String(fps)}
                    onChange={(v) => set('fps', Number(v))}
                    options={fpsOptions.map((f) => ({ value: String(f), label: String(f) }))}
                  />
                  {kind === 'webp' && (
                    <Range label="品質" min={1} max={100} value={settings.quality} onChange={(v) => set('quality', v)} />
                  )}
                  {outW > 0 && outH > 0 && (
                    <p className="muted">
                      輸出 {outW}×{outH}，{fps} fps
                      {length != null && `，約 ${Math.max(1, Math.round(length * fps))} 格`}
                    </p>
                  )}
                  {length != null && length > LONG_ANIM && (
                    <p className="vc-warn">片段有 {spoken(length)}，動圖會很大、也要轉比較久，建議剪短一點或調低寬度、格數。</p>
                  )}
                </>
              )}

              <div className="vc-actions">
                {phase === 'converting' ? (
                  <button type="button" className="secondary" onClick={() => engine.current?.cancel()}>
                    取消
                  </button>
                ) : (
                  <button type="button" disabled={!info || !!clipError || busy} onClick={() => void convert()}>
                    轉成 {KIND_LABEL[kind].split(' ')[0]}
                  </button>
                )}
              </div>

              <div className="vc-status" aria-live="polite">
                {phase === 'loading' && (
                  <>
                    <span>第一次使用要下載轉檔引擎（約 10 MB），之後會留在瀏覽器快取…</span>
                    <Bar value={loadProgress ? loadProgress.loaded / loadProgress.total : null} />
                  </>
                )}
                {phase === 'probing' && <span>讀取影片資訊…</span>}
                {phase === 'converting' && (
                  <>
                    <span>
                      轉檔中{progress != null ? ` ${Math.floor(progress * 100)}%` : '…'}
                      <span className="muted">（電腦越快越快，手機上長片段可能要等一陣子）</span>
                    </span>
                    <Bar value={progress} />
                  </>
                )}
                {error && <p className="error">{error}</p>}
              </div>
            </section>
          </div>
        </>
      )}

      {results.length > 0 && (
        <section className="vc-results">
          <h2>轉好的檔案</h2>
          <ul>
            {results.map((r) => (
              <li key={r.id} className={`vc-result ${r.kind}`}>
                {r.kind === 'mp3' ? (
                  <audio controls src={r.url} preload="metadata" />
                ) : (
                  <div className="vc-result-img">
                    <img src={r.url} alt={r.name} />
                  </div>
                )}
                <div className="vc-result-body">
                  <strong className="vc-ellipsis" title={r.name}>
                    {r.name}
                  </strong>
                  <span className="vc-meta">
                    {formatBytes(r.blob.size)}
                    {r.width && r.height ? ` · ${r.width}×${r.height}` : ''}
                    {r.length != null ? ` · ${spoken(r.length)}` : ''}
                  </span>
                  <span className="vc-meta muted">花了 {spoken(r.took / 1000)}</span>
                  <div className="ik-buttons">
                    <button type="button" onClick={() => downloadBlob(r.blob, r.name)}>
                      下載
                    </button>
                    {r.shareable && (
                      <button type="button" className="secondary" onClick={() => void share(r)}>
                        分享
                      </button>
                    )}
                    <button type="button" className="secondary vc-icon-btn" onClick={() => remove(r)} aria-label={`移除 ${r.name}`}>
                      ✕
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dragging && source && (
        <div className="ik-veil" aria-hidden="true">
          放開就換成這個檔案
        </div>
      )}

      <section className="ik-notes">
        <h2>說明</h2>
        <ul className="muted">
          <li>全部在瀏覽器本機處理，影片不會上傳。用的是 ffmpeg 的 WebAssembly 版（ffmpeg.wasm，GPL），在背景執行緒轉檔，畫面不會卡住。</li>
          <li>第一次加入檔案時要下載轉檔引擎（壓縮後約 10 MB），之後會留在瀏覽器快取。幾 GB 的影片也能讀，只會讀到要轉的那一段。</li>
          <li>
            MP3：192 kbps 一般聽起來就跟原檔差不多，想要最好音質選 320。影片本身的聲音如果是 AAC，轉成 MP3 是重新壓縮，不會比原本更好。
          </li>
          <li>
            GIF 只有 256 色、檔案大，適合幾秒鐘的短片段；同樣的畫面 WebP 通常小很多、顏色也比較準，LINE、Discord 和新版瀏覽器都能播，只有少數舊軟體不支援。
          </li>
          <li>手機的直拍影片會自動轉正。轉檔速度看裝置，電腦大約幾秒到幾十秒，手機會慢一些；轉太久可以按「取消」，縮短片段或調低寬度、格數再試。</li>
        </ul>
      </section>
    </div>
  )
}

function Bar({ value }: { value: number | null }) {
  return (
    <span
      className={`ik-bar vc-bar${value == null ? ' busy' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : Math.round(value * 100)}
    >
      <span style={value == null ? undefined : { width: `${Math.round(value * 100)}%` }} />
    </span>
  )
}
