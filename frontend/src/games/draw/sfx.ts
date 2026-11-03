/**
 * 你畫我猜的音效（合成器見 shared/sfx.ts）：輪到自己畫、自己猜對、別人猜對、差一點、揭露提示、公布答案。
 * 都是從 view 前後的變化（`useDrawSounds`）或「差一點」的即時事件觸發的。
 */

import { useEffect, useRef } from 'react'
import { useSfx, type Synth } from '../shared/sfx'
import type { DrawView } from './types'

export type DrawSound = 'turn' | 'correct' | 'guessed' | 'close' | 'hint' | 'all' | 'timeup'

const VOLUME = 0.3

function render(s: Synth, sound: DrawSound) {
  switch (sound) {
    case 'turn':
      // 輪到你了：往上的琶音
      ;[523, 659, 784, 1047].forEach((f, i) => s.tone('triangle', f, f, i * 0.08, 0.22, 0.4))
      break
    case 'correct':
      // 猜對了：明亮的「叮咚」加一點閃亮的高音
      s.tone('sine', 784, 784, 0, 0.18, 0.45)
      s.tone('sine', 1047, 1047, 0.1, 0.35, 0.45)
      ;[1568, 2093].forEach((f, i) => s.tone('sine', f, f, 0.2 + i * 0.06, 0.25, 0.18))
      break
    case 'guessed':
      s.tone('sine', 1319, 1319, 0, 0.18, 0.25)
      break
    case 'close':
      // 差一點：兩聲短短的「嘟嘟」
      s.tone('triangle', 587, 587, 0, 0.09, 0.4)
      s.tone('triangle', 698, 698, 0.12, 0.12, 0.4)
      break
    case 'hint':
      s.tone('sine', 880, 1320, 0, 0.16, 0.3)
      break
    case 'all':
      ;[523, 659, 784].forEach((f, i) => s.tone('triangle', f, f, i * 0.07, 0.4, 0.3))
      s.tone('sine', 1047, 1047, 0.21, 0.5, 0.35)
      break
    case 'timeup':
      s.tone('triangle', 392, 392, 0, 0.18, 0.4)
      s.tone('triangle', 262, 262, 0.18, 0.35, 0.4)
      break
  }
}

export function useDrawSfx() {
  return useSfx('draw:sfx', VOLUME, render)
}

function opened(view: DrawView): number {
  return view.hint?.chars.filter((c) => c !== null).length ?? 0
}

/** 比較前後兩個 view 決定要不要出聲；第一個 view（剛進房間、重新整理）只看是不是輪到自己選題 */
export function useDrawSounds(view: DrawView | null, play: (sound: DrawSound) => void) {
  const prev = useRef<DrawView | null>(null)
  useEffect(() => {
    const before = prev.current
    prev.current = view
    if (!view || view === before) return
    const me = view.you
    const sameTurn = before !== null && before.turn === view.turn && before.stage !== 'end'
    if (!sameTurn || before.stage !== view.stage) {
      if (view.stage === 'choose' && me !== null && me === view.drawer) {
        play('turn')
        return
      }
    }
    if (!sameTurn) return
    if (me !== null && view.seats[me]?.guessed && !before.seats[me]?.guessed) play('correct')
    else if (before.stage === 'draw' && view.stage === 'reveal') play(view.ending === 'all' ? 'all' : 'timeup')
    else if (view.stage === 'draw' && view.seats.some((s, i) => s.guessed && !before.seats[i]?.guessed)) play('guessed')
    if (view.stage === 'draw' && opened(view) > opened(before)) play('hint')
  }, [view, play])
}
