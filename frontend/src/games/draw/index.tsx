import { useEffect, useLayoutEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, SfxButton, StatusLine } from '../shared/ui'
import { MAX_CHAT, useParty, type Party } from '../shared/useParty'
import { Board } from './board'
import { Contribute } from './Contribute'
import { useDrawSfx, useDrawSounds, type DrawSound } from './sfx'
import { Sketch } from './Sketch'
import { LEVEL_NAMES, type DrawOptions, type DrawParty, type DrawView } from './types'
import './draw.css'

type DgParty = Party<DrawParty>

/** 你畫我猜：規則在伺服器（backend/src/draw.rs），筆畫的同步見 board.ts */
export default function DrawGame() {
  const [board] = useState(() => new Board())
  const party = useParty<DrawParty>('draw', { onEvent: (event) => board.receive(event) })
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <div className="dg-entry">
          <PartyEntry party={party}>
            <p>輪流畫圖，其他人在聊天室猜答案，越早猜中分數越高。2～10 人，開房間把連結傳給朋友就能玩。</p>
          </PartyEntry>
          <Contribute />
        </div>
      </GameLayout>
    )
  }
  return <InRoom party={party} board={board} />
}

function Rules() {
  return (
    <div className="game-help">
      <strong>怎麼玩</strong>
      <ul>
        <li>每個人輪流畫。輪到你時從三個詞（簡單、普通、困難）挑一個，在時間內畫出來；不能寫字。</li>
        <li>畫筆之外還有「倒顏料」：點一下，把那一塊相連的同色區域塗滿目前的顏色。</li>
        <li>其他人在聊天室打字猜，猜中的那句只有自己看得到，大家只會看到「某某猜對了」。</li>
        <li>很接近時畫布上會跳出「差一點！」（只有自己看得到）；整句裡有答案但多打了其他字，那句不會送出，只打答案就好。</li>
        <li>
          不會自動給提示：畫的人覺得大家猜不出來時，可以按「給提示」揭露一個字（兩個字的詞最多一個、三個字以上最多兩個）。
          所有人都猜中或時間到就公布答案。
        </li>
        <li>猜中的人和畫的人可以互相聊天，還沒猜中的人看不到。</li>
        <li>計分：越早猜中分數越高（20～100 分）；畫的人每有一個人猜中得 25 分。普通的詞乘 1.2、困難的乘 1.5。分數在同一個房間累計。</li>
        <li>題目除了內建的，還有大家投稿、管理員審核通過的。登入後可以在開房間的地方「投稿題目」。</li>
      </ul>
    </div>
  )
}

function InRoom({ party, board }: { party: DgParty; board: Board }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const sfx = useDrawSfx()
  useDrawSounds(view, sfx.play)

  // 換下一棒、重連時用 view 裡的整張畫布；版本沒有比較新就不用（事件已經先套上去了）
  useLayoutEffect(() => {
    if (view) board.adopt(view.canvas)
  }, [view, board])

  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩你畫我猜"
      extra={
        <>
          <SfxButton sfx={sfx} />
          {party.isHost && playing && (
            <button
              type="button"
              className="secondary"
              onClick={() => window.confirm('中止這一局，回到大廳？') && party.abort()}
            >
              中止這局
            </button>
          )}
        </>
      }
    />
  )
  if (!room) {
    return (
      <div className="dg">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="dg">
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
    <div className="dg">
      {header}
      <GameLayout
        side={
          <>
            <ChatBox party={party} title={chatTitle(view)} placeholder={chatHint(view)} />
            <Scores party={party} view={view} />
            <Rules />
          </>
        }
      >
        <Play party={party} view={view} board={board} play={sfx.play} />
        <PartyNotice party={party} />
        {room.phase === 'results' && (
          <>
            <Results party={party} view={view} />
            <PartyLobby party={party} options={<OptionsForm party={party} />} />
          </>
        )}
      </GameLayout>
    </div>
  )
}

function guessing(view: DrawView): boolean {
  return view.stage === 'draw' && view.you !== null && view.you !== view.drawer && !view.seats[view.you].guessed
}

function chatTitle(view: DrawView): string {
  return guessing(view) ? '猜答案' : '聊天'
}

function chatHint(view: DrawView): string {
  if (view.stage !== 'draw') return '說點什麼…'
  if (view.you === null) return '觀戰中：說出答案不會送出'
  if (guessing(view)) return '在這裡打你猜的答案'
  return '只有畫的人和猜中的人看得到'
}

function OptionsForm({ party }: { party: DgParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<DrawOptions>) => party.setOptions({ ...o, ...patch })
  const players = Math.min(room.players.filter((p) => p.online).length, room.max)

  return (
    <div className="dg-options">
      <Segmented
        label="每人畫幾次"
        value={o.cycles}
        options={[1, 2, 3].map((n) => ({ value: n, label: `${n} 次` }))}
        onChange={(cycles) => set({ cycles })}
        disabled={!editable}
      />
      <Segmented
        label="每次作畫時間"
        value={o.drawSecs}
        options={[60, 80, 100, 120].map((s) => ({ value: s, label: `${s} 秒` }))}
        onChange={(drawSecs) => set({ drawSecs })}
        disabled={!editable}
      />
      <Segmented
        label="提示詞的分類（例如「動物」）"
        value={o.category ? 1 : 0}
        options={[
          { value: 1, label: '顯示' },
          { value: 0, label: '不顯示' },
        ]}
        onChange={(v) => set({ category: v === 1 })}
        disabled={!editable}
      />
      <p className="muted">
        {players >= 2 ? `${players} 人，每人畫 ${o.cycles} 次，共 ${players * o.cycles} 棒。` : '至少要 2 人。'}
        {!party.isHost && ' 選項由房主決定。'}
      </p>
    </div>
  )
}

/** 猜得很接近時，伺服器只送給自己的提示：在畫布上方跳出來幾秒，再響一聲，不會漏看 */
function useCloseToast(party: DgParty, play: (sound: DrawSound) => void): ReactNode {
  const [close, setClose] = useState<{ id: number; text: string } | null>(null)
  const { subscribe } = party
  useEffect(
    () =>
      subscribe((event) => {
        if (event?.type !== 'close') return
        play('close')
        const text = event.guess ? `「${event.guess}」差一點！` : '很接近了！只要打答案本身就好'
        setClose((prev) => ({ id: (prev?.id ?? 0) + 1, text }))
      }),
    [subscribe, play],
  )
  useEffect(() => {
    if (!close) return
    const timer = setTimeout(() => setClose(null), 3000)
    return () => clearTimeout(timer)
  }, [close])
  return (
    close && (
      <p key={close.id} className="dg-toast" role="status">
        {close.text}
      </p>
    )
  )
}

function Play({
  party,
  view,
  board,
  play,
}: {
  party: DgParty
  view: DrawView
  board: Board
  play: (sound: DrawSound) => void
}) {
  const name = (seat: number) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const me = view.you
  const drawing = me !== null && me === view.drawer
  const drawerName = name(view.drawer)
  const toast = useCloseToast(party, play)

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  switch (view.stage) {
    case 'choose':
      status = drawing ? '輪到你畫了！選一個詞' : `${drawerName} 正在選題…`
      tone = drawing ? 'accent' : undefined
      break
    case 'draw':
      if (drawing) {
        status = '開始畫吧！'
        tone = 'accent'
      } else if (me !== null && view.seats[me].guessed) {
        status = '你猜對了！等其他人…'
        tone = 'ok'
      } else status = `猜猜看 ${drawerName} 在畫什麼`
      break
    case 'reveal':
      status =
        view.ending === 'all' ? '大家都猜中了！' : view.ending === 'left' ? `${drawerName} 離線了` : '時間到！'
      break
    case 'end':
      status = '這局結束！'
      tone = 'ok'
      break
  }

  let overlay: ReactNode = null
  if (view.stage === 'choose' && !drawing) {
    overlay = <p>{drawerName} 正在選題…</p>
  } else if (view.stage === 'reveal' && view.word) {
    overlay = (
      <p>
        答案是<strong>{view.word}</strong>
      </p>
    )
  }

  return (
    <div className="dg-play">
      <StatusLine tone={tone}>
        {status} {view.stage !== 'end' && <Countdown ms={view.endsIn} stamp={view} />}
      </StatusLine>
      <p className="muted dg-turn">
        第 {view.turn} / {view.turns} 棒 · {drawerName} 畫
      </p>
      {view.stage === 'choose' && drawing && view.choices && (
        <div className="dg-choices" role="group" aria-label="選一個詞">
          {view.choices.map((c, i) => (
            <button key={i} type="button" onClick={() => party.act({ type: 'choose', index: i })}>
              <strong>{c.word}</strong>
              <span className={`chip dg-level ${c.level}`}>{LEVEL_NAMES[c.level]}</span>
              <span className="muted">{c.category}</span>
            </button>
          ))}
        </div>
      )}
      <WordBar view={view} drawing={drawing} onHint={party.connected ? () => party.act({ type: 'hint' }) : null} />
      <Sketch
        board={board}
        canvasId={view.canvas.id}
        canDraw={drawing && view.stage === 'draw' && party.connected}
        send={party.act}
        overlay={overlay}
        toast={guessing(view) ? toast : null}
      />
      {guessing(view) && <GuessBar party={party} />}
    </div>
  )
}

/**
 * 手機上聊天室在畫布下面很遠，一打字畫布就捲走了：猜的人在畫布正下方多一個輸入框和最新的兩則訊息。
 * 桌機的聊天室就在旁邊，用 CSS 藏起來。
 */
function GuessBar({ party }: { party: DgParty }) {
  const [draft, setDraft] = useState('')
  const last = party.chat.slice(-2)

  function submit(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    party.say(text)
    setDraft('')
  }

  return (
    <div className="dg-guess">
      <ol className="dg-guess-log">
        {last.map((line) => (
          <li key={line.id} className={line.tone ? `tone-${line.tone}` : line.pid === null ? 'system' : ''}>
            {line.pid !== null && <strong>{line.name}</strong>}
            <span>{line.text}</span>
          </li>
        ))}
      </ol>
      <form className="inline-form" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="打你猜的答案"
          maxLength={MAX_CHAT}
          enterKeyHint="send"
          autoComplete="off"
          aria-label="猜答案"
          disabled={!party.connected}
        />
        <button type="submit" disabled={!draft.trim() || !party.connected}>
          猜
        </button>
      </form>
    </div>
  )
}

/**
 * 題目列：畫的人和猜中的人看到答案，其他人看到提示（每個字一格，揭露了就填上）。
 * 畫的人多一個「給提示」按鈕，已經揭露的字標出來。
 */
function WordBar({ view, drawing, onHint }: { view: DrawView; drawing: boolean; onHint: (() => void) | null }) {
  if (view.stage === 'draw' && view.word) {
    const chars = view.hint?.chars
    return (
      <div className="dg-word known">
        <span className="muted">{drawing ? '你要畫' : '答案'}</span>
        <strong aria-label={view.word}>
          {drawing && chars
            ? [...view.word].map((c, i) => (
                <span key={i} className={chars[i] ? 'dg-opened' : undefined}>
                  {c}
                </span>
              ))
            : view.word}
        </strong>
        {view.level && <span className={`chip dg-level ${view.level}`}>{LEVEL_NAMES[view.level]}</span>}
        {drawing && (
          <button
            type="button"
            className="secondary dg-hint"
            onClick={onHint ?? undefined}
            disabled={!onHint || view.hintsLeft === 0}
          >
            {view.hintsLeft > 0 ? `💡 給提示（還能給 ${view.hintsLeft} 個字）` : '提示給完了'}
          </button>
        )}
      </div>
    )
  }
  if (view.stage === 'draw' && view.hint) {
    const { chars, category } = view.hint
    return (
      <div className="dg-word" aria-label={`提示：${chars.length} 個字`}>
        <span className="dg-blanks">
          {chars.map((c, i) => (
            <span key={i} className={c ? 'open' : ''}>
              {c ?? ''}
            </span>
          ))}
        </span>
        <span className="muted">{chars.length} 個字</span>
        {category && <span className="chip subtle">{category}</span>}
        {view.level && <span className={`chip dg-level ${view.level}`}>{LEVEL_NAMES[view.level]}</span>}
      </div>
    )
  }
  return null
}

/** 分數：照這一局的分數排，作畫中標出誰在畫、誰猜中了 */
function Scores({ party, view }: { party: DgParty; view: DrawView }) {
  const order = view.seats.map((_, i) => i).sort((a, b) => view.seats[b].score - view.seats[a].score || a - b)
  const showTurn = view.stage === 'reveal'
  return (
    <section className="dg-scores" aria-label="分數">
      <h3>分數</h3>
      <ol>
        {order.map((i) => {
          const s = view.seats[i]
          const player = party.playerAt(i)
          return (
            <li key={i} className={`${i === view.you ? 'me' : ''}${s.online ? '' : ' offline'}`}>
              <span className="dg-score-name">{player?.name ?? `座位 ${i + 1}`}</span>
              <span className="dg-score-chips">
                {i === view.you && <span className="chip subtle">你</span>}
                {i === view.drawer && view.stage !== 'end' && <span className="chip">畫畫中</span>}
                {s.guessed && view.stage === 'draw' && <span className="chip dg-guessed">✓ 猜中</span>}
                {!s.online && <span className="chip subtle">離線</span>}
                {(showTurn || (s.guessed && view.stage === 'draw')) && s.turnPoints > 0 && (
                  <span className="dg-plus">+{s.turnPoints}</span>
                )}
              </span>
              <strong className="dg-score">{s.score}</strong>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Results({ party, view }: { party: DgParty; view: DrawView }) {
  const name = (seat: number) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  const order = view.seats.map((_, i) => i).sort((a, b) => view.seats[b].score - view.seats[a].score || a - b)
  const best = view.seats[order[0]]?.score ?? 0
  const carried = view.seats.some((s) => s.total !== s.score)
  return (
    <section className="dg-results">
      <h3>這局排名</h3>
      <table className="responsive dg-rank">
        <thead>
          <tr>
            <th>名次</th>
            <th>玩家</th>
            <th>這局</th>
            {carried && <th>累計</th>}
          </tr>
        </thead>
        <tbody>
          {order.map((i) => {
            const s = view.seats[i]
            // 同分同名次
            const place = order.findIndex((j) => view.seats[j].score === s.score) + 1
            return (
              <tr key={i} className={i === view.you ? 'me' : ''}>
                <td data-label="名次">
                  {place}
                  {s.score === best && best > 0 ? ' 🏆' : ''}
                </td>
                <td data-label="玩家">{name(i)}</td>
                <td data-label="這局">{s.score} 分</td>
                {carried && <td data-label="累計">{s.total} 分</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
      {view.done.length > 0 && (
        <>
          <h3>這局畫過的題目</h3>
          <ol className="dg-done">
            {view.done.map((d, i) => (
              <li key={i}>
                <strong>{d.word}</strong>
                <span className="muted">
                  {name(d.drawer)} 畫 · {d.guessed} 人猜中
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}
