// 主題偏好存在 localStorage；index.html 裡有一段同樣邏輯的 inline script，在畫面出來前先套用，避免閃一下亮色
export type ThemePreference = 'system' | 'light' | 'dark'

const KEY = 'theme'

export function getThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY)
    if (value === 'light' || value === 'dark') return value
  } catch {
    // 無痕模式或封鎖網站資料時讀不到，就跟隨系統
  }
  return 'system'
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, preference)
  } catch {
    // 存不了也照樣套用到這次的畫面
  }
  const root = document.documentElement
  if (preference === 'system') delete root.dataset.theme
  else root.dataset.theme = preference
}
