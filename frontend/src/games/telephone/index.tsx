import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Board } from '../draw/board'
import { paint } from '../draw/paint'
import { Sketch } from '../draw/Sketch'
import type { Stroke } from '../draw/types'
import '../draw/draw.css'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  MAX_POINTS,
  MAX_STROKES,
  MAX_TEXT,
  type Chain,
  type Content,
  type Entry,
  type TelephoneParty,
  type TpOptions,
  type TpView,
} from './types'
import './telephone.css'

type TpParty = Party<TelephoneParty>
type Task = NonNullable<TpView['task']>

/** 寫字的草稿停手多久送一次、畫圖的草稿最多多久送一次（時間到時伺服器收的是最後存的那份） */
const TEXT_SAVE_MS = 400
const DRAW_SAVE_MS = 1000
/** 時間快到時，提早這麼久再存一次，免得最後幾筆沒送到 */
const FINAL_SAVE_MS = 1500

/** 畫布的筆畫不即時轉給別人，Sketch 送出的 begin／more 都不用管 */
const ignore = () => {}

/** 傳話畫畫：規則都在伺服器（backend/src/telephone.rs），這裡只畫自己的 view、送動作 */
export default function Telephone() {
  const party = useParty<TelephoneParty>('telephone')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>每個人寫一句話，傳給下一個人畫，再傳給下一個人看圖猜…傳一圈之後一起看題目被傳成什麼樣子。3～10 人，手機也能畫。</p>
        </PartyEntry>
      </GameLayout>
    )
  }
  return <InRoom party={party} />
}

function Rules() {
  return (
    <div className="game-help">
      <strong>怎麼玩</strong>
      <ul>
        <li>第一步每個人寫一個題目（想不到可以按「給我一個題目」），寫完傳給下一個人。</li>
        <li>拿到句子的人照著畫，拿到畫的人寫出他覺得在畫什麼，寫字、畫圖輪流，一路傳下去。</li>
        <li>每個人只看得到上一個人給的那一步，看不到最早的題目，也看不到別串。</li>
        <li>每一步有時間限制，大家都按「完成」就提早進下一步；時間到會交出你目前寫的、畫的（沒寫、沒畫也會傳下去）。</li>
        <li>傳完之後一串一串揭曉，房主按「下一步」大家一起看；喜歡的作品可以按 👍，最後看誰拿到最多讚。</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: TpParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩傳話畫畫"
      extra={
        party.isHost &&
        playing && (
          <button
            type="button"
            className="secondary"
            onClick={() => window.confirm('中止這一局，回到大廳？') && party.abort()}
          >
            中止這局
          </button>
        )
      }
    />
  )
  if (!room) {
    return (
      <div className="tp">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="tp">
        {header}
        <PartyNotice party={party} />
        <GameLayout
          side={
            <>
              <ChatBox party={party} />
              <Rules />
            </>
          }
        >
          <PartyLobby party={party} options={<OptionsForm party={party} />} />
        </GameLayout>
      </div>
    )
  }

  return (
    <div className="tp">
      {header}
      <GameLayout
        side={
          <>
            <ChatBox party={party} />
            <Progress party={party} view={view} />
            <Rules />
          </>
        }
      >
        <Play party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && <PartyLobby party={party} options={<OptionsForm party={party} />} />}
      </GameLayout>
    </div>
  )
}

function OptionsForm({ party }: { party: TpParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<TpOptions>) => party.setOptions({ ...o, ...patch })
  const players = Math.min(room.players.filter((p) => p.online).length, room.max)
  const steps = o.steps === 0 ? players : Math.min(o.steps, players)

  return (
    <div className="tp-options">
      <Segmented
        label="每串傳幾步"
        value={o.steps}
        options={[
          { value: 0, label: '跟人數一樣' },
          ...[4, 6, 8].map((n) => ({ value: n, label: `${n} 步` })),
        ]}
        onChange={(v) => set({ steps: v })}
        disabled={!editable}
      />
      <Segmented
        label="寫字時間"
        value={o.writeSecs}
        options={[30, 45, 60].map((s) => ({ value: s, label: `${s} 秒` }))}
        onChange={(writeSecs) => set({ writeSecs })}
        disabled={!editable}
      />
      <Segmented
        label="畫圖時間"
        value={o.drawSecs}
        options={[60, 90, 120].map((s) => ({ value: s, label: `${s} 秒` }))}
        onChange={(drawSecs) => set({ drawSecs })}
        disabled={!editable}
      />
      <p className="muted">
        {players >= 3 ? `${players} 人、${players} 串，每串傳 ${steps} 步。` : '至少要 3 人。'}
        {!party.isHost && ' 選項由房主決定。'}
      </p>
    </div>
  )
}

function nameOf(party: TpParty, seat: number): string {
  return party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
}

/** 進度：照傳下去的順序，作答中標出誰完成了 */
function Progress({ party, view }: { party: TpParty; view: TpView }) {
  const answering = view.stage === 'write' || view.stage === 'draw'
  const done = view.seats.filter((s) => s.done).length
  return (
    <section className="tp-progress" aria-label="玩家">
      <h3>{answering ? `完成 ${done} / ${view.seats.length}` : '玩家'}</h3>
      <ol>
        {view.ring.map((seat) => {
          const s = view.seats[seat]
          return (
            <li key={seat} className={`${seat === view.you ? 'me' : ''}${s.online ? '' : ' offline'}`}>
              <span className="tp-progress-name">{nameOf(party, seat)}</span>
              {seat === view.you && <span className="chip subtle">你</span>}
              {!s.online && <span className="chip subtle">離線</span>}
              {answering && (s.done ? <span className="chip tp-done">✓ 完成</span> : <span className="muted">作答中…</span>)}
              {view.stage === 'end' && <span className="tp-likes">👍 {s.likes}</span>}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Play({ party, view }: { party: TpParty; view: TpView }) {
  if (view.stage === 'reveal' && view.reveal) return <Reveal party={party} view={view} />
  if (view.stage === 'end') return <Results party={party} view={view} />
  const me = view.you
  const done = me !== null && view.seats[me].done
  const stepLine = (
    <p className="muted tp-step">
      第 {view.step + 1} / {view.steps} 步 · {view.stage === 'draw' ? '畫圖' : view.step === 0 ? '出題' : '看圖寫字'}
    </p>
  )
  if (me === null || !view.task) {
    return (
      <div className="tp-play">
        <StatusLine>
          大家正在{view.stage === 'draw' ? '畫圖' : '寫字'}… <Countdown ms={view.endsIn} stamp={view} />
        </StatusLine>
        {stepLine}
        <p className="muted tp-center">觀戰中：傳完之後就能一起看結果。</p>
      </div>
    )
  }
  return (
    <div className="tp-play">
      <StatusLine tone={done ? 'ok' : 'accent'}>
        {done ? '完成了！等其他人…' : view.stage === 'draw' ? '把它畫出來！' : view.step === 0 ? '寫一個題目' : '這張畫在畫什麼？'}{' '}
        <Countdown ms={view.endsIn} stamp={view} />
      </StatusLine>
      {stepLine}
      {view.stage === 'draw' ? (
        <DrawTask key={view.step} party={party} view={view} task={view.task} done={done} />
      ) : (
        <WriteTask key={view.step} party={party} view={view} task={view.task} done={done} />
      )}
    </div>
  )
}

/** 時間快到時再存一次（`endsIn` 是收到 view 當下的剩餘時間，`stamp` 換了就重新起算） */
function useFinalSave(endsIn: number | null, stamp: unknown, save: () => void) {
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })
  useEffect(() => {
    if (endsIn === null) return
    const id = setTimeout(() => saveRef.current(), Math.max(0, endsIn - FINAL_SAVE_MS))
    return () => clearTimeout(id)
  }, [endsIn, stamp])
}

function WriteTask({ party, view, task, done }: { party: TpParty; view: TpView; task: Task; done: boolean }) {
  const step = view.step
  const [text, setText] = useState(() => (task.draft?.kind === 'text' ? task.draft.text : ''))
  // 「給我一個題目」抽到新的就填進輸入框（在 render 裡依 props 更新 state）
  const [suggested, setSuggested] = useState(task.suggestion?.id ?? 0)
  if (task.suggestion && task.suggestion.id !== suggested) {
    setSuggested(task.suggestion.id)
    setText(task.suggestion.text)
  }
  const { act } = party

  // 停手一下就存草稿
  useEffect(() => {
    if (done) return
    const id = setTimeout(() => act({ type: 'write', step, text, done: false }), TEXT_SAVE_MS)
    return () => clearTimeout(id)
  }, [act, step, text, done])
  useFinalSave(view.endsIn, view, () => {
    if (!done) act({ type: 'write', step, text, done: false })
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    act({ type: 'write', step, text, done: true })
  }

  const previous = task.previous
  return (
    <div className="tp-task">
      {previous && previous.kind === 'drawing' && (
        <figure className="tp-given">
          <figcaption className="muted">{nameOf(party, previous.author)} 畫的</figcaption>
          <ContentBody content={previous} />
        </figure>
      )}
      <form className="tp-write" onSubmit={submit}>
        <label>
          <span>{step === 0 ? '題目（一句畫得出來的話）' : '你覺得這張畫在畫什麼？'}</span>
          <input
            value={text}
            onChange={(e) => setText([...e.target.value].slice(0, MAX_TEXT).join(''))}
            placeholder={step === 0 ? '例如：一隻貓在月球上釣魚' : '用一句話描述'}
            maxLength={MAX_TEXT * 2}
            disabled={done || !party.connected}
            enterKeyHint="done"
            autoComplete="off"
          />
        </label>
        <div className="tp-buttons">
          {step === 0 && !done && (
            <button type="button" className="secondary" onClick={() => act({ type: 'suggest' })} disabled={!party.connected}>
              給我一個題目
            </button>
          )}
          {done ? (
            <button type="button" className="secondary" onClick={() => act({ type: 'edit', step })} disabled={!party.connected}>
              修改
            </button>
          ) : (
            <button type="submit" disabled={!text.trim() || !party.connected}>
              完成
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

function DrawTask({ party, view, task, done }: { party: TpParty; view: TpView; task: Task; done: boolean }) {
  const step = view.step
  const [board] = useState(() => {
    const b = new Board()
    b.adopt({ id: 1, v: 0, strokes: task.draft?.kind === 'drawing' ? task.draft.strokes : [] })
    return b
  })
  const { act } = party
  const doneRef = useRef(done)
  useEffect(() => {
    doneRef.current = done
  })

  // 一邊畫一邊存草稿：有變就排一次，最多每秒送一次整張
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const save = () => {
      timer = undefined
      if (!doneRef.current) act({ type: 'draw', step, strokes: strokesOf(board), done: false })
    }
    const unsubscribe = board.subscribe(() => {
      if (timer === undefined) timer = setTimeout(save, DRAW_SAVE_MS)
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [act, board, step])
  useFinalSave(view.endsIn, view, () => {
    if (!done) act({ type: 'draw', step, strokes: strokesOf(board), done: false })
  })

  const previous = task.previous
  const prompt = previous?.kind === 'text' ? previous.text : ''
  return (
    <div className="tp-task tp-draw">
      <div className="tp-prompt">
        <span className="muted">{previous ? `${nameOf(party, previous.author)} 寫的` : '題目'}</span>
        <strong>{prompt || '（沒寫，自由發揮吧）'}</strong>
      </div>
      <Sketch
        board={board}
        canvasId={1}
        canDraw={!done && party.connected}
        send={ignore}
        maxStrokes={MAX_STROKES}
        maxPoints={MAX_POINTS}
      />
      <div className="tp-buttons">
        {done ? (
          <button type="button" className="secondary" onClick={() => act({ type: 'edit', step })} disabled={!party.connected}>
            修改
          </button>
        ) : (
          <button
            type="button"
            onClick={() => act({ type: 'draw', step, strokes: strokesOf(board), done: true })}
            disabled={!party.connected}
          >
            完成
          </button>
        )}
      </div>
    </div>
  )
}

function strokesOf(board: Board): Stroke[] {
  return board.strokes.map((s) => ({ c: s.c, w: s.w, p: [...s.p] }))
}

/** 唯讀的一張畫（4:3），跟著實際大小和螢幕密度重畫 */
function Picture({ strokes }: { strokes: Stroke[] }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const draw = () => {
      const rect = el.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      el.width = Math.max(1, Math.round(rect.width * dpr))
      el.height = Math.max(1, Math.round(rect.height * dpr))
      paint(el, strokes)
    }
    const observer = new ResizeObserver(draw)
    observer.observe(el)
    draw()
    return () => observer.disconnect()
  }, [strokes])
  return (
    <div className="tp-picture">
      <canvas ref={canvas} role="img" aria-label="一張畫" />
    </div>
  )
}

/** 一串裡的一步：誰做的、寫的字或畫的圖，加上按讚 */
function EntryCard({
  party,
  view,
  chain,
  index,
  entry,
  canLike,
}: {
  party: TpParty
  view: TpView
  chain: number
  index: number
  entry: Entry
  canLike: boolean
}) {
  const verb = index === 0 ? '出題' : entry.kind === 'drawing' ? '畫' : '猜'
  const mine = entry.author === view.you
  return (
    <li className={`tp-entry ${entry.kind}`}>
      <div className="tp-entry-head">
        <strong>{nameOf(party, entry.author)}</strong>
        <span className="muted">{verb}</span>
        {entry.auto && <span className="chip subtle">沒寫，系統出題</span>}
      </div>
      <ContentBody content={entry} />
      <div className="tp-entry-foot">
        {canLike && view.you !== null && !mine ? (
          <button
            type="button"
            className={`tp-like${entry.liked ? '' : ' secondary'}`}
            aria-pressed={entry.liked}
            onClick={() => party.act({ type: 'like', chain, entry: index })}
            disabled={!party.connected}
          >
            👍 {entry.likes}
          </button>
        ) : (
          <span className="tp-likes" aria-label={`${entry.likes} 個讚`}>
            👍 {entry.likes}
          </span>
        )}
      </div>
    </li>
  )
}

function ContentBody({ content }: { content: Content }) {
  if (content.kind === 'text') {
    return content.text ? <p className="tp-text">{content.text}</p> : <p className="tp-text empty">（沒寫）</p>
  }
  return content.strokes.length > 0 ? <Picture strokes={content.strokes} /> : <p className="tp-blank">（沒畫）</p>
}

function ChainView({ party, view, chain, canLike }: { party: TpParty; view: TpView; chain: Chain; canLike: boolean }) {
  const last = useRef<HTMLLIElement | null>(null)
  const count = chain.entries.length
  // 揭曉新的一步時捲到看得到它
  useEffect(() => {
    if (canLike) last.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [count, canLike])
  return (
    <ol className="tp-chain">
      {chain.entries.map((entry, i) => (
        <EntryCard key={i} party={party} view={view} chain={chain.index} index={i} entry={entry} canLike={canLike} />
      ))}
      <li ref={last} className="tp-chain-end" aria-hidden />
    </ol>
  )
}

/** 揭曉：一串一串、一步一步攤開；房主按下一步（房主沒有座位時大家都能按） */
function Reveal({ party, view }: { party: TpParty; view: TpView }) {
  const reveal = view.reveal!
  const chains = view.ring.length
  const host = party.room?.players.find((p) => p.pid === party.room?.host)
  const canNext = view.you !== null && (party.isHost || host?.seat == null)
  const label = reveal.shown < view.steps ? '下一步' : reveal.chain + 1 < chains ? '下一串' : '看結果'
  return (
    <div className="tp-play">
      <StatusLine tone="accent">
        {nameOf(party, reveal.current.owner)} 的題目傳成了…
      </StatusLine>
      <p className="muted tp-step">
        第 {reveal.chain + 1} / {chains} 串 · 攤開 {reveal.shown} / {view.steps} 步
      </p>
      <ChainView party={party} view={view} chain={reveal.current} canLike />
      <div className={`tp-buttons${canNext ? ' tp-next' : ''}`}>
        {canNext ? (
          <button type="button" onClick={() => party.act({ type: 'next', chain: reveal.chain, shown: reveal.shown })} disabled={!party.connected}>
            {label}
          </button>
        ) : (
          <p className="muted">等房主按下一步…</p>
        )}
      </div>
    </div>
  )
}

/** 結算：每一串都能翻回來看，加上誰拿到最多讚 */
function Results({ party, view }: { party: TpParty; view: TpView }) {
  const chains = view.chains ?? []
  const [picked, setPicked] = useState(0)
  const chain = chains[Math.min(picked, chains.length - 1)]
  const order = view.seats.map((_, i) => i).sort((a, b) => view.seats[b].likes - view.seats[a].likes || a - b)
  const best = view.seats[order[0]]?.likes ?? 0
  return (
    <div className="tp-play">
      <StatusLine tone="ok">這局結束！</StatusLine>
      {best > 0 && (
        <section className="tp-awards">
          <h3>最多讚</h3>
          <ol>
            {order
              .filter((i) => view.seats[i].likes > 0)
              .map((i) => (
                <li key={i} className={i === view.you ? 'me' : ''}>
                  <span>
                    {view.seats[i].likes === best ? '🏆 ' : ''}
                    {nameOf(party, i)}
                  </span>
                  <strong>👍 {view.seats[i].likes}</strong>
                </li>
              ))}
          </ol>
        </section>
      )}
      {chain && (
        <>
          <Segmented
            label="看哪一串"
            value={chain.index}
            options={chains.map((c) => ({ value: c.index, label: nameOf(party, c.owner) }))}
            onChange={setPicked}
          />
          <ChainView party={party} view={view} chain={chain} canLike={false} />
        </>
      )}
    </div>
  )
}
