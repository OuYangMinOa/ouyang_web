import { useKeys as useSchemeKeys, type KeyScheme, type KeySettings as SchemeSettings, type Keys as SchemeKeys } from '../shared/keys'

/** 魔法氣泡的快捷鍵；存取和編輯見 `shared/keys.ts`，設定存在 `/games/puyo/settings` */

export type Action = 'left' | 'right' | 'soft' | 'hard' | 'cw' | 'ccw' | 'pause' | 'music'

export type Keys = SchemeKeys<Action>
export type KeySettings = SchemeSettings<Action>

export const KEYS: KeyScheme<Action> = {
  game: 'puyo',
  actions: [
    { action: 'left', label: '左移' },
    { action: 'right', label: '右移' },
    { action: 'soft', label: '加速下落' },
    { action: 'hard', label: '直接落下' },
    { action: 'cw', label: '順時針轉' },
    { action: 'ccw', label: '逆時針轉' },
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
    pause: ['Escape', 'KeyP'],
    music: ['KeyM'],
  },
}

export function useKeys(): KeySettings {
  return useSchemeKeys(KEYS)
}
