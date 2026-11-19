import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { errorMessage } from '../api'
import { useAuth } from '../auth'
import { copyToClipboard } from '../clipboard'
import { FuncSayContext, type FuncSay } from './context'
import { applyVote, fetchQuotes, load, save, sendFavorite, sendVote, type Politics, type Quote, type Vote } from './quotes'
import './funcsay.css'

const TOAST_MS = 3000

type Toast = { message: string; login: boolean; id: number }

/** 幹話語錄的外框：載入語錄和自己按過的讚，切換「全部」「隨機」「收藏」不用重抓 */
export default function FuncSayApp() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const [quotes, setQuotes] = useState<Quote[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [votes, setVotes] = useState<Map<number, Vote>>(() => new Map())
  const [favorites, setFavorites] = useState<number[]>([])
  const [politics, setPoliticsState] = useState<Politics>(() => load('politics', 'hide'))
  const [toast, setToast] = useState<Toast | null>(null)
  const [attempt, setAttempt] = useState(0)
  // 送出中的語錄，回來之前再按不理它
  const pending = useRef(new Set<number>())
  const userId = user?.id

  // 登入、登出後重抓：自己按過的讚跟著帳號走
  useEffect(() => {
    if (loading) return
    let cancelled = false
    fetchQuotes()
      .then((listing) => {
        if (cancelled) return
        setLoadError('')
        setQuotes(listing.quotes)
        setVotes(new Map(Object.entries(listing.mine?.votes ?? {}).map(([id, vote]) => [Number(id), vote])))
        setFavorites(listing.mine?.favorites ?? [])
      })
      .catch((e) => {
        if (!cancelled) setLoadError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [loading, userId, attempt])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), toast.login ? TOAST_MS * 2 : TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])

  const notify = useCallback((message: string, login = false) => setToast({ message, login, id: Date.now() }), [])

  function setPolitics(value: Politics) {
    setPoliticsState(value)
    save('politics', value)
  }

  function replaceQuote(id: number, change: (quote: Quote) => Quote) {
    setQuotes((list) => list && list.map((q) => (q.id === id ? change(q) : q)))
  }

  function setVote(id: number, vote: Vote | null) {
    setVotes((map) => {
      const next = new Map(map)
      if (vote) next.set(id, vote)
      else next.delete(id)
      return next
    })
  }

  async function vote(id: number, to: Vote | null) {
    if (!userId) return notify('登入後就能按讚和倒讚', true)
    if (pending.current.has(id)) return
    const from = votes.get(id) ?? null
    if (from === to) return
    pending.current.add(id)
    // 先改畫面，伺服器回來再換成真正的票數（Android APP 那邊可能剛好也有人投）
    setVote(id, to)
    replaceQuote(id, (q) => applyVote(q, from, to))
    try {
      const result = await sendVote(id, to)
      setVote(id, result.vote)
      replaceQuote(id, () => result.quote)
    } catch (e) {
      setVote(id, from)
      replaceQuote(id, (q) => applyVote(q, to, from))
      notify(errorMessage(e))
    } finally {
      pending.current.delete(id)
    }
  }

  async function toggleFavorite(id: number) {
    if (!userId) return notify('登入後就能收藏', true)
    if (pending.current.has(-id)) return
    const on = !favorites.includes(id)
    pending.current.add(-id)
    setFavorites((list) => (on ? [id, ...list] : list.filter((f) => f !== id)))
    try {
      await sendFavorite(id, on)
    } catch (e) {
      setFavorites((list) => (on ? list.filter((f) => f !== id) : [id, ...list]))
      notify(errorMessage(e))
    } finally {
      pending.current.delete(-id)
    }
  }

  async function copy(quote: Quote) {
    await copyToClipboard(quote.text)
    notify('已複製')
  }

  const value: FuncSay = {
    quotes,
    loadError,
    reload: () => {
      setLoadError('')
      setAttempt((n) => n + 1)
    },
    signedIn: !!userId,
    votes,
    favorites,
    politics,
    setPolitics,
    vote,
    toggleFavorite,
    copy,
    askLogin: (message) => notify(message, true),
  }

  return (
    <FuncSayContext value={value}>
      <div className="funcsay">
        <Outlet />
      </div>
      {toast && (
        <div key={toast.id} className="funcsay-toast" role="status">
          {toast.message}
          {toast.login && (
            <Link to={`/login?next=${encodeURIComponent(location.pathname)}`} className="funcsay-toast-link">
              登入
            </Link>
          )}
        </div>
      )}
    </FuncSayContext>
  )
}
