import { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useFuncSay } from './context'
import QuoteCard from './QuoteCard'
import { byPolitics, load, matches, POLITICS, save, sortQuotes, SORTS, type Politics, type Sort } from './quotes'

/** 全部語錄或我的收藏；收藏照收藏的順序、不管政治類的篩選 */
export default function QuoteList({ favoritesOnly = false }: { favoritesOnly?: boolean }) {
  const { quotes, loadError, reload, signedIn, favorites, politics, setPolitics } = useFuncSay()
  const location = useLocation()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>(() => load('sort', 'id'))

  const pool = useMemo(() => {
    if (!quotes) return []
    if (!favoritesOnly) return byPolitics(quotes, politics)
    const byId = new Map(quotes.map((q) => [q.id, q]))
    return favorites.flatMap((id) => byId.get(id) ?? [])
  }, [quotes, favoritesOnly, favorites, politics])
  const shown = useMemo(() => {
    const found = pool.filter((q) => matches(q, query))
    return favoritesOnly ? found : sortQuotes(found, sort)
  }, [pool, query, sort, favoritesOnly])

  function changeSort(value: Sort) {
    setSort(value)
    save('sort', value)
  }

  const loginLink = `/login?next=${encodeURIComponent(location.pathname)}`
  const title = favoritesOnly ? '我的收藏' : '幹話語錄'

  if (favoritesOnly && !signedIn) {
    return (
      <>
        <h1>{title}</h1>
        <div className="card narrow stack">
          <p className="muted">登入後就能收藏喜歡的語錄，換裝置也看得到。</p>
          <Link to={loginLink} className="funcsay-login">
            登入
          </Link>
        </div>
      </>
    )
  }

  let empty = ''
  if (quotes && shown.length === 0) {
    if (query.trim()) empty = `找不到「${query.trim()}」。`
    else if (favoritesOnly) empty = '還沒有收藏，在語錄下面按 ☆ 加入。'
    else empty = '這個分類沒有語錄。'
  }

  return (
    <>
      <div className="funcsay-head">
        <h1>{title}</h1>
        {quotes && (
          <span className="muted">{query.trim() ? `找到 ${shown.length} 則` : `${pool.length} 則`}</span>
        )}
      </div>

      {!favoritesOnly && !signedIn && (
        <p className="muted funcsay-hint">
          登入後可以按讚、倒讚和收藏，票數跟 Android APP 是同一份。{' '}
          <Link to={loginLink} className="text-link">
            登入
          </Link>
        </p>
      )}

      <div className="funcsay-toolbar">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋語錄、出處或編號"
          aria-label="搜尋語錄、出處或編號"
        />
        {!favoritesOnly && (
          <>
            <select
              value={politics}
              onChange={(e) => setPolitics(e.target.value as Politics)}
              aria-label="政治類語錄"
            >
              {POLITICS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <select value={sort} onChange={(e) => changeSort(e.target.value as Sort)} aria-label="排序">
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {loadError && (
        <div className="funcsay-error">
          <p className="error">載入失敗：{loadError}</p>
          <button type="button" className="secondary" onClick={reload}>
            重試
          </button>
        </div>
      )}
      {!quotes && !loadError && <p className="muted">載入中…</p>}
      {empty && <p className="muted funcsay-empty">{empty}</p>}

      <ol className="funcsay-list">
        {shown.map((quote) => (
          <li key={quote.id}>
            <QuoteCard quote={quote} />
          </li>
        ))}
      </ol>
    </>
  )
}
