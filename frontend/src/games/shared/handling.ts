import { useAccountSetting } from './accountSetting'

/**
 * 操作手感：左右鍵按住多久開始連續移動（DAS），之後每格的間隔（ARR），加速下落每格的間隔（soft），都是毫秒。
 * 按下時先走一格，按住滿 DAS 走第二格，之後每 ARR 一格；ARR 0 是直接滑到底，soft 0 是直接落到底（不鎖定）。
 * 設定存在 `/games/<game>/handling`，範圍跟後端 game_settings.rs 一樣。
 */
export type Handling = { das: number; arr: number; soft: number }

export const HANDLING_DEFAULTS: Handling = { das: 180, arr: 40, soft: 30 }
export const DAS_RANGE = { min: 50, max: 400, step: 10 }
export const ARR_RANGE = { min: 0, max: 200, step: 5 }
export const SOFT_RANGE = { min: 0, max: 100, step: 5 }

function clamp(raw: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(range.max, Math.max(range.min, Math.round(raw))) : fallback
}

export function sanitizeHandling(raw: unknown): Handling {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    das: clamp(r.das, DAS_RANGE, HANDLING_DEFAULTS.das),
    arr: clamp(r.arr, ARR_RANGE, HANDLING_DEFAULTS.arr),
    soft: clamp(r.soft, SOFT_RANGE, HANDLING_DEFAULTS.soft),
  }
}

export function useHandling(game: string) {
  const { value, ...rest } = useAccountSetting(`${game}:handling`, `/games/${game}/handling`, 'handling', sanitizeHandling)
  return { handling: value, ...rest }
}

export type HandlingSettings = ReturnType<typeof useHandling>
