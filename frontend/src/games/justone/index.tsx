import { useState, type FormEvent, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  MAX_CLUE,
  MAX_GUESS,
  STATUS_NAMES,
  type JoClue,
  type JoOptions,
  type JoRecord,
  type JoView,
  type JustOneParty,
  type Outcome,
} from './types'
import './justone.css'

type JoParty = Party<JustOneParty>
type NameOf = (seat: number) => string

/** 只有一個詞：規則都在伺服器（backend/src/justone.rs），這裡只畫自己的 view、送動作 */
export default function JustOne() {
  const party = useParty<JustOneParty>('justone')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>
            合作遊戲：每題輪一個人猜，其他人各寫一個提示詞，一樣的提示會互相抵消。用最少的提示讓隊友猜中，13 張牌看你們能猜對幾張。
            3～10 人。
          </p>
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
        <li>大家同一隊。每題輪一個人猜，其他人（出題的人）看得到題目，各自偷偷寫一個提示詞，3 人玩時每人寫兩個。</li>
        <li>提示不能包含題目，也不能是題目的一部分。大家寫完才看得到彼此的提示。</li>
        <li>一模一樣的提示會自動刪掉（全形半形、大小寫、空白標點都不算差別）。出題的人還可以把意思太像的標「太像了」刪掉。</li>
        <li>猜的人只看得到留下來的提示，猜一次或跳過。猜對 +1 張；跳過丟掉這張；猜錯丟掉這張和下一張（最後一張猜錯就扣一張猜對的）。</li>
        <li>猜錯但意思一樣（例如寫法不同）時，出題的人過半數按「算對」就算猜對。</li>
        <li>公布答案之前，出題的人在聊天室說的話猜的人看不到。</li>
        <li>線下模式：猜的人直接說出答案，由出題的人按「猜對了」或「猜錯了」。</li>
        <li>寫提示時斷線或時間到沒寫就是沒有提示；猜的人時間到或斷線算跳過。</li>
      </ul>
      <strong>評語（13 張）</strong>
      <ul>
        <li>13：滿分！</li>
        <li>12：太厲害了 · 11：超棒 · 9～10：很不錯</li>
        <li>7～8：中等水準 · 4～6：好的開始 · 0～3：再試一次</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: JoParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩只有一個詞"
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
      <div className="jo">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const side = (
    <>
      <ChatBox party={party} placeholder={chatHint(view)} />
      <Rules />
    </>
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="jo">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>
          <PartyLobby party={party} options={<OptionsForm party={party} />} />
        </GameLayout>
      </div>
    )
  }

  return (
    <div className="jo">
      {header}
      <GameLayout side={side}>
        <Board party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && <PartyLobby party={party} options={<OptionsForm party={party} />} />}
      </GameLayout>
    </div>
  )
}

function chatHint(view: JoView | null): string {
  if (!view || view.stage === 'reveal' || view.stage === 'end') return '說點什麼…'
  if (view.you === null) return '觀戰中：出題的人說的話公布前看不到'
  if (view.you === view.guesser) return '你在猜：出題的人說的話公布前看不到'
  return '只有出題的人看得到，猜的人看不到'
}

function OptionsForm({ party }: { party: JoParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<JoOptions>) => party.setOptions({ ...o, ...patch })
  const players = Math.min(room.players.filter((p) => p.online).length, room.max)

  return (
    <div className="jo-options">
      <Segmented
        label="牌數"
        value={o.cards}
        options={[7, 10, 13, 16].map((n) => ({ value: n, label: `${n} 張` }))}
        onChange={(cards) => set({ cards })}
        disabled={!editable}
      />
      <Segmented
        label="寫提示時間"
        value={o.clueSecs}
        options={[
          ...[60, 90, 120].map((s) => ({ value: s, label: `${s} 秒` })),
          { value: 0, label: '不限' },
        ]}
        onChange={(clueSecs) => set({ clueSecs })}
        disabled={!editable}
      />
      <Segmented
        label="猜的時間"
        value={o.guessSecs}
        options={[
          ...[30, 60, 90].map((s) => ({ value: s, label: `${s} 秒` })),
          { value: 0, label: '不限' },
        ]}
        onChange={(guessSecs) => set({ guessSecs })}
        disabled={!editable}
      />
      <Segmented
        label="玩法"
        value={o.offline ? 1 : 0}
        options={[
          { value: 0, label: '線上打字猜' },
          { value: 1, label: '線下說出答案' },
        ]}
        onChange={(v) => set({ offline: v === 1 })}
        disabled={!editable}
      />
      <p className={players >= 3 || players === 0 ? 'muted' : 'error'}>
        {players < 3 ? '至少要 3 人' : players === 3 ? '3 人：每個出題的人寫兩個提示' : `${players} 人：每個出題的人寫一個提示`}
      </p>
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

function Board({ party, view }: { party: JoParty; view: JoView }) {
  const me = view.you
  const name: NameOf = (seat) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const guessing = me === view.guesser
  const giver = me !== null && !guessing
  const who = name(view.guesser)
  const submitted = view.seats.filter((s, i) => i !== view.guesser && s.submitted).length
  const givers = view.seats.length - 1

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  switch (view.stage) {
    case 'clue':
      status = giver ? `寫一個提示讓 ${who} 猜` : `大家正在寫提示（${submitted}/${givers}）`
      if (giver && !view.mine) tone = 'accent'
      break
    case 'review':
      status = giver ? '檢查提示：意思太像的標「太像了」' : '出題的人在檢查提示…'
      break
    case 'guess':
      if (guessing) {
        status = view.options.offline ? '大聲說出你的答案（或跳過）' : '輪到你猜了！'
        tone = 'accent'
      } else status = view.options.offline ? `${who} 正在說答案，對或錯由你們判斷` : `${who} 正在猜…`
      break
    case 'reveal':
      status = outcomeText(view.outcome, view.accept?.accepted ?? false)
      tone = view.outcome === 'correct' || view.accept?.accepted ? 'ok' : view.outcome === 'wrong' ? 'danger' : undefined
      break
    case 'end':
      status = view.result ? `結束！猜對 ${view.result.score} / ${view.result.total} 張` : '結束'
      tone = 'ok'
      break
  }

  return (
    <div className="jo-board">
      <WordCard view={view} name={name} />
      <StatusLine tone={tone}>
        {status} <Countdown ms={view.endsIn} stamp={view} />
      </StatusLine>
      <DeckLine view={view} />
      <ActionPanel party={party} view={view} name={name} />
      <Seats party={party} view={view} name={name} />
      {view.stage === 'end' && view.result && <Result view={view} />}
      <History view={view} name={name} />
    </div>
  )
}

function outcomeText(outcome: Outcome | null, accepted: boolean): string {
  if (accepted) return '出題的人投票：算對！'
  switch (outcome) {
    case 'correct':
      return '猜對了！'
    case 'wrong':
      return '猜錯了'
    case 'pass':
      return '跳過這題'
    default:
      return ''
  }
}

/** 題目：出題的人看得到（點一下遮住），猜的人只看到問號 */
function WordCard({ view, name }: { view: JoView; name: NameOf }) {
  const [hidden, setHidden] = useState(false)
  const me = view.you
  const open = view.stage === 'reveal' || view.stage === 'end'
  if (me === null && !open) {
    return <p className="jo-word spectator">觀戰中：公布前看不到題目，下一局開始時就能參加。</p>
  }
  if (!view.word) {
    return (
      <div className="jo-word guesser">
        <span className="jo-word-label">這題你是猜的人</span>
        <strong>？</strong>
        <span className="jo-word-hint">看大家的提示猜出題目</span>
      </div>
    )
  }
  const label = open ? '答案' : `題目 · ${name(view.guesser)} 猜`
  return (
    <button
      type="button"
      className={`jo-word${hidden ? ' hidden' : ''}`}
      onClick={() => setHidden((h) => !h)}
      aria-pressed={hidden}
    >
      <span className="jo-word-label">{label}</span>
      <strong>{hidden ? '● ● ●' : view.word}</strong>
      <span className="jo-word-hint">{hidden ? '點一下顯示' : '點一下遮住（防偷看）'}</span>
    </button>
  )
}

function DeckLine({ view }: { view: JoView }) {
  const { deck } = view
  return (
    <p className="muted jo-deck">
      第 {view.round} 題 · 猜對 <strong>{deck.score}</strong> · 丟掉 {deck.lost} · 牌堆還有 {deck.left} 張
      {view.options.offline && ' · 線下'}
      {view.best && ` · 這個房間最好 ${view.best.score}/${view.best.total}`}
    </p>
  )
}

function ActionPanel({ party, view, name }: { party: JoParty; view: JoView; name: NameOf }) {
  const me = view.you
  const guessing = me === view.guesser
  const giver = me !== null && !guessing
  const clues = view.clues ?? []

  switch (view.stage) {
    case 'clue':
      if (!giver) return null
      return <ClueForm key={view.round} party={party} view={view} />
    case 'review': {
      if (!giver) return null
      const ready = view.seats[me].ready
      const waiting = view.seats.filter((s, i) => i !== view.guesser && i !== me && s.online && !s.ready).length
      return (
        <div className="jo-actions">
          <p>點一下意思太像的提示標「太像了」（再點一次取消），大家都按「檢查好了」就給 {name(view.guesser)} 猜。</p>
          <ClueList clues={clues} name={name} onMark={(i) => party.act({ type: 'mark', index: i })} />
          <button type="button" onClick={() => party.act({ type: 'ready' })} disabled={ready}>
            {ready ? `等其他 ${waiting} 人…` : '檢查好了'}
          </button>
        </div>
      )
    }
    case 'guess':
      if (guessing) {
        return (
          <div className="jo-actions">
            <p>
              留下 {clues.length} 個提示{view.removed ? `（刪掉了 ${view.removed} 個）` : ''}
            </p>
            <ClueList clues={clues} name={name} big />
            {view.options.offline ? (
              <>
                <p>大聲說出你的答案，出題的人會按對或錯。</p>
                <button type="button" className="secondary" onClick={() => party.act({ type: 'pass' })}>
                  跳過這題
                </button>
              </>
            ) : (
              <GuessForm party={party} />
            )}
          </div>
        )
      }
      return (
        <div className="jo-actions">
          {giver && view.options.offline ? (
            <>
              <p>{name(view.guesser)} 說的答案對嗎？</p>
              <div className="jo-judge">
                <button type="button" onClick={() => party.act({ type: 'judge', correct: true })}>
                  猜對了
                </button>
                <button type="button" className="danger" onClick={() => party.act({ type: 'judge', correct: false })}>
                  猜錯了
                </button>
              </div>
            </>
          ) : (
            <p>{name(view.guesser)} 看得到的是標「留下」的提示。</p>
          )}
          <ClueList clues={clues} name={name} />
        </div>
      )
    case 'reveal':
      return <RevealPanel party={party} view={view} name={name} />
    default:
      return null
  }
}

function ClueForm({ party, view }: { party: JoParty; view: JoView }) {
  const [words, setWords] = useState<string[]>(() =>
    Array.from({ length: view.perGiver }, (_, i) => view.mine?.[i] ?? ''),
  )
  const filled = words.every((w) => w.trim())
  const sent = view.mine !== null && view.mine.every((w, i) => w === words[i].trim())

  function submit(e: FormEvent) {
    e.preventDefault()
    if (filled) party.act({ type: 'clue', words: words.map((w) => w.trim()) })
  }

  return (
    <form className="jo-actions" onSubmit={submit}>
      <label className="jo-clue-field">
        <span>
          寫{view.perGiver === 2 ? '兩個' : '一個'}提示詞（不能包含題目；和別人一樣會被刪掉）
        </span>
        <div className="jo-clue-inputs">
          {words.map((w, i) => (
            <input
              key={i}
              value={w}
              onChange={(e) => setWords((prev) => prev.map((p, k) => (k === i ? e.target.value : p)))}
              maxLength={MAX_CLUE}
              placeholder={i === 0 ? '例如：紅色' : '第二個提示'}
              aria-label={`提示 ${i + 1}`}
              enterKeyHint="send"
              autoComplete="off"
              autoFocus={i === 0}
            />
          ))}
        </div>
      </label>
      <button type="submit" disabled={!filled || sent}>
        {sent ? '已送出，等其他人…' : view.mine ? '改成這個' : '送出'}
      </button>
      {view.mine && <p className="muted">已送出：{view.mine.join('、')}（大家寫完之前還能改）</p>}
    </form>
  )
}

function GuessForm({ party }: { party: JoParty }) {
  const [word, setWord] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    if (word.trim()) party.act({ type: 'guess', word: word.trim() })
  }

  return (
    <form className="jo-guess" onSubmit={submit}>
      <label>
        <span>你覺得題目是什麼？只有一次機會</span>
        <div className="inline-form">
          <input
            value={word}
            onChange={(e) => setWord(e.target.value)}
            maxLength={MAX_GUESS}
            enterKeyHint="send"
            autoComplete="off"
            autoFocus
          />
          <button type="submit" disabled={!word.trim()}>
            猜
          </button>
        </div>
      </label>
      <button type="button" className="secondary" onClick={() => party.act({ type: 'pass' })}>
        跳過這題（只丟這張）
      </button>
    </form>
  )
}

/** 提示卡；`onMark` 有給就是檢查階段，留下的提示可以點一下標「太像了」 */
function ClueList({
  clues,
  name,
  onMark,
  big,
}: {
  clues: JoClue[]
  name: NameOf
  onMark?: (index: number) => void
  big?: boolean
}) {
  if (clues.length === 0) return <p className="muted jo-no-clues">沒有提示</p>
  return (
    <ul className={`jo-clues${big ? ' big' : ''}`}>
      {clues.map((c, i) => {
        const markable = onMark && (c.status === 'ok' || c.status === 'similar')
        const note =
          c.status === 'similar' && c.markedBy !== null ? `${name(c.markedBy)} 標了太像` : STATUS_NAMES[c.status]
        const body = (
          <>
            <strong className="jo-clue-text">{c.text}</strong>
            <span className="jo-clue-meta">
              {name(c.seat)}
              {!big && <span className="jo-clue-status"> · {note}</span>}
            </span>
          </>
        )
        return (
          <li key={i} className={`jo-clue ${c.status}`}>
            {markable ? (
              <button
                type="button"
                className="jo-clue-body"
                onClick={() => onMark(i)}
                aria-pressed={c.status === 'similar'}
              >
                {body}
              </button>
            ) : (
              <div className="jo-clue-body">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function RevealPanel({ party, view, name }: { party: JoParty; view: JoView; name: NameOf }) {
  const me = view.you
  const ready = me !== null && view.seats[me].ready
  const giver = me !== null && me !== view.guesser
  const accept = view.accept
  // 猜錯（沒被算對）會多丟一張，牌堆剩一張也會直接結束
  const losing = view.outcome === 'wrong' && !accept?.accepted ? 1 : 0
  const more = view.deck.left > losing
  let guess: ReactNode
  if (view.guess) guess = <>猜「<strong>{view.guess}</strong>」</>
  else if (view.outcome === 'pass') guess = '跳過'
  else guess = view.options.offline ? '口頭作答' : '沒有猜'

  return (
    <div className="jo-actions">
      <p>
        {name(view.guesser)} {guess}
      </p>
      {accept && (
        <div className="jo-accept">
          <p className="muted">
            意思一樣只是寫法不同？出題的人過半數按「算對」就算猜對（{accept.votes}/{accept.needed}）
          </p>
          {giver && (
            <button
              type="button"
              className={accept.mine ? '' : 'secondary'}
              onClick={() => party.act({ type: 'accept' })}
              aria-pressed={accept.mine}
            >
              {accept.mine ? '✓ 我覺得算對（再按取消）' : '算對'}
            </button>
          )}
        </div>
      )}
      <ClueList clues={view.clues ?? []} name={name} />
      {me !== null && (
        <button type="button" onClick={() => party.act({ type: 'ready' })} disabled={ready}>
          {ready ? '等其他人…' : more ? '下一題' : '看結果'}
        </button>
      )}
    </div>
  )
}

function Seats({ party, view, name }: { party: JoParty; view: JoView; name: NameOf }) {
  const me = view.you
  return (
    <ul className="jo-seats" aria-label="玩家">
      {view.seats.map((s, i) => {
        const player = party.playerAt(i)
        const chips: ReactNode[] = []
        if (i === me) chips.push(<span key="me" className="chip subtle">你</span>)
        if (i === view.guesser) chips.push(<span key="guess" className="chip">猜的人</span>)
        if (!s.online) chips.push(<span key="off" className="chip subtle">離線</span>)
        if (view.stage === 'clue' && i !== view.guesser)
          chips.push(
            <span key="sub" className="chip subtle">
              {s.submitted ? '✓ 寫好了' : '寫提示中…'}
            </span>,
          )
        if ((view.stage === 'review' || view.stage === 'reveal') && s.ready)
          chips.push(<span key="ready" className="chip subtle">✓ 好了</span>)
        if (player?.bot) chips.push(<span key="bot" className="chip subtle">電腦</span>)
        const cls = ['jo-seat', i === view.guesser ? 'guesser' : '', i === me ? 'me' : ''].filter(Boolean).join(' ')
        return (
          <li key={i} className={cls}>
            <span className="jo-seat-name">{name(i)}</span>
            <span className="jo-seat-chips">{chips}</span>
          </li>
        )
      })}
    </ul>
  )
}

function Result({ view }: { view: JoView }) {
  const result = view.result!
  const correct = view.history.filter((r) => r.outcome === 'correct' || r.accepted).length
  return (
    <section className="jo-result">
      <h3>
        {result.score} / {result.total}
      </h3>
      <p className="jo-rating">{result.rating}</p>
      <p className="muted">
        猜了 {view.history.length} 題，猜對 {correct} 題
        {view.best && `；這個房間最好 ${view.best.score}/${view.best.total}`}
      </p>
    </section>
  )
}

function recordText(r: JoRecord): string {
  if (r.accepted) return `猜「${r.guess}」，投票算對`
  switch (r.outcome) {
    case 'correct':
      return r.guess ? `猜「${r.guess}」，猜對` : '猜對'
    case 'wrong':
      return r.guess ? `猜「${r.guess}」，猜錯` : '猜錯'
    case 'pass':
      return '跳過'
  }
}

/** 猜完的題目，最新的在上面 */
function History({ view, name }: { view: JoView; name: NameOf }) {
  if (view.history.length === 0) return null
  return (
    <section className="jo-log">
      <h3>紀錄</h3>
      <ol>
        {[...view.history].reverse().map((r) => {
          const ok = r.outcome === 'correct' || r.accepted
          return (
            <li key={r.round} className={ok ? 'ok' : r.outcome === 'wrong' ? 'wrong' : ''}>
              <div className="jo-log-head">
                <span className="muted">第 {r.round} 題</span>
                <strong>{r.word}</strong>
                <span>
                  {name(r.guesser)} {recordText(r)}
                </span>
              </div>
              <div className="jo-log-clues">
                {r.clues.length === 0 && <span className="muted">沒有提示</span>}
                {r.clues.map((c, k) => (
                  <span key={k} className={`jo-log-clue ${c.status}`} title={`${name(c.seat)} · ${STATUS_NAMES[c.status]}`}>
                    {c.text}
                  </span>
                ))}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
