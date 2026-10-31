import { useKeys as useSchemeKeys, type KeyScheme, type KeySettings as SchemeSettings, type Keys as SchemeKeys } from '../shared/keys'

/** 俄羅斯方塊的快捷鍵；存取和編輯見 `shared/keys.ts` */

export type Action = 'left' | 'right' | 'soft' | 'hard' | 'cw' | 'ccw' | 'hold' | 'pause' | 'music'

export type Keys = SchemeKeys<Action>
export type KeySettings = SchemeSettings<Action>

export const KEYS: KeyScheme<Action> = {
  game: 'tetris',
  actions: [
    { action: 'left', label: '左移' },
    { action: 'right', label: '右移' },
    { action: 'soft', label: '加速下落' },
    { action: 'hard', label: '直接落下' },
    { action: 'cw', label: '順時針轉' },
    { action: 'ccw', label: '逆時針轉' },
    { action: 'hold', label: '保留' },
    { action: 'pause', label: '暫停' },
    { action: 'music', label: '音樂開關' },
  ],
  defaults: {
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    soft: ['ArrowDown'],
    hard: ['Space'],
    cw: ['ArrowUp', 'KeyX'],
    ccw: ['KeyZ', 'Control'],
    hold: ['KeyC', 'Shift'],
    pause: ['Escape', 'KeyP'],
    music: ['KeyM'],
  },
}

export function useKeys(): KeySettings {
  return useSchemeKeys(KEYS)
}
