/**
 * 遊戲的背景音樂（所有小遊戲共用），用 Web Audio 即時合成，不需要音檔。
 *
 * 每首曲子寫旋律和每小節的低音根音，再挑一套編制配合遊戲的性質：
 * - `lead`：主旋律的樂器（古箏、手風琴、電鋼琴、8-bit 方波…，見 `INSTRUMENTS`）
 * - `bassStyle`：低音怎麼彈（長音、每拍跳、爵士走路低音、蹦恰恰…，見 `BASS_STYLES`）
 * - `drums`：要不要打節奏、打哪一種（見 `DRUM_STYLES`）；鼓聲不過低通也不加回音，才不會糊
 * - `bar`：一小節幾個八分音符，預設 8（四四拍），小步舞曲是 6（四三拍）
 * - `swing`：反拍往後拖，爵士、lo-fi 用
 * 沒寫的就用預設：`calm`（棋類、慢慢想的遊戲）是音樂盒加長音低音，其他是鐘琴加每拍跳的低音，都不打鼓。
 *
 * 排程以八分音符為單位，旋律、低音、鼓一起走，中途變速也不會對不齊。用「往前看」的做法：
 * 每 50ms 檢查一次，把接下來 0.2 秒內要響的音先排進 AudioContext，計時器有點延遲也不會走音。
 */

import { useCallback, useEffect, useState } from 'react'
import { load, save } from './storage'

/** [音名, 長度（八分音符數）]；音名 null 是休止 */
export type Note = [string | null, number]

export type Song = {
  melody: Note[]
  /** 每小節的低音根音；旋律的總長要剛好是小節數 × `bar` */
  bass: string[]
  /** 等級 1 的速度、每升一級快多少、最快多少（BPM，以四分音符算） */
  bpm: number
  bpmPerLevel: number
  maxBpm: number
  /** 柔和版：比較小聲、比較悶、回音長一點，預設的樂器也換成音樂盒 */
  calm?: boolean
  /** 一小節幾個八分音符，預設 8 */
  bar?: number
  lead?: InstrumentName
  bassStyle?: BassStyle
  /** 低音用的樂器，預設是正弦波 */
  bassTone?: InstrumentName
  drums?: DrumStyle
  /** 反拍的八分音符往後延多少個八分音符（0～1/3） */
  swing?: number
  mix?: Partial<Mix>
}

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

function midi(name: string): number {
  const m = /^([A-G])(#?)(\d)$/.exec(name)!
  return (Number(m[3]) + 1) * 12 + SEMITONES[m[1]] + (m[2] ? 1 : 0)
}

function frequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12)
}

export function tempo(song: Song, level: number): number {
  return Math.min(song.bpm + (level - 1) * song.bpmPerLevel, song.maxBpm)
}

const LOOKAHEAD_S = 0.2
const TIMER_MS = 50

// ── 混音 ──────────────────────────────────────────────

type Mix = {
  volume: number
  /** 旋律和低音最後過的低通濾波器：越低越悶、越柔 */
  lowpass: number
  /** 回音：間隔、每次剩多少、混進來多少 */
  echo: number
  echoFeedback: number
  echoMix: number
  /** 鼓相對於旋律的音量 */
  drums: number
}

const LIVELY: Mix = { volume: 0.14, lowpass: 2000, echo: 0.24, echoFeedback: 0.25, echoMix: 0.15, drums: 2.5 }
const CALM: Mix = { volume: 0.09, lowpass: 2000, echo: 0.36, echoFeedback: 0.3, echoMix: 0.22, drums: 2.5 }

// ── 樂器 ──────────────────────────────────────────────

type Layer = {
  type: OscillatorType
  /** 頻率是音高的幾倍（泛音），預設 1 */
  ratio?: number
  gain?: number
  /** 微調（cents），兩層一高一低會有合唱、手風琴那種晃動 */
  detune?: number
  /** 這一層幾秒內自己消失（木琴、電鋼琴敲下去那一下的金屬聲） */
  decay?: number
}

type Instrument = {
  layers: Layer[]
  attack: number
  /** 起音後幾秒衰減到 `sustain`；沒寫就是用整個音的長度慢慢衰減（鐘琴） */
  decay?: number
  sustain: number
  release: number
  /** 每個音自己的低通：起音時截止頻率是音高的 `from` 倍，`time` 秒內變成 `to` 倍（撥弦會越撥越悶） */
  filter?: { from: number; to: number; time: number }
  /** 顫音：`delay` 秒後開始，每秒晃 `rate` 下，上下 `cents` */
  vibrato?: { rate: number; cents: number; delay: number }
  /** 音量忽大忽小（電鋼琴、鐵琴） */
  tremolo?: { rate: number; depth: number }
  /** 起音從低 `cents` 滑上來（古箏的滑音） */
  bend?: { cents: number; time: number }
}

const INSTRUMENTS = {
  /** 鐘琴：敲下去整個音慢慢變小（俄羅斯方塊、魔法氣泡、沒指定樂器的熱鬧曲子） */
  bell: { layers: [{ type: 'triangle' }], attack: 0.012, sustain: 0.35, release: 0.12 },
  /** 音樂盒：同上但起音軟一點、餘音長（沒指定樂器的柔和曲子） */
  musicbox: { layers: [{ type: 'triangle' }], attack: 0.03, sustain: 0.45, release: 0.7 },
  /** 木琴：一敲就收，帶一點木頭的高泛音 */
  marimba: {
    layers: [
      { type: 'sine', gain: 1.7 },
      { type: 'sine', ratio: 4, gain: 0.5, decay: 0.06 },
    ],
    attack: 0.003,
    decay: 0.6,
    sustain: 0.02,
    release: 0.12,
  },
  /** 撥弦（弦樂撥奏）：短、輕，適合躡手躡腳 */
  pizz: {
    layers: [
      { type: 'sawtooth', gain: 1.2 },
      { type: 'triangle', gain: 1.5 },
    ],
    attack: 0.003,
    decay: 0.3,
    sustain: 0.02,
    release: 0.08,
    filter: { from: 7, to: 1.6, time: 0.12 },
  },
  /** 古箏：撥下去先往上滑一點，越響越悶，長音會揉弦 */
  zither: {
    layers: [
      { type: 'sawtooth', gain: 0.52 },
      { type: 'triangle', gain: 0.82 },
    ],
    attack: 0.003,
    decay: 1.3,
    sustain: 0.06,
    release: 0.3,
    filter: { from: 9, to: 1.8, time: 0.45 },
    bend: { cents: 45, time: 0.07 },
    vibrato: { rate: 5.5, cents: 14, delay: 0.35 },
  },
  /** 簫、笛：吹出來的軟音，起音慢、有顫音 */
  flute: {
    layers: [
      { type: 'sine', gain: 0.75 },
      { type: 'triangle', ratio: 2, gain: 0.06 },
    ],
    attack: 0.09,
    decay: 0.4,
    sustain: 0.75,
    release: 0.22,
    vibrato: { rate: 5, cents: 16, delay: 0.22 },
  },
  /** 電鋼琴：圓圓的、有一點金屬尾音，會微微晃 */
  epiano: {
    layers: [
      { type: 'sine', gain: 0.9 },
      { type: 'sine', ratio: 2, gain: 0.2, decay: 0.5 },
      { type: 'triangle', ratio: 4, gain: 0.045, decay: 0.12 },
    ],
    attack: 0.006,
    decay: 1.2,
    sustain: 0.25,
    release: 0.35,
    tremolo: { rate: 4.5, depth: 0.18 },
  },
  /** 鐵琴：比電鋼琴亮、晃得更明顯，諜報片那種 */
  vibes: {
    layers: [{ type: 'sine' }, { type: 'sine', ratio: 4, gain: 0.16, decay: 0.3 }],
    attack: 0.004,
    decay: 1.6,
    sustain: 0.15,
    release: 0.6,
    tremolo: { rate: 5.5, depth: 0.4 },
  },
  /** 8-bit 方波：紅白機那種 */
  chip: { layers: [{ type: 'square', gain: 0.72 }], attack: 0.002, decay: 0.15, sustain: 0.6, release: 0.03 },
  /** 手風琴：兩組簧片一高一低，會晃 */
  accordion: {
    layers: [
      { type: 'sawtooth', gain: 0.7, detune: -7 },
      { type: 'sawtooth', gain: 0.7, detune: 7 },
    ],
    attack: 0.03,
    decay: 0.25,
    sustain: 0.8,
    release: 0.08,
    filter: { from: 5, to: 4, time: 0.1 },
  },
  /** 銅管：起音時聲音慢慢打開 */
  brass: {
    layers: [
      { type: 'sawtooth', gain: 0.95 },
      { type: 'sawtooth', gain: 0.45, detune: 6 },
    ],
    attack: 0.04,
    decay: 0.3,
    sustain: 0.7,
    release: 0.12,
    filter: { from: 1.2, to: 4.5, time: 0.09 },
    vibrato: { rate: 5, cents: 8, delay: 0.3 },
  },
  /** 弦樂合奏：短短的弓，起音快一點八分音符才不會糊在一起，餘音留長，像夜裡的霧 */
  strings: {
    layers: [
      { type: 'sawtooth', gain: 0.64, detune: -9 },
      { type: 'sawtooth', gain: 0.64, detune: 9 },
    ],
    attack: 0.06,
    decay: 0.5,
    sustain: 0.8,
    release: 0.4,
    filter: { from: 3, to: 3, time: 0.1 },
    vibrato: { rate: 5.5, cents: 10, delay: 0.2 },
  },
  /** 大鍵琴：很亮、撥一下就收，巴洛克味 */
  harpsichord: {
    layers: [
      { type: 'sawtooth', gain: 1.7 },
      { type: 'square', ratio: 2, gain: 0.45 },
    ],
    attack: 0.002,
    decay: 0.9,
    sustain: 0.05,
    release: 0.1,
    filter: { from: 12, to: 3, time: 0.5 },
  },
  /** 單簧管：方波的空心木管聲，有點傻氣也有點狡猾 */
  reed: {
    layers: [
      { type: 'square', gain: 0.34 },
      { type: 'sine', gain: 0.34 },
    ],
    attack: 0.025,
    decay: 0.25,
    sustain: 0.75,
    release: 0.08,
    filter: { from: 4, to: 3, time: 0.1 },
    vibrato: { rate: 5, cents: 6, delay: 0.3 },
  },
  /** 流行樂的合成器撥音：亮、彈 */
  synth: {
    layers: [
      { type: 'sawtooth', gain: 1, detune: -10 },
      { type: 'square', gain: 0.63, detune: 10 },
    ],
    attack: 0.004,
    decay: 0.4,
    sustain: 0.25,
    release: 0.1,
    filter: { from: 9, to: 2.5, time: 0.25 },
  },

  // 低音用的
  /** 正弦波低音（`bell` 的低音版） */
  sub: { layers: [{ type: 'sine' }], attack: 0.012, sustain: 0.35, release: 0.12 },
  /** 正弦波低音（`musicbox` 的低音版） */
  softSub: { layers: [{ type: 'sine' }], attack: 0.03, sustain: 0.45, release: 0.7 },
  /** 低音提琴撥弦：爵士的走路低音 */
  upright: {
    layers: [
      { type: 'triangle', gain: 0.9 },
      { type: 'sine', gain: 0.56 },
    ],
    attack: 0.006,
    decay: 0.5,
    sustain: 0.15,
    release: 0.08,
    filter: { from: 8, to: 2, time: 0.2 },
  },
  /** 低音號：蹦恰恰、進行曲的「蹦」 */
  tuba: {
    layers: [
      { type: 'sawtooth', gain: 0.4 },
      { type: 'sine', gain: 0.8 },
    ],
    attack: 0.025,
    decay: 0.3,
    sustain: 0.6,
    release: 0.08,
    filter: { from: 3, to: 3, time: 0.1 },
  },
  /** 紅白機的三角波低音 */
  nes: { layers: [{ type: 'triangle', gain: 1.33 }], attack: 0.002, decay: 0.1, sustain: 0.8, release: 0.02 },
} satisfies Record<string, Instrument>

export type InstrumentName = keyof typeof INSTRUMENTS

// ── 低音 ──────────────────────────────────────────────

/** 一小節的和弦：根音、下一小節的根音（MIDI 音高）；三度是大三度 4、小三度 3，看不出來是 null */
type Chord = { root: number; next: number; third: 3 | 4 | null }

/** 小節裡這個八分音符要彈的低音：`notes` 是離根音幾個半音，`chord` 的音用主旋律的樂器彈 */
type BassHit = { notes: number[]; len: number; vol: number; chord?: boolean }

type BassPattern = (i: number, bar: number, c: Chord) => BassHit | null

/** 和弦內音（三度、五度）放到 E3～D#4 之間，不要壓到旋律也不要太糊；看不出大小調就用八度代替三度 */
function chordTones(c: Chord): number[] {
  return [c.third ?? 12, 7].map((x) => {
    let note = c.root + x
    while (note < 52) note += 12
    while (note >= 64) note -= 12
    return note - c.root
  })
}

const BASS_STYLES = {
  /** 每小節彈根音、五度兩下，拖長（柔和曲子的預設） */
  pedal: (i, bar) => {
    if (i === 0) return { notes: [0], len: bar === 8 ? 3.6 : bar * 0.9, vol: 0.7 }
    if (bar === 8 && i === 4) return { notes: [7], len: 3.6, vol: 0.7 }
    return null
  },
  /** 每拍一下，根音和高八度交替（熱鬧曲子的預設） */
  bounce: (i) => (i % 2 ? null : { notes: [i % 4 ? 12 : 0], len: 1.6, vol: 0.8 }),
  /** 根音加五度一起按住整個小節：禪、夜晚、古風 */
  drone: (i, bar) => (i === 0 ? { notes: [0, 7], len: bar * 0.98, vol: 0.4 } : null),
  /**
   * 爵士的走路低音：每拍一個音，根音、三度、五度（看不出大小調就是根音、五度、八度），
   * 最後一拍差半音靠到下一個和弦：下一個根音比較低就從上面靠，比較高就從下面靠
   */
  walk: (i, bar, c) => {
    if (i % 2) return null
    const beat = i / 2
    if (beat < bar / 2 - 1) return { notes: [(c.third ? [0, c.third, 7] : [0, 7, 12])[beat]], len: 1.8, vol: 0.75 }
    const approach = c.next === c.root ? -1 : c.next < c.root + 7 ? c.next + 1 - c.root : c.next - 1 - c.root
    return { notes: [approach], len: 1.8, vol: 0.75 }
  },
  /** 蹦恰恰：低音在一、三拍（三拍子只有第一拍），其他拍用和弦短短地「恰」一下 */
  oompah: (i, bar, c) => {
    if (i % 2) return null
    if (i === 0) return { notes: [0], len: 1.6, vol: 0.85 }
    if (bar === 8 && i === 4) return { notes: [c.root >= 48 ? -5 : 7], len: 1.6, vol: 0.8 }
    return { notes: chordTones(c), len: 0.7, vol: 0.28, chord: true }
  },
  /** 8-bit：每個八分音符都彈，根音和高八度一直跳 */
  chip: (i) => ({ notes: [i % 2 ? 12 : 0], len: 0.75, vol: 0.55 }),
} satisfies Record<string, BassPattern>

export type BassStyle = keyof typeof BASS_STYLES

// ── 鼓 ────────────────────────────────────────────────

type Drum = 'kick' | 'snare' | 'hat' | 'shaker' | 'clap' | 'snap' | 'brush' | 'ride' | 'blockHigh' | 'blockLow'

/** [小節裡第幾個八分音符（可以是 3.5 這種十六分音符）, 鼓, 音量] */
type DrumHit = [number, Drum, number]

const OFFBEATS = [1, 3, 5, 7]

const DRUM_STYLES = {
  none: [],
  /** 沙鈴打反拍、大鼓輕輕點一三拍：輕鬆的派對 */
  light: [[0, 'kick', 0.45], [4, 'kick', 0.35], ...OFFBEATS.map((i): DrumHit => [i, 'shaker', 0.35])],
  /** 流行樂：大鼓、拍手、鈸 */
  pop: [
    [0, 'kick', 0.75],
    [3, 'kick', 0.35],
    [4, 'kick', 0.65],
    [2, 'clap', 0.55],
    [6, 'clap', 0.55],
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): DrumHit => [i, 'hat', i % 2 ? 0.3 : 0.18]),
  ],
  /** 酒館：每拍跺腳、二四拍拍手 */
  stomp: [
    [0, 'kick', 0.75],
    [2, 'kick', 0.55],
    [4, 'kick', 0.75],
    [6, 'kick', 0.55],
    [2, 'clap', 0.5],
    [6, 'clap', 0.5],
  ],
  /** 進行曲：小鼓滾奏、大鼓在一三拍 */
  march: [
    [0, 'kick', 0.5],
    [4, 'kick', 0.4],
    [0, 'snare', 0.45],
    [2, 'snare', 0.26],
    [3, 'snare', 0.16],
    [3.5, 'snare', 0.16],
    [4, 'snare', 0.4],
    [6, 'snare', 0.26],
    [7, 'snare', 0.16],
    [7.5, 'snare', 0.19],
  ],
  /** 爵士鼓刷：叮、叮咑、叮，二四拍刷一下 */
  brush: [
    [0, 'ride', 0.4],
    [2, 'ride', 0.45],
    [3, 'ride', 0.25],
    [4, 'ride', 0.4],
    [6, 'ride', 0.45],
    [7, 'ride', 0.25],
    [2, 'brush', 0.45],
    [6, 'brush', 0.45],
  ],
  /** 二四拍彈手指 */
  snap: [
    [2, 'snap', 0.38],
    [6, 'snap', 0.38],
  ],
  /** 時鐘滴答 */
  tick: [
    [0, 'blockHigh', 0.24],
    [2, 'blockLow', 0.2],
    [4, 'blockHigh', 0.24],
    [6, 'blockLow', 0.2],
  ],
  /** 木魚：小節頭敲一下，中間輕輕一下 */
  temple: [
    [0, 'blockLow', 0.4],
    [4, 'blockHigh', 0.2],
  ],
  /** 心跳：撲通、撲通 */
  heartbeat: [
    [0, 'kick', 0.55],
    [0.55, 'kick', 0.35],
    [4, 'kick', 0.5],
    [4.55, 'kick', 0.3],
  ],
  /** lo-fi：慵懶的大鼓、輕輕的小鼓，反拍有一點點鈸 */
  lofi: [
    [0, 'kick', 0.55],
    [5, 'kick', 0.35],
    [2, 'snare', 0.28],
    [6, 'snare', 0.28],
    ...OFFBEATS.map((i): DrumHit => [i, 'hat', 0.16]),
  ],
  /** 8-bit：短短的雜訊鼓 */
  chip: [
    [0, 'kick', 0.6],
    [4, 'kick', 0.55],
    [2, 'snare', 0.35],
    [6, 'snare', 0.35],
    ...OFFBEATS.map((i): DrumHit => [i, 'hat', 0.18]),
  ],
} satisfies Record<string, DrumHit[]>

export type DrumStyle = keyof typeof DRUM_STYLES

// ── 播放 ──────────────────────────────────────────────

export class Music {
  private ctx: BaseAudioContext | null = null
  private master: GainNode | null = null
  private drumBus: GainNode | null = null
  private noise: AudioBuffer | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  /** 已經排進去、還沒響完的音，暫停時要停掉 */
  private sounding = new Set<AudioScheduledSourceNode>()
  /** 下一個要排的八分音符，以及它開始的時間 */
  private step = 0
  private time = 0
  private bpm: number
  private song: Song
  private bar: number
  /** 整首有幾個八分音符 */
  private steps: number
  /** 第幾個八分音符要開始哪個旋律音 */
  private melodyAt = new Map<number, Note>()
  private chords: Chord[]
  /** 小節裡每個八分音符位置要打的鼓 */
  private drumsAt: DrumHit[][]
  private mix: Mix
  private lead: Instrument
  private bassTone: Instrument
  private bassStyle: BassPattern

  constructor(song: Song) {
    this.song = song
    this.bar = song.bar ?? 8
    this.mix = { ...(song.calm ? CALM : LIVELY), ...song.mix }
    this.lead = INSTRUMENTS[song.lead ?? (song.calm ? 'musicbox' : 'bell')]
    this.bassTone = INSTRUMENTS[song.bassTone ?? (song.calm ? 'softSub' : 'sub')]
    this.bassStyle = BASS_STYLES[song.bassStyle ?? (song.calm ? 'pedal' : 'bounce')]
    this.bpm = tempo(song, 1)
    this.steps = song.bass.length * this.bar
    song.melody.reduce((step, note) => (this.melodyAt.set(step, note), step + note[1]), 0)
    this.chords = this.analyze()
    this.drumsAt = Array.from({ length: this.bar }, () => [])
    for (const hit of DRUM_STYLES[song.drums ?? 'none'] as DrumHit[]) {
      if (hit[0] < this.bar) this.drumsAt[Math.floor(hit[0])].push(hit)
    }
  }

  /** 從旋律猜每小節是大和弦還是小和弦：看這一小節裡響的是根音上面的大三度還是小三度 */
  private analyze(): Chord[] {
    const roots = this.song.bass.map(midi)
    const heard = roots.map(() => new Set<number>())
    let step = 0
    for (const [name, len] of this.song.melody) {
      if (name) {
        const pitch = midi(name) % 12
        for (let s = step; s < step + len; s++) heard[Math.floor(s / this.bar) % roots.length].add(pitch)
      }
      step += len
    }
    return roots.map((root, i) => {
      const minor = heard[i].has((root + 3) % 12)
      const major = heard[i].has((root + 4) % 12)
      return { root, next: roots[(i + 1) % roots.length], third: major === minor ? null : major ? 4 : 3 }
    })
  }

  setLevel(level: number) {
    this.bpm = tempo(this.song, level)
  }

  /** 要在使用者操作（點擊、按鍵）之後呼叫，瀏覽器才允許出聲 */
  play() {
    if (this.timer) return
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      this.connect(new Ctx())
    }
    const ctx = this.ctx as AudioContext
    void ctx.resume().catch(() => {})
    // 從停下的那一小節開頭接著播
    this.step = Math.floor(this.step / this.bar) * this.bar
    this.time = ctx.currentTime + 0.05
    this.timer = setInterval(() => this.schedule(), TIMER_MS)
    this.schedule()
  }

  pause() {
    clearInterval(this.timer)
    this.timer = undefined
    for (const node of this.sounding) node.stop()
    this.sounding.clear()
  }

  dispose() {
    this.pause()
    if (this.ctx instanceof AudioContext) void this.ctx.close().catch(() => {})
    this.ctx = null
    this.master = null
    this.drumBus = null
  }

  /** 接好混音的線路。離線錄音（試聽、檢查音量）也用這個：傳 OfflineAudioContext 進來，再呼叫 `schedule(秒數)` */
  connect(ctx: BaseAudioContext) {
    this.ctx = ctx
    const mix = this.mix
    this.master = ctx.createGain()
    this.master.gain.value = mix.volume
    const lowpass = ctx.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = mix.lowpass
    const echo = ctx.createDelay(1)
    echo.delayTime.value = mix.echo
    const feedback = ctx.createGain()
    feedback.gain.value = mix.echoFeedback
    const wet = ctx.createGain()
    wet.gain.value = mix.echoMix
    this.master.connect(lowpass).connect(ctx.destination)
    lowpass.connect(echo).connect(feedback).connect(echo)
    echo.connect(wet).connect(ctx.destination)
    this.drumBus = ctx.createGain()
    this.drumBus.gain.value = mix.volume * mix.drums
    this.drumBus.connect(ctx.destination)
    // 一秒的白雜訊，小鼓、沙鈴、鈸都從這裡濾出來
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }

  /** 把 `until` 秒之前要響的音都排進去 */
  schedule(until = this.ctx ? this.ctx.currentTime + LOOKAHEAD_S : 0) {
    const ctx = this.ctx
    if (!ctx) return
    // 分頁在背景太久，排程落後太多就直接跳到現在
    if (this.time < ctx.currentTime - 1) this.time = ctx.currentTime + 0.05
    const eighth = 60 / this.bpm / 2
    const swing = (this.song.swing ?? 0) * eighth
    while (this.time < until) {
      const i = this.step % this.bar
      const at = this.time + (i % 2 ? swing : 0)
      const note = this.melodyAt.get(this.step)
      if (note?.[0]) this.tone(this.lead, frequency(midi(note[0])), at, note[1] * eighth * 0.85, 0.6)
      const chord = this.chords[Math.floor(this.step / this.bar)]
      const hit = this.bassStyle(i, this.bar, chord)
      for (const n of hit?.notes ?? []) {
        this.tone(hit!.chord ? this.lead : this.bassTone, frequency(chord.root + n), at, hit!.len * eighth, hit!.vol)
      }
      for (const [pos, drum, vol] of this.drumsAt[i]) {
        this.drum(drum, pos === i ? at : this.time + (pos - i) * eighth, vol)
      }
      this.time += eighth
      this.step = (this.step + 1) % this.steps
    }
  }

  private track(node: AudioScheduledSourceNode, start: number, stop: number) {
    node.onended = () => this.sounding.delete(node)
    this.sounding.add(node)
    node.start(start)
    node.stop(stop)
  }

  private tone(inst: Instrument, freq: number, at: number, duration: number, volume: number) {
    const ctx = this.ctx!
    const { attack, sustain, release } = inst
    const end = at + duration
    const stop = end + release + 0.02
    // 快速起音後衰減，放開時再淡出，聽起來像彈出來的而不是一直嗶
    const gain = ctx.createGain()
    const floor = Math.max(sustain, 0.001)
    const decay = inst.decay ?? Math.max(attack * 2, duration) - attack
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(volume, at + attack)
    if (at + attack + decay <= end) {
      gain.gain.exponentialRampToValueAtTime(volume * floor, at + attack + decay)
      gain.gain.setValueAtTime(volume * floor, end)
    } else {
      // 音比衰減短：衰減到一半就放開，算出放開時剩多少
      const progress = Math.max(0, end - at - attack) / decay
      gain.gain.exponentialRampToValueAtTime(volume * floor ** progress, Math.max(end, at + attack + 0.001))
    }
    gain.gain.linearRampToValueAtTime(0, end + release)
    gain.connect(this.master!)

    // 振盪器 → (音色濾波) → (忽大忽小) → 音量包絡
    let out: AudioNode = gain
    if (inst.filter) {
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      const cutoff = (x: number) => Math.min(Math.max(freq * x, 60), 16000)
      filter.frequency.setValueAtTime(cutoff(inst.filter.from), at)
      filter.frequency.exponentialRampToValueAtTime(cutoff(inst.filter.to), at + inst.filter.time)
      filter.connect(out)
      out = filter
    }
    if (inst.tremolo) {
      const trem = ctx.createGain()
      trem.gain.value = 1 - inst.tremolo.depth / 2
      const lfo = ctx.createOscillator()
      lfo.frequency.value = inst.tremolo.rate
      const depth = ctx.createGain()
      depth.gain.value = inst.tremolo.depth / 2
      lfo.connect(depth).connect(trem.gain)
      this.track(lfo, at, stop)
      trem.connect(out)
      out = trem
    }

    // 顫音和滑音都推 detune，所有層一起晃
    let wobble: GainNode | null = null
    if (inst.vibrato) {
      const lfo = ctx.createOscillator()
      lfo.frequency.value = inst.vibrato.rate
      wobble = ctx.createGain()
      wobble.gain.value = 0
      wobble.gain.setValueAtTime(0, at + inst.vibrato.delay)
      wobble.gain.linearRampToValueAtTime(inst.vibrato.cents, at + inst.vibrato.delay + 0.3)
      lfo.connect(wobble)
      this.track(lfo, at, stop)
    }
    for (const layer of inst.layers) {
      const osc = ctx.createOscillator()
      osc.type = layer.type
      osc.frequency.value = freq * (layer.ratio ?? 1)
      const base = layer.detune ?? 0
      if (inst.bend) {
        osc.detune.setValueAtTime(base - inst.bend.cents, at)
        osc.detune.linearRampToValueAtTime(base, at + inst.bend.time)
      } else osc.detune.value = base
      wobble?.connect(osc.detune)
      const level = ctx.createGain()
      const g = layer.gain ?? 1
      level.gain.setValueAtTime(g, at)
      if (layer.decay) level.gain.exponentialRampToValueAtTime(g * 0.001, at + layer.decay)
      osc.connect(level).connect(out)
      this.track(osc, at, stop)
    }
  }

  private drum(kind: Drum, at: number, vol: number) {
    const ctx = this.ctx!
    const out = this.drumBus!
    /** 雜訊過一個濾波器，`attack` 秒淡入、`length` 秒內消失 */
    const noise = (type: BiquadFilterType, freq: number, q: number, length: number, level: number, attack = 0) => {
      const src = ctx.createBufferSource()
      src.buffer = this.noise
      const filter = ctx.createBiquadFilter()
      filter.type = type
      filter.frequency.value = freq
      filter.Q.value = q
      const env = ctx.createGain()
      env.gain.setValueAtTime(attack ? 0 : level, at)
      if (attack) env.gain.linearRampToValueAtTime(level, at + attack)
      env.gain.exponentialRampToValueAtTime(0.001, at + attack + length)
      src.connect(filter).connect(env).connect(out)
      this.track(src, at, at + attack + length + 0.02)
    }
    /** 一個從 `from` 掉到 `to` 赫茲的短音（大鼓、木魚） */
    const thump = (type: OscillatorType, from: number, to: number, length: number, level: number) => {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.setValueAtTime(from, at)
      if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + length * 0.5)
      const env = ctx.createGain()
      env.gain.setValueAtTime(level, at)
      env.gain.exponentialRampToValueAtTime(0.001, at + length)
      osc.connect(env).connect(out)
      this.track(osc, at, at + length + 0.02)
    }
    switch (kind) {
      case 'kick':
        thump('sine', 120, 42, 0.28, vol * 0.5)
        break
      case 'snare':
        noise('highpass', 1200, 0.7, 0.15, vol * 0.7)
        thump('triangle', 190, 160, 0.08, vol * 0.4)
        break
      case 'hat':
        noise('highpass', 7000, 0.7, 0.045, vol * 0.6)
        break
      case 'shaker':
        noise('bandpass', 5500, 0.8, 0.07, vol * 0.6, 0.02)
        break
      case 'clap':
        noise('bandpass', 1400, 1, 0.11, vol)
        break
      case 'snap':
        noise('bandpass', 2200, 1.2, 0.06, vol * 3)
        break
      case 'brush':
        noise('bandpass', 3000, 0.5, 0.2, vol * 0.5, 0.04)
        break
      case 'ride':
        noise('highpass', 6000, 0.7, 0.35, vol * 0.3)
        break
      case 'blockHigh':
        thump('sine', 1250, 1250, 0.06, vol * 1.6)
        break
      case 'blockLow':
        thump('sine', 850, 850, 0.07, vol * 1.6)
        break
    }
  }
}

/**
 * 在遊戲進行中（`playing`）播放背景音樂。開關記在 localStorage 的 `music`，所有遊戲共用，
 * 在一個遊戲關掉，換到別的遊戲也是關的；還沒存過就沿用以前各遊戲自己記的 `<game>:music`
 */
export function useMusic(game: string, song: Song, playing: boolean, level: number) {
  const [enabled, setEnabled] = useState(() => load<boolean | null>('music', null) ?? load<boolean>(`${game}:music`, true))
  const [music] = useState(() => new Music(song))
  useEffect(() => () => music.dispose(), [music])
  useEffect(() => music.setLevel(level), [music, level])
  useEffect(() => {
    if (playing && enabled) music.play()
    else music.pause()
  }, [music, playing, enabled])
  const toggle = useCallback(() => {
    setEnabled((on) => {
      save('music', !on)
      return !on
    })
  }, [])
  return { enabled, toggle }
}

export type MusicControl = ReturnType<typeof useMusic>
