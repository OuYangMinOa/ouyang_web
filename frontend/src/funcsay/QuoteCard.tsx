import { useFuncSay } from './context'
import Icon from './Icon'
import type { Quote } from './quotes'

/** 一則語錄：本文、出處，下面是讚、倒讚、收藏、複製 */
export default function QuoteCard({ quote, large = false }: { quote: Quote; large?: boolean }) {
  const { votes, favorites, vote, toggleFavorite, copy } = useFuncSay()
  const mine = votes.get(quote.id) ?? null
  const favorite = favorites.includes(quote.id)

  return (
    <article className={`funcsay-card ${large ? 'large' : ''}`}>
      <p className="funcsay-text">{quote.text}</p>
      {quote.source && <p className="funcsay-source">{quote.source}</p>}
      <div className="funcsay-foot">
        <span className="funcsay-meta">
          #{quote.id}
          {quote.politics && <span className="chip subtle">政治</span>}
        </span>
        <div className="funcsay-actions">
          <button
            type="button"
            className={`funcsay-btn love ${mine === 'love' ? 'on' : ''}`}
            onClick={() => vote(quote.id, mine === 'love' ? null : 'love')}
            aria-pressed={mine === 'love'}
            aria-label={`讚，${quote.love} 個`}
            title={mine === 'love' ? '收回讚' : '讚'}
          >
            <Icon name="love" />
            <span>{quote.love}</span>
          </button>
          <button
            type="button"
            className={`funcsay-btn hate ${mine === 'hate' ? 'on' : ''}`}
            onClick={() => vote(quote.id, mine === 'hate' ? null : 'hate')}
            aria-pressed={mine === 'hate'}
            aria-label={`倒讚，${quote.hate} 個`}
            title={mine === 'hate' ? '收回倒讚' : '倒讚'}
          >
            <Icon name="hate" />
            <span>{quote.hate}</span>
          </button>
          <button
            type="button"
            className={`funcsay-btn fav ${favorite ? 'on' : ''}`}
            onClick={() => toggleFavorite(quote.id)}
            aria-pressed={favorite}
            aria-label={favorite ? '取消收藏' : '收藏'}
            title={favorite ? '取消收藏' : '收藏'}
          >
            <Icon name="star" />
          </button>
          <button type="button" className="funcsay-btn" onClick={() => copy(quote)} aria-label="複製" title="複製">
            <Icon name="copy" />
          </button>
        </div>
      </div>
    </article>
  )
}
