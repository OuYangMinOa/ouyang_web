/**
 * 俄羅斯方塊的音效（合成器見 shared/sfx.ts）。
 * 旋轉卡進 spin 的位置時多一聲高音的「叮」，還沒放下就知道卡對了。
 */

import { useSfx as useSharedSfx, type Synth } from '../shared/sfx'
import type { Sound } from './engine'

const VOLUME = 0.35

function render(s: Synth, sound: Sound) {
  switch (sound) {
    case 'move':
      s.tone('triangle', 880, 880, 0, 0.03, 0.12)
      break
    case 'rotate':
      s.tone('triangle', 520, 780, 0, 0.06, 0.25)
      break
    case 'spin':
      s.tone('triangle', 520, 780, 0, 0.06, 0.25)
      s.tone('sine', 1568, 2093, 0.03, 0.14, 0.3)
      break
    case 'hold':
      s.tone('sine', 400, 900, 0, 0.1, 0.25)
      break
    case 'drop':
      s.tone('sine', 170, 45, 0, 0.16, 0.9)
      break
    case 'lock':
      s.tone('triangle', 240, 120, 0, 0.08, 0.4)
      break
    case 'clear':
      ;[1047, 1319, 1568].forEach((f, i) => s.tone('sine', f, f, i * 0.05, 0.15, 0.3))
      break
    case 'big':
      ;[1047, 1319, 1568, 2093].forEach((f, i) => s.tone('sine', f, f, i * 0.06, 0.25, 0.35))
      s.tone('triangle', 523, 523, 0, 0.4, 0.2)
      break
    case 'garbage':
      s.tone('triangle', 130, 65, 0, 0.22, 0.6)
      break
  }
}

/** 音效開關記在 localStorage；`play` 在關掉時什麼都不做 */
export function useSfx() {
  return useSharedSfx('tetris:sfx', VOLUME, render)
}
