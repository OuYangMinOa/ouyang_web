/** 手機上點一下要挖開還是插旗（單人和線上競速共用；右鍵或長按做相反的動作） */
export type Tool = 'dig' | 'flag'

export const TOOL_OPTIONS: { value: Tool; label: string }[] = [
  { value: 'dig', label: '⛏️ 挖開' },
  { value: 'flag', label: '🚩 插旗' },
]
