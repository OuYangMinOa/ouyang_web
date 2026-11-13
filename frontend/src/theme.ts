// 外觀偏好存在 localStorage，分成兩個獨立的選擇：
// - 深淺（theme）：跟隨系統／亮色／深色 → <html data-theme>，跟隨系統時不設
// - 風格（style）：墨與陽／塗鴉／山嵐／貼紙 → <html data-style>，墨與陽是預設、不設
// index.html 裡有一段同樣邏輯的 inline script，在畫面出來前先套用，避免閃一下
import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'

export type ThemePreference = 'system' | 'light' | 'dark'
export type StylePreference = 'ink' | 'doodle' | 'mist' | 'sticker'
/** 畫面上的一個點（clientX／clientY），新的外觀從這裡暈開 */
export type Origin = { x: number; y: number }

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
  return value === 'doodle' || value === 'mist' || value === 'sticker' ? value : 'ink'
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

// ---- 換外觀的轉場 ----
// 用 View Transitions：瀏覽器先把舊畫面拍成一張圖，新畫面從 origin 那個點蓋上去。
// 怎麼蓋看「要換成的風格」（<html data-vt>，動畫在 components/Appearance.css）：
// 墨與陽是墨暈開、塗鴉是用筆塗滿、山嵐是霧漫上來、貼紙是一個帶白邊黑框的圓彈開。
// 瀏覽器不支援、使用者要求減少動態，或沒給 origin（別的分頁改的）就直接換。

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let transitionSeq = 0

function change(update: () => void, origin?: Origin) {
  const root = document.documentElement
  if (!origin || !document.startViewTransition || reduceMotion.matches || document.hidden) {
    update()
    applyToRoot()
    return
  }
  const seq = ++transitionSeq
  const farX = Math.max(origin.x, window.innerWidth - origin.x)
  const farY = Math.max(origin.y, window.innerHeight - origin.y)
  root.style.setProperty('--vt-x', `${origin.x}px`)
  root.style.setProperty('--vt-y', `${origin.y}px`)
  // 從 origin 到最遠的角落，圓要長到這麼大才蓋得滿
  root.style.setProperty('--vt-max', `${Math.ceil(Math.hypot(farX, farY))}px`)
  const transition = document.startViewTransition(() => {
    update()
    root.dataset.vt = style
    // 馬上重畫（例如首頁的太陽換成別的），瀏覽器拍新畫面時才是換好的樣子
    flushSync(applyToRoot)
  })
  const done = () => {
    // 動畫還沒跑完又換了一次：留給後面那次收
    if (seq !== transitionSeq) return
    delete root.dataset.vt
    root.style.removeProperty('--vt-x')
    root.style.removeProperty('--vt-y')
    root.style.removeProperty('--vt-max')
  }
  transition.finished.then(done, done)
}

export function setThemePreference(preference: ThemePreference, origin?: Origin) {
  if (preference === theme) return
  change(() => {
    theme = preference
    write(THEME_KEY, preference === 'system' ? null : preference)
  }, origin)
}

export function setStylePreference(preference: StylePreference, origin?: Origin) {
  if (preference === style) return
  change(() => {
    style = preference
    write(STYLE_KEY, preference === 'ink' ? null : preference)
  }, origin)
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
