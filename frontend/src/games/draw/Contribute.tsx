import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { api, errorMessage } from '../../api'
import { useAuth } from '../../auth'
import { Segmented } from '../shared/ui'
import {
  CATEGORY_MAX_CHARS,
  MAX_PER_SUBMIT,
  WORD_CHARS,
  WORD_LEVEL_NAMES,
  WORD_LEVELS,
  WORD_STATUS_NAMES,
  splitWords,
  type MyWords,
  type SubmitResult,
  type SubmittedWord,
  type WordLevel,
} from './types'

const STATUS_CLASS: Record<SubmittedWord['status'], string> = {
  pending: 'muted',
  approved: 'success',
  rejected: 'error',
}

/**
 * 投稿題目：登入的人投稿，管理員審核通過後所有房間都會出到（backend/src/draw_words.rs）。
 * 平常收起來，打開才去讀自己的投稿。
 */
export function Contribute() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  if (loading) return null
  return (
    <details className="dg-words" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>投稿題目</summary>
      {!user ? (
        <p className="muted">
          想到好畫又好猜的詞？
          <Link to="/login" className="text-link" state={{ from: location.pathname + location.search }}>
            登入
          </Link>
          後就能投稿，管理員審核通過後，所有房間都會出到。
        </p>
      ) : (
        open && <ContributeForm />
      )}
    </details>
  )
}

function ContributeForm() {
  const [mine, setMine] = useState<MyWords | null>(null)
  const [text, setText] = useState('')
  const [category, setCategory] = useState('')
  const [level, setLevel] = useState<WordLevel>(2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SubmitResult | null>(null)
  const categoryList = useId()
  const words = splitWords(text)
  const tooMany = words.length > MAX_PER_SUBMIT

  function reload() {
    return api<MyWords>('/games/draw/words')
      .then(setMine)
      .catch((e) => setError(errorMessage(e)))
  }

  useEffect(() => {
    api<MyWords>('/games/draw/words')
      .then(setMine)
      .catch((e) => setError(errorMessage(e)))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setResult(null)
    try {
      const reply = await api<SubmitResult>('/games/draw/words', {
        method: 'POST',
        body: JSON.stringify({ words, category: category.trim(), level }),
      })
      setResult(reply)
      setText('')
      setError(null)
      await reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function withdraw(word: SubmittedWord) {
    setBusy(true)
    try {
      await api(`/games/draw/words/${word.id}`, { method: 'DELETE' })
      setMine((prev) => prev && { ...prev, words: prev.words.filter((w) => w.id !== word.id) })
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!mine) return error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>

  return (
    <div className="dg-words-body">
      <p className="muted">
        目前題庫有 {mine.builtin + mine.submitted} 個詞，其中 {mine.submitted} 個是大家投稿的。
        {mine.trusted ? '你是管理員，投稿會直接加進題庫。' : '投稿經管理員審核通過後，所有房間都會出到。'}
      </p>
      <form className="stack" onSubmit={submit}>
        <label>
          要投稿的詞
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="例如：電音三太子、夾娃娃"
          />
          <span className="muted">
            一行一個，或用頓號、逗號隔開；每個詞 {WORD_CHARS.min}～{WORD_CHARS.max} 個字，只能有文字和數字。
            {words.length > 0 && (
              <span className={tooMany ? 'error' : undefined}>
                {' '}
                共 {words.length} 個{tooMany && `，一次最多 ${MAX_PER_SUBMIT} 個`}。
              </span>
            )}
          </span>
        </label>
        <div className="row dg-words-meta">
          <label>
            分類
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              list={categoryList}
              maxLength={CATEGORY_MAX_CHARS}
              placeholder="例如：動物"
              autoComplete="off"
            />
            <datalist id={categoryList}>
              {mine.categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <Segmented label="難度" value={level} options={WORD_LEVELS} onChange={setLevel} />
        </div>
        <button type="submit" disabled={busy || words.length === 0 || tooMany || !category.trim()}>
          {mine.trusted ? '加進題庫' : '送出投稿'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {result && <Outcome result={result} trusted={mine.trusted} />}

      <h3>我的投稿（{mine.words.length}）</h3>
      {mine.words.length === 0 ? (
        <p className="muted">還沒有投稿過。</p>
      ) : (
        <ul className="dg-mine">
          {mine.words.map((w) => (
            <li key={w.id}>
              <strong>{w.word}</strong>
              <span className="muted">
                {w.category}・{WORD_LEVEL_NAMES[w.level]}
              </span>
              <span className={`dg-mine-status ${STATUS_CLASS[w.status]}`}>{WORD_STATUS_NAMES[w.status]}</span>
              {w.status === 'pending' && (
                <button type="button" className="secondary" disabled={busy} onClick={() => withdraw(w)}>
                  收回
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Outcome({ result, trusted }: { result: SubmitResult; trusted: boolean }) {
  const { added, skipped } = result
  return (
    <div className="dg-words-outcome" role="status">
      {added.length > 0 ? (
        <p className="success">
          收下 {added.length} 個{trusted ? '，已經加進題庫' : '，等管理員審核'}：{added.join('、')}
        </p>
      ) : (
        <p className="muted">這次沒有收下任何詞。</p>
      )}
      {skipped.length > 0 && (
        <ul>
          {skipped.map((s, i) => (
            <li key={i}>
              <strong>{s.word}</strong>：{s.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
