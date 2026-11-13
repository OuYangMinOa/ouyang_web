// 外觀偏好存在 localStorage，分成兩個獨立的選擇：
// - 深淺（theme）：跟隨系統／亮色／深色 → <html data-theme>，跟隨系統時不設
// - 風格（style）：墨與陽／塗鴉／山嵐 → <html data-style>，墨與陽是預設、不設
// index.html 裡有一段同樣邏輯的 inline script，在畫面出來前先套用，避免閃一下
import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type StylePreference = 'ink' | 'doodle' | 'mist'

const THEME_KEY = 'theme'
const STYLE_KEY = 'style'
// 塗鴉用的字（全站是圓體「粉圓」，名字和站名是手寫字「芫荽」），選了塗鴉才載入；index.html 用同一個 id
const DOODLE_FONT_ID = 'doodle-font'
const DOODLE_FONT_URL = 'https://fonts.googleapis.com/css2?family=Huninn&family=Iansui&display=swap'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // 無痕模式或封鎖網站資料時讀不到，就用預設
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // 存不了也照樣套用到這次的畫面
  }
}

function readTheme(): ThemePreference {
  const value = read(THEME_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

function readStyle(): StylePreference {
  const value = read(STYLE_KEY)
  return value === 'doodle' || value === 'mist' ? value : 'ink'
}

// 存不進 localStorage 時，這次開著的畫面還是照選的走
let theme = readTheme()
let style = readStyle()

export function getThemePreference(): ThemePreference {
  return theme
}

export function getStylePreference(): StylePreference {
  return style
}

function loadDoodleFont() {
  if (document.getElementById(DOODLE_FONT_ID)) return
  const link = document.createElement('link')
  link.id = DOODLE_FONT_ID
  link.rel = 'stylesheet'
  link.href = DOODLE_FONT_URL
  document.head.append(link)
}

function applyToRoot() {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  if (style === 'ink') {
    delete root.dataset.style
  } else {
    // 山嵐用的是本來就載入的字，只有塗鴉要另外下載
    if (style === 'doodle') loadDoodleFont()
    root.dataset.style = style
  }
  refresh()
}

export function setThemePreference(preference: ThemePreference) {
  theme = preference
  write(THEME_KEY, preference === 'system' ? null : preference)
  applyToRoot()
}

export function setStylePreference(preference: StylePreference) {
  style = preference
  write(STYLE_KEY, preference === 'ink' ? null : preference)
  applyToRoot()
}

// ---- 讓元件跟著外觀重畫（例如首頁的太陽） ----

export type Appearance = {
  style: StylePreference
  theme: ThemePreference
  /** 實際上是不是深色：選了深色，或跟隨系統而系統是深色 */
  dark: boolean
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()
let current = snapshot()

function snapshot(): Appearance {
  return { style, theme, dark: theme === 'dark' || (theme === 'system' && darkQuery.matches) }
}

function refresh() {
  const next = snapshot()
  if (next.style === current.style && next.theme === current.theme && next.dark === current.dark) return
  current = next
  listeners.forEach((listener) => listener())
}

darkQuery.addEventListener('change', refresh)
// 別的分頁改了外觀，這個分頁也跟著換（key 是 null 代表整個 localStorage 被清掉）
window.addEventListener('storage', (event) => {
  if (event.key !== THEME_KEY && event.key !== STYLE_KEY && event.key !== null) return
  theme = readTheme()
  style = readStyle()
  applyToRoot()
})

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => current)
}
