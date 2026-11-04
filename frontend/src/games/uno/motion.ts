import { useLayoutEffect, useRef, useState } from 'react'
import type { Card, UnoView } from './types'

/**
 * UNO 的動畫。伺服器一次送來整個新 view（抽 4 張就是手牌直接多 4 張），
 * 這裡比對新舊 view，把差異拆成一張一張的動作播出來：
 * - 出牌：桌上那張從出牌的人那邊飛過來，原本的牌壓在下面
 * - 抽牌：一張一張從牌堆飛到那個人的座位／自己的手牌，到了才算進張數
 * - 新的一局：從牌堆一圈一圈發牌
 * 只影響畫面，規則和能不能出牌都照 view。
 */

/** 每張飛行的時間 */
const FLIGHT_MS = 420
/** 出牌的動畫 */
const PLAY_MS = 380

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** 一次抽 n 張時每張間隔多久：張數少慢慢抽，張數多加快，整串不要拖太久 */
const spacing = (n: number, min: number, max: number, total: number) => Math.max(min, Math.min(max, total / n))

/** 把 node 放在畫面最上層，從 from 飛到 to，飛完拿掉。sizeAt 決定 node 本身的尺寸用哪一邊（另一邊用縮放） */
function fly(node: HTMLElement, from: DOMRect, to: DOMRect, sizeAt: 'from' | 'to', duration = FLIGHT_MS) {
  const box = sizeAt === 'from' ? from : to
  node.classList.add('uno-flyer')
  node.setAttribute('aria-hidden', 'true')
  Object.assign(node.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  })
  document.body.appendChild(node)
  const other = sizeAt === 'from' ? to : from
  const dx = other.left - box.left
  const dy = other.top - box.top
  const sx = other.width / box.width || 1
  const sy = other.height / box.height || 1
  const away = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
  const [start, end] = sizeAt === 'from' ? ['none', away] : [away, 'none']
  // 中途稍微抬高、轉一下，看起來像被拿起來
  const mid = `translate(${dx / 2}px, ${dy / 2 - 24}px) scale(${(1 + sx) / 2}, ${(1 + sy) / 2}) rotate(-8deg)`
  const anim = node.animate([{ transform: start }, { transform: mid, offset: 0.5 }, { transform: end }], {
    duration,
    easing: 'cubic-bezier(.3,.7,.4,1)',
  })
  return anim.finished.then(
    () => node.remove(),
    () => node.remove(),
  )
}

type MotionEls = {
  pile: HTMLElement | null
  top: HTMLElement | null
  hand: HTMLElement | null
  handArea: HTMLElement | null
  seats: Map<number, HTMLElement>
  /** 自己剛點出去的那張牌的位置，出牌動畫從這裡開始 */
  playFrom: DOMRect | null
}

/** 給元件登記 DOM 位置用（ref callback） */
export type MotionRefs = {
  pile: (el: HTMLElement | null) => void
  top: (el: HTMLElement | null) => void
  hand: (el: HTMLElement | null) => void
  handArea: (el: HTMLElement | null) => void
  seat: (seat: number, el: HTMLElement | null) => void
  /** 自己點出去的那張牌的位置 */
  playFrom: (rect: DOMRect) => void
}

export type Motion = {
  attach: MotionRefs
  /** 各座位還在路上、還沒算進張數的牌 */
  lag: number[]
  /** 自己還沒輪到發出來的新牌（不畫） */
  hidden: Card[]
  /** 自己正在飛過來的牌（畫出來但先看不見，佔好位置） */
  landing: Card[]
  /** 壓在桌上那張下面的牌 */
  under: Card | null
}

type Item = { seat: number; card?: Card }

export function useMotion(view: UnoView): Motion {
  const els = useRef<MotionEls>({ pile: null, top: null, hand: null, handArea: null, seats: new Map(), playFrom: null })
  const [attach] = useState<MotionRefs>(() => ({
    pile: (el) => void (els.current.pile = el),
    top: (el) => void (els.current.top = el),
    hand: (el) => void (els.current.hand = el),
    handArea: (el) => void (els.current.handArea = el),
    seat: (seat, el) => void (el ? els.current.seats.set(seat, el) : els.current.seats.delete(seat)),
    playFrom: (rect) => void (els.current.playFrom = rect),
  }))
  const [lag, setLag] = useState<number[]>([])
  const [hidden, setHidden] = useState<Card[]>([])
  const [landing, setLanding] = useState<Card[]>([])
  const [under, setUnder] = useState<Card | null>(null)
  const prev = useRef<UnoView | null>(null)
  const timers = useRef<number[]>([])
  /** 排隊中的最後一張什麼時候出發，新的抽牌接在後面 */
  const queueEnd = useRef(0)
  /** 換局時加一，舊的計時器、飛行結束後就不要再動狀態 */
  const generation = useRef(0)

  // 卸載時停掉排隊中的動畫。prev 也清掉：StrictMode 會卸載再掛上一次，重跑時當作第一次畫
  useLayoutEffect(
    () => () => {
      generation.current++
      timers.current.forEach(clearTimeout)
      timers.current = []
      prev.current = null
    },
    [],
  )

  useLayoutEffect(() => {
    const old = prev.current
    prev.current = view
    const animate = !reducedMotion() && !document.hidden

    function flush() {
      generation.current++
      timers.current.forEach(clearTimeout)
      timers.current = []
      queueEnd.current = 0
      setLag([])
      setHidden([])
      setLanding([])
    }

    /** 一張到了 */
    function arrive(item: Item, gen: number) {
      if (gen !== generation.current) return
      if (item.card !== undefined) {
        const card = item.card
        setLanding((l) => l.filter((c) => c !== card))
      } else {
        setLag((l) => l.map((n, s) => (s === item.seat ? Math.max(0, n - 1) : n)))
        els.current.seats
          .get(item.seat)
          ?.querySelector('.uno-back')
          ?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.5)' }, { transform: 'scale(1)' }], 220)
      }
    }

    /** 一張從牌堆出發 */
    function launch(item: Item, gen: number) {
      if (gen !== generation.current) return
      const pile = els.current.pile?.getBoundingClientRect()
      if (item.card !== undefined) {
        const card = item.card
        setHidden((h) => h.filter((c) => c !== card))
        setLanding((l) => [...l, card])
        // 等這張畫進手牌、知道它的位置再飛
        requestAnimationFrame(() => {
          if (gen !== generation.current) return
          const el = els.current.hand?.querySelector<HTMLElement>(`[data-card="${card}"]`)
          if (!el || !pile) return arrive(item, gen)
          const to = el.getBoundingClientRect()
          const clone = el.cloneNode(true) as HTMLElement
          clone.classList.remove('incoming', 'ok', 'dim', 'drawn', 'picked')
          clone.removeAttribute('data-card')
          clone.tabIndex = -1
          clone.style.setProperty('--w', `${to.width}px`)
          void fly(clone, pile, to, 'to').then(() => arrive(item, gen))
        })
      } else {
        const target = els.current.seats.get(item.seat)?.querySelector('.uno-back')
        if (!target || !pile) return arrive(item, gen)
        const back = document.createElement('span')
        back.className = 'uno-flyer-back'
        void fly(back, pile, target.getBoundingClientRect(), 'from').then(() => arrive(item, gen))
      }
    }

    /** 把這些牌排進佇列，一張一張發；還沒到的先不算進張數 */
    function queue(items: Item[], delay: number, gap: number) {
      if (items.length === 0) return
      const gen = generation.current
      const mine = items.flatMap((i) => (i.card === undefined ? [] : [i.card]))
      if (mine.length) setHidden((h) => [...h, ...mine])
      setLag((l) => {
        const next = view.seats.map((_, s) => l[s] ?? 0)
        for (const i of items) if (i.card === undefined) next[i.seat]++
        return next
      })
      const now = performance.now()
      let at = Math.max(now + delay, queueEnd.current)
      for (const item of items) {
        const wait = at - now
        timers.current.push(window.setTimeout(() => launch(item, gen), wait))
        at += gap
      }
      queueEnd.current = at
    }

    // 第一次畫：剛開局（還沒人動過）就發牌，中途進來的不動
    if (!old || old.game !== view.game) {
      flush()
      setUnder(null)
      els.current.playFrom = null
      if (!animate || view.stage !== 'play' || view.log.length > 0) return
      const n = view.seats.length
      const me = view.you
      const myHand = view.hand ?? []
      const rounds = Math.max(...view.seats.map((s, i) => (i === me ? myHand.length : s.count)))
      const items: Item[] = []
      // 從自己的下一位開始一人一張繞圈發
      const first = ((me ?? -1) + 1 + n) % n
      for (let r = 0; r < rounds; r++) {
        for (let k = 0; k < n; k++) {
          const seat = (first + k) % n
          if (seat === me) {
            if (r < myHand.length) items.push({ seat, card: myHand[r] })
          } else if (r < view.seats[seat].count) items.push({ seat })
        }
      }
      queue(items, 150, spacing(items.length, 40, 110, 2200))
      return
    }

    let delay = 0
    if (old.top !== view.top) {
      setUnder(old.top)
      const top = els.current.top
      const last = view.log.findLast((e) => e.type === 'play')
      let from: DOMRect | undefined
      if (last && last.seat === view.you) from = els.current.playFrom ?? els.current.handArea?.getBoundingClientRect()
      else if (last) from = els.current.seats.get(last.seat)?.getBoundingClientRect()
      els.current.playFrom = null
      if (animate && top && from) {
        const to = top.getBoundingClientRect()
        const dx = from.left + from.width / 2 - (to.left + to.width / 2)
        const dy = from.top + from.height / 2 - (to.top + to.height / 2)
        top.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(0.6) rotate(-35deg)`, opacity: 0.4 },
            { transform: 'translate(0, 0) scale(1.08) rotate(4deg)', opacity: 1, offset: 0.75 },
            { transform: 'none', opacity: 1 },
          ],
          { duration: PLAY_MS, easing: 'cubic-bezier(.2,.8,.3,1)' },
        )
        // 出 +2／+4 之後下一位罰抽：等牌落下再開始抽
        delay = PLAY_MS - 80
      }
    }

    if (!animate) return
    // 抽牌：別人看張數增加多少；自己看手牌多了哪幾張（被抓沒喊 UNO 也一樣）
    const items: Item[] = []
    view.seats.forEach((s, seat) => {
      if (seat === view.you && view.hand && old.hand) {
        const had = new Set(old.hand)
        for (const card of view.hand) if (!had.has(card)) items.push({ seat, card })
      } else {
        for (let k = old.seats[seat].count; k < s.count; k++) items.push({ seat })
      }
    })
    queue(items, delay, spacing(items.length, 90, 240, 1800))
  }, [view])

  return { attach, lag, hidden, landing, under }
}
