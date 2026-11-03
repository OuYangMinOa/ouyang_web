import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { copyToClipboard } from '../clipboard'
import './threads.css'

// 不用捷徑、直接在網頁貼網址下載（電腦、Android 也能用）。網址可以帶 ?url= 直接查。
// 後端是捷徑用的同一支 GET /api/threads/video，網頁沒帶金鑰，用登入的帳號，查到的一樣記在下載紀錄。

type Video = { url: string; thumbnail: string; width: number; height: number }
type Post = { code: string; author: string; caption: string; videos: Video[] }

/** 跟 threads.rs 的 COOLDOWN 一樣：同一個 IP 不管成功與否，10 秒只能查一次 */
const COOLDOWN_MS = 10_000

/** 從貼上的文字裡找出 Threads 的網址（分享時常常會連同其他字一起複製） */
const THREADS_URL = /(?:https?:\/\/)?(?:www\.)?threads\.(?:com|net)\/[^\s<>"'，。]+/i

function extractUrl(text: string) {
  // 句尾的標點不是網址的一部分
  return text.match(THREADS_URL)?.[0].replace(/[.,!?;:)\]]+$/, '') ?? null
}

/** 手機上用分享選單存影片（iPhone 選「儲存影片」就會進相簿）；電腦直接下載檔案 */
function shareable(file: File) {
  return matchMedia('(pointer: coarse)').matches && !!navigator.canShare?.({ files: [file] })
}

/** CDN 有開 CORS，可以直接在瀏覽器下載，影片不經過我們的伺服器 */
async function fetchVideo(url: string, signal: AbortSignal, onProgress: (ratio: number | null) => void) {
  const res = await fetch(url, { signal, referrerPolicy: 'no-referrer' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('Content-Length')) || 0
  const reader = res.body.getReader()
  const chunks: BlobPart[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress(total ? loaded / total : null)
  }
  return new Blob(chunks, { type: 'video/mp4' })
}

function saveFile(file: File) {
  const href = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = href
  a.download = file.name
  a.click()
  // 馬上釋放的話有些瀏覽器會下載失敗
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'loading'; progress: number | null }
  /** 手機：檔案已經在記憶體裡，按下去打開分享選單 */
  | { kind: 'ready'; file: File }
  | { kind: 'saved' }
  | { kind: 'failed' }

function VideoCard({ post, video, index }: { post: Post; video: Video; index: number }) {
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const copiedTimer = useRef(0)

  useEffect(
    () => () => {
      abort.current?.abort()
      clearTimeout(copiedTimer.current)
    },
    [],
  )

  const many = post.videos.length > 1
  const name = `threads_${post.author || 'video'}_${post.code}${many ? `_${index + 1}` : ''}.mp4`

  async function share(file: File) {
    try {
      await navigator.share({ files: [file] })
    } catch {
      // 使用者取消，或下載太久、瀏覽器不准自動打開：留著檔案讓他再按一次
    }
  }

  async function download() {
    if (save.kind === 'ready') {
      share(save.file)
      return
    }
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setSave({ kind: 'loading', progress: null })
    try {
      const blob = await fetchVideo(video.url, controller.signal, (progress) => setSave({ kind: 'loading', progress }))
      const file = new File([blob], name, { type: 'video/mp4' })
      if (shareable(file)) {
        setSave({ kind: 'ready', file })
        await share(file)
      } else {
        saveFile(file)
        setSave({ kind: 'saved' })
      }
    } catch {
      if (!controller.signal.aborted) setSave({ kind: 'failed' })
    }
  }

  async function copy() {
    await copyToClipboard(video.url)
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  const label =
    save.kind === 'loading'
      ? `下載中${save.progress === null ? '…' : ` ${Math.round(save.progress * 100)}%`}`
      : save.kind === 'ready'
        ? '分享／儲存影片'
        : save.kind === 'saved'
          ? '已下載 ✓'
          : '下載影片'

  return (
    <li className="th-video">
      <video
        controls
        playsInline
        preload="metadata"
        poster={video.thumbnail || undefined}
        src={video.url}
        style={video.width && video.height ? { aspectRatio: `${video.width} / ${video.height}` } : undefined}
      />
      <div className="th-video-meta">
        {many && <strong>第 {index + 1} 支</strong>}
        {video.width > 0 && (
          <span className="muted">
            {video.width}×{video.height}
          </span>
        )}
      </div>
      <div className="th-actions">
        <button type="button" onClick={download} disabled={save.kind === 'loading'}>
          {label}
        </button>
        <button type="button" className="secondary" onClick={copy}>
          {copied ? '已複製 ✓' : '複製影片網址'}
        </button>
        <a className="th-link-button" href={video.url} target="_blank" rel="noreferrer">
          開啟影片
        </a>
      </div>
      {save.kind === 'failed' && <p className="error">下載失敗，可以按「開啟影片」後再自己存檔。</p>}
    </li>
  )
}

export default function PastePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [input, setInput] = useState(() => searchParams.get('url') ?? '')
  const [post, setPost] = useState<Post | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [readyAt, setReadyAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const started = useRef(false)

  const wait = Math.max(0, Math.ceil((readyAt - now) / 1000))
  const canPaste = typeof navigator.clipboard?.readText === 'function'

  // 冷卻中每秒更新一次倒數
  useEffect(() => {
    if (readyAt <= Date.now()) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= readyAt) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [readyAt])

  async function lookup(text: string) {
    const url = extractUrl(text)
    if (!url) {
      setError('請貼上 Threads 貼文的網址（threads.com 或 threads.net）')
      return
    }
    // 先填進輸入框，冷卻中貼上的網址才不會不見
    setInput(url)
    if (loading) return
    if (wait > 0) {
      setError(`查詢太頻繁，請 ${wait} 秒後再試`)
      return
    }
    setSearchParams({ url }, { replace: true })
    setError('')
    setPost(null)
    setLoading(true)
    const start = Date.now()
    setReadyAt(start + COOLDOWN_MS)
    setNow(start)
    try {
      const res = await fetch(`/api/threads/video?url=${encodeURIComponent(url)}`)
      const body = await res.json().catch(() => ({}))
      if (res.status === 429) {
        const retry = Number(body.retry_after ?? res.headers.get('Retry-After')) || COOLDOWN_MS / 1000
        setReadyAt(Date.now() + retry * 1000)
        setNow(Date.now())
      }
      if (!res.ok) throw new Error(body.error ?? `查詢失敗（HTTP ${res.status}）`)
      setPost(body as Post)
    } catch (e) {
      setError(e instanceof TypeError ? '連不上伺服器，請稍後再試' : e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // 網址帶 ?url= 時直接查；StrictMode 會跑兩次 effect，用 ref 擋掉第二次（不然會撞到冷卻）
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (input) lookup(input)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submit(e: FormEvent) {
    e.preventDefault()
    lookup(input)
  }

  /** 空的輸入框貼上網址就直接查 */
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    if (input.trim()) return
    const url = extractUrl(e.clipboardData.getData('text'))
    if (!url) return
    e.preventDefault()
    lookup(url)
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      if (extractUrl(text)) lookup(text)
      else {
        setInput(text.trim())
        setError('剪貼簿裡沒有 Threads 的網址')
      }
    } catch {
      setError('沒辦法讀取剪貼簿，請直接貼到輸入框')
    }
  }

  const postUrl = post?.author ? `https://www.threads.com/@${post.author}/post/${post.code}` : null

  return (
    <div className="threads">
      <h1>貼網址下載</h1>
      <p className="muted">
        不用裝捷徑：在 Threads 按「分享 → 複製連結」，貼到下面就能抓出貼文裡的影片。電腦和 Android 也能用。
      </p>

      <form className="card th-form" onSubmit={submit}>
        <label htmlFor="threads-url">貼文網址</label>
        <div className="th-input-row">
          <input
            id="threads-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            placeholder="https://www.threads.com/@…/post/…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
          />
          {canPaste && (
            <button type="button" className="secondary" onClick={pasteFromClipboard} disabled={loading}>
              貼上
            </button>
          )}
        </div>
        <button type="submit" className="th-submit" disabled={loading || wait > 0 || !input.trim()}>
          {loading ? '查詢中…' : wait > 0 ? `${wait} 秒後可再查` : '抓影片'}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="muted th-note">
          同一個網路 10 秒只能查一次，跟捷徑共用。影片網址幾天後就會失效，請盡快下載；要登入 Threads
          才看得到的貼文抓不到。
        </p>
      </form>

      {post && (
        <section className="card th-post" aria-live="polite">
          <div className="th-post-head">
            {postUrl ? (
              <a className="text-link" href={postUrl} target="_blank" rel="noreferrer">
                @{post.author}
              </a>
            ) : (
              <span>貼文 {post.code}</span>
            )}
            <span className="muted">{post.videos.length} 支影片</span>
          </div>
          {post.caption && <p className="th-caption">{post.caption}</p>}
          <ul className="th-videos">
            {post.videos.map((video, i) => (
              <VideoCard key={`${post.code}-${i}`} post={post} video={video} index={i} />
            ))}
          </ul>
          <p className="muted th-note">
            已記在 <Link className="text-link" to="/threads/downloads">下載紀錄</Link>。
          </p>
        </section>
      )}
    </div>
  )
}
