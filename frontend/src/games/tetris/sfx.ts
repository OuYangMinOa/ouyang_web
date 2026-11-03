/**
 * 俄羅斯方塊的音效，跟背景音樂一樣用 Web Audio 即時合成，不需要音檔。
 * 每個音都很短，敲下去就淡掉；旋轉卡進 spin 的位置時多一聲高音的「叮」，還沒放下就知道卡對了。
 */

import { useCallback, useEffect, useState } from 'react'
import { load, save } from '../shared/storage'
import type { Sound } from './engine'

const VOLUME = 0.35

class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null

  private start(): AudioContext | null {
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return null
      this.ctx = new Ctx()
      this.master = this.ctx.createGain()
      this.master.gain.value = VOLUME
      const lowpass = this.ctx.createBiquadFilter()
      lowpass.type = 'lowpass'
      lowpass.frequency.value = 6000
      this.master.connect(lowpass).connect(this.ctx.destination)
    }
    // 瀏覽器要等使用者操作過才肯出聲；遊戲中一定按過鍵了
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
    return this.ctx
  }

  /** 一個音：從 `from` 滑到 `to` 赫茲，`at` 秒後開始，響 `length` 秒 */
  private tone(type: OscillatorType, from: number, to: number, at: number, length: number, volume: number) {
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

  play(sound: Sound) {
    if (!this.start()) return
    switch (sound) {
      case 'move':
        this.tone('triangle', 880, 880, 0, 0.03, 0.12)
        break
      case 'rotate':
        this.tone('triangle', 520, 780, 0, 0.06, 0.25)
        break
      case 'spin':
        this.tone('triangle', 520, 780, 0, 0.06, 0.25)
        this.tone('sine', 1568, 2093, 0.03, 0.14, 0.3)
        break
      case 'hold':
        this.tone('sine', 400, 900, 0, 0.1, 0.25)
        break
      case 'drop':
        this.tone('sine', 170, 45, 0, 0.16, 0.9)
        break
      case 'lock':
        this.tone('triangle', 240, 120, 0, 0.08, 0.4)
        break
      case 'clear':
        ;[1047, 1319, 1568].forEach((f, i) => this.tone('sine', f, f, i * 0.05, 0.15, 0.3))
        break
      case 'big':
        ;[1047, 1319, 1568, 2093].forEach((f, i) => this.tone('sine', f, f, i * 0.06, 0.25, 0.35))
        this.tone('triangle', 523, 523, 0, 0.4, 0.2)
        break
      case 'garbage':
        this.tone('triangle', 130, 65, 0, 0.22, 0.6)
        break
    }
  }

  dispose() {
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.master = null
  }
}

/** 音效開關記在 localStorage；`play` 在關掉時什麼都不做 */
export function useSfx() {
  const storageKey = 'tetris:sfx'
  const [enabled, setEnabled] = useState(() => load<boolean>(storageKey, true))
  const [sfx] = useState(() => new Sfx())
  useEffect(() => () => sfx.dispose(), [sfx])
  const play = useCallback(
    (sound: Sound) => {
      if (enabled) sfx.play(sound)
    },
    [sfx, enabled],
  )
  const toggle = useCallback(() => {
    setEnabled((on) => {
      save(storageKey, !on)
      return !on
    })
  }, [])
  return { enabled, toggle, play }
}

export type SfxControl = ReturnType<typeof useSfx>
