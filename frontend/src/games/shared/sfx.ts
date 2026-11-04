/**
 * 遊戲音效共用的合成器：跟背景音樂一樣用 Web Audio 即時合成，不需要音檔。
 * 每個音都很短，敲下去就淡掉；各遊戲自己決定每種音效由哪幾個音組成（例如 tetris/sfx.ts）。
 */

import { useCallback, useEffect, useState } from 'react'
import { load, save } from './storage'

export class Synth {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private volume: number

  constructor(volume: number) {
    this.volume = volume
  }

  /** 準備好出聲就回傳 true（瀏覽器不支援 Web Audio 時是 false） */
  start(): boolean {
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return false
      this.ctx = new Ctx()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      const lowpass = this.ctx.createBiquadFilter()
      lowpass.type = 'lowpass'
      lowpass.frequency.value = 6000
      this.master.connect(lowpass).connect(this.ctx.destination)
    }
    // 瀏覽器要等使用者操作過才肯出聲（點過、按過鍵）
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
    return true
  }

  /** 一個音：從 `from` 滑到 `to` 赫茲，`at` 秒後開始，響 `length` 秒；要先 `start` */
  tone(type: OscillatorType, from: number, to: number, at: number, length: number, volume: number) {
    const ctx = this.ctx!
    const t = ctx.currentTime + 0.005 + at
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(from, t)
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + length * 0.8)
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(volume, t + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
    osc.connect(gain).connect(this.master!)
    osc.start(t)
    osc.stop(t + length + 0.02)
  }

  dispose() {
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.master = null
  }
}

/**
 * 音效開關記在 localStorage（`storageKey`），和背景音樂分開；`play` 在關掉時什麼都不做。
 * `render` 用合成器把一種音效彈出來，要是固定的函式（不要每次 render 都換）。
 */
export function useSfx<S>(storageKey: string, volume: number, render: (synth: Synth, sound: S) => void) {
  const [enabled, setEnabled] = useState(() => load<boolean>(storageKey, true))
  const [synth] = useState(() => new Synth(volume))
  useEffect(() => () => synth.dispose(), [synth])
  const play = useCallback(
    (sound: S) => {
      if (enabled && synth.start()) render(synth, sound)
    },
    [synth, enabled, render],
  )
  const toggle = useCallback(() => {
    setEnabled((on) => {
      save(storageKey, !on)
      return !on
    })
  }, [storageKey])
  return { enabled, toggle, play }
}
