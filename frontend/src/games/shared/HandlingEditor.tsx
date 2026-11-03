import { ARR_RANGE, DAS_RANGE, HANDLING_DEFAULTS, SOFT_RANGE, type Handling, type HandlingSettings } from './handling'

const SLIDERS: { field: keyof Handling; label: string; range: typeof DAS_RANGE; hint: string }[] = [
  { field: 'das', label: 'DAS（開始連續移動）', range: DAS_RANGE, hint: '左右鍵按住多久才開始連續移動；點一下常常多走一格就調長一點' },
  { field: 'arr', label: 'ARR（連續移動間隔）', range: ARR_RANGE, hint: '連續移動時每格的間隔，0 是直接滑到底' },
  { field: 'soft', label: '加速下落間隔', range: SOFT_RANGE, hint: '按住加速下落時每格的間隔，0 是瞬間落到底（不會鎖定，還能移動）' },
]

const FIELDS = SLIDERS.map((s) => s.field)

/** 調整 DAS、ARR、加速下落：拖了就生效，停下來才存到帳號 */
export function HandlingEditor({ settings, onDone }: { settings: HandlingSettings; onDone: () => void }) {
  const { handling, change, error, synced } = settings
  const isDefault = FIELDS.every((f) => handling[f] === HANDLING_DEFAULTS[f])

  return (
    <>
      <ul className="game-handling">
        {SLIDERS.map(({ field, label, range, hint }) => (
          <li key={field}>
            <label htmlFor={`handling-${field}`}>{label}</label>
            <output htmlFor={`handling-${field}`}>{field === 'soft' && handling.soft === 0 ? '瞬間' : `${handling[field]} ms`}</output>
            <input
              id={`handling-${field}`}
              type="range"
              min={range.min}
              max={range.max}
              step={range.step}
              value={handling[field]}
              onChange={(e) => change({ ...handling, [field]: Number(e.target.value) })}
            />
            <span className="muted">{hint}</span>
          </li>
        ))}
      </ul>
      <p className="muted">
        預設 DAS {HANDLING_DEFAULTS.das} ms、ARR {HANDLING_DEFAULTS.arr} ms、加速下落 {HANDLING_DEFAULTS.soft} ms。
        {synced ? '設定存在你的帳號，換裝置也一樣。' : '設定存在這個瀏覽器，登入後會存到帳號。'}
      </p>
      {error && <p className="error">{error}</p>}
      <div className="game-keys-actions">
        <button type="button" className="secondary" onClick={() => change(null)} disabled={isDefault}>
          恢復預設
        </button>
        <button type="button" onClick={onDone}>
          完成
        </button>
      </div>
    </>
  )
}
