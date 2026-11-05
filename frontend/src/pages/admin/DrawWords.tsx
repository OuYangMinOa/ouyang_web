import { useEffect, useState } from 'react'
import { api, errorMessage } from '../../api'
import {
  CATEGORY_MAX_CHARS,
  WORD_LEVEL_NAMES,
  WORD_LEVELS,
  type SubmittedWord,
  type WordLevel,
} from '../../games/draw/types'
import type { DrawWordsReport } from './types'

const BASE = '/admin/draw-words'
const CATEGORY_LIST = 'dgw-categories'
/** 已通過的最多列幾個，其他的用搜尋找 */
const SHOWN = 200

type Review = 'approved' | 'rejected'
type Patch = { category?: string; level?: WordLevel }

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—'
}

/** 你畫我猜的投稿題目：審核、改分類和難度，以及目前題庫的分布（後端見 draw_words.rs） */
export default function AdminDrawWords() {
  const [report, setReport] = useState<DrawWordsReport | null>(null)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<DrawWordsReport>(BASE)
      .then(setReport)
      .catch((e) => setError(errorMessage(e)))
  }, [])

  /** 做一件事，之後換成新的清單（`task` 沒回傳清單就重新讀一次） */
  async function run(task: () => Promise<DrawWordsReport | null>) {
    setBusy(true)
    try {
      const next = (await task()) ?? (await api<DrawWordsReport>(BASE))
      setReport(next)
      setSelected((prev) => new Set([...prev].filter((id) => next.pending.some((w) => w.id === id))))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function review(ids: number[], status: Review) {
    return run(() => api<DrawWordsReport>(`${BASE}/status`, { method: 'PUT', body: JSON.stringify({ ids, status }) }))
  }

  function update(word: SubmittedWord, patch: Patch) {
    return run(async () => {
      await api(`${BASE}/${word.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      return null
    })
  }

  function withdraw(word: SubmittedWord) {
    if (confirm(`把「${word.word}」從題庫撤下？之後也不能再被投稿，除非刪掉這筆。`)) review([word.id], 'rejected')
  }

  function remove(word: SubmittedWord) {
    if (!confirm(`刪掉「${word.word}」這筆？刪掉之後這個詞可以再被投稿。`)) return
    run(async () => {
      await api(`${BASE}/${word.id}`, { method: 'DELETE' })
      return null
    })
  }

  if (!report) return error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>

  const { pending, approved, rejected } = report
  const allSelected = pending.length > 0 && pending.every((w) => selected.has(w.id))
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(pending.map((w) => w.id)))
  const picked = [...selected]
  const q = query.trim()
  const matched = q ? approved.filter((w) => w.word.includes(q) || w.category.includes(q)) : approved
  const edit = (w: SubmittedWord) => (
    <>
      <td data-label="分類">
        <CategoryInput key={w.category} word={w} disabled={busy} onSave={(category) => update(w, { category })} />
      </td>
      <td data-label="難度">
        <select
          value={w.level}
          disabled={busy}
          aria-label={`「${w.word}」的難度`}
          onChange={(e) => update(w, { level: Number(e.target.value) as WordLevel })}
        >
          {WORD_LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </td>
    </>
  )

  return (
    <>
      <h1>你畫我猜題目</h1>
      <p className="muted">
        登入的人在遊戲頁投稿，這裡通過的詞會和內建詞庫一起出題（之後開的局才會用到）。分類和難度可以先改再通過。
      </p>
      <datalist id={CATEGORY_LIST}>
        {report.categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {error && <p className="error">{error}</p>}

      <h2>待審核（{pending.length}）</h2>
      {pending.length === 0 ? (
        <p className="muted">目前沒有待審核的投稿。</p>
      ) : (
        <>
          <div className="dgw-bulk">
            <label className="dgw-check">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              全選
            </label>
            <button type="button" disabled={busy || picked.length === 0} onClick={() => review(picked, 'approved')}>
              通過勾選（{picked.length}）
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy || picked.length === 0}
              onClick={() => review(picked, 'rejected')}
            >
              不通過勾選
            </button>
          </div>
          <div className="table-wrap">
            <table className="responsive dgw-table">
              <thead>
                <tr>
                  <th aria-label="選取" />
                  <th>詞</th>
                  <th>分類</th>
                  <th>難度</th>
                  <th>投稿者</th>
                  <th>投稿時間</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((w) => (
                  <tr key={w.id}>
                    <td className="dgw-pick">
                      <label className="dgw-check">
                        <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} />
                        <span className="dgw-pick-label">選取</span>
                      </label>
                    </td>
                    <td data-label="詞" className="primary">
                      {w.word}
                    </td>
                    {edit(w)}
                    <td data-label="投稿者">{w.submitter ?? '—'}</td>
                    <td data-label="投稿時間">
                      <time>{formatTime(w.created_at)}</time>
                    </td>
                    <td className="actions">
                      <button type="button" disabled={busy} onClick={() => review([w.id], 'approved')}>
                        通過
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() => review([w.id], 'rejected')}
                      >
                        不通過
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>已通過（{approved.length}）</h2>
      {approved.length === 0 ? (
        <p className="muted">還沒有通過的投稿。</p>
      ) : (
        <>
          <input
            className="dgw-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋詞或分類"
            aria-label="搜尋已通過的詞"
          />
          <div className="table-wrap">
            <table className="responsive dgw-table">
              <thead>
                <tr>
                  <th>詞</th>
                  <th>分類</th>
                  <th>難度</th>
                  <th>投稿者</th>
                  <th>通過</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {matched.slice(0, SHOWN).map((w) => (
                  <tr key={w.id}>
                    <td data-label="詞" className="primary">
                      {w.word}
                    </td>
                    {edit(w)}
                    <td data-label="投稿者">{w.submitter ?? '—'}</td>
                    <td data-label="通過">
                      {w.reviewer ?? '—'}
                      <span className="muted"> {formatTime(w.reviewed_at)}</span>
                    </td>
                    <td className="actions">
                      <button type="button" className="danger" disabled={busy} onClick={() => withdraw(w)}>
                        撤下
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matched.length > SHOWN && <p className="muted">還有 {matched.length - SHOWN} 個沒列出來，用搜尋找。</p>}
          {matched.length === 0 && <p className="muted">沒有符合的詞。</p>}
        </>
      )}

      {rejected.length > 0 && (
        <>
          <h2>最近沒通過</h2>
          <p className="muted">沒通過的詞不能再被投稿；刪掉那筆就可以。</p>
          <div className="table-wrap">
            <table className="responsive dgw-table">
              <thead>
                <tr>
                  <th>詞</th>
                  <th>分類</th>
                  <th>投稿者</th>
                  <th>審核</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rejected.map((w) => (
                  <tr key={w.id}>
                    <td data-label="詞" className="primary">
                      {w.word}
                    </td>
                    <td data-label="分類">
                      {w.category}・{WORD_LEVEL_NAMES[w.level]}
                    </td>
                    <td data-label="投稿者">{w.submitter ?? '—'}</td>
                    <td data-label="審核">
                      {w.reviewer ?? '—'}
                      <span className="muted"> {formatTime(w.reviewed_at)}</span>
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => review([w.id], 'approved')}
                      >
                        改成通過
                      </button>
                      <button type="button" className="danger" disabled={busy} onClick={() => remove(w)}>
                        刪除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Distribution rows={report.distribution} />
    </>
  )
}

/** 分類欄：改完離開欄位（或按 Enter）才存 */
function CategoryInput({
  word,
  disabled,
  onSave,
}: {
  word: SubmittedWord
  disabled: boolean
  onSave: (category: string) => void
}) {
  const [value, setValue] = useState(word.category)
  function commit() {
    const category = value.trim()
    if (category && category !== word.category) onSave(category)
    else setValue(word.category)
  }
  return (
    <input
      className="dgw-category"
      value={value}
      list={CATEGORY_LIST}
      maxLength={CATEGORY_MAX_CHARS}
      disabled={disabled}
      aria-label={`「${word.word}」的分類`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

const LEVEL_COLUMNS = ['簡單', '普通', '困難']

/** 目前遊戲用的詞庫，每個分類各難度有幾個詞；詞少的分類排在後面 */
function Distribution({ rows }: { rows: DrawWordsReport['distribution'] }) {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const total = (r: DrawWordsReport['distribution'][number]) => sum(r.builtin) + sum(r.submitted)
  const sorted = [...rows].sort((a, b) => total(b) - total(a))
  const builtin = [0, 1, 2].map((i) => sum(rows.map((r) => r.builtin[i])))
  const submitted = [0, 1, 2].map((i) => sum(rows.map((r) => r.submitted[i])))
  const count = (b: number, s: number) => (
    <>
      {b + s}
      {s > 0 && <span className="dgw-plus">+{s}</span>}
    </>
  )
  return (
    <>
      <h2>題庫分布</h2>
      <p className="muted">
        共 {sum(builtin) + sum(submitted)} 個詞（內建 {sum(builtin)}、投稿 {sum(submitted)}
        ），綠色的 +N 是其中投稿的詞。選題時簡單、普通、困難各抽一個。
      </p>
      <div className="table-wrap">
        <table className="dgw-dist">
          <thead>
            <tr>
              <th>分類</th>
              {LEVEL_COLUMNS.map((name) => (
                <th key={name}>{name}</th>
              ))}
              <th>合計</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.category}>
                <td data-label="分類" className="primary">
                  {r.category}
                </td>
                {LEVEL_COLUMNS.map((name, i) => (
                  <td key={name} data-label={name}>
                    {count(r.builtin[i], r.submitted[i])}
                  </td>
                ))}
                <td data-label="合計">{count(sum(r.builtin), sum(r.submitted))}</td>
              </tr>
            ))}
            <tr className="dgw-total">
              <td data-label="分類" className="primary">
                全部
              </td>
              {LEVEL_COLUMNS.map((name, i) => (
                <td key={name} data-label={name}>
                  {count(builtin[i], submitted[i])}
                </td>
              ))}
              <td data-label="合計">{count(sum(builtin), sum(submitted))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}
