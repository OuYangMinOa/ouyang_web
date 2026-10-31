import { useEffect, useMemo, useState } from 'react'
import { copyToClipboard } from '../clipboard'
import { usePlayer } from './context'
import Icon from './Icon'
import { formatDate, isNew, load, matches, save, shareUrl, sortTracks, trackTitle, type Sort } from './tracks'

const SORTS: { value: Sort; label: string }[] = [
  { value: 'name', label: '依名稱' },
  { value: 'newest', label: '最新加入' },
]

const TOAST_MS = 2500

/**
 * 手機用系統的分享選單，可以直接選 Telegram；電腦上那個選單不好用，直接複製連結。
 * 回傳要顯示的提示，使用者自己取消分享就不顯示。
 */
async function share(name: string): Promise<string | null> {
  const url = shareUrl(name)
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ url })
      return null
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null
      // 其他失敗（例如瀏覽器不讓分享）就改成複製
    }
  }
  await copyToClipboard(url)
  return '已複製連結，貼到 Telegram 或 Discord 就能直接播放'
}

/** 跳動的音量條，表示這首正在播 */
function Bars() {
  return (
    <span className="music-bars" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

/** 曲目清單：全部或只有收藏；點一下就播，上一首／下一首照這份清單目前的篩選和排序 */
export default function MusicLibrary({ favoritesOnly = false }: { favoritesOnly?: boolean }) {
  const { tracks, loadError, current, playing, play, playAll, toggle, favorites, toggleFavorite } = usePlayer()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>(() => load('sort', 'name'))
  const [toast, setToast] = useState<{ message: string; id: number } | null>(null)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const shown = useMemo(
    () => sortTracks((tracks ?? []).filter((t) => (!favoritesOnly || favorites.has(t.name)) && matches(t, query)), sort),
    [tracks, favoritesOnly, favorites, query, sort],
  )
  const names = shown.map((t) => t.name)
  const total = favoritesOnly ? (tracks ?? []).filter((t) => favorites.has(t.name)).length : (tracks?.length ?? 0)

  function changeSort(value: Sort) {
    setSort(value)
    save('sort', value)
  }

  let empty = ''
  if (tracks && shown.length === 0) {
    if (query.trim()) empty = `找不到「${query.trim()}」。`
    else if (favoritesOnly) empty = '還沒有收藏，在清單裡按 ☆ 加入。'
    else empty = '目前沒有音樂。'
  }

  return (
    <>
      <div className="music-head">
        <h1>{favoritesOnly ? '我的收藏' : '全部音樂'}</h1>
        {tracks && <span className="muted">{total} 首</span>}
      </div>

      <div className="music-toolbar">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋名稱"
          aria-label="搜尋名稱"
        />
        <select value={sort} onChange={(e) => changeSort(e.target.value as Sort)} aria-label="排序">
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <div className="music-toolbar-actions">
          <button type="button" onClick={() => playAll(names, false)} disabled={names.length === 0}>
            <Icon name="play" /> 播放全部
          </button>
          <button type="button" className="secondary" onClick={() => playAll(names, true)} disabled={names.length === 0}>
            <Icon name="shuffle" /> 隨機
          </button>
        </div>
      </div>

      {loadError && <p className="error">載入失敗：{loadError}</p>}
      {!tracks && !loadError && <p className="muted">載入中…</p>}
      {empty && <p className="muted music-empty">{empty}</p>}

      <ol className="music-list">
        {shown.map((track, i) => {
          const isCurrent = track.name === current
          const favorite = favorites.has(track.name)
          const title = trackTitle(track.name)
          return (
            <li key={track.name} className={`music-track ${isCurrent ? 'current' : ''}`}>
              <button
                type="button"
                className="music-track-main"
                onClick={() => (isCurrent ? toggle() : play(track.name, names))}
                aria-label={isCurrent && playing ? `暫停 ${title}` : `播放 ${title}`}
                aria-current={isCurrent || undefined}
              >
                <span className="music-track-state">
                  {isCurrent && playing ? (
                    <Bars />
                  ) : (
                    <>
                      <span className="music-track-no">{i + 1}</span>
                      <span className="music-track-play">
                        <Icon name="play" />
                      </span>
                    </>
                  )}
                </span>
                <span className="music-track-title">{title}</span>
                {isNew(track) && <span className="chip subtle music-new">新</span>}
                <span className="music-track-date">{formatDate(track.modified)}</span>
              </button>
              <button
                type="button"
                className={`music-fav ${favorite ? 'on' : ''}`}
                onClick={() => toggleFavorite(track.name)}
                aria-pressed={favorite}
                aria-label={favorite ? `取消收藏 ${title}` : `收藏 ${title}`}
                title={favorite ? '取消收藏' : '收藏'}
              >
                {favorite ? '★' : '☆'}
              </button>
              <button
                type="button"
                className="music-share"
                onClick={() =>
                  share(track.name).then((message) => message && setToast({ message, id: Date.now() }))
                }
                aria-label={`分享 ${title}`}
                title="分享"
              >
                <Icon name="share" />
              </button>
            </li>
          )
        })}
      </ol>

      {toast && (
        <div key={toast.id} className="music-toast" role="status">
          {toast.message}
        </div>
      )}
    </>
  )
}
