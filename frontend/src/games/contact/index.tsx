import { useState, type FormEvent, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  CARD_MARKS,
  CARD_NAMES,
  MAX_CLUE,
  MAX_COUNT,
  TEAMS,
  type ContactParty,
  type CtOptions,
  type CtView,
  type TurnEnd,
} from './types'
import './contact.css'

type CtParty = Party<ContactParty>
type NameOf = (seat: number) => string

/** 暗號接頭：規則都在伺服器（backend/src/contact.rs），這裡只畫自己的 view、送動作 */
export default function Contact() {
  const party = useParty<ContactParty>('contact')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>
            分成翡翠、紫晶兩隊：桌上 25 個詞，只有聯絡人知道哪些是自己人。聯絡人用「一個詞＋一個數字」讓組員接上頭，
            先找齊自己人的隊伍獲勝，翻到叛徒就輸。4～10 人，也能當面玩。
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
        <li>4～10 人分成翡翠、紫晶兩隊，每隊一位聯絡人，其他人是組員。開局先選隊，房主可以隨機分隊；聯絡人每局輪流換人。</li>
        <li>
          桌上 5×5 共 25 個詞。只有聯絡人看得到密碼表：先手隊 9 張、後手隊 8 張、路人 7 張，還有 1 張叛徒。
        </li>
        <li>輪到的隊伍，聯絡人給「一個詞＋一個數字」，提示詞不能是盤面上的詞，也不能包含或被包含在盤面上的詞裡。</li>
        <li>組員點格子標記想翻的（只有同隊看得到），再按「翻開」。這輪最多翻「數字＋1」張；翻到自己人可以繼續，翻到路人或對方的就換隊。</li>
        <li>翻到叛徒立刻輸。先翻完自己隊所有詞的隊伍獲勝（被對方翻到也算）。翻過一張之後可以「結束這輪」。</li>
        <li>對局中聯絡人在聊天室說的話只有聯絡人看得到，觀戰的人也看不到密碼表。</li>
        <li>給提示時間到就跳過這輪，猜的時間到就換隊。聯絡人斷線 20 秒由一位組員接手（看過密碼表後這局就不能翻牌）。</li>
        <li>線下模式：聯絡人當面說出提示，網頁上只選數字；聯絡人用自己的手機看密碼表。</li>
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: CtParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩暗號接頭"
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
      <div className="ct">
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
      <div className="ct">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>
          <PartyLobby party={party} options={<OptionsForm party={party} />} />
        </GameLayout>
      </div>
    )
  }

  return (
    <div className="ct">
      {header}
      <GameLayout side={side}>
        <Board party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && <PartyLobby party={party} options={<OptionsForm party={party} />} />}
      </GameLayout>
    </div>
  )
}

function chatHint(view: CtView | null): string {
  if (!view || view.stage === 'teams' || view.stage === 'end') return '說點什麼…'
  if (view.you !== null && view.insiders[view.you]) return '只有聯絡人看得到，組員看不到'
  return '說點什麼…（聯絡人說的話你看不到）'
}

function OptionsForm({ party }: { party: CtParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<CtOptions>) => party.setOptions({ ...o, ...patch })
  const players = Math.min(room.players.filter((p) => p.online).length, room.max)
  const secs = (values: number[]) => [
    ...values.map((s) => ({ value: s, label: s % 60 === 0 ? `${s / 60} 分鐘` : `${s} 秒` })),
    { value: 0, label: '不限' },
  ]

  return (
    <div className="ct-options">
      <Segmented
        label="給提示的時間"
        value={o.clueSecs}
        options={secs([60, 120, 180])}
        onChange={(clueSecs) => set({ clueSecs })}
        disabled={!editable}
      />
      <Segmented
        label="猜的時間"
        value={o.guessSecs}
        options={secs([60, 120, 180])}
        onChange={(guessSecs) => set({ guessSecs })}
        disabled={!editable}
      />
      <Segmented
        label="玩法"
        value={o.offline ? 1 : 0}
        options={[
          { value: 0, label: '線上打字提示' },
          { value: 1, label: '線下當面說' },
        ]}
        onChange={(v) => set({ offline: v === 1 })}
        disabled={!editable}
      />
      <p className={players >= 4 || players === 0 ? 'muted' : 'error'}>
        {players < 4 ? '至少要 4 人（每隊 2 人）' : `${players} 人：開始後先選隊`}
      </p>
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

/** 某一隊的座位 */
function seatsOf(view: CtView, team: number): number[] {
  return view.teams.flatMap((t, s) => (t === team ? [s] : []))
}

function Board({ party, view }: { party: CtParty; view: CtView }) {
  const name: NameOf = (seat) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  if (view.stage === 'teams') return <TeamPicker party={party} view={view} name={name} />

  const me = view.you
  const myTeam = me !== null ? view.teams[me] : null
  const insider = me !== null && view.insiders[me]
  const ours = myTeam === view.turn
  const turnName = `${TEAMS[view.turn].name}隊`
  const lead = view.leads[view.turn]

  let status: ReactNode
  let tone: 'ok' | 'danger' | 'accent' | undefined
  switch (view.stage) {
    case 'clue':
      if (ours && insider) {
        status = view.options.offline ? '輪到你：當面說出提示，再選數字' : '輪到你給提示'
        tone = 'accent'
      } else status = `等${turnName}的 ${lead !== null ? name(lead) : '聯絡人'} 給提示`
      break
    case 'guess': {
      const clue = view.clue
      const text = clue ? `${clue.word ? `「${clue.word}」` : '（當面說的）'}${clue.count}` : ''
      if (ours && !insider) {
        status = `輪到你們猜：${text}`
        tone = 'accent'
      } else status = `${turnName}在猜：${text}`
      break
    }
    case 'end':
      status = view.winner !== null ? `${TEAMS[view.winner].name}隊獲勝！` : '結束'
      tone = myTeam === null || myTeam === view.winner ? 'ok' : 'danger'
      break
  }

  return (
    <div className="ct-board">
      <Scoreboard view={view} />
      <StatusLine tone={tone}>
        {status} <Countdown ms={view.endsIn} stamp={view} />
      </StatusLine>
      {view.stage === 'end' && <Result view={view} />}
      {view.stage === 'guess' && <ClueBanner view={view} name={name} />}
      <Grid party={party} view={view} name={name} />
      <ActionPanel party={party} view={view} name={name} />
      <Rosters view={view} name={name} />
      <Log view={view} name={name} />
    </div>
  )
}

/** 選隊：自己點要加入哪一隊、要不要當聯絡人；房主可以隨機分隊、開始發牌 */
function TeamPicker({ party, view, name }: { party: CtParty; view: CtView; name: NameOf }) {
  const me = view.you
  const room = party.room!
  const host = room.players.find((p) => p.pid === room.host)
  // 房主沒有座位（觀戰）時，座位上的人都能按
  const canRun = me !== null && (party.isHost || host?.seat == null)
  const free = view.teams.flatMap((t, s) => (t === null ? [s] : []))
  // 開始時沒選隊的人會補進人少的那隊
  let [a, b] = [seatsOf(view, 0).length, seatsOf(view, 1).length]
  for (let k = 0; k < free.length; k++) {
    if (a <= b) a++
    else b++
  }
  const tooSmall = Math.min(a, b) < 2
  const mine = me !== null ? view.teams[me] : null

  return (
    <div className="ct-board">
      <StatusLine tone={me !== null && mine === null ? 'accent' : undefined}>
        {me === null ? '大家在選隊…' : mine === null ? '選一隊加入' : '選好了，等房主開始發牌'}
      </StatusLine>
      <div className="ct-teams">
        {[0, 1].map((t) => {
          const members = seatsOf(view, t)
          const lead = view.leads[t]
          return (
            <section key={t} className={`ct-team ct-t${t}`} aria-label={`${TEAMS[t].name}隊`}>
              <h3>
                {TEAMS[t].mark} {TEAMS[t].name}隊 <span className="muted">{members.length} 人</span>
              </h3>
              <ul>
                {members.length === 0 && <li className="muted">還沒有人</li>}
                {members.map((s) => (
                  <li key={s} className={s === me ? 'me' : ''}>
                    <span className="ct-name">{name(s)}</span>
                    <span className="ct-chips">
                      {lead === s && <span className="chip">聯絡人</span>}
                      {s === me && <span className="chip subtle">你</span>}
                      {!view.online[s] && <span className="chip subtle">離線</span>}
                      {view.led[s] > 0 && <span className="chip subtle">當過 {view.led[s]} 次</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {lead === null && members.length > 0 && <p className="muted">還沒有聯絡人，開始時照輪替挑一位</p>}
              {me !== null &&
                (mine === t ? (
                  <button type="button" className="secondary" onClick={() => party.act({ type: 'lead' })}>
                    {lead === me ? '不當聯絡人' : '我當聯絡人'}
                  </button>
                ) : (
                  <button type="button" className="ct-join" onClick={() => party.act({ type: 'join', team: t })}>
                    加入{TEAMS[t].name}
                  </button>
                ))}
            </section>
          )
        })}
      </div>
      {free.length > 0 && (
        <p className="muted ct-note">還沒選隊：{free.map(name).join('、')}（開始時自動補進人少的那隊）</p>
      )}
      {tooSmall && <p className="error ct-note">每隊至少要 2 人：1 位聯絡人加至少 1 位組員</p>}
      {canRun ? (
        <div className="ct-run">
          <button type="button" className="secondary" onClick={() => party.act({ type: 'shuffle' })}>
            隨機分隊
          </button>
          <button type="button" onClick={() => party.act({ type: 'go' })} disabled={tooSmall}>
            開始發牌
          </button>
        </div>
      ) : (
        <p className="muted ct-note">{me === null ? '觀戰中，下一局開始時就能參加。' : '等房主按「開始發牌」…'}</p>
      )}
    </div>
  )
}

function Scoreboard({ view }: { view: CtView }) {
  return (
    <div className="ct-score">
      {[0, 1].map((t) => {
        const cls = [
          'ct-score-team',
          `ct-t${t}`,
          view.stage !== 'end' && view.turn === t ? 'active' : '',
          view.winner === t ? 'won' : '',
        ]
        return (
          <div key={t} className={cls.filter(Boolean).join(' ')}>
            <span className="ct-score-name">
              {TEAMS[t].mark} {TEAMS[t].name}
              {view.first === t && <small>先手</small>}
            </span>
            <span className="ct-score-left">
              剩 <strong>{view.left[t]}</strong> 張
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 猜的時候：這輪的提示和還能翻幾張 */
function ClueBanner({ view, name }: { view: CtView; name: NameOf }) {
  const clue = view.clue
  if (!clue) return null
  return (
    <div className={`ct-clue ct-t${view.turn}`}>
      <span className="ct-clue-label">{clue.by !== null ? `${name(clue.by)} 的提示` : '提示'}</span>
      <strong className="ct-clue-word">{clue.word ?? '（當面說）'}</strong>
      <strong className="ct-clue-count">{clue.count}</strong>
      <span className="ct-clue-label">
        還能翻 {clue.limit - clue.made} 張
      </span>
    </div>
  )
}

/** 5×5 盤面：組員點一下標記；看得到密碼表的人沒翻開的格子會上淡淡的顏色 */
function Grid({ party, view, name }: { party: CtParty; view: CtView; name: NameOf }) {
  const [hideKey, setHideKey] = useState(false)
  const me = view.you
  const myTeam = me !== null ? view.teams[me] : null
  const insider = me !== null && view.insiders[me]
  const canMark = view.stage === 'guess' && myTeam === view.turn && !insider
  const showKey = view.key !== null && (view.stage === 'end' || !hideKey)
  const words = view.words ?? []

  return (
    <section className="ct-grid-box" aria-label="盤面">
      {view.key && view.stage !== 'end' && (
        <div className="ct-key-bar">
          <span className="muted">你看得到密碼表，別讓組員看到螢幕</span>
          <button type="button" className="secondary" onClick={() => setHideKey((h) => !h)} aria-pressed={hideKey}>
            {hideKey ? '顯示密碼表' : '遮住密碼表'}
          </button>
        </div>
      )}
      <ol className={`ct-grid${canMark ? ' can-mark' : ''}`}>
        {words.map((word, i) => {
          const open = view.revealed?.[i] ?? null
          const secret = showKey ? (view.key?.[i] ?? null) : null
          const kind = open ?? secret
          const marks = view.marks?.[i] ?? []
          const mine = me !== null && marks.includes(me)
          const cls = [
            'ct-card',
            open ? `open ${open}` : secret ? `key ${secret}` : '',
            marks.length > 0 ? 'marked' : '',
            mine ? 'mine' : '',
          ]
          const label = [
            word,
            open ? `翻開了：${CARD_NAMES[open]}` : secret ? `密碼表：${CARD_NAMES[secret]}` : '',
            marks.length > 0 ? `${marks.map(name).join('、')} 標記了` : '',
          ]
          return (
            <li key={i}>
              <button
                type="button"
                className={cls.filter(Boolean).join(' ')}
                data-len={Math.min([...word].length, 5)}
                disabled={!canMark || open !== null}
                onClick={() => party.act({ type: 'mark', index: i })}
                aria-pressed={canMark && !open ? mine : undefined}
                aria-label={label.filter(Boolean).join('，')}
              >
                <span className="ct-word">{word}</span>
                {kind && (
                  <span className="ct-tag" aria-hidden="true">
                    {CARD_MARKS[kind]}
                  </span>
                )}
                {marks.length > 0 && (
                  <span className="ct-marks" aria-hidden="true">
                    {marks.length}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function ActionPanel({ party, view, name }: { party: CtParty; view: CtView; name: NameOf }) {
  const me = view.you
  if (me === null) {
    return view.stage === 'end' ? null : (
      <p className="muted ct-note">觀戰中：看不到密碼表，下一局開始時就能參加。</p>
    )
  }
  const ours = view.teams[me] === view.turn
  const insider = view.insiders[me]
  switch (view.stage) {
    case 'clue':
      if (ours && insider) return <ClueForm key={view.log.length} party={party} view={view} />
      return (
        <p className="muted ct-note">
          {ours ? '等你們的聯絡人想提示…' : '對方的聯絡人在想提示…'}
          {insider && '（你看過密碼表，聊天只有聯絡人看得到）'}
        </p>
      )
    case 'guess':
      if (ours && !insider) return <GuessPanel party={party} view={view} name={name} />
      return (
        <p className="muted ct-note">
          {ours ? '組員在猜，你只能看，不能透露。' : '對方在猜…'}
        </p>
      )
    default:
      return null
  }
}

/** 本地先比一次盤面上的詞（伺服器會再檢查，以伺服器為準）：全形轉半形、只留文字數字、小寫、臺→台 */
function normalize(text: string): string {
  return [...text.normalize('NFKC').toLowerCase()]
    .filter((c) => /[\p{L}\p{N}]/u.test(c))
    .join('')
    .replaceAll('臺', '台')
}

function clashWith(clue: string, words: string[]): string | null {
  const c = normalize(clue)
  if (!c) return null
  return words.find((w) => {
    const n = normalize(w)
    return n !== '' && (c.includes(n) || n.includes(c))
  }) ?? null
}

/** 聯絡人給提示：一個詞（線下模式不用打）＋一個數字 */
function ClueForm({ party, view }: { party: CtParty; view: CtView }) {
  const [word, setWord] = useState('')
  const [count, setCount] = useState(1)
  const offline = view.options.offline
  const trimmed = word.trim()
  const hit = offline ? null : clashWith(trimmed, view.words ?? [])
  const ready = offline || (trimmed !== '' && !/\s/.test(trimmed))

  function submit(e: FormEvent) {
    e.preventDefault()
    if (ready) party.act({ type: 'clue', word: offline ? '' : trimmed, count })
  }

  return (
    <form className="ct-actions" onSubmit={submit}>
      {offline ? (
        <p>當面說出你的提示詞，再選數字送出。</p>
      ) : (
        <label className="ct-field">
          <span>提示詞：一個詞，不能是盤面上的詞，也不能包含或被包含在盤面上的詞裡</span>
          <input
            value={word}
            onChange={(e) => setWord(e.target.value)}
            maxLength={MAX_CLUE}
            placeholder="例如：海邊"
            enterKeyHint="send"
            autoComplete="off"
            autoFocus
          />
        </label>
      )}
      {hit && <p className="error">撞到盤面上的「{hit}」，換一個詞</p>}
      {/\s/.test(trimmed) && <p className="error">只能是一個詞，不要有空白</p>}
      <div className="ct-field">
        <span>數字：和這個提示有關的有幾張（組員最多可以翻數字＋1 張）</span>
        <div className="ct-count" role="radiogroup" aria-label="數字">
          {Array.from({ length: MAX_COUNT }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={n === count}
              className={n === count ? 'active' : 'secondary'}
              onClick={() => setCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <button type="submit" disabled={!ready}>
        送出提示：{offline ? '' : `「${trimmed}」`}
        {count}
      </button>
    </form>
  )
}

/** 組員：標記過的格子列在這裡，按「翻開」才算數 */
function GuessPanel({ party, view, name }: { party: CtParty; view: CtView; name: NameOf }) {
  const words = view.words ?? []
  const clue = view.clue
  const left = clue ? clue.limit - clue.made : 0
  const picks = (view.marks ?? [])
    .map((who, index) => ({ index, who }))
    .filter((p) => p.who.length > 0 && !view.revealed?.[p.index])
    .sort((x, y) => y.who.length - x.who.length || x.index - y.index)

  return (
    <div className="ct-actions">
      <p>
        點格子標記想翻的（同隊的人看得到），再按「翻開」。這輪還能翻 <strong>{left}</strong> 張，翻錯就換對方。
      </p>
      {picks.length === 0 ? (
        <p className="muted">還沒有人標記</p>
      ) : (
        <ul className="ct-picks">
          {picks.map(({ index, who }) => (
            <li key={index}>
              <span className="ct-pick-word">{words[index]}</span>
              <span className="ct-pick-who">{who.map(name).join('、')}</span>
              <button type="button" onClick={() => party.act({ type: 'reveal', index, seq: view.seq })}>
                翻開
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="secondary"
        onClick={() => party.act({ type: 'stop' })}
        disabled={!clue || clue.made === 0}
      >
        結束這輪
      </button>
    </div>
  )
}

function Rosters({ view, name }: { view: CtView; name: NameOf }) {
  return (
    <div className="ct-teams">
      {[0, 1].map((t) => (
        <section key={t} className={`ct-team ct-t${t}`} aria-label={`${TEAMS[t].name}隊`}>
          <h3>
            {TEAMS[t].mark} {TEAMS[t].name}隊
          </h3>
          <ul>
            {seatsOf(view, t).map((s) => (
              <li key={s} className={s === view.you ? 'me' : ''}>
                <span className="ct-name">{name(s)}</span>
                <span className="ct-chips">
                  {view.leads[t] === s && <span className="chip">聯絡人</span>}
                  {view.leads[t] !== s && view.insiders[s] && <span className="chip subtle">看過密碼表</span>}
                  {s === view.you && <span className="chip subtle">你</span>}
                  {!view.online[s] && <span className="chip subtle">離線</span>}
                  {view.wins[s] > 0 && <span className="chip subtle">贏 {view.wins[s]} 局</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function Result({ view }: { view: CtView }) {
  if (view.winner === null) return null
  const t = view.winner
  const mine = view.you !== null ? view.teams[view.you] : null
  return (
    <section className={`ct-result ct-t${t}`}>
      <h3>
        {TEAMS[t].mark} {TEAMS[t].name}隊獲勝
      </h3>
      <p>{view.reason === 'traitor' ? `${TEAMS[1 - t].name}隊翻到了叛徒` : '所有暗號都接上頭了'}</p>
      {mine !== null && <p className="ct-result-me">{mine === t ? '你們贏了！' : '下一局扳回來！'}</p>}
      <p className="muted">密碼表公開了：沒翻開的格子也標上了顏色。</p>
    </section>
  )
}

const END_TEXT: Record<TurnEnd, string> = {
  miss: '翻錯換隊',
  limit: '翻滿了',
  stop: '自己結束',
  timeout: '時間到',
  away: '組員都不在',
  noClue: '沒有給提示',
  over: '分出勝負',
}

/** 每一輪的提示和翻開的格子，最新的在上面 */
function Log({ view, name }: { view: CtView; name: NameOf }) {
  if (view.log.length === 0) return null
  const words = view.words ?? []
  return (
    <section className="ct-log">
      <h3>紀錄</h3>
      <ol>
        {view.log
          .map((turn, k) => ({ turn, k }))
          .reverse()
          .map(({ turn, k }) => (
            <li key={k} className={`ct-t${turn.team}`}>
              <div className="ct-log-head">
                <strong>
                  {TEAMS[turn.team].mark} {TEAMS[turn.team].name}
                </strong>
                <span>
                  {turn.by === null
                    ? '沒有給提示'
                    : `${name(turn.by)}：${turn.word ? `「${turn.word}」` : '（當面說）'}${turn.count}`}
                </span>
                {turn.end && turn.end !== 'noClue' && <span className="muted">{END_TEXT[turn.end]}</span>}
              </div>
              {turn.reveals.length > 0 && (
                <div className="ct-log-flips">
                  {turn.reveals.map((f) => (
                    <span key={f.index} className={`ct-flip ${f.card}`} title={`${name(f.by)} 翻的：${CARD_NAMES[f.card]}`}>
                      {CARD_MARKS[f.card]} {words[f.index]}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
      </ol>
    </section>
  )
}
