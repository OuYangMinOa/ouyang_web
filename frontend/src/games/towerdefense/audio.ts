import { Synth } from '../shared/sfx'
import type { TowerId } from './online'

/**
 * 迷宮塔防的音效：和其他遊戲一樣用 Web Audio 即時合成（`shared/sfx.ts`），不下載音檔。
 * 塔一多每秒會開好幾十次火，所以同一種聲音隔一小段時間才響一次，音量也壓得比較低。
 */

export type Sound =
  | 'build'
  | 'upgrade'
  | 'sell'
  | 'deny'
  | 'pop'
  | 'boom'
  | 'leak'
  | 'wave'
  | 'boss'
  | 'coin'
  | 'send'
  | 'incoming'
  | 'win'
  | 'lose'
  | 'click'

/** 同一種聲音最快多久響一次（毫秒） */
const GAP: Partial<Record<Sound | TowerId, number>> = {
  pop: 60,
  boom: 90,
  bolt: 70,
  cannon: 140,
  frost: 120,
  tesla: 110,
  poison: 150,
  sniper: 160,
  leak: 250,
  deny: 200,
}

export class TdAudio {
  private readonly synth = new Synth(0.22)
  private enabled: boolean
  private last = new Map<string, number>()

  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  setEnabled(on: boolean) {
    this.enabled = on
  }

  /** 瀏覽器要使用者點過才肯出聲：點畫面時呼叫 */
  unlock() {
    if (this.enabled) this.synth.start()
  }

  private ready(key: Sound | TowerId): boolean {
    if (!this.enabled || !this.synth.start()) return false
    const now = performance.now()
    if (now - (this.last.get(key) ?? -1e9) < (GAP[key] ?? 0)) return false
    this.last.set(key, now)
    return true
  }

  /** 塔開火 */
  shot(kind: TowerId) {
    if (!this.ready(kind)) return
    const s = this.synth
    switch (kind) {
      case 'bolt':
        s.tone('triangle', 880, 520, 0, 0.07, 0.12)
        break
      case 'cannon':
        s.tone('sawtooth', 160, 60, 0, 0.18, 0.22)
        break
      case 'frost':
        s.tone('sine', 1400, 900, 0, 0.12, 0.1)
        s.tone('sine', 2100, 1500, 0.02, 0.1, 0.05)
        break
      case 'tesla':
        s.tone('square', 1800, 300, 0, 0.09, 0.07)
        s.tone('sawtooth', 900, 200, 0.02, 0.08, 0.06)
        break
      case 'poison':
        s.tone('sine', 300, 180, 0, 0.14, 0.12)
        break
      case 'sniper':
        s.tone('square', 700, 140, 0, 0.12, 0.13)
        s.tone('triangle', 1600, 500, 0, 0.06, 0.1)
        break
      case 'beacon':
        break
    }
  }

  play(sound: Sound) {
    if (!this.ready(sound)) return
    const s = this.synth
    switch (sound) {
      case 'click':
        s.tone('triangle', 620, 620, 0, 0.04, 0.12)
        break
      case 'build':
        s.tone('triangle', 260, 180, 0, 0.09, 0.3)
        s.tone('square', 520, 780, 0.05, 0.09, 0.12)
        break
      case 'upgrade':
        s.tone('triangle', 523, 523, 0, 0.09, 0.22)
        s.tone('triangle', 659, 659, 0.07, 0.09, 0.22)
        s.tone('triangle', 784, 784, 0.14, 0.14, 0.24)
        break
      case 'sell':
        s.tone('triangle', 660, 330, 0, 0.14, 0.2)
        s.tone('sine', 1320, 1760, 0.08, 0.1, 0.12)
        break
      case 'deny':
        s.tone('square', 160, 120, 0, 0.12, 0.16)
        break
      case 'pop':
        s.tone('sine', 520, 180, 0, 0.08, 0.16)
        break
      case 'boom':
        s.tone('sawtooth', 120, 40, 0, 0.22, 0.26)
        s.tone('square', 80, 40, 0, 0.16, 0.16)
        break
      case 'coin':
        s.tone('sine', 1320, 1320, 0, 0.05, 0.1)
        s.tone('sine', 1760, 1760, 0.05, 0.1, 0.1)
        break
      case 'leak':
        s.tone('sawtooth', 220, 110, 0, 0.25, 0.3)
        s.tone('square', 147, 98, 0.05, 0.25, 0.16)
        break
      case 'wave':
        // 號角：下一波來了
        s.tone('sawtooth', 196, 196, 0, 0.18, 0.2)
        s.tone('sawtooth', 294, 294, 0.16, 0.34, 0.24)
        break
      case 'boss':
        s.tone('sawtooth', 98, 98, 0, 0.3, 0.3)
        s.tone('sawtooth', 92, 92, 0.3, 0.3, 0.3)
        s.tone('sawtooth', 73, 73, 0.6, 0.6, 0.34)
        break
      case 'send':
        s.tone('square', 330, 660, 0, 0.1, 0.14)
        break
      case 'incoming':
        s.tone('square', 660, 440, 0, 0.1, 0.18)
        s.tone('square', 660, 440, 0.14, 0.1, 0.18)
        break
      case 'win':
        ;[523, 659, 784, 1047].forEach((f, i) => s.tone('triangle', f, f, i * 0.13, 0.3, 0.26))
        break
      case 'lose':
        ;[392, 330, 262, 196].forEach((f, i) => s.tone('triangle', f, f, i * 0.18, 0.36, 0.26))
        break
    }
  }

  dispose() {
    this.synth.dispose()
  }
}
