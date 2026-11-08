// 背景音樂：和其他音效一樣用 Web Audio 即時合成，不用下載音檔。
// 每條賽道一首（速度、調性、和弦進行、音色不同）：鼓、貝斯、和弦、琶音、主旋律五軌，8 小節一輪。
// 主旋律照賽道自己的種子產生，同一條賽道每次聽到的都一樣。
// 選單時只有和弦、琶音和輕輕的貝斯；起跑後整首進來；最後一圈鼓變密、旋律高八度。
// 排程用「提早一點排好接下來的音」的做法：計時器每 40 毫秒看一次，把 0.2 秒內要響的音先排進 AudioContext。

export type MusicMood = 'menu' | 'race' | 'final'

type Song = {
  bpm: number
  /** 主音（MIDI 音高，第 3 個八度附近） */
  root: number
  /** 音階（半音） */
  scale: number[]
  /** 8 小節，每小節的和弦（音階的第幾級，0 起算） */
  chords: number[]
  seed: number
  /** 貝斯：`pump` 八分音符一低一高（合成器浪潮），`drive` 一直彈根音（搖滾） */
  bass: 'pump' | 'drive'
  lead: OscillatorType
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]

const SONGS: Record<string, Song> = {
  // 海岸：明亮的大調，I–V–vi–IV
  coast: { bpm: 124, root: 52, scale: MAJOR, chords: [0, 4, 5, 3, 0, 4, 3, 4], seed: 11, bass: 'pump', lead: 'square' },
  // 峽谷：小調搖滾，i–VI–III–VII
  canyon: { bpm: 138, root: 45, scale: MINOR, chords: [0, 5, 2, 6, 0, 5, 6, 4], seed: 23, bass: 'drive', lead: 'sawtooth' },
  // 夜城：合成器浪潮，i–VI–III–VII 再轉到 iv–v
  city: { bpm: 108, root: 50, scale: MINOR, chords: [0, 5, 2, 6, 0, 5, 3, 4], seed: 37, bass: 'pump', lead: 'sawtooth' },
  // 台北信義：傍晚的城市流行，IV–V–iii–vi（王道進行）再接 ii–V–I
  xinyi: { bpm: 116, root: 53, scale: MAJOR, chords: [3, 4, 2, 5, 1, 4, 0, 4], seed: 53, bass: 'pump', lead: 'triangle' },
}

const BARS = 8
const STEPS = 16
/** 提早排多久（秒） */
const AHEAD = 0.2
/** 音樂整體的音量；選單時小聲一點，暫停時再小聲 */
const VOLUME = 0.32
const MOOD_VOLUME: Record<MusicMood, number> = { menu: 0.55, race: 1, final: 1 }
const PAUSED = 0.35

type Note = { step: number; deg: number; len: number }

/** 小節裡的節奏：[第幾個十六分音符開始, 長幾個十六分音符] */
const RHYTHMS: [number, number][][] = [
  [
    [0, 3],
    [3, 3],
    [6, 2],
    [8, 4],
    [12, 4],
  ],
  [
    [0, 2],
    [2, 2],
    [4, 4],
    [10, 2],
    [12, 4],
  ],
  [
    [0, 6],
    [6, 2],
    [8, 2],
    [10, 6],
  ],
  [
    [2, 2],
    [4, 2],
    [6, 4],
    [12, 2],
    [14, 2],
  ],
  [
    [0, 2],
    [2, 2],
    [4, 2],
    [6, 2],
    [8, 8],
  ],
]
/** 每四小節最後一小節：拉長收尾 */
const ENDING: [number, number][] = [
  [0, 4],
  [4, 4],
  [8, 8],
]

/** 固定種子的亂數（mulberry32） */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 主旋律：前兩小節是主題，第三小節用第一小節的節奏換音，第四小節收尾；後四小節換一組節奏。
 * 每小節第一個音、落在拍子上的音用和弦內音，其他的音一級一級往上往下走
 */
function compose(song: Song): Note[] {
  const rnd = random(song.seed)
  const pick = <T>(items: T[]) => items[Math.floor(rnd() * items.length)]
  const notes: Note[] = []
  let deg = 4
  for (let half = 0; half < 2; half++) {
    const a = pick(RHYTHMS)
    const b = pick(RHYTHMS)
    const rhythms = [a, b, a, ENDING]
    for (let k = 0; k < 4; k++) {
      const bar = half * 4 + k
      const chord = song.chords[bar]
      const tones = [chord, chord + 2, chord + 4, chord + 7, chord + 9]
      rhythms[k].forEach(([step, len], i) => {
        if (i === 0 || step % 4 === 0) {
          // 和弦內音裡離上一個音最近的（偶爾跳遠一點）
          const near = tones.map((t) => ({ t, d: Math.abs(t - deg) })).sort((x, y) => x.d - y.d)
          deg = near[rnd() < 0.75 ? 0 : 1].t
        } else {
          deg += pick([-2, -1, -1, 1, 1, 2])
        }
        deg = Math.max(0, Math.min(11, deg))
        notes.push({ step: bar * STEPS + step, deg, len })
      })
    }
  }
  return notes
}

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12)

export class Music {
  private readonly ctx: AudioContext
  private readonly out: GainNode
  private readonly bus: GainNode
  /** 和弦另外一路：大鼓打下去時壓低一點，聽起來一抽一抽的 */
  private readonly padBus: GainNode
  private readonly echo: GainNode
  private readonly delay: DelayNode
  private readonly noise: AudioBuffer
  private song: Song = SONGS.coast
  private melody: Note[] = compose(SONGS.coast)
  private mood: MusicMood = 'menu'
  private enabled: boolean
  private paused = false
  private step = 0
  private next = 0
  private timer = 0

  constructor(ctx: AudioContext, noise: AudioBuffer, enabled: boolean) {
    this.ctx = ctx
    this.noise = noise
    this.enabled = enabled
    this.out = ctx.createGain()
    this.out.gain.value = 0
    this.out.connect(ctx.destination)
    this.bus = ctx.createGain()
    this.bus.connect(this.out)
    this.padBus = ctx.createGain()
    this.padBus.connect(this.bus)
    // 回音：琶音和旋律送一點進來，延遲一個附點八分音符
    const delay = ctx.createDelay(1)
    delay.delayTime.value = (60 / this.song.bpm) * 0.75
    const feedback = ctx.createGain()
    feedback.gain.value = 0.32
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 2400
    this.echo = ctx.createGain()
    this.echo.gain.value = 1
    this.echo.connect(delay)
    delay.connect(tone)
    tone.connect(feedback).connect(delay)
    tone.connect(this.bus)
    this.delay = delay
    this.applyVolume(0.01)
    this.timer = window.setInterval(this.pump, 40)
  }

  setEnabled(on: boolean) {
    this.enabled = on
    this.applyVolume(0.15)
    if (on) this.next = 0
  }

  setPaused(paused: boolean) {
    this.paused = paused
    this.applyVolume(0.2)
  }

  /** 換賽道的歌：從頭開始 */
  setSong(id: string) {
    const song = SONGS[id] ?? SONGS.coast
    if (song === this.song) return
    this.song = song
    this.melody = compose(song)
    this.delay.delayTime.setTargetAtTime((60 / song.bpm) * 0.75, this.ctx.currentTime, 0.05)
    this.restart()
  }

  /** 起跑時整首從頭開始；最後一圈、跑完時接著彈 */
  setMood(mood: MusicMood) {
    if (mood === this.mood) return
    const start = this.mood === 'menu' && mood === 'race'
    this.mood = mood
    this.applyVolume(0.3)
    if (start) this.restart()
  }

  dispose() {
    window.clearInterval(this.timer)
    this.out.disconnect()
  }

  private restart() {
    this.step = 0
    this.next = 0
  }

  private applyVolume(time: number) {
    const v = this.enabled ? VOLUME * MOOD_VOLUME[this.mood] * (this.paused ? PAUSED : 1) : 0
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, time)
  }

  /** 把接下來 `AHEAD` 秒內的音排好 */
  private readonly pump = () => {
    const ctx = this.ctx
    if (!this.enabled || ctx.state !== 'running') return
    const now = ctx.currentTime
    const sixteenth = 60 / this.song.bpm / 4
    // 剛開始、或計時器被拖慢（切到背景）：從現在接著排，漏掉的就不補
    if (this.next < now) this.next = now + 0.05
    while (this.next < now + AHEAD) {
      this.play(this.step % (BARS * STEPS), this.next, sixteenth)
      this.step++
      this.next += sixteenth
    }
  }

  private play(step: number, t: number, sixteenth: number) {
    const song = this.song
    const bar = Math.floor(step / STEPS)
    const s = step % STEPS
    const chord = song.chords[bar]
    const note = (deg: number, octave: number) =>
      song.root + octave * 12 + song.scale[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7)
    const menu = this.mood === 'menu'
    const final = this.mood === 'final'

    // 鼓
    if (!menu) {
      if (s % 4 === 0) this.kick(t)
      if (final && s === 14 && bar % 2 === 1) this.kick(t)
      if (s === 4 || s === 12) this.snare(t, 0.26)
      if (song.bass === 'drive' && s === 15 && bar % 4 === 3) this.snare(t, 0.14)
      if (final) this.hat(t, s % 4 === 2 ? 0.07 : 0.035, s % 4 === 2)
      else if (s % 4 === 2) this.hat(t, 0.06, false)
      if (s === 0 && bar % 4 === 0) this.crash(t, final ? 0.13 : 0.08)
    } else if (s % 4 === 2) this.hat(t, 0.025, false)

    // 貝斯：八分音符
    if (s % 2 === 0) {
      const root = note(chord, -1)
      if (menu) {
        if (s % 8 === 0) this.bass(t, root, sixteenth * 7, 0.11)
      } else {
        const up = song.bass === 'pump' && s % 4 === 2
        this.bass(t, up ? root + 12 : root, sixteenth * 1.7, 0.15)
      }
    }

    // 和弦：每小節一個，三個音
    if (s === 0) {
      const tones = [note(chord, 0), note(chord + 2, 0), note(chord + 4, 0)]
      this.pad(t, tones, sixteenth * STEPS, menu ? 0.05 : 0.04)
    }

    // 琶音：十六分音符繞著和弦內音跑
    const arp = [0, 2, 4, 7, 4, 2]
    if (menu ? s % 2 === 0 : true) this.pluck(t, note(chord + arp[s % arp.length], 1), menu ? 0.04 : 0.028)

    // 主旋律
    if (!menu) {
      for (const n of this.melody) {
        if (n.step === step) this.lead(t, note(n.deg, final ? 2 : 1), n.len * sixteenth * 0.92)
      }
    }
  }

  private env(t: number, peak: number, attack: number, length: number): GainNode {
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + length)
    return g
  }

  private kick(t: number) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(140, t)
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.12)
    const g = this.env(t, 0.55, 0.004, 0.32)
    osc.connect(g).connect(this.bus)
    osc.start(t)
    osc.stop(t + 0.35)
    // 和弦跟著壓一下再回來
    this.padBus.gain.cancelScheduledValues(t)
    this.padBus.gain.setValueAtTime(0.35, t)
    this.padBus.gain.linearRampToValueAtTime(1, t + 0.24)
  }

  private noiseHit(t: number, type: BiquadFilterType, freq: number, peak: number, length: number) {
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = freq
    const g = this.env(t, peak, 0.002, length)
    src.connect(filter).connect(g).connect(this.bus)
    src.start(t, Math.random() * 0.5)
    src.stop(t + length + 0.02)
  }

  private snare(t: number, peak: number) {
    this.noiseHit(t, 'highpass', 1500, peak, 0.17)
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(210, t)
    osc.frequency.exponentialRampToValueAtTime(130, t + 0.08)
    const g = this.env(t, peak * 0.7, 0.002, 0.1)
    osc.connect(g).connect(this.bus)
    osc.start(t)
    osc.stop(t + 0.12)
  }

  private hat(t: number, peak: number, open: boolean) {
    this.noiseHit(t, 'highpass', 7500, peak, open ? 0.2 : 0.045)
  }

  private crash(t: number, peak: number) {
    this.noiseHit(t, 'highpass', 4500, peak, 1.3)
  }

  private bass(t: number, midi: number, length: number, peak: number) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = midiHz(midi)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.Q.value = 6
    filter.frequency.setValueAtTime(900, t)
    filter.frequency.exponentialRampToValueAtTime(240, t + Math.min(length, 0.25))
    const g = this.env(t, peak, 0.005, length)
    osc.connect(filter).connect(g).connect(this.bus)
    osc.start(t)
    osc.stop(t + length + 0.02)
  }

  private pad(t: number, notes: number[], length: number, peak: number) {
    const ctx = this.ctx
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 1300
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(peak, t + 0.25)
    g.gain.setValueAtTime(peak, t + length - 0.1)
    g.gain.exponentialRampToValueAtTime(0.0001, t + length + 0.35)
    filter.connect(g).connect(this.padBus)
    for (const m of notes) {
      for (const detune of [-8, 8]) {
        const osc = ctx.createOscillator()
        osc.type = 'sawtooth'
        osc.frequency.value = midiHz(m)
        osc.detune.value = detune
        osc.connect(filter)
        osc.start(t)
        osc.stop(t + length + 0.4)
      }
    }
  }

  private pluck(t: number, midi: number, peak: number) {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = midiHz(midi)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 2600
    const g = this.env(t, peak, 0.003, 0.14)
    osc.connect(filter).connect(g)
    g.connect(this.bus)
    g.connect(this.echo)
    osc.start(t)
    osc.stop(t + 0.16)
  }

  private lead(t: number, midi: number, length: number) {
    const ctx = this.ctx
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 3200
    const g = ctx.createGain()
    const peak = 0.075
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(peak, t + 0.01)
    g.gain.setValueAtTime(peak * 0.8, t + Math.max(0.02, length - 0.04))
    g.gain.exponentialRampToValueAtTime(0.0001, t + length + 0.08)
    filter.connect(g)
    g.connect(this.bus)
    const send = ctx.createGain()
    send.gain.value = 0.45
    g.connect(send).connect(this.echo)
    for (const [type, detune] of [
      [this.song.lead, -5],
      ['square', 6],
    ] as [OscillatorType, number][]) {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.value = midiHz(midi)
      osc.detune.value = detune
      osc.connect(filter)
      osc.start(t)
      osc.stop(t + length + 0.1)
    }
  }
}
