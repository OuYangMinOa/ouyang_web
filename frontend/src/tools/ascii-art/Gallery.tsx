import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { renderArt, type ArtOptions } from './fonts'
import { useFont } from './useFont'

const PAGE = 24

/** 字型總覽：同一段文字用每個字型各畫一次，捲到底再載入下一批 */
export default function Gallery({
  fonts,
  text,
  options,
  current,
  onPick,
}: {
  fonts: string[]
  text: string
  options: Omit<ArtOptions, 'font'>
  current: string
  onPick: (font: string) => void
}) {
  const [count, setCount] = useState(PAGE)
  const sentinel = useRef<HTMLButtonElement>(null)
  const more = count < fonts.length

  // 每次數量變了就重新觀察：新的一批太短、哨兵還在畫面裡時會接著載入
  useEffect(() => {
    const el = sentinel.current
    if (!el || !more || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount((c) => c + PAGE)
      },
      { rootMargin: '800px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [count, more])

  if (fonts.length === 0) return <p className="muted">沒有符合的字型。</p>

  return (
    <>
      <ul className="aa-gallery">
        {fonts.slice(0, count).map((font) => (
          <GalleryItem
            key={font}
            font={font}
            text={text}
            options={options}
            current={font === current}
            onPick={onPick}
          />
        ))}
      </ul>
      {more && (
        <button ref={sentinel} type="button" className="secondary aa-more" onClick={() => setCount((c) => c + PAGE)}>
          載入更多（還有 {fonts.length - count} 個）
        </button>
      )}
    </>
  )
}

const GalleryItem = memo(function GalleryItem({
  font,
  text,
  options,
  current,
  onPick,
}: {
  font: string
  text: string
  options: Omit<ArtOptions, 'font'>
  current: boolean
  onPick: (font: string) => void
}) {
  const status = useFont(font)
  const { h, v, width, whitespaceBreak } = options
  const art = useMemo(() => {
    if (status !== 'ready') return null
    try {
      return renderArt(text, { font, h, v, width, whitespaceBreak })
    } catch {
      return null
    }
  }, [status, text, font, h, v, width, whitespaceBreak])

  // 點卡片任何地方都能選；正在框選文字時不算
  const pick = () => {
    if (window.getSelection()?.toString()) return
    onPick(font)
  }

  return (
    <li className={current ? 'aa-gallery-item current' : 'aa-gallery-item'} onClick={pick}>
      <div className="aa-gallery-head">
        <strong>{font}</strong>
        <button
          type="button"
          className="secondary"
          onClick={(e) => {
            e.stopPropagation()
            onPick(font)
          }}
        >
          {current ? '使用中' : '使用'}
        </button>
      </div>
      <pre className="aa-art aa-gallery-art">
        {status === 'error' ? (
          <span className="aa-dim">字型載入失敗</span>
        ) : art === null ? (
          <span className="aa-dim">載入中…</span>
        ) : art === '' ? (
          <span className="aa-dim">（這個字型畫不出這段文字）</span>
        ) : (
          art
        )}
      </pre>
    </li>
  )
})
