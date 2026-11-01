import { useState, type FormEvent, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  MAX_DESCRIPTION,
  ROLE_NAMES,
  type Speech,
  type UcOptions,
  type UcView,
  type UndercoverParty,
} from './types'
import './undercover.css'

type UcParty = Party<UndercoverParty>

/** 誰是臥底：規則都在伺服器（backend/src/undercover.rs），這裡只畫自己的 view、送動作 */
export default function Undercover() {
  const party = useParty<UndercoverParty>('undercover')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>
            大家拿到相近的兩個詞，少數人是臥底。輪流用一句話描述自己的詞，再投票把臥底找出來。
            3～10 人，人不夠可以加電腦。
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
        <li>大部分人拿到同一個詞（平民），一兩個人拿到相近的另一個詞（臥底）。你只看得到自己的詞，不知道自己是哪一邊。</li>
        <li>輪流用一句話描述自己的詞，不能直接說出來。說太白臥底會猜到，說太模糊會被懷疑。</li>
        <li>大家說完後投票，票最多的人出局；平手只在平手的人之間重投一次，再平手這輪就沒人出局。</li>
        <li>臥底全部出局，平民贏；臥底人數追上平民，臥底贏。</li>
        <li>白板沒有詞，只能聽別人的描述混進去，算臥底這邊；被投出局時可以猜一次平民的詞，猜中就直接贏。</li>
        <li>線下模式：大家當面說，輪到的人說完按「說完了」，網站只負責發詞、輪流和投票。</li>
        <li>出局和觀戰的人只能在旁邊聊天，場上的人看不到。</li>
        <li>分數在同一個房間累計：平民贏每人 1 分，臥底這邊贏每人 2 分。</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: UcParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩誰是臥底"
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
      <div className="uc">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const side = (
    <>
      <ChatBox party={party} placeholder={chatHint(party, view)} />
      <Rules />
    </>
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="uc">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>
          <PartyLobby party={party} options={<OptionsForm party={party} />} />
        </GameLayout>
      </div>
    )
  }

  return (
    <div className="uc">
      {header}
      <GameLayout side={side}>
        <Board party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && <PartyLobby party={party} options={<OptionsForm party={party} />} />}
      </GameLayout>
    </div>
  )
}

function chatHint(party: UcParty, view: UcView | null): string {
  if (!view || view.stage === 'end') return '說點什麼…'
  if (view.you === null) return '觀戰中：只有觀戰和出局的人看得到'
  if (!view.seats[view.you].alive) return '出局了：只有觀戰和出局的人看得到'
  return party.room?.phase === 'playing' ? '討論誰是臥底（不能說出你的詞）' : '說點什麼…'
}

/** 和後端 Options::sides 一樣：(臥底, 白板)，配不出來是 null */
function sides(o: UcOptions, players: number): [number, number] | null {
  const blank = o.blank ? 1 : 0
  const limit = Math.max(0, Math.floor((players - 1) / 2) - blank)
  let wanted = o.undercover
  if (wanted === 0) {
    const base = players <= 5 ? 1 : players <= 8 ? 2 : 3
    wanted = Math.min(Math.max(base - blank, 1), Math.max(limit, 1))
  }
  return wanted >= 1 && wanted <= limit ? [wanted, blank] : null
}

function OptionsForm({ party }: { party: UcParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<UcOptions>) => party.setOptions({ ...o, ...patch })
  const players = Math.min(room.players.filter((p) => p.bot || p.online).length, room.max)
  const lineup = sides(o, players)

  return (
    <div className="uc-options">
      <Segmented
        label="臥底人數"
        value={o.undercover}
        options={[
          { value: 0, label: '自動' },
          { value: 1, label: '1 人' },
          { value: 2, label: '2 人' },
          { value: 3, label: '3 人' },
        ]}
        onChange={(undercover) => set({ undercover })}
        disabled={!editable}
      />
      <Segmented
        label="白板（沒有詞，算臥底這邊）"
        value={o.blank ? 1 : 0}
        options={[
          { value: 0, label: '不加' },
          { value: 1, label: '加一個' },
        ]}
        onChange={(v) => set({ blank: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="玩法"
        value={o.offline ? 1 : 0}
        options={[
          { value: 0, label: '線上打字' },
          { value: 1, label: '線下口述' },
        ]}
        onChange={(v) => set({ offline: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="出局時"
        value={o.reveal ? 1 : 0}
        options={[
          { value: 1, label: '公開身分' },
          { value: 0, label: '不公開' },
        ]}
        onChange={(v) => set({ reveal: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="每人發言時間"
        value={o.speakSecs}
        options={[30, 45, 60, 90].map((s) => ({ value: s, label: `${s} 秒` }))}
        onChange={(speakSecs) => set({ speakSecs })}
        disabled={!editable}
      />
      <Segmented
        label="說完後的討論時間"
        value={o.discussSecs}
        options={[
          { value: 0, label: '不討論' },
          ...[30, 60, 120].map((s) => ({ value: s, label: `${s} 秒` })),
        ]}
        onChange={(discussSecs) => set({ discussSecs })}
        disabled={!editable}
      />
      <p className={lineup ? 'muted' : 'error'}>
        {lineup
          ? `${players} 人：${players - lineup[0] - lineup[1]} 位平民、${lineup[0]} 位臥底${lineup[1] ? '、1 位白板' : ''}`
          : players < 3
            ? '至少要 3 人'
            : `${players} 人配不出這種組合，請減少臥底或拿掉白板`}
      </p>
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

function Board({ party, view }: { party: UcParty; view: UcView }) {
  const me = view.you
  const name = (seat: number) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const alive = me !== null && view.seats[me].alive
  const lastTally = view.tallies.at(-1)

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  switch (view.stage) {
    case 'peek':
      status = '記住你的詞，準備發言'
      break
    case 'speak':
      if (view.speaker === me) {
        status = '輪到你發言了'
        tone = 'accent'
      } else status = `${view.speaker === null ? '' : name(view.speaker)} 發言中…`
      break
    case 'discuss':
      status = '討論時間：誰最可疑？'
      break
    case 'vote':
      status = view.vote?.revote ? '平手！只在平手的人之間重投' : '投票：選出你覺得是臥底的人'
      tone = 'accent'
      break
    case 'out':
      status = lastTally?.out != null ? `${name(lastTally.out)} 出局` : '這輪沒有人出局'
      break
    case 'guess':
      status =
        view.guessing === me ? '你是白板！猜一次平民的詞' : `${name(view.guessing ?? 0)} 是白板，正在猜平民的詞…`
      tone = 'accent'
      break
    case 'end': {
      const won = me !== null && (view.result?.winner === 'undercover') === (view.seats[me].role !== 'civilian')
      status = view.result?.winner === 'civilian' ? '平民獲勝！' : '臥底獲勝！'
      if (me !== null) status = `${status}${won ? '（你贏了）' : '（你輸了）'}`
      tone = me === null ? 'ok' : won ? 'ok' : 'danger'
      break
    }
  }

  return (
    <div className="uc-board">
      <WordCard view={view} />
      <StatusLine tone={tone}>
        {status} <Countdown ms={view.endsIn} stamp={view} />
      </StatusLine>
      <p className="muted uc-lineup">
        {view.round > 0 && `第 ${view.round} 輪 · `}
        {view.counts.civilian} 平民、{view.counts.undercover} 臥底{view.counts.blank ? '、1 白板' : ''}
        {view.options.offline && ' · 線下口述'}
      </p>

      <ActionPanel party={party} view={view} alive={alive} name={name} />

      <Seats party={party} view={view} name={name} />
      {view.stage === 'end' && view.result && <Result view={view} name={name} />}
      <SpeechLog view={view} name={name} />
    </div>
  )
}

/** 自己的詞：大大的，點一下遮住（防偷看） */
function WordCard({ view }: { view: UcView }) {
  const [hidden, setHidden] = useState(false)
  if (view.you === null) {
    return <p className="uc-word spectator">觀戰中：看不到大家的詞，下一局開始時就能參加。</p>
  }
  const dead = !view.seats[view.you].alive
  let word: ReactNode = view.word
  if (view.blank) word = '你是白板'
  return (
    <button
      type="button"
      className={`uc-word${hidden ? ' hidden' : ''}`}
      onClick={() => setHidden((h) => !h)}
      aria-pressed={hidden}
    >
      <span className="uc-word-label">{dead ? '你已出局 · 你的詞' : '你的詞'}</span>
      <strong>{hidden ? '● ● ●' : word}</strong>
      <span className="uc-word-hint">
        {hidden ? '點一下顯示' : view.blank ? '沒有詞，聽別人怎麼說，混進去！（點一下遮住）' : '點一下遮住'}
      </span>
    </button>
  )
}

function ActionPanel({
  party,
  view,
  alive,
  name,
}: {
  party: UcParty
  view: UcView
  alive: boolean
  name: (seat: number) => string
}) {
  const me = view.you
  if (me === null) return null
  const ready = view.seats[me].ready
  const waiting = view.seats.filter((s, i) => s.alive && s.online && !s.ready && i !== me).length

  switch (view.stage) {
    case 'peek':
      if (!alive) return null
      return (
        <div className="uc-actions">
          <button type="button" onClick={() => party.act({ type: 'ready' })} disabled={ready}>
            {ready ? '等其他人…' : '記住了'}
          </button>
        </div>
      )
    case 'speak':
      if (view.speaker !== me) return null
      return view.options.offline ? (
        <div className="uc-actions">
          <p>大聲說出你的描述，說完按下面的按鈕。</p>
          <button type="button" onClick={() => party.act({ type: 'done' })}>
            說完了
          </button>
        </div>
      ) : (
        <DescribeForm party={party} />
      )
    case 'discuss':
      if (!alive) return null
      return (
        <div className="uc-actions">
          <p>在聊天室討論誰最可疑，大家都按了就提早投票。</p>
          <button type="button" onClick={() => party.act({ type: 'ready' })} disabled={ready}>
            {ready ? `等其他 ${waiting} 人…` : '可以投票了'}
          </button>
        </div>
      )
    case 'vote': {
      if (!alive || !view.vote) return null
      const mine = view.vote.mine
      return (
        <p className="uc-actions uc-vote-hint">
          {mine === null ? '點下面的名字投票（投完還能改）' : `你投給了 ${name(mine)}，投完前還能改`}
        </p>
      )
    }
    case 'guess':
      return view.guessing === me ? <GuessForm party={party} /> : null
    default:
      return null
  }
}

function DescribeForm({ party }: { party: UcParty }) {
  const [text, setText] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    if (text.trim()) party.act({ type: 'describe', text: text.trim() })
  }

  return (
    <form className="uc-actions" onSubmit={submit}>
      <label>
        <span>用一句話描述你的詞（不能直接說出來）</span>
        <div className="inline-form">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_DESCRIPTION}
            placeholder="例如：夏天很常見"
            enterKeyHint="send"
            autoFocus
          />
          <button type="submit" disabled={!text.trim()}>
            送出
          </button>
        </div>
      </label>
      <button type="button" className="secondary" onClick={() => party.act({ type: 'done' })}>
        這輪跳過
      </button>
    </form>
  )
}

function GuessForm({ party }: { party: UcParty }) {
  const [word, setWord] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    if (word.trim()) party.act({ type: 'guess', word: word.trim() })
  }

  return (
    <form className="uc-actions" onSubmit={submit}>
      <label>
        <span>你覺得平民的詞是什麼？只有一次機會</span>
        <div className="inline-form">
          <input value={word} onChange={(e) => setWord(e.target.value)} maxLength={MAX_DESCRIPTION} autoFocus />
          <button type="submit" disabled={!word.trim()}>
            猜
          </button>
        </div>
      </label>
    </form>
  )
}

function Seats({ party, view, name }: { party: UcParty; view: UcView; name: (seat: number) => string }) {
  const me = view.you
  const canVote = view.stage === 'vote' && me !== null && view.seats[me].alive && view.vote !== null
  const lastTally = view.tallies.at(-1)
  const showVotes = view.stage === 'out' && lastTally

  return (
    <ul className="uc-seats" aria-label="玩家">
      {view.seats.map((s, i) => {
        const player = party.playerAt(i)
        const candidate = canVote && i !== me && view.vote!.candidates.includes(i)
        const chosen = canVote && view.vote!.mine === i
        const votes = showVotes ? lastTally.ballots.filter((b) => b === i).length : 0
        const chips: ReactNode[] = []
        if (i === me) chips.push(<span key="me" className="chip subtle">你</span>)
        if (view.speaker === i) chips.push(<span key="speak" className="chip">發言中</span>)
        if (!s.alive) chips.push(<span key="out" className="chip subtle">出局</span>)
        if (s.role) chips.push(<span key="role" className={`chip uc-role ${s.role}`}>{ROLE_NAMES[s.role]}</span>)
        if (player?.bot) chips.push(<span key="bot" className="chip subtle">電腦</span>)
        if (!s.online) chips.push(<span key="off" className="chip subtle">離線</span>)
        if ((view.stage === 'peek' || view.stage === 'discuss') && s.alive && s.ready)
          chips.push(<span key="ready" className="chip subtle">✓ 好了</span>)
        if (view.stage === 'vote' && s.voted) chips.push(<span key="voted" className="chip subtle">✓ 已投</span>)
        if (votes > 0) chips.push(<span key="votes" className="chip subtle">{votes} 票</span>)

        const body = (
          <>
            <span className="uc-seat-name">{name(i)}</span>
            <span className="uc-seat-chips">{chips}</span>
            {s.points > 0 && <span className="uc-seat-points">{s.points} 分</span>}
          </>
        )
        const cls = [
          'uc-seat',
          s.alive ? '' : 'dead',
          view.speaker === i ? 'speaking' : '',
          chosen ? 'chosen' : '',
          i === me ? 'me' : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <li key={i} className={cls}>
            {candidate ? (
              <button
                type="button"
                className="uc-seat-body"
                onClick={() => party.act({ type: 'vote', seat: i })}
                aria-pressed={chosen}
              >
                {body}
              </button>
            ) : (
              <div className="uc-seat-body">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Result({ view, name }: { view: UcView; name: (seat: number) => string }) {
  const result = view.result!
  return (
    <section className="uc-result">
      <h3>{result.winner === 'civilian' ? '平民獲勝' : '臥底獲勝'}</h3>
      <p>
        平民的詞是 <strong>{result.words.civilian}</strong>，臥底的詞是 <strong>{result.words.undercover}</strong>
      </p>
      {view.guess && (
        <p className="muted">
          白板 {name(view.guess.seat)} {view.guess.word ? `猜「${view.guess.word}」，${view.guess.correct ? '猜中了！' : '沒猜中'}` : '沒有猜'}
        </p>
      )}
      <ul className="uc-roles">
        {view.seats.map((s, i) => (
          <li key={i}>
            <span>{name(i)}</span>
            {s.role && <span className={`chip uc-role ${s.role}`}>{ROLE_NAMES[s.role]}</span>}
            <span className="muted">累計 {s.points} 分</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function speechText(speech: Speech, offline: boolean): string {
  if (speech.text) return speech.text
  if (speech.timeout) return '（時間到，沒有發言）'
  return offline ? '（口頭描述）' : '（跳過）'
}

/** 發言和投票紀錄，最新的一輪在上面 */
function SpeechLog({ view, name }: { view: UcView; name: (seat: number) => string }) {
  if (view.round === 0) return null
  const rounds = Array.from({ length: view.round }, (_, i) => view.round - i)
  return (
    <section className="uc-log">
      <h3>紀錄</h3>
      {rounds.map((round) => {
        const speeches = view.speeches.filter((s) => s.round === round)
        const tallies = view.tallies.filter((t) => t.round === round)
        return (
          <div key={round} className="uc-log-round">
            <h4>第 {round} 輪</h4>
            {speeches.length === 0 && <p className="muted">還沒有人發言</p>}
            <ol>
              {speeches.map((s, k) => (
                <li key={k}>
                  <strong>{name(s.seat)}</strong>
                  <span className={s.text ? '' : 'muted'}>{speechText(s, view.options.offline)}</span>
                </li>
              ))}
            </ol>
            {tallies.map((t, k) => (
              <div key={k} className="uc-tally">
                <span className="muted">{t.revote ? '重投：' : '投票：'}</span>
                {t.ballots
                  .map((to, from) => (to === null ? null : `${name(from)} → ${name(to)}`))
                  .filter(Boolean)
                  .join('、') || '沒有人投票'}
                <span className="uc-tally-out">
                  {t.out !== null ? `，${name(t.out)} 出局` : t.revote || !tallies[k + 1] ? '' : '，平手'}
                </span>
              </div>
            ))}
          </div>
        )
      })}
    </section>
  )
}
