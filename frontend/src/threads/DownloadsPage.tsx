import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '../api'
import { deleteDownload, getDownloads, type Download } from './api'
import './threads.css'

export default function DownloadsPage() {
  const [downloads, setDownloads] = useState<Download[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getDownloads()
      .then(setDownloads)
      .catch((e) => setError(errorMessage(e)))
  }, [])

  async function remove(item: Download) {
    if (!confirm('刪除這筆紀錄？')) return
    try {
      await deleteDownload(item.id)
      setDownloads((prev) => prev && prev.filter((d) => d.id !== item.id))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (!downloads) return error ? <p className="error">{error}</p> : <p className="muted">載入中…</p>

  return (
    <div className="threads">
      <h1>下載紀錄</h1>
      <p className="muted">用捷徑或網頁下載過的貼文，新的在前面，最多保留 500 筆。</p>
      {error && <p className="error">{error}</p>}
      {downloads.length === 0 ? (
        <p className="muted">
          還沒有下載過。先到 <Link className="text-link" to="/threads">安裝捷徑</Link>，在 Threads 按分享試試看，或是直接
          <Link className="text-link" to="/threads/paste">貼網址下載</Link>。
        </p>
      ) : (
        <div className="table-wrap">
          <table className="responsive">
            <thead>
              <tr>
                <th>時間</th>
                <th>作者</th>
                <th>貼文</th>
                <th>影片</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {downloads.map((item) => (
                <tr key={item.id}>
                  <td data-label="時間">
                    <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
                  </td>
                  <td data-label="作者">{item.author ? `@${item.author}` : '—'}</td>
                  <td data-label="貼文" className="primary">
                    <a className="threads-post" href={item.url} target="_blank" rel="noreferrer">
                      {item.caption || item.url}
                    </a>
                  </td>
                  <td data-label="影片">{item.video_count} 支</td>
                  <td className="actions">
                    <button type="button" className="danger" onClick={() => remove(item)}>
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
