/**
 * 遊戲的背景音樂（所有小遊戲共用），用 Web Audio 即時合成，不需要音檔。
 * 音色走柔和路線：主旋律是三角波、低音是正弦波，每個音像敲鐘琴一樣敲下去就慢慢變小，
 * 最後過一個低通濾波器把刺耳的高頻削掉，再加一點點回音。速度跟著等級變快。
 * `calm` 的曲子（棋類、派對這種慢慢玩的）更小聲、更悶、餘音更長，低音每小節只彈根音和五度。
 *
 * 排程以八分音符為單位，旋律和低音一起走，中途變速也不會對不齊。用「往前看」的做法：每 50ms 檢查一次，把接下來 0.2 秒內要響的音先排進 AudioContext，
 * 計時器有點延遲也不會走音。
 */

import { useCallback, useEffect, useState } from 'react'
import { load, save } from './storage'

/** [音名, 長度（八分音符數）]；音名 null 是休止 */
export type Note = [string | null, number]

export type Song = {
  melody: Note[]
  /** 每小節（8 個八分音符）的低音根音；旋律的總長要剛好是小節數 × 8 */
  bass: string[]
  /** 等級 1 的速度、每升一級快多少、最快多少（BPM） */
  bpm: number
  bpmPerLevel: number
  maxBpm: number
  /** 柔和版音色，見檔案開頭 */
  calm?: boolean
}

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

function frequency(name: string): number {
  const m = /^([A-G])(#?)(\d)$/.exec(name)!
  const midi = (Number(m[3]) + 1) * 12 + SEMITONES[m[1]] + (m[2] ? 1 : 0)
  return 440 * 2 ** ((midi - 69) / 12)
}

export function tempo(song: Song, level: number): number {
  return Math.min(song.bpm + (level - 1) * song.bpmPerLevel, song.maxBpm)
}

const LOOKAHEAD_S = 0.2
const TIMER_MS = 50

type Voice = {
  volume: number
  /** 低通濾波器的截止頻率：越低越悶、越柔 */
  lowpass: number
  /** 回音：間隔、每次剩多少、混進來多少 */
  echo: number
  echoFeedback: number
  echoMix: number
  /** 起音、敲下去後衰減到剩多少、放開後多久消失 */
  attack: number
  sustain: number
  release: number
}

const LIVELY: Voice = {
  volume: 0.14,
  lowpass: 2000,
  echo: 0.24,
  echoFeedback: 0.25,
  echoMix: 0.15,
  attack: 0.012,
  sustain: 0.35,
  release: 0.12,
}

const CALM: Voice = {
  volume: 0.09,
  lowpass: 1300,
  echo: 0.36,
  echoFeedback: 0.3,
  echoMix: 0.22,
  attack: 0.03,
  sustain: 0.45,
  release: 0.7,
}

export class Music {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  /** 已經排進去、還沒響完的音，暫停時要停掉 */
  private sounding = new Set<OscillatorNode>()
  /** 下一個要排的八分音符，以及它開始的時間 */
  private step = 0
  private time = 0
  private bpm: number
  private song: Song
  /** 整首有幾個八分音符（每小節 8 個） */
  private steps: number
  /** 第幾個八分音符要開始哪個旋律音 */
  private melodyAt = new Map<number, Note>()
  private voice: Voice

  constructor(song: Song) {
    this.song = song
    this.voice = song.calm ? CALM : LIVELY
    this.bpm = tempo(song, 1)
    this.steps = song.bass.length * 8
    song.melody.reduce((step, note) => (this.melodyAt.set(step, note), step + note[1]), 0)
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
      this.ctx = new Ctx()
      const ctx = this.ctx
      const voice = this.voice
      this.master = ctx.createGain()
      this.master.gain.value = voice.volume
      const lowpass = ctx.createBiquadFilter()
      lowpass.type = 'lowpass'
      lowpass.frequency.value = voice.lowpass
      const echo = ctx.createDelay(1)
      echo.delayTime.value = voice.echo
      const feedback = ctx.createGain()
      feedback.gain.value = voice.echoFeedback
      const mix = ctx.createGain()
      mix.gain.value = voice.echoMix
      this.master.connect(lowpass).connect(ctx.destination)
      lowpass.connect(echo).connect(feedback).connect(echo)
      echo.connect(mix).connect(ctx.destination)
    }
    void this.ctx.resume().catch(() => {})
    // 從停下的那一小節開頭接著播
    this.step = Math.floor(this.step / 8) * 8
    this.time = this.ctx.currentTime + 0.05
    this.timer = setInterval(() => this.schedule(), TIMER_MS)
    this.schedule()
  }

  pause() {
    clearInterval(this.timer)
    this.timer = undefined
    for (const osc of this.sounding) osc.stop()
    this.sounding.clear()
  }

  dispose() {
    this.pause()
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.master = null
  }

  private schedule() {
    const ctx = this.ctx
    if (!ctx) return
    // 分頁在背景太久，排程落後太多就直接跳到現在
    if (this.time < ctx.currentTime - 1) this.time = ctx.currentTime + 0.05
    const eighth = 60 / this.bpm / 2
    while (this.time < ctx.currentTime + LOOKAHEAD_S) {
      const note = this.melodyAt.get(this.step)
      if (note?.[0]) this.tone('triangle', frequency(note[0]), this.time, note[1] * eighth * 0.85, 0.6)
      const root = frequency(this.song.bass[Math.floor(this.step / 8)])
      if (this.song.calm) {
        // 低音每小節兩下：根音、五度，拖長一點
        if (this.step % 4 === 0) this.tone('sine', root * (this.step % 8 ? 1.5 : 1), this.time, eighth * 3.6, 0.7)
      } else if (this.step % 2 === 0) {
        // 低音每拍（兩個八分音符）一下，根音和高八度交替
        this.tone('sine', root * (this.step % 4 ? 2 : 1), this.time, eighth * 1.6, 0.8)
      }
      this.time += eighth
      this.step = (this.step + 1) % this.steps
    }
  }

  private tone(type: OscillatorType, freq: number, at: number, duration: number, volume: number) {
    const ctx = this.ctx!
    const { attack, sustain, release } = this.voice
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.value = freq
    // 快速起音後慢慢衰減，放開時再淡出，聽起來像敲出來的而不是一直嗶
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(volume, at + attack)
    gain.gain.exponentialRampToValueAtTime(volume * sustain, at + Math.max(attack * 2, duration))
    gain.gain.linearRampToValueAtTime(0, at + duration + release)
    osc.connect(gain).connect(this.master!)
    osc.onended = () => this.sounding.delete(osc)
    this.sounding.add(osc)
    osc.start(at)
    osc.stop(at + duration + release + 0.02)
  }
}

/** 在遊戲進行中（`playing`）播放背景音樂；開關記在 localStorage 的 `<game>:music` */
export function useMusic(game: string, song: Song, playing: boolean, level: number) {
  const storageKey = `${game}:music`
  const [enabled, setEnabled] = useState(() => load<boolean>(storageKey, true))
  const [music] = useState(() => new Music(song))
  useEffect(() => () => music.dispose(), [music])
  useEffect(() => music.setLevel(level), [music, level])
  useEffect(() => {
    if (playing && enabled) music.play()
    else music.pause()
  }, [music, playing, enabled])
  const toggle = useCallback(() => {
    setEnabled((on) => {
      save(storageKey, !on)
      return !on
    })
  }, [storageKey])
  return { enabled, toggle }
}

export type MusicControl = ReturnType<typeof useMusic>
