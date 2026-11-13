// 影片轉檔：解析 ffmpeg 的輸出、組出轉檔參數。純函式，不碰 worker

export type OutKind = 'mp3' | 'gif' | 'webp'

export type MediaInfo = {
  /** 秒；讀不到（例如串流格式）是 null */
  duration: number | null
  /** 第一條影像（不含封面圖）；寬高已經照旋轉資訊轉正 */
  video: { codec: string; width: number; height: number; fps: number | null } | null
  audio: { codec: string } | null
}

/** 要轉的片段，秒；end 是 null 表示到結尾 */
export type Clip = { start: number; end: number | null }

export type Settings = {
  kind: OutKind
  /** MP3 位元率（kbps） */
  bitrate: number
  /** 動圖每秒幾格 */
  fps: number
  /** 動圖寬度，0 是原尺寸；只縮小不放大 */
  width: number
  /** WebP 品質 1–100 */
  quality: number
}

export const EXT: Record<OutKind, string> = { mp3: 'mp3', gif: 'gif', webp: 'webp' }
export const MIME: Record<OutKind, string> = { mp3: 'audio/mpeg', gif: 'image/gif', webp: 'image/webp' }

/** 「Duration: 00:01:23.45」 */
function parseDuration(text: string): number | null {
  const m = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text)
  if (!m) return null
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return s > 0 ? s : null
}

/** 從 `ffmpeg -i <檔案>` 的輸出讀出長度、影像與聲音 */
export function parseProbe(lines: string[]): MediaInfo {
  const text = lines.join('\n')
  let video: MediaInfo['video'] = null
  let audio: MediaInfo['audio'] = null
  let videoLine = -1

  lines.forEach((line, i) => {
    const m = /Stream #\d+:\d+.*?: (Video|Audio): (\w+)(.*)$/.exec(line)
    if (!m) return
    if (m[1] === 'Audio') {
      audio ??= { codec: m[2] }
      return
    }
    // 音樂檔的專輯封面也是一條 Video，不算
    if (video || /\(attached pic\)/.test(m[3])) return
    const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(m[3])
    if (!size) return
    const fps = /([\d.]+) fps/.exec(m[3])
    video = { codec: m[2], width: Number(size[1]), height: Number(size[2]), fps: fps ? Number(fps[1]) : null }
    videoLine = i
  })

  // 直拍的手機影片：寬高是橫的，另外記旋轉 90 度；ffmpeg 轉檔時會自動轉正
  if (video && videoLine >= 0) {
    const v: NonNullable<MediaInfo['video']> = video
    const after = lines.slice(videoLine + 1, videoLine + 12)
    const end = after.findIndex((l) => /Stream #/.test(l))
    const block = (end >= 0 ? after.slice(0, end) : after).join('\n')
    const rot = /rotation of (-?[\d.]+) degrees/.exec(block) ?? /rotate\s*:\s*(-?\d+)/.exec(block)
    if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) {
      video = { ...v, width: v.height, height: v.width }
    }
  }

  return { duration: parseDuration(text), video, audio }
}

/** 轉檔時的進度：「time=00:00:04.10」，回傳秒 */
export function parseTime(line: string): number | null {
  const m = /time=\s*(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line)
  if (!m || m[1]) return null
  return Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

/** 片段實際長度；整段又不知道長度時是 null */
export function clipLength(clip: Clip, info: MediaInfo): number | null {
  const end = clip.end ?? info.duration
  return end == null ? null : Math.max(0, end - clip.start)
}

function clipArgs(clip: Clip, info: MediaInfo): string[] {
  const args: string[] = []
  // 放在 -i 前面：直接跳到附近的關鍵格再解碼，長影片從中間開始也很快，而且時間一樣精準
  if (clip.start > 0) args.push('-ss', clip.start.toFixed(3))
  const toEnd = clip.end == null || (info.duration != null && clip.end >= info.duration - 0.001)
  if (!toEnd) args.push('-t', (clip.end! - clip.start).toFixed(3))
  return args
}

/** 動圖的畫格與縮放；只縮小不放大 */
function frameFilters(s: Settings, info: MediaInfo): string {
  const srcFps = info.video?.fps
  const fps = srcFps && srcFps > 0 ? Math.min(s.fps, srcFps) : s.fps
  const filters = [`fps=${fps}`]
  const srcW = info.video?.width ?? 0
  if (s.width > 0 && (srcW === 0 || s.width < srcW)) {
    filters.push(srcW ? `scale=${s.width}:-1:flags=lanczos` : `scale='min(${s.width},iw)':-1:flags=lanczos`)
  }
  return filters.join(',')
}

/** 一次 ffmpeg 指令；weight 是它佔整體進度的比例 */
export type Pass = { args: string[]; weight: number }

/** GIF 第一趟算出來的調色盤 */
export const PALETTE = '/palette.png'

/** 要依序執行的 ffmpeg 指令（ffmpeg.wasm 會自己加上 -nostdin -y） */
export function buildPasses(input: string, output: string, clip: Clip, info: MediaInfo, s: Settings): Pass[] {
  const head = ['-hide_banner', ...clipArgs(clip, info), '-i', input]
  switch (s.kind) {
    case 'mp3':
      return [
        {
          weight: 1,
          args: [
            ...head,
            '-map', '0:a:0',
            '-c:a', 'libmp3lame',
            '-b:a', `${s.bitrate}k`,
            // ID3v2.3：Windows 檔案總管和舊的播放器才讀得到標題
            '-id3v2_version', '3',
            output,
          ],
        },
      ]
    case 'gif': {
      // 分兩趟：一趟裡 split 給 palettegen 和 paletteuse 的話，調色盤要等整段讀完才出來，
      // 這之前的每一格都得先放在記憶體（原尺寸 1080p 幾秒就超過 wasm 的上限），進度也一直停在 0%。
      // 第一趟只統計顏色，另外接一個丟掉的輸出，ffmpeg 才會一路回報讀到哪；第二趟再讀一次套上調色盤。
      // stats_mode=diff 只統計有變動的地方，畫面裡會動的東西顏色比較準；
      // bayer 抖色比誤差擴散小很多，diff_mode=rectangle 只重畫有變的區塊，檔案也比較小
      const frames = frameFilters(s, info)
      return [
        {
          weight: 0.4,
          args: [
            ...head,
            '-filter_complex', `[0:V:0]${frames},split[a][b];[a]palettegen=stats_mode=diff[p]`,
            '-map', '[p]', '-update', '1', PALETTE,
            '-map', '[b]', '-f', 'null', '-',
          ],
        },
        {
          weight: 0.6,
          args: [
            ...head,
            '-i', PALETTE,
            '-filter_complex', `[0:V:0]${frames}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
            '-loop', '0',
            output,
          ],
        },
      ]
    }
    case 'webp':
      // libwebp 一格一格寫出去，不會累積在記憶體
      return [
        {
          weight: 1,
          args: [
            ...head,
            '-map', '0:V:0',
            '-vf', frameFilters(s, info),
            '-c:v', 'libwebp',
            '-lossless', '0',
            '-quality', String(s.quality),
            '-compression_level', '4',
            '-loop', '0',
            output,
          ],
        },
      ]
  }
}

/** 轉檔失敗時，從 ffmpeg 的輸出挑一句看得懂的說明 */
export function explainFailure(lines: string[], kind: OutKind): string {
  const text = lines.join('\n')
  if (/matches no streams/.test(text)) {
    return kind === 'mp3' ? '這個檔案沒有聲音。' : '這個檔案沒有畫面，只能轉成 MP3。'
  }
  if (/Invalid data found when processing input|could not find codec parameters|moov atom not found/i.test(text)) {
    return '讀不懂這個檔案，可能不是影片，或是檔案不完整。'
  }
  if (/Decoder .* not found|Unsupported codec|no decoder/i.test(text)) {
    return '這部影片用的編碼轉檔引擎不支援。'
  }
  if (/Cannot allocate memory|out of memory|OOM/i.test(text)) {
    return '記憶體不足：試試縮短片段、調低寬度或每秒格數。'
  }
  const last = lines.filter((l) => l.trim()).at(-1)
  return `轉檔失敗${last ? `：${last.trim()}` : '。'}`
}

/** 「1:23.5」「83.5」「1:02:03」都可以；看不懂回傳 NaN，空白回傳 null */
export function parseClock(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  if (!/^\d+(:\d{1,2}){0,2}(\.\d*)?$/.test(t)) return NaN
  return t.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}

/** 秒 → 「1:23.5」（滿一小時是「1:02:03.4」） */
export function formatClock(sec: number, digits = 1): string {
  // 先四捨五入到要顯示的位數再拆，59.96 才會變成 1:00.0 而不是 0:60.0
  const scale = 10 ** digits
  const total = Math.round(Math.max(0, sec) * scale) / scale
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const [int, frac] = (total % 60).toFixed(digits).split('.')
  const ss = int.padStart(2, '0') + (frac ? `.${frac}` : '')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
