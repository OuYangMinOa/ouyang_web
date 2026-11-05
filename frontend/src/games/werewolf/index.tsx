import { useState, type ReactNode } from 'react'
import { ChatBox, Countdown, PartyEntry, PartyHeader, PartyLobby, PartyNotice } from '../shared/Party'
import { GameLayout, Segmented, StatusLine } from '../shared/ui'
import { useParty, type Party } from '../shared/useParty'
import {
  GODS,
  MIN_PLAYERS,
  ROLE_ICONS,
  ROLE_INFO,
  ROLE_NAMES,
  describe,
  isGod,
  lineupOf,
  preset,
  type Death,
  type God,
  type NightLog,
  type Role,
  type Tally,
  type WerewolfParty,
  type WwOptions,
  type WwView,
} from './types'
import './werewolf.css'

type WwParty = Party<WerewolfParty>
type NameOf = (seat: number) => string

const ALL_ROLES: Role[] = ['wolf', 'villager', ...GODS]

/** 狼人殺：規則都在伺服器（backend/src/werewolf.rs），這裡只畫自己的 view、送動作 */
export default function Werewolf() {
  const party = useParty<WerewolfParty>('werewolf')
  if (!party.code) {
    return (
      <GameLayout side={<Rules />}>
        <PartyEntry party={party}>
          <p>
            夜裡狼人悄悄挑一個人下手，白天大家討論、投票把狼人找出來。預言家、女巫、獵人、守衛各有本事。
            6～12 人，人不夠可以加電腦，也能大家坐在一起玩、網頁當法官。
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
        <li>狼人互相認識，其他人只知道自己的身分。狼人全部出局，好人贏。</li>
        <li>
          狼人淘汰掉平民或神職其中一整邊就贏（屠邊）；房主也可以改成要淘汰所有好人（屠城）。
        </li>
        <li>夜晚：守衛守一個人、狼人私下商量並投票選一個人下手、預言家查驗一個人，接著輪到女巫用藥。</li>
        <li>天亮只公布誰出局，不說原因。獵人出局時可以開槍帶走一個人（被毒倒時不行），之後依規則留遺言。</li>
        <li>白天討論完投票放逐一個人，可以棄票；平票時由其他人在平票的人之間再投一次（或直接沒人出局）。</li>
        <li>線上模式在聊天室討論；線下模式大家當面說，夜晚各自在手機上行動，房主按「開始投票」。</li>
        <li>夜晚只有狼人能私下說話；出局的人只能和出局、觀戰的人聊天。</li>
        <li>在聊天室說「我是預言家」「3號是狼」「小明金水」，電腦玩家也聽得懂。贏的陣營每人得 1 分，在同一個房間累計。</li>
      </ul>
      <strong>角色</strong>
      <ul>
        {ALL_ROLES.map((role) => (
          <li key={role}>
            <strong>
              {ROLE_ICONS[role]} {ROLE_NAMES[role]}
            </strong>
            ：{ROLE_INFO[role]}
          </li>
        ))}
      </ul>
    </div>
  )
}

function InRoom({ party }: { party: WwParty }) {
  const { room, view } = party
  const playing = room?.phase === 'playing'
  const header = (
    <PartyHeader
      party={party}
      shareTitle="一起來玩狼人殺"
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
      <div className="ww">
        {header}
        {!party.error && <p className="muted">連線中…</p>}
      </div>
    )
  }

  const chat = chatState(room.phase === 'playing' ? view : null)
  const side = (
    <>
      <ChatBox party={party} title={chat.title} placeholder={chat.hint} disabled={chat.disabled} />
      <Rules />
    </>
  )

  if (room.phase === 'lobby' || !view) {
    return (
      <div className="ww">
        {header}
        <PartyNotice party={party} />
        <GameLayout side={side}>
          <PartyLobby party={party} options={<OptionsForm party={party} />} />
        </GameLayout>
      </div>
    )
  }

  return (
    <div className="ww">
      {header}
      <GameLayout side={side}>
        <Board party={party} view={view} />
        <PartyNotice party={party} />
        {room.phase === 'results' && <PartyLobby party={party} options={<OptionsForm party={party} />} />}
      </GameLayout>
    </div>
  )
}

/** 剛出局、技能或遺言還沒處理完（和後端 `pending` 一樣） */
function isPending(view: WwView, seat: number): boolean {
  if (view.stage === 'dawn' || view.stage === 'skill' || view.stage === 'verdict') return view.batch.includes(seat)
  if (view.stage === 'lastWords' && view.speaker !== null) {
    return view.speakers.slice(view.speakers.indexOf(view.speaker)).includes(seat)
  }
  return false
}

/** 聊天室這個階段給誰看、能不能說話（實際的規則在後端 `chat`） */
function chatState(view: WwView | null): { title: string; hint: string; disabled: boolean } {
  if (!view || view.stage === 'end') return { title: '聊天', hint: '說點什麼…', disabled: false }
  if (view.you === null || !view.me) return { title: '聊天', hint: '觀戰中：只有出局和觀戰的人看得到', disabled: false }
  if (!view.me.alive) {
    if (view.speaker === view.you) return { title: '聊天', hint: '你的遺言：大家都看得到', disabled: false }
    if (isPending(view, view.you)) return { title: '聊天', hint: '剛出局：等輪到你的遺言再說', disabled: true }
    return { title: '出局頻道', hint: '只有出局和觀戰的人看得到', disabled: false }
  }
  if (view.stage === 'night' || view.stage === 'witch') {
    return view.me.role === 'wolf'
      ? { title: '狼人頻道', hint: '只有狼隊友看得到', disabled: false }
      : { title: '聊天', hint: '天黑了，夜晚不能說話', disabled: true }
  }
  if (view.stage === 'peek') return { title: '聊天', hint: '說點什麼…', disabled: false }
  return { title: '聊天', hint: '例如：我是預言家、3號是狼、小明金水', disabled: false }
}

function OptionsForm({ party }: { party: WwParty }) {
  const room = party.room!
  const o = room.options
  const editable = party.isHost && room.phase !== 'playing'
  const set = (patch: Partial<WwOptions>) => party.setOptions({ ...o, ...patch })
  const toggle = (role: God) => {
    const next = { ...o }
    next[role] = !o[role]
    party.setOptions(next)
  }
  const players = Math.min(room.players.filter((p) => p.bot || p.online).length, room.max)
  const lineup = players >= MIN_PLAYERS ? lineupOf(o, players) : null

  return (
    <div className="ww-options">
      <Segmented
        label="玩法"
        value={o.offline ? 1 : 0}
        options={[
          { value: 0, label: '線上聊天' },
          { value: 1, label: '線下當面' },
        ]}
        onChange={(v) => set({ offline: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="角色"
        value={o.custom ? 1 : 0}
        options={[
          { value: 0, label: '依人數' },
          { value: 1, label: '自訂' },
        ]}
        onChange={(v) => {
          if (v === 1 && !o.custom) {
            // 從目前人數的預設配置開始改
            const p = preset(Math.max(players, MIN_PLAYERS))
            set({ custom: true, wolves: p.wolves, seer: p.seer, witch: p.witch, hunter: p.hunter, guard: p.guard })
          } else {
            set({ custom: v === 1 })
          }
        }}
        disabled={!editable}
      />
      {o.custom && (
        <>
          <Segmented
            label="狼人"
            value={o.wolves}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} 個` }))}
            onChange={(wolves) => set({ wolves })}
            disabled={!editable}
          />
          <div className="segmented-field">
            <span className="segmented-label">神職</span>
            <div className="ww-toggles">
              {GODS.map((role) => (
                <button
                  key={role}
                  type="button"
                  className={o[role] ? 'active' : ''}
                  aria-pressed={o[role]}
                  onClick={() => toggle(role)}
                  disabled={!editable}
                >
                  {ROLE_ICONS[role]} {ROLE_NAMES[role]}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <Segmented
        label="勝利條件"
        value={o.win}
        options={[
          { value: 'side', label: '屠邊' },
          { value: 'all', label: '屠城' },
        ]}
        onChange={(win) => set({ win })}
        disabled={!editable}
      />
      <Segmented
        label="女巫救自己"
        value={o.selfSave}
        options={[
          { value: 'never', label: '不行' },
          { value: 'firstNight', label: '只有第一晚' },
          { value: 'always', label: '可以' },
        ]}
        onChange={(selfSave) => set({ selfSave })}
        disabled={!editable}
      />
      <Segmented
        label="遺言"
        value={o.lastWords}
        options={[
          { value: 'never', label: '沒有' },
          { value: 'firstNight', label: '第一晚和白天' },
          { value: 'always', label: '都有' },
        ]}
        onChange={(lastWords) => set({ lastWords })}
        disabled={!editable}
      />
      <Segmented
        label="平票"
        value={o.tie}
        options={[
          { value: 'revote', label: '再投一次' },
          { value: 'noExile', label: '沒人出局' },
        ]}
        onChange={(tie) => set({ tie })}
        disabled={!editable}
      />
      <Segmented
        label="出局時"
        value={o.reveal ? 1 : 0}
        options={[
          { value: 0, label: '不公開身分' },
          { value: 1, label: '公開身分' },
        ]}
        onChange={(v) => set({ reveal: v === 1 })}
        disabled={!editable}
      />
      <Segmented
        label="夜晚時間"
        value={o.nightSecs}
        options={[30, 45, 60, 90].map((s) => ({ value: s, label: `${s} 秒` }))}
        onChange={(nightSecs) => set({ nightSecs })}
        disabled={!editable}
      />
      <Segmented
        label={o.offline ? '討論上限' : '討論時間'}
        value={o.discussSecs}
        options={[120, 180, 300, 480].map((s) => ({ value: s, label: `${s / 60} 分` }))}
        onChange={(discussSecs) => set({ discussSecs })}
        disabled={!editable}
      />
      <p className={lineup === null || typeof lineup === 'string' ? 'error' : 'muted'}>
        {lineup === null
          ? `至少要 ${MIN_PLAYERS} 人（現在 ${players} 人），可以加電腦補位`
          : typeof lineup === 'string'
            ? lineup
            : `${players} 人：${describe(lineup)}`}
      </p>
      {o.offline && (
        <p className="muted">
          線下模式：大家坐在一起，夜晚各自在手機上行動（沒事做的人也點一下懷疑對象，旁邊的人才看不出誰有身分），
          白天當面討論，房主按「開始投票」，投票一樣在手機上。
        </p>
      )}
      {!party.isHost && <p className="muted">選項由房主決定。</p>}
    </div>
  )
}

/** 點座位要做什麼（守護、刀人、查驗、下毒、開槍、投票、記懷疑） */
type SeatPick = { can: (seat: number) => boolean; act: (seat: number) => void; chosen: number | null; cta: string }

function seatPick(party: WwParty, view: WwView, poisonMode: boolean, name: NameOf): SeatPick | null {
  const me = view.me
  const you = view.you
  if (you === null || !me) return null
  const alive = (i: number) => view.seats[i].alive
  const act = party.act
  const others = (i: number) => alive(i) && i !== you
  if (!me.alive) {
    if (view.stage === 'skill' && me.skill?.canShoot) {
      return {
        can: others,
        act: (i) => window.confirm(`開槍帶走 ${name(i)}？`) && act({ type: 'shoot', seat: i }),
        chosen: null,
        cta: '開槍',
      }
    }
    return null
  }
  const suspect: SeatPick = {
    can: others,
    act: (i) => act({ type: 'suspect', seat: i === me.suspect ? null : i }),
    chosen: me.suspect,
    cta: '懷疑',
  }
  switch (view.stage) {
    case 'night': {
      if (me.role === 'guard' && me.guard) {
        const g = me.guard
        return {
          can: (i) => alive(i) && i !== g.last,
          act: (i) => act({ type: 'guard', seat: i }),
          chosen: g.decided ? g.pick : null,
          cta: '守護',
        }
      }
      if (me.role === 'wolf') {
        const mine = me.kills?.find((k) => k.seat === you)
        return {
          can: alive,
          act: (i) => act({ type: 'kill', seat: i }),
          chosen: mine?.voted ? mine.target : null,
          cta: '下手',
        }
      }
      if (me.role === 'seer' && me.checked === null) {
        return {
          can: (i) => others(i) && !me.checks?.some((c) => c.seat === i),
          act: (i) => act({ type: 'check', seat: i }),
          chosen: null,
          cta: '查驗',
        }
      }
      return suspect
    }
    case 'witch':
      if (me.role === 'witch') {
        return poisonMode
          ? {
              can: others,
              act: (i) => window.confirm(`對 ${name(i)} 下毒？`) && act({ type: 'poison', seat: i }),
              chosen: null,
              cta: '下毒',
            }
          : null
      }
      return me.role === 'wolf' ? null : suspect
    case 'vote': {
      const vote = view.vote
      if (!vote || !vote.voters.includes(you)) return null
      return {
        can: (i) => vote.candidates.includes(i) && i !== you,
        act: (i) => act({ type: 'vote', seat: i }),
        chosen: vote.voted ? vote.mine : null,
        cta: '投他',
      }
    }
    default:
      return null
  }
}

function Board({ party, view }: { party: WwParty; view: WwView }) {
  const name: NameOf = (seat) => party.playerAt(seat)?.name ?? `座位 ${seat + 1}`
  // 伺服器不知道誰是房主：「開始投票」「下一位」只給房主看到，房主沒有座位時所有人都有
  const host = party.room?.players.find((p) => p.pid === party.room?.host)
  const canAdvance = view.you !== null && (party.isHost || host?.seat == null)
  const night = view.stage === 'night' || view.stage === 'witch'
  // 女巫按了「用毒藥…」的那一晚；換一晚自然失效
  const [poisonNight, setPoisonNight] = useState<number | null>(null)
  const poisonMode = view.stage === 'witch' && poisonNight === view.day
  const pick = seatPick(party, view, poisonMode, name)

  return (
    <div className={`ww-board${night ? ' night' : ''}`}>
      <RoleCard view={view} name={name} />
      <p className="ww-sky">
        <span className="ww-sky-icon" aria-hidden="true">
          {night ? '🌙' : view.stage === 'peek' ? '🌆' : view.stage === 'end' ? '🏁' : '☀️'}
        </span>
        <span>{skyText(view)}</span>
      </p>
      <StatusLine tone={statusTone(view)}>
        {statusText(view, name)} <Countdown ms={view.endsIn} stamp={view} />
      </StatusLine>
      <ActionPanel
        party={party}
        view={view}
        name={name}
        canAdvance={canAdvance}
        poisonMode={poisonMode}
        setPoisonMode={(on) => setPoisonNight(on ? view.day : null)}
      />
      <Seats party={party} view={view} name={name} pick={pick} />
      {view.result && <Result view={view} name={name} />}
      {view.me && <Notes view={view} name={name} />}
      <Timeline view={view} name={name} />
    </div>
  )
}

function skyText(view: WwView): string {
  const lineup = `${describe(view.lineup)}${view.options.offline ? ' · 線下當面' : ''}`
  switch (view.stage) {
    case 'peek':
      return `天黑之前 · ${lineup}`
    case 'night':
    case 'witch':
      return `第 ${view.day} 晚 · ${lineup}`
    case 'end':
      return `遊戲結束 · ${lineup}`
    default:
      return `第 ${view.day} 天 · ${lineup}`
  }
}

function won(view: WwView): boolean | null {
  if (!view.result || !view.me) return null
  return (view.me.role === 'wolf') === (view.result.winner === 'wolf')
}

function statusTone(view: WwView): 'ok' | 'danger' | 'accent' | undefined {
  switch (view.stage) {
    case 'end': {
      const w = won(view)
      return w === false ? 'danger' : 'ok'
    }
    case 'dawn':
      return view.batch.length > 0 ? 'danger' : 'ok'
    case 'verdict':
      return view.tallies.at(-1)?.out != null ? 'danger' : undefined
    case 'vote':
      return 'accent'
    default:
      return undefined
  }
}

function statusText(view: WwView, name: NameOf): ReactNode {
  switch (view.stage) {
    case 'peek':
      return '看看你的身分'
    case 'night': {
      const actors = [view.lineup.guard && '守衛', '狼人', view.lineup.seer && '預言家'].filter(Boolean)
      return `天黑請閉眼：${actors.join('、')}行動中`
    }
    case 'witch':
      return '女巫行動中'
    case 'dawn':
      return view.batch.length > 0 ? `天亮了，昨晚 ${view.batch.map(name).join('、')} 出局` : '天亮了，昨晚是平安夜'
    case 'skill':
      return '出局的人確認技能中'
    case 'lastWords':
      return view.speaker === null ? '遺言' : `${name(view.speaker)} 的遺言`
    case 'discuss':
      return view.options.offline ? '白天：大家當面討論' : '白天：在聊天室討論'
    case 'vote':
      return view.vote?.revote ? '平票重投：只能投平票的人' : '投票放逐'
    case 'verdict': {
      const last = view.tallies.at(-1)
      return last?.out != null ? `${name(last.out)} 被放逐` : '今天沒有人被放逐'
    }
    case 'end': {
      const text = view.result?.winner === 'good' ? '好人獲勝！' : '狼人獲勝！'
      const w = won(view)
      return w === null ? text : `${text}${w ? '（你贏了）' : '（你輸了）'}`
    }
  }
}

/** 自己的身分：點一下遮住（線下時防旁邊的人偷看） */
function RoleCard({ view, name }: { view: WwView; name: NameOf }) {
  const [hidden, setHidden] = useState(false)
  if (view.you === null || !view.me) {
    return <p className="ww-role spectator">觀戰中：看不到大家的身分，下一局開始時就能參加。</p>
  }
  const me = view.me
  const role = me.role
  const mates = (me.wolves ?? []).filter((s) => s !== view.you)
  const camp = role === 'wolf' ? '狼人陣營' : isGod(role) ? '好人陣營・神職' : '好人陣營'
  return (
    <button
      type="button"
      className={`ww-role ${role === 'wolf' ? 'wolf' : 'good'}${hidden ? ' hidden' : ''}`}
      onClick={() => setHidden((h) => !h)}
      aria-pressed={hidden}
    >
      <span className="ww-role-label">{hidden ? '你的身分' : camp}</span>
      <strong>
        <span aria-hidden="true">{hidden ? '🂠' : ROLE_ICONS[role]}</span> {hidden ? '● ● ●' : ROLE_NAMES[role]}
      </strong>
      {!hidden && <span className="ww-role-info">{ROLE_INFO[role]}</span>}
      {!hidden && mates.length > 0 && <span className="ww-role-mates">狼隊友：{mates.map(name).join('、')}</span>}
      {!me.alive && <span className="ww-role-dead">你已出局</span>}
      <span className="ww-role-hint">{hidden ? '點一下顯示' : '點一下遮住'}</span>
    </button>
  )
}

function ActionPanel({
  party,
  view,
  name,
  canAdvance,
  poisonMode,
  setPoisonMode,
}: {
  party: WwParty
  view: WwView
  name: NameOf
  canAdvance: boolean
  poisonMode: boolean
  setPoisonMode: (on: boolean) => void
}) {
  const me = view.me
  const you = view.you
  if (you === null || !me) return null
  const seat = view.seats[you]
  const act = party.act
  const waiting = (aliveOnly: boolean) =>
    view.seats.filter((s, i) => s.online && !s.ready && i !== you && (!aliveOnly || s.alive)).length

  switch (view.stage) {
    case 'peek':
      return (
        <div className="ww-actions">
          <p>記好你的身分，大家都按了就天黑。</p>
          <button type="button" onClick={() => act({ type: 'ready' })} disabled={seat.ready}>
            {seat.ready ? `等其他 ${waiting(false)} 人…` : '記住了'}
          </button>
        </div>
      )
    case 'night':
      return <NightPanel party={party} view={view} name={name} />
    case 'witch':
      return (
        <WitchPanel party={party} view={view} name={name} poisonMode={poisonMode} setPoisonMode={setPoisonMode} />
      )
    case 'skill': {
      if (!me.skill) return null
      if (me.skill.canShoot) {
        return (
          <div className="ww-actions">
            <p>你是獵人，可以開槍帶走一位還活著的玩家（點下面的名字），也可以不開槍。</p>
            <div className="ww-buttons">
              <button type="button" className="secondary" onClick={() => act({ type: 'shoot', seat: null })}>
                不開槍
              </button>
            </div>
          </div>
        )
      }
      return (
        <div className="ww-actions">
          <p>{me.skill.hunter ? '你被毒藥毒倒了，不能開槍。' : '你出局了，沒有可以發動的技能。'}</p>
          <button type="button" onClick={() => act({ type: 'shoot', seat: null })}>
            確定
          </button>
        </div>
      )
    }
    case 'lastWords': {
      const lastOne = view.speaker !== null && view.speakers.indexOf(view.speaker) === view.speakers.length - 1
      if (view.speaker === you) {
        return (
          <div className="ww-actions">
            <p>{view.options.offline ? '輪到你的遺言：當面說給大家聽。' : '輪到你的遺言：在聊天室說，大家都看得到。'}</p>
            <button type="button" onClick={() => act({ type: 'done' })}>
              說完了
            </button>
          </div>
        )
      }
      if (view.options.offline && canAdvance) {
        return (
          <div className="ww-actions">
            <p>說完了可以由房主按下一步。</p>
            <button type="button" className="secondary" onClick={() => act({ type: 'advance' })}>
              {lastOne ? '遺言結束' : '下一位'}
            </button>
          </div>
        )
      }
      return null
    }
    case 'discuss':
      if (view.options.offline) {
        return (
          <div className="ww-actions">
            <p>大家當面討論。{canAdvance ? '討論夠了就按「開始投票」。' : '等房主按「開始投票」。'}</p>
            {canAdvance && (
              <button type="button" onClick={() => act({ type: 'advance' })}>
                開始投票
              </button>
            )}
          </div>
        )
      }
      if (!me.alive) return null
      return (
        <div className="ww-actions">
          <p>在聊天室說說你的看法，活著的人都按了就提早投票。</p>
          <button type="button" onClick={() => act({ type: 'ready' })} disabled={seat.ready}>
            {seat.ready ? `等其他 ${waiting(true)} 人…` : '可以投票了'}
          </button>
        </div>
      )
    case 'vote': {
      const vote = view.vote
      if (!vote) return null
      if (!me.alive) return <p className="ww-actions ww-hint">你已出局，不能投票。</p>
      if (!vote.voters.includes(you)) return <p className="ww-actions ww-hint">你在平票名單上，這輪不能投票。</p>
      const current = !vote.voted ? '' : vote.mine === null ? '你目前棄票。' : `你目前投 ${name(vote.mine)}。`
      return (
        <div className="ww-actions">
          <p>
            {vote.revote ? '點一位平票的玩家投票' : '點一位玩家投票放逐'}，開票前還能改。{current}
          </p>
          <div className="ww-buttons">
            <button
              type="button"
              className="secondary"
              onClick={() => act({ type: 'vote', seat: null })}
              disabled={vote.voted && vote.mine === null}
            >
              棄票
            </button>
          </div>
        </div>
      )
    }
    default:
      return null
  }
}

function NightPanel({ party, view, name }: { party: WwParty; view: WwView; name: NameOf }) {
  const me = view.me!
  const act = party.act
  if (!me.alive) return <p className="ww-actions ww-hint">你已出局，等天亮。</p>
  const suspectHint = (
    <p className="muted">可以點一位玩家記下你的懷疑（只有你看得到），旁邊的人也看不出誰有夜間行動。</p>
  )
  if (me.role === 'guard' && me.guard) {
    const g = me.guard
    return (
      <div className="ww-actions">
        <p>
          {g.decided
            ? `你今晚守護 ${g.pick === null ? '沒有人（空守）' : name(g.pick)}，天亮前還能改。`
            : '點一位玩家守護他，可以守自己。'}
        </p>
        {g.last !== null && <p className="muted">昨晚守了 {name(g.last)}，今晚不能再守他。</p>}
        <div className="ww-buttons">
          <button
            type="button"
            className="secondary"
            onClick={() => act({ type: 'guard', seat: null })}
            disabled={g.decided && g.pick === null}
          >
            今晚空守
          </button>
        </div>
      </div>
    )
  }
  if (me.role === 'wolf') {
    return (
      <div className="ww-actions">
        <p>點一位玩家投票下手。狼人都投同一個人就定案，時間到照多數（平手隨機）。可以在狼人頻道和隊友商量。</p>
        <ul className="ww-wolf-votes">
          {(me.kills ?? []).map((k) => (
            <li key={k.seat}>
              <strong>{k.seat === view.you ? '你' : name(k.seat)}</strong>
              <span>{k.voted ? (k.target === null ? '空刀' : `→ ${name(k.target)}`) : '還沒投'}</span>
            </li>
          ))}
        </ul>
        <div className="ww-buttons">
          <button type="button" className="secondary" onClick={() => act({ type: 'kill', seat: null })}>
            今晚空刀
          </button>
        </div>
      </div>
    )
  }
  if (me.role === 'seer') {
    if (me.checked === null) {
      return (
        <div className="ww-actions">
          <p>點一位玩家查驗他是不是狼人。</p>
        </div>
      )
    }
    const wolf = me.checks?.find((c) => c.seat === me.checked)?.wolf ?? false
    return (
      <div className="ww-actions">
        <p>
          查驗結果：<strong>{name(me.checked)}</strong> 是{' '}
          <span className={`chip ${wolf ? 'ww-wolf' : 'ww-good'}`}>{wolf ? '狼人' : '好人'}</span>
        </p>
        {suspectHint}
      </div>
    )
  }
  return (
    <div className="ww-actions">
      <p>{me.role === 'witch' ? '狼人決定好就輪到你用藥。' : '天黑請閉眼，你今晚沒有行動。'}</p>
      {suspectHint}
    </div>
  )
}

function WitchPanel({
  party,
  view,
  name,
  poisonMode,
  setPoisonMode,
}: {
  party: WwParty
  view: WwView
  name: NameOf
  poisonMode: boolean
  setPoisonMode: (on: boolean) => void
}) {
  const me = view.me!
  const act = party.act
  if (!me.alive) return <p className="ww-actions ww-hint">你已出局，等天亮。</p>
  if (me.role === 'wolf' && me.decided) {
    const target = me.decided.target
    return (
      <p className="ww-actions ww-hint">今晚{target === null ? '空刀' : `對 ${name(target)} 下手`}，等女巫行動…</p>
    )
  }
  const w = me.witch
  if (me.role !== 'witch' || !w) {
    return <p className="ww-actions ww-hint">女巫行動中…可以繼續點玩家記下懷疑。</p>
  }
  if (w.done) return <p className="ww-actions ww-hint">等天亮…</p>
  if (!w.antidote && !w.poison) return <p className="ww-actions ww-hint">你的藥都用完了，等天亮。</p>
  const victim = w.victimKnown ? w.victim : null
  const self = victim !== null && victim === view.you
  const canSave = w.antidote && victim !== null && (!self || w.canSelfSave)
  return (
    <div className="ww-actions">
      <p>
        {!w.victimKnown ? (
          '解藥用過了，看不到今晚誰被狼人選中。'
        ) : victim === null ? (
          '今晚狼人沒有下手。'
        ) : (
          <>
            今晚 <strong>{name(victim)}</strong>
            {self ? '（你自己）' : ''} 被狼人選中。
          </>
        )}
      </p>
      {w.antidote && self && !w.canSelfSave && <p className="muted">這局的規則不能救自己。</p>}
      {poisonMode ? (
        <>
          <p className="ww-warn">點一位玩家下毒（毒藥只有一瓶）。</p>
          <div className="ww-buttons">
            <button type="button" className="secondary" onClick={() => setPoisonMode(false)}>
              取消
            </button>
          </div>
        </>
      ) : (
        <div className="ww-buttons">
          {w.antidote && (
            <button type="button" onClick={() => act({ type: 'save' })} disabled={!canSave}>
              {victim !== null ? `用解藥救 ${name(victim)}` : '用解藥'}
            </button>
          )}
          {w.poison && (
            <button type="button" className="danger" onClick={() => setPoisonMode(true)}>
              用毒藥…
            </button>
          )}
          <button type="button" className="secondary" onClick={() => act({ type: 'pass' })}>
            今晚不用藥
          </button>
        </div>
      )}
      <p className="muted">同一晚只能用一瓶藥。</p>
    </div>
  )
}

function Seats({ party, view, name, pick }: { party: WwParty; view: WwView; name: NameOf; pick: SeatPick | null }) {
  const you = view.you
  const me = view.me
  const checks = new Map((me?.checks ?? []).map((c) => [c.seat, c.wolf]))
  const wolfVotes = new Map<number, number>()
  for (const k of me?.kills ?? []) {
    if (k.voted && k.target !== null) wolfVotes.set(k.target, (wolfVotes.get(k.target) ?? 0) + 1)
  }
  const tied = view.stage === 'vote' && view.vote?.revote ? view.vote.candidates : []
  const night = view.stage === 'night' || view.stage === 'witch'

  return (
    <ul className="ww-seats" aria-label="玩家">
      {view.seats.map((s, i) => {
        const player = party.playerAt(i)
        const clickable = pick?.can(i) ?? false
        const chosen = pick !== null && pick.chosen === i
        const chips: ReactNode[] = []
        if (i === you) chips.push(<span key="me" className="chip subtle">你</span>)
        if (s.role && (i !== you || view.stage === 'end')) {
          chips.push(
            <span key="role" className={`chip ${s.role === 'wolf' ? 'ww-wolf' : 'ww-good'}`}>
              {ROLE_ICONS[s.role]} {ROLE_NAMES[s.role]}
            </span>,
          )
        }
        if (!s.alive) chips.push(<span key="dead" className="chip subtle">出局</span>)
        if (view.speaker === i) chips.push(<span key="speak" className="chip">遺言中</span>)
        if (view.stage === 'skill' && view.skillWait.includes(i)) {
          chips.push(<span key="skill" className="chip subtle">確認中</span>)
        }
        if (tied.includes(i)) chips.push(<span key="tie" className="chip">平票</span>)
        const votes = wolfVotes.get(i)
        if (votes) chips.push(<span key="wolves" className="chip ww-wolf">🐺 ×{votes}</span>)
        const check = checks.get(i)
        if (check !== undefined) {
          chips.push(
            <span key="check" className={`chip ${check ? 'ww-wolf' : 'ww-good'}`}>
              🔮 {check ? '狼人' : '好人'}
            </span>,
          )
        }
        if (night && me?.suspect === i) chips.push(<span key="suspect" className="chip subtle">❓ 懷疑</span>)
        if (player?.bot) chips.push(<span key="bot" className="chip subtle">電腦</span>)
        if (!s.online) chips.push(<span key="off" className="chip subtle">離線</span>)
        const readyStage = view.stage === 'peek' || (view.stage === 'discuss' && !view.options.offline)
        if (readyStage && s.alive && s.ready) chips.push(<span key="ready" className="chip subtle">✓ 好了</span>)
        if (s.voted) chips.push(<span key="voted" className="chip subtle">✓ 已投</span>)

        const body = (
          <>
            <span className="ww-seat-top">
              <span className="ww-seat-no">{i + 1}號</span>
              <span className="ww-seat-name">{name(i)}</span>
            </span>
            {chips.length > 0 && <span className="ww-seat-chips">{chips}</span>}
            {(clickable || chosen) && pick && <span className="ww-seat-cta">{chosen ? `✓ ${pick.cta}` : pick.cta}</span>}
            {s.points > 0 && <span className="ww-seat-points">{s.points} 分</span>}
          </>
        )
        const cls = ['ww-seat', s.alive ? '' : 'dead', chosen ? 'chosen' : '', i === you ? 'me' : '']
          .filter(Boolean)
          .join(' ')
        return (
          <li key={i} className={cls}>
            {clickable && pick ? (
              <button type="button" className="ww-seat-body" onClick={() => pick.act(i)} aria-pressed={chosen}>
                {body}
              </button>
            ) : (
              <div className="ww-seat-body">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** 只有自己看得到的紀錄：查驗、用藥、守護 */
function Notes({ view, name }: { view: WwView; name: NameOf }) {
  const me = view.me!
  const lines: ReactNode[] = []
  for (const c of me.checks ?? []) {
    lines.push(
      <li key={`c${c.night}`}>
        🔮 第 {c.night} 晚查驗 {name(c.seat)}：
        <span className={`chip ${c.wolf ? 'ww-wolf' : 'ww-good'}`}>{c.wolf ? '狼人' : '好人'}</span>
      </li>,
    )
  }
  for (const h of me.witch?.history ?? []) {
    if (h.saved !== null) lines.push(<li key={`s${h.night}`}>🧪 第 {h.night} 晚用解藥救了 {name(h.saved)}</li>)
    if (h.poisoned !== null) lines.push(<li key={`p${h.night}`}>☠️ 第 {h.night} 晚毒了 {name(h.poisoned)}</li>)
  }
  if (me.witch) {
    lines.push(
      <li key="left" className="muted">
        解藥{me.witch.antidote ? '還在' : '用掉了'}、毒藥{me.witch.poison ? '還在' : '用掉了'}
      </li>,
    )
  }
  for (const g of me.guard?.history ?? []) {
    lines.push(
      <li key={`g${g.night}`}>
        🛡️ 第 {g.night} 晚{g.seat === null ? '空守' : `守護 ${name(g.seat)}`}
      </li>,
    )
  }
  if (lines.length === 0) return null
  return (
    <section className="ww-log">
      <h3>你的紀錄（只有你看得到）</h3>
      <ul className="ww-notes">{lines}</ul>
    </section>
  )
}

function TallyLine({ tally, name }: { tally: Tally; name: NameOf }) {
  const byTarget = new Map<number, number[]>()
  const abstain: number[] = []
  for (const v of tally.voters) {
    const t = tally.ballots[v]
    if (t === null) abstain.push(v)
    else byTarget.set(t, [...(byTarget.get(t) ?? []), v])
  }
  const sorted = [...byTarget.entries()].sort((a, b) => b[1].length - a[1].length)
  return (
    <>
      <span>
        🗳️ {tally.revote ? '平票重投' : '投票'}：
        {tally.out !== null ? <strong>{name(tally.out)} 被放逐</strong> : '沒有人被放逐'}
      </span>
      <span className="ww-ballots">
        {sorted.map(([t, voters]) => (
          <span key={t}>
            {name(t)} {voters.length} 票（{voters.map(name).join('、')}）
          </span>
        ))}
        {abstain.length > 0 && <span className="muted">棄票：{abstain.map(name).join('、')}</span>}
      </span>
    </>
  )
}

/** 公開的紀錄：每晚誰出局、獵人開槍、投票，最新的一天在上面 */
function Timeline({ view, name }: { view: WwView; name: NameOf }) {
  const days: ReactNode[] = []
  const nightOver = (d: number) => d < view.day || (view.stage !== 'night' && view.stage !== 'witch')
  const diedAt = (seat: number) => view.deaths.find((x) => x.seat === seat)
  for (let d = view.day; d >= 1; d--) {
    const items: ReactNode[] = []
    if (nightOver(d)) {
      const dead = view.deaths.filter((x) => x.day === d && x.when === 'night').map((x) => x.seat)
      items.push(<li key="night">🌙 第 {d} 晚：{dead.length > 0 ? `${dead.map(name).join('、')} 出局` : '平安夜'}</li>)
    }
    const shots = view.shots.filter((s) => s.day === d)
    const shotLine = (s: (typeof shots)[number]) => (
      <li key={`shot${s.hunter}`}>
        🏹 {name(s.hunter)} 開槍帶走了 {name(s.target)}
      </li>
    )
    for (const s of shots) if (diedAt(s.hunter)?.when !== 'exile') items.push(shotLine(s))
    view.tallies
      .filter((t) => t.day === d)
      .forEach((t, k) =>
        items.push(
          <li key={`vote${k}`} className="ww-tally">
            <TallyLine tally={t} name={name} />
          </li>,
        ),
      )
    for (const s of shots) if (diedAt(s.hunter)?.when === 'exile') items.push(shotLine(s))
    if (items.length > 0) {
      days.push(
        <div key={d} className="ww-log-day">
          <h4>第 {d} 天</h4>
          <ul>{items}</ul>
        </div>,
      )
    }
  }
  if (days.length === 0) return null
  return (
    <section className="ww-log">
      <h3>公開紀錄</h3>
      {days}
    </section>
  )
}

function deathText(death: Death): string {
  switch (death.cause) {
    case 'knife':
      return `第 ${death.day} 晚被狼人淘汰`
    case 'poison':
      return `第 ${death.day} 晚被毒倒`
    case 'exile':
      return `第 ${death.day} 天被放逐`
    case 'shot':
      return `第 ${death.day} 天被獵人帶走`
    default:
      return `第 ${death.day} 天出局`
  }
}

function nightText(n: NightLog, name: NameOf): string {
  const parts: string[] = []
  if (n.guard !== null) parts.push(`守衛守 ${name(n.guard)}`)
  parts.push(n.kill === null ? '狼人空刀' : `狼人選 ${name(n.kill)}`)
  if (n.saved && n.kill !== null) parts.push(`女巫救了 ${name(n.kill)}`)
  if (n.poison !== null) parts.push(`女巫毒了 ${name(n.poison)}`)
  if (n.check) parts.push(`預言家查 ${name(n.check.seat)}（${n.check.wolf ? '狼人' : '好人'}）`)
  parts.push(n.deaths.length > 0 ? `→ ${n.deaths.map(name).join('、')} 出局` : '→ 平安夜')
  return parts.join('，')
}

function Result({ view, name }: { view: WwView; name: NameOf }) {
  const result = view.result!
  return (
    <section className={`ww-result ${result.winner}`}>
      <h3>{result.winner === 'good' ? '🌅 好人獲勝' : '🐺 狼人獲勝'}</h3>
      {result.reason && <p>{result.reason}</p>}
      <h4>身分</h4>
      <ul className="ww-roles">
        {view.seats.map((s, i) => {
          const death = view.deaths.find((d) => d.seat === i)
          return (
            <li key={i}>
              <span>
                {i + 1}號 {name(i)}
              </span>
              {s.role && (
                <span className={`chip ${s.role === 'wolf' ? 'ww-wolf' : 'ww-good'}`}>
                  {ROLE_ICONS[s.role]} {ROLE_NAMES[s.role]}
                </span>
              )}
              <span className="muted">
                {death ? deathText(death) : '存活'} · 累計 {s.points} 分
              </span>
            </li>
          )
        })}
      </ul>
      {view.nights && view.nights.length > 0 && (
        <>
          <h4>每一晚</h4>
          <ul className="ww-nights">
            {view.nights.map((n) => (
              <li key={n.night}>
                <strong>第 {n.night} 晚</strong> {nightText(n, name)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
