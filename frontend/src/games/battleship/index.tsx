import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { OnlinePanel } from '../shared/OnlinePanel'
import { load, save } from '../shared/storage'
import { GameLayout, Segmented, StatusLine, Toolbar, type Option } from '../shared/ui'
import { useRoom, type Room, type RoomEvent } from '../shared/useRoom'
import { chooseShot, type Level } from './ai'
import { Battlefield, FleetPanel } from './Battlefield'
import {
  answerShot,
  DEFAULT_OPTIONS,
  describeShot,
  other,
  randomLayout,
  reduceEvents,
  serializeLayout,
  validLayout,
  type Battle,
  type BsEvent,
  type Layout,
  type Options,
  type Side,
} from './rules'
import { commitHash, loadSecret, newSalt, saveSecret } from './secret'
import { Setup } from './Setup'
import './battleship.css'

type Mode = 'ai' | 'local' | 'online'
type Ev = RoomEvent<BsEvent>
type Tone = 'ok' | 'danger' | 'accent' | undefined

const MODES: Option<Mode>[] = [
  { value: 'ai', label: '電腦' },
  { value: 'local', label: '本地雙人' },
  { value: 'online', label: '線上' },
]
const LEVELS: Option<Level>[] = [
  { value: 'easy', label: '簡單' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困難' },
]
const FIRSTS: Option<Side>[] = [
  { value: 0, label: '我先攻' },
  { value: 1, label: '電腦先攻' },
]

/** 電腦開砲前等一下，看得到上一砲的結果 */
const COMPUTER_DELAY = 700
/** 只用來產生一開始的隨機擺法：不相鄰的擺法在兩種規則下都合法 */
const STRICT: Options = { chain: false, noTouch: true }

function loadChoice<T extends string | number>(key: string, options: Option<T>[], fallback: T): T {
  const value = load<unknown>(key, fallback)
  return options.some((o) => o.value === value) ? (value as T) : fallback
}

function loadOptions(): Options {
  const saved = load<Partial<Options>>('battleship:options', DEFAULT_OPTIONS)
  return {
    chain: typeof saved?.chain === 'boolean' ? saved.chain : DEFAULT_OPTIONS.chain,
    noTouch: typeof saved?.noTouch === 'boolean' ? saved.noTouch : DEFAULT_OPTIONS.noTouch,
  }
}

function RulesNote({ online }: { online?: boolean }) {
  return (
    <p className="muted">
      規則：雙方各有 5 艘船（5、4、3、3、2 格），擺好後輪流朝對方海域開砲，先擊沉對方全部船隻的一方獲勝。
      打中顯示「擊中」，整艘船的每一格都被打中就「擊沉」，並公開那艘船的位置。
      {online &&
        ' 線上對戰時，你的佈局只留在這台裝置：開局只送出佈局的雜湊，每一砲由被打的一方自己回報結果；結束時雙方公開佈局，自動檢查對方每一次回報是否屬實。'}
    </p>
  )
}

function OptionsFields({
  options,
  onChange,
  disabled,
  note,
}: {
  options: Options
  onChange: (options: Options) => void
  disabled: boolean
  note?: string | null
}) {
  return (
    <fieldset className="bs-options" disabled={disabled}>
      <legend>規則</legend>
      <label className="bs-option">
        <input
          type="checkbox"
          checked={options.noTouch}
          onChange={(e) => onChange({ ...options, noTouch: e.target.checked })}
        />
        船和船不能相鄰（連斜角也不行）
      </label>
      <label className="bs-option">
        <input
          type="checkbox"
          checked={options.chain}
          onChange={(e) => onChange({ ...options, chain: e.target.checked })}
        />
        打中可以再打一次
      </label>
      {note && <p className="muted">{note}</p>}
    </fieldset>
  )
}

/** 局面結束時的一句話（電腦和本地模式） */
function overText(battle: Battle, me: Side | null, names: [string, string]): { text: string; tone: Tone } {
  const result = battle.result!
  const winner = result.winner
  if (me === null) {
    const text =
      result.reason === 'resign'
        ? `${names[other(winner)]}認輸，${names[winner]}獲勝！`
        : `${names[winner]}擊沉了對方全部的船，獲勝！`
    return { text, tone: 'ok' }
  }
  if (winner === me)
    return { text: result.reason === 'resign' ? '對手認輸，你贏了！' : '你擊沉了對方全部的船，你贏了！', tone: 'ok' }
  return { text: result.reason === 'resign' ? '你認輸了' : `你的船全被擊沉了，${names[winner]}獲勝`, tone: 'danger' }
}

/**
 * 本地模式開一砲：用最新的事件重算局面（連點兩下時第二下會看到已經換人而被忽略），
 * 再由被打的一方用自己的佈局回報。
 */
function fire(
  g: OfflineGame,
  firstOf: (round: number) => Side,
  shooter: Side,
  cell: number | ((b: Battle) => number),
): OfflineGame {
  const now = reduceEvents(g.events, firstOf)
  if (now.phase !== 'playing' || now.toMove !== shooter || now.pending) return g
  const target = other(shooter)
  const layout = g.layouts[target]
  if (!layout) return g
  const at = typeof cell === 'function' ? cell(now) : cell
  if (now.shots.some((s) => s.by === shooter && s.cell === at)) return g
  return {
    ...g,
    events: [
      ...g.events,
      { seat: shooter, data: { type: 'shot', cell: at } },
      { seat: target, data: answerShot(now, target, layout, at) },
    ],
  }
}

// ---- 電腦 ----

type OfflineGame = { events: Ev[]; layouts: [Layout | null, Layout | null]; first: Side }

function freshGame(options: Options, first: Side): OfflineGame {
  return { events: [{ seat: 0, data: { type: 'options', options } }], layouts: [null, null], first }
}

function ComputerGame({
  modeSwitch,
  options,
  setOptions,
}: {
  modeSwitch: ReactNode
  options: Options
  setOptions: (o: Options) => void
}) {
  const [level, setLevel] = useState<Level>(() => loadChoice('battleship:level', LEVELS, 'normal'))
  const [game, setGame] = useState<OfflineGame>(() =>
    freshGame(options, loadChoice<Side>('battleship:first', FIRSTS, 0)),
  )
  const [draft, setDraft] = useState<Layout>(() => randomLayout(STRICT))
  const battle = useMemo(() => reduceEvents(game.events, () => game.first), [game])
  const { phase, result } = battle
  const names: [string, string] = ['你', '電腦']

  // 電腦開砲：等一下再打；局面在這段時間內變了（重開、換難度）就作廢
  const ply = battle.shots.length
  const computerTurn = phase === 'playing' && battle.toMove === 1 && !battle.pending
  useEffect(() => {
    if (!computerTurn) return
    const timer = setTimeout(() => {
      setGame((g) => {
        if (reduceEvents(g.events, () => g.first).shots.length !== ply) return g
        return fire(
          g,
          () => g.first,
          1,
          (now) => chooseShot(level, now, 1),
        )
      })
    }, COMPUTER_DELAY)
    return () => clearTimeout(timer)
  }, [computerTurn, ply, level])

  function restart(nextOptions = options, first = game.first) {
    setGame(freshGame(nextOptions, first))
    setDraft(randomLayout(STRICT))
  }

  function start() {
    const mine = validLayout(draft, battle.options)
    if (!mine) return
    setGame((g) => ({
      ...g,
      layouts: [mine, randomLayout(battle.options)],
      events: [
        ...g.events,
        { seat: 0, data: { type: 'commit', hash: '' } },
        { seat: 1, data: { type: 'commit', hash: '' } },
      ],
    }))
  }

  function shoot(cell: number) {
    setGame((g) => fire(g, () => g.first, 0, cell))
  }

  let status: string
  let tone: Tone
  const last = describeShot(battle.shots.at(-1), { me: 0, myLayout: game.layouts[0], opponent: '電腦' })
  if (phase === 'setup') {
    status = '擺好你的船，按「開始對戰」'
  } else if (result) {
    ;({ text: status, tone } = overText(battle, 0, names))
  } else if (battle.toMove === 0) {
    status = last ? `${last}　輪到你` : '輪到你開砲，點敵方海域'
    tone = 'accent'
  } else {
    status = last ? `${last}　電腦瞄準中…` : '電腦瞄準中…'
  }

  const side = (
    <>
      {modeSwitch}
      <Segmented
        label="難度"
        value={level}
        options={LEVELS}
        onChange={(v) => {
          setLevel(v)
          save('battleship:level', v)
        }}
      />
      <Segmented
        label="先攻"
        value={game.first}
        options={FIRSTS}
        disabled={phase !== 'setup'}
        onChange={(v) => {
          save('battleship:first', v)
          setGame((g) => ({ ...g, first: v }))
        }}
      />
      <OptionsFields
        options={battle.options}
        disabled={phase !== 'setup'}
        onChange={(o) => {
          setOptions(o)
          restart(o)
        }}
      />
      {phase !== 'setup' && <FleetPanel battle={battle} me={0} names={names} />}
      <RulesNote />
    </>
  )

  return (
    <GameLayout side={side}>
      <StatusLine tone={tone}>{status}</StatusLine>
      {phase === 'setup' ? (
        <Setup layout={draft} options={battle.options} onChange={setDraft} onReady={start} readyLabel="開始對戰" />
      ) : (
        <>
          <Battlefield
            battle={battle}
            me={0}
            myLayout={game.layouts[0]}
            enemyLayout={game.layouts[1]}
            canShoot={phase === 'playing' && battle.toMove === 0 && !battle.pending}
            onShoot={shoot}
            titles={['電腦的海域', '我方海域']}
          />
          <Toolbar>
            {result ? (
              <button type="button" onClick={() => restart()}>
                再來一局
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    window.confirm('確定要認輸嗎？') &&
                    setGame((g) => ({ ...g, events: [...g.events, { seat: 0, data: { type: 'resign' } }] }))
                  }
                >
                  認輸
                </button>
                <button type="button" className="secondary" onClick={() => restart()}>
                  重新開始
                </button>
              </>
            )}
          </Toolbar>
        </>
      )}
    </GameLayout>
  )
}

// ---- 本地雙人（同一台裝置輪流看，換人時把畫面蓋起來） ----

const PLAYERS: [string, string] = ['玩家一', '玩家二']

function LocalGame({
  modeSwitch,
  options,
  setOptions,
}: {
  modeSwitch: ReactNode
  options: Options
  setOptions: (o: Options) => void
}) {
  const [game, setGame] = useState<OfflineGame>(() => freshGame(options, 0))
  const [draft, setDraft] = useState<Layout>(() => randomLayout(STRICT))
  const [viewer, setViewer] = useState<Side>(0)
  const battle = useMemo(() => reduceEvents(game.events, () => 0), [game])
  const { phase, result } = battle

  // 擺船時輪到還沒擺好的人；對戰時輪到開砲的人；畫面上的人不是他，就先蓋起來等交換
  const active: Side = phase === 'setup' ? (battle.commits[0] === null ? 0 : 1) : battle.toMove
  const covered = phase !== 'over' && viewer !== active

  function restart(nextOptions = options) {
    setGame(freshGame(nextOptions, 0))
    setDraft(randomLayout(STRICT))
    setViewer(0)
  }

  function ready() {
    const layout = validLayout(draft, battle.options)
    if (!layout) return
    setGame((g) => {
      const layouts: OfflineGame['layouts'] = [...g.layouts]
      layouts[active] = layout
      return { ...g, layouts, events: [...g.events, { seat: active, data: { type: 'commit', hash: '' } }] }
    })
    setDraft(randomLayout(STRICT))
  }

  function shoot(cell: number) {
    if (!covered) setGame((g) => fire(g, () => 0, active, cell))
  }

  let status: string
  let tone: Tone
  const last = describeShot(battle.shots.at(-1), { me: viewer, names: PLAYERS })
  if (result) ({ text: status, tone } = overText(battle, null, PLAYERS))
  else if (covered) status = `請把裝置交給${PLAYERS[active]}`
  else if (phase === 'setup') status = `${PLAYERS[active]}擺船（不要讓對方看到）`
  else {
    status = last ? `${last}　輪到${PLAYERS[active]}` : `${PLAYERS[active]}先開砲`
    tone = 'accent'
  }

  const side = (
    <>
      {modeSwitch}
      <OptionsFields
        options={battle.options}
        disabled={phase !== 'setup' || battle.commits[0] !== null}
        onChange={(o) => {
          setOptions(o)
          restart(o)
        }}
      />
      {phase !== 'setup' && !covered && (
        <FleetPanel battle={battle} me={phase === 'over' ? 0 : viewer} names={PLAYERS} />
      )}
      <RulesNote />
      <p className="muted">本地雙人：同一台裝置輪流使用，換人時畫面會先蓋起來，確認對方沒有偷看再開始。</p>
    </>
  )

  let main: ReactNode
  if (covered) {
    let note = ''
    if (phase === 'setup') note = battle.commits[0] === null ? '' : `${PLAYERS[0]}已經擺好船。`
    else if (last) note = last
    else note = '雙方都擺好船了。'
    main = (
      <div className="bs-handoff">
        <p className="bs-handoff-icon" aria-hidden="true">
          🔄
        </p>
        {note && <p>{note}</p>}
        <p>
          請把裝置交給 <strong>{PLAYERS[active]}</strong>
        </p>
        <button type="button" onClick={() => setViewer(active)}>
          我是{PLAYERS[active]}，開始
        </button>
      </div>
    )
  } else if (phase === 'setup') {
    main = (
      <Setup
        key={active}
        layout={draft}
        options={battle.options}
        onChange={setDraft}
        onReady={ready}
        readyLabel={active === 0 ? '擺好了，換玩家二' : '擺好了，開始對戰'}
      />
    )
  } else {
    const me: Side = phase === 'over' ? 0 : viewer
    main = (
      <Battlefield
        battle={battle}
        me={me}
        myLayout={game.layouts[me]}
        enemyLayout={game.layouts[other(me)]}
        canShoot={phase === 'playing' && !battle.pending}
        onShoot={shoot}
        titles={[`${PLAYERS[other(me)]}的海域`, `${PLAYERS[me]}的海域`]}
      />
    )
  }

  return (
    <GameLayout side={side}>
      <StatusLine tone={tone}>{status}</StatusLine>
      {main}
      {phase !== 'setup' && !covered && (
        <Toolbar>
          {result ? (
            <button type="button" onClick={() => restart()}>
              再來一局
            </button>
          ) : (
            <>
              <button
                type="button"
                className="danger"
                onClick={() =>
                  window.confirm(`${PLAYERS[active]}確定要認輸嗎？`) &&
                  setGame((g) => ({ ...g, events: [...g.events, { seat: active, data: { type: 'resign' } }] }))
                }
              >
                {PLAYERS[active]}認輸
              </button>
              <button type="button" className="secondary" onClick={() => restart()}>
                重新開始
              </button>
            </>
          )}
        </Toolbar>
      )}
    </GameLayout>
  )
}

// ---- 線上 ----

/**
 * 對方公開的佈局是否和開局時的雜湊一致：[seat0, seat1]，還沒公開或還在算是 null。
 * 雜湊要非同步算（hash-wasm 要先載入），所以不放在 reduceEvents 裡。
 */
function useHashChecks(battle: Battle): [boolean | null, boolean | null] {
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const items = useMemo(
    () =>
      ([0, 1] as const).map((side) => {
        const reveal = battle.reveals[side]
        const commit = battle.commits[side]
        if (!reveal || commit === null || !reveal.layout.length) return null
        return { key: `${commit}|${serializeLayout(reveal.layout)}|${reveal.salt}`, commit, reveal }
      }),
    [battle],
  )
  const started = useRef(new Set<string>())
  useEffect(() => {
    for (const item of items) {
      if (!item || started.current.has(item.key)) continue
      const { key, commit, reveal } = item
      started.current.add(key)
      void commitHash(reveal.layout, reveal.salt)
        .then((hash) => setChecked((prev) => ({ ...prev, [key]: hash === commit })))
        .catch(() => {
          // hash-wasm 載入失敗（離線）：維持「驗證中」，下次局面更新再試
          started.current.delete(key)
        })
    }
  }, [items])
  const result = (i: 0 | 1) => {
    const key = items[i]?.key
    return key ? (checked[key] ?? null) : null
  }
  return [result(0), result(1)]
}

function OnlineGame({ modeSwitch, room }: { modeSwitch: ReactNode; room: Room<BsEvent> }) {
  const battle = useMemo(() => reduceEvents(room.events), [room.events])
  const { phase, result } = battle
  const seat = room.seat
  const code = room.code
  const myCommit = seat === null ? null : battle.commits[seat]
  const secret = useMemo(
    () => (code && seat !== null && myCommit ? loadSecret(code, seat, battle.round, myCommit) : null),
    [code, seat, battle.round, myCommit],
  )
  const lost = myCommit !== null && myCommit !== undefined && !secret

  // 擺船的草稿：換房間、換座位、新的一局就重新隨機擺一次
  const draftKey = `${code}:${seat}:${battle.round}`
  const initialDraft = useMemo(() => (draftKey ? randomLayout(STRICT) : []), [draftKey])
  const [draft, setDraft] = useState<{ key: string; layout: Layout } | null>(null)
  const layout = draft?.key === draftKey ? draft.layout : initialDraft
  const [busy, setBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const hashOk = useHashChecks(battle)
  const live = room.connected && seat !== null
  const opp: Side | null = seat === null ? null : other(seat)

  // 被打的時候自動回報（只用自己的佈局算）。同一砲只送一次；斷線時清掉，重連後歷史裡沒有就再送
  const reported = useRef<string | null>(null)
  const revealed = useRef<string | null>(null)
  // 開砲後到伺服器傳回來之前不能再開（連點會多送好幾砲，雖然會被忽略，但會佔掉房間的紀錄上限）
  const fired = useRef<string | null>(null)
  useEffect(() => {
    if (!room.connected) {
      reported.current = null
      revealed.current = null
      fired.current = null
    }
  }, [room.connected])
  const pending = battle.pending
  useEffect(() => {
    if (!live || !pending || pending.by === seat || !secret || phase !== 'playing') return
    const key = `${draftKey}:${battle.shots.length}`
    if (reported.current === key) return
    reported.current = key
    room.send(answerShot(battle, seat!, secret.layout, pending.cell))
  }, [live, pending, seat, secret, phase, draftKey, battle, room])

  // 結束後自動公開自己的佈局，讓對方驗證
  useEffect(() => {
    if (!live || phase !== 'over' || !secret || battle.reveals[seat!]) return
    if (revealed.current === draftKey) return
    revealed.current = draftKey
    room.send({ type: 'reveal', layout: secret.layout, salt: secret.salt })
  }, [live, phase, secret, battle.reveals, seat, draftKey, room])

  async function ready() {
    if (!code || seat === null) return
    const valid = validLayout(layout, battle.options)
    if (!valid) return
    setBusy(true)
    setCommitError(null)
    try {
      const salt = newSalt()
      const hash = await commitHash(valid, salt)
      // 先存好再送出：送出後才存，萬一這時候關掉分頁就回不來了
      saveSecret(code, seat, battle.round, { layout: valid, salt, hash, at: Date.now() })
      room.send({ type: 'commit', hash })
    } catch {
      setCommitError('載入雜湊元件失敗，請檢查網路後再試一次')
    } finally {
      setBusy(false)
    }
  }

  function resign() {
    if (window.confirm('確定要認輸嗎？')) room.send({ type: 'resign' })
  }

  const cheatOf = (side: Side) =>
    battle.cheat[side] ?? (hashOk[side] === false ? '公開的佈局和開局時送出的雜湊不符' : null)

  let status: string
  let tone: Tone
  let verify: string | null = null
  const last = seat === null ? null : describeShot(battle.shots.at(-1), { me: seat, myLayout: secret?.layout })
  if (!code) status = '建立或加入房間開始對戰'
  else if (room.error) {
    status = room.error
    tone = 'danger'
  } else if (!room.connected || seat === null || opp === null) status = '連線中…'
  else if (result) {
    const oppCheat = cheatOf(opp)
    const myCheat = cheatOf(seat)
    if (oppCheat) {
      status = `對方回報不實，判你獲勝`
      verify = `⚠️ ${oppCheat}`
      tone = 'ok'
    } else if (myCheat) {
      status = '你的回報和佈局對不上，判你落敗'
      verify = `⚠️ ${myCheat}（這台裝置存的佈局可能有問題）`
      tone = 'danger'
    } else {
      ;({ text: status, tone } = overText(battle, seat, seat === 0 ? ['你', '對手'] : ['對手', '你']))
      if (battle.commits[opp] !== null) {
        // 自己贏了就不必等對方公開（對方說謊也只是害自己輸）；輸了才需要確認對方沒有亂報
        if (!battle.reveals[opp]) verify = result.winner === opp ? '等待對手公開佈局來驗證這局…' : null
        else if (hashOk[opp] === true) verify = '✓ 已驗證：對手的佈局和開局時的雜湊一致，每一次回報都屬實'
        else verify = '驗證中…'
      }
    }
  } else if (lost) {
    status = '這台裝置找不到你這局的佈局（可能清除了瀏覽器資料或換了裝置），無法回應對手的砲擊，只能認輸'
    tone = 'danger'
  } else if (phase === 'setup') {
    if (myCommit) status = battle.commits[opp] ? '雙方都準備好了' : '等待對手擺好船…'
    else status = room.peerOnline ? '擺好你的船，按「準備好了」' : '擺好你的船，按「準備好了」（對手還沒加入）'
    if (battle.commits[opp] && !myCommit) status = '對手已經擺好船了，' + status
  } else if (pending && pending.by === seat) {
    status = room.peerOnline ? '開砲！等待對手回報…' : '等待對手回報（對手離線，重新連線後會繼續）'
  } else if (pending) {
    status = '對手開砲中…'
  } else if (battle.toMove === seat) {
    status = last ? `${last}　輪到你` : '你先開砲，點敵方海域'
    tone = 'accent'
  } else {
    status = last ? `${last}　等待對手開砲…` : '對手先開砲，等待中…'
  }
  if (commitError) {
    status = commitError
    tone = 'danger'
  }

  const first = battle.first
  const seatNames: [string, string] = first === 0 ? ['先攻', '後攻'] : ['後攻', '先攻']
  const canShoot = live && room.peerOnline && phase === 'playing' && battle.toMove === seat && !pending && !lost

  const side = (
    <>
      {modeSwitch}
      <OnlinePanel room={room} seatNames={seatNames} />
      {code && seat !== null && (
        <OptionsFields
          options={battle.options}
          disabled={phase !== 'setup' || battle.commits[0] !== null || battle.commits[1] !== null || !live}
          note={
            phase === 'setup' && (battle.commits[0] !== null || battle.commits[1] !== null)
              ? '已經有人擺好船，這局的規則不能再改。'
              : phase === 'setup'
                ? '雙方都可以調整，任一方按下「準備好了」後就固定。'
                : null
          }
          onChange={(options) => room.send({ type: 'options', options })}
        />
      )}
      {phase !== 'setup' && seat !== null && (
        <FleetPanel battle={battle} me={seat} names={seat === 0 ? ['你', '對手'] : ['對手', '你']} />
      )}
      <RulesNote online />
    </>
  )

  let main: ReactNode = null
  if (code && seat !== null && opp !== null) {
    if (phase === 'setup' && !myCommit) {
      main = (
        <Setup
          key={draftKey}
          layout={layout}
          options={battle.options}
          onChange={(next) => setDraft({ key: draftKey, layout: next })}
          onReady={ready}
          readyLabel="準備好了"
          busy={busy || !live}
        />
      )
    } else if (phase === 'setup') {
      main = (
        <div className="bs-handoff">
          <p className="bs-handoff-icon" aria-hidden="true">
            ⚓
          </p>
          <p>你的船已經就位，佈局只存在這台裝置。</p>
          <p className="muted">對手擺好後就會開始，{first === seat ? '你先攻' : '對手先攻'}。</p>
        </div>
      )
    } else {
      const reveal = battle.reveals[opp]
      main = (
        <Battlefield
          battle={battle}
          me={seat}
          myLayout={secret?.layout ?? null}
          enemyLayout={reveal?.layout.length ? reveal.layout : null}
          canShoot={canShoot}
          onShoot={(cell) => {
            const key = `${draftKey}:${battle.shots.length}`
            if (fired.current === key) return
            fired.current = key
            room.send({ type: 'shot', cell })
          }}
        />
      )
    }
  }

  return (
    <GameLayout side={side}>
      <StatusLine tone={tone}>{status}</StatusLine>
      {verify && (
        <p className={`bs-verify${verify.startsWith('⚠️') ? ' bad' : verify.startsWith('✓') ? ' good' : ''}`}>
          {verify}
        </p>
      )}
      {main}
      {code && seat !== null && (
        <Toolbar>
          {result ? (
            <button type="button" onClick={() => room.send({ type: 'restart' })} disabled={!room.connected}>
              再來一局
            </button>
          ) : (
            // 擺船時還沒開打，不需要認輸；只有找不到佈局時要靠認輸結束這局
            (phase === 'playing' || lost) && (
              <button type="button" className="danger" onClick={resign} disabled={!room.connected}>
                認輸
              </button>
            )
          )}
        </Toolbar>
      )}
    </GameLayout>
  )
}

export default function Battleship() {
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(location.search).has('room') ? 'online' : loadChoice('battleship:mode', MODES, 'ai'),
  )
  const [options, setOptionsState] = useState<Options>(loadOptions)
  const room = useRoom<BsEvent>('battleship', mode === 'online')

  function setOptions(next: Options) {
    setOptionsState(next)
    save('battleship:options', next)
  }

  function changeMode(next: Mode) {
    if (next === mode) return
    if (mode === 'online') room.leave()
    setMode(next)
    save('battleship:mode', next)
  }

  const modeSwitch = <Segmented label="模式" value={mode} options={MODES} onChange={changeMode} />
  if (mode === 'ai') return <ComputerGame modeSwitch={modeSwitch} options={options} setOptions={setOptions} />
  if (mode === 'local') return <LocalGame modeSwitch={modeSwitch} options={options} setOptions={setOptions} />
  return <OnlineGame modeSwitch={modeSwitch} room={room} />
}
