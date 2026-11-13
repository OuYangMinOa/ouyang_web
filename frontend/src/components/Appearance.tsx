import { useRef } from 'react'
import {
  setStylePreference,
  setThemePreference,
  useAppearance,
  type StylePreference,
  type ThemePreference,
} from '../theme'
import './Appearance.css'

const STYLES: { value: StylePreference; name: string; desc: string }[] = [
  { value: 'ink', name: '墨與陽', desc: '宣紙與墨，乾淨俐落' },
  { value: 'doodle', name: '塗鴉', desc: '手畫線條，筆記本與黑板' },
  { value: 'mist', name: '山嵐', desc: '霧灰與松綠，安靜耐看' },
]

const THEMES: { value: ThemePreference; icon: string; label: string }[] = [
  { value: 'system', icon: '◐', label: '跟隨系統' },
  { value: 'light', icon: '☀', label: '亮色' },
  { value: 'dark', icon: '☾', label: '深色' },
]

const HINTS: Record<StylePreference, { light: string; dark: string }> = {
  ink: { light: '亮色是宣紙上的墨', dark: '深色是夜裡的餘燼' },
  doodle: { light: '亮色是方格筆記本上的原子筆和螢光筆', dark: '深色是黑板上的粉筆' },
  mist: { light: '亮色是清晨起霧的山', dark: '深色是入夜的山谷' },
}

/** 外觀設定裡的縮圖：data-preview 會把那個風格＋深淺的變數套在縮圖上（index.css） */
function Thumb({ preview }: { preview: string }) {
  return (
    <span className="appearance-thumb" data-preview={preview} aria-hidden="true">
      <span className="thumb-bar">
        <b>歐陽天地</b>
        <i />
        <i />
      </span>
      <span className="thumb-title">
        小<span className="thumb-mark">天地</span>
      </span>
      <span className="thumb-cards">
        <span />
        <span />
      </span>
      <span className="thumb-button">按鈕</span>
    </span>
  )
}

/** 頁首右上角的「外觀」：打開對話框選風格和深淺，選了馬上套用，記在這台裝置上 */
export default function Appearance() {
  const dialog = useRef<HTMLDialogElement>(null)
  const { style, theme, dark } = useAppearance()
  const styleName = STYLES.find((s) => s.value === style)?.name
  const themeLabel = THEMES.find((t) => t.value === theme)?.label
  const mode = dark ? 'dark' : 'light'
  const hint = HINTS[style][mode]

  return (
    <>
      <button
        type="button"
        className="appearance-button"
        aria-haspopup="dialog"
        title={`外觀：${styleName}・${themeLabel}`}
        onClick={() => dialog.current?.showModal()}
      >
        <span aria-hidden="true">🎨</span>
        <span className="appearance-label">外觀</span>
      </button>

      <dialog
        ref={dialog}
        className="appearance-dialog"
        aria-labelledby="appearance-title"
        // 點對話框外面（遮罩）就關掉
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close()
        }}
      >
        <form method="dialog" className="appearance-body">
          <header className="appearance-head">
            <div>
              <h2 id="appearance-title">外觀</h2>
              <p className="muted">選了馬上套用，記在這台裝置上</p>
            </div>
            <button className="appearance-close" value="close" aria-label="關閉">
              ✕
            </button>
          </header>

          <section className="appearance-section">
            <h3 id="appearance-style">風格</h3>
            <div className="appearance-styles" role="radiogroup" aria-labelledby="appearance-style">
              {STYLES.map((s) => (
                <label key={s.value} className="appearance-option">
                  <input
                    type="radio"
                    name="appearance-style"
                    value={s.value}
                    checked={style === s.value}
                    onChange={() => setStylePreference(s.value)}
                  />
                  <Thumb preview={`${s.value}-${mode}`} />
                  <span className="appearance-option-text">
                    <strong>{s.name}</strong>
                    <small>{s.desc}</small>
                  </span>
                  <span className="appearance-check" aria-hidden="true">
                    ✓
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="appearance-section">
            <h3 id="appearance-theme">深淺</h3>
            <div className="appearance-themes" role="radiogroup" aria-labelledby="appearance-theme">
              {THEMES.map((t) => (
                <label key={t.value}>
                  <input
                    type="radio"
                    name="appearance-theme"
                    value={t.value}
                    checked={theme === t.value}
                    onChange={() => setThemePreference(t.value)}
                  />
                  <span className="appearance-theme-icon" aria-hidden="true">
                    {t.icon}
                  </span>
                  {t.label}
                </label>
              ))}
            </div>
            <p className="appearance-hint">
              {theme === 'system' ? `跟著系統切換，現在是${dark ? '深色' : '亮色'}：${hint}。` : `${hint}。`}
            </p>
          </section>

          <footer className="appearance-foot">
            <button value="done">完成</button>
          </footer>
        </form>
      </dialog>
    </>
  )
}
