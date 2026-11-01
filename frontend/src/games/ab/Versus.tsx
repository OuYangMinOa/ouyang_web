import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { OnlinePanel } from '../shared/OnlinePanel'
import { load, save } from '../shared/storage'
import { GameLayout, Segmented, StatusLine, Toolbar, type Option } from '../shared/ui'
import { useRoom, type RoomEvent, type Seat } from '../shared/useRoom'
import { AnalysisView } from './AnalysisView'
import { CodePad, type Mark } from './CodePad'
import { randomCode, score, summarize, type Level, type StepAnalysis } from './logic'
import { loadSecret, storeSecret } from './secrets'
import { useAbWorker } from './useAbWorker'
import {
  canGuess,
  cluesOf,
  commitInput,
  finalResult,
  isBad,
  isWin,
  loadSha256,
  other,
  pendingAnswer,
  randomSalt,
  reduceVersus,
  turnOf,
  verifySide,
  type AbEvent,
  type Check,
  type Guess,
  type VersusState,
} from './versusRules'

type Opponent = 'cpu' | 'online'
type Tone = 'ok' | 'danger' | 'accent' | undefined

const OPPONENTS: Option<Opponent>[] = [
  { value: 'cpu', label: '電腦' },
  { value: 'online', label: '線上' },
]
const LEVELS: Option<Level>[] = [
  { value: 'easy', label: '簡單' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困難' },
]
const LEVEL_HELP: Record<Level, string> = {
  easy: '電腦每次隨便猜一個跟提示對得上的數字。',
  normal: '電腦大多走最佳步，偶爾失手。',
  hard: '電腦每一步都挑「猜完後平均剩最少可能」的組合，平均 5 次多就猜中。',
}
/** 電腦至少想這麼久再出手，看起來才像在思考 */
const THINK_MS = 700
const ME: Seat = 0
const CPU: Seat = 1
const NO_MARKS: Mark[] = []

/** 讀偏好；存的值不在選項裡（舊版本或被竄改）就用預設 */
function loadChoice<T extends string>(key: string, options: Option<T>[], fallback: T): T {
  const value = load<unknown>(key, fallback)
  return options.some((o) => o.value === value) ? (value as T) : fallback
}

/** 對戰模式：雙方各藏一組數字，輪流猜對方的。對手可以是電腦或線上的真人 */
export function Versus({ modeSwitch }: { modeSwitch: ReactNode }) {
  const [params, setParams] = useSearchParams()
  const [picked, setPicked] = useState<Opponent>(() => loadChoice('ab:opponent', OPPONENTS, 'cpu'))
  // 網址上有 ?room=（例如點了邀請連結）就一定是線上
  const opponent: Opponent = params.has('room') ? 'online' : picked

  function change(next: Opponent) {
    if (next === opponent) return
    if (opponent === 'online') {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          p.delete('room')
          return p
        },
        { replace: true },
      )
    }
    setPicked(next)
    save('ab:opponent', next)
  }

  const opponentSwitch = <Segmented label="對手" value={opponent} options={OPPONENTS} onChange={change} />
  return opponent === 'cpu' ? (
    <CpuVersus modeSwitch={modeSwitch} opponentSwitch={opponentSwitch} />
  ) : (
    <OnlineVersus modeSwitch={modeSwitch} opponentSwitch={opponentSwitch} />
  )
}

/** 規則說明，放在側邊欄 */
function Rules() {
  return (
    <div className="muted ab-vs-rules">
      <p>規則：雙方各藏一組四位不重複的數字，輪流猜對方的，先猜中（4A0B）的人獲勝。</p>
      <p>先手猜中後，後手還有同一回合的最後一次機會，也猜中就平手。每局輪流當先手。</p>
    </div>
  )
}

// ---- 對電腦 ----

function CpuVersus({ modeSwitch, opponentSwitch }: { modeSwitch: ReactNode; opponentSwitch: ReactNode }) {
  const [level, setLevel] = useState<Level>(() => loadChoice('ab:level', LEVELS, 'normal'))
  // 事件格式和線上一樣，用同一個 reduceVersus；seat 0 是玩家、1 是電腦
  const [events, setEvents] = useState<RoomEvent<AbEvent>[]>([])
  const [secrets, setSecrets] = useState(() => ({ round: 0, mine: null as string | null, cpu: randomCode() }))
  const state = useMemo(() => reduceVersus(events), [events])
  const request = useAbWorker()

  const mySecret = secrets.round === state.round ? secrets.mine : null
  const cpuTurn = canGuess(state, CPU) && mySecret !== null
  const cpuClues = useMemo(() => cluesOf(state, CPU), [state])
  const round = state.round

  // 電腦出手：猜測和玩家的回報一起放進去（玩家的數字就在這台電腦上，直接幫他算）
  useEffect(() => {
    if (!cpuTurn || !mySecret) return
    let cancelled = false
    const begin = performance.now()
    request({ type: 'next', clues: cpuClues, level }).then((res) => {
      const code = res.guess
      if (!code) return
      setTimeout(
        () => {
          if (cancelled) return
          const { a, b } = score(code, mySecret)
          setEvents((prev) => [
            ...prev,
            { seat: CPU, data: { type: 'guess', round, code } },
            { seat: ME, data: { type: 'answer', round, n: cpuClues.length, a, b } },
          ])
        },
        Math.max(0, THINK_MS - (performance.now() - begin)),
      )
    })
    return () => {
      cancelled = true
    }
  }, [cpuTurn, cpuClues, mySecret, level, round, request])

  function reset() {
    setEvents([])
    setSecrets({ round: 0, mine: null, cpu: randomCode() })
  }

  const match: Match = {
    state,
    me: ME,
    opponent: '電腦',
    mySecret,
    opponentSecret: state.result ? secrets.cpu : null,
    live: true,
    notice: null,
    thinking: cpuTurn,
    secretLost: false,
    busy: false,
    checks: null,
    hide(secret) {
      setSecrets((s) => ({ ...s, round, mine: secret }))
      setEvents((prev) => [
        ...prev,
        { seat: ME, data: { type: 'commit', round, hash: '' } },
        { seat: CPU, data: { type: 'commit', round, hash: '' } },
      ])
    },
    guess(code) {
      const { a, b } = score(code, secrets.cpu)
      const n = state.sides[ME].guesses.length
      setEvents((prev) => [
        ...prev,
        { seat: ME, data: { type: 'guess', round, code } },
        { seat: CPU, data: { type: 'answer', round, n, a, b } },
      ])
    },
    resign() {
      if (window.confirm('確定要認輸嗎？')) setEvents((prev) => [...prev, { seat: ME, data: { type: 'resign', round } }])
    },
    restart() {
      setEvents((prev) => [...prev, { seat: ME, data: { type: 'restart', round } }])
      setSecrets({ round: round + 1, mine: null, cpu: randomCode() })
    },
  }

  const side = (
    <>
      {opponentSwitch}
      <Segmented
        label="難度"
        value={level}
        options={LEVELS}
        onChange={(v) => {
          setLevel(v)
          save('ab:level', v)
          reset()
        }}
      />
      <p className="muted">{LEVEL_HELP[level]}換難度會重新開始。</p>
      <Rules />
    </>
  )

  return <VersusView match={match} modeSwitch={modeSwitch} side={side} />
}

// ---- 線上 ----

/** SHA-256 載入好之前是 null（驗證先顯示「檢查中」） */
function useSha256(): ((s: string) => string) | null {
  const [sha, setSha] = useState<{ fn: (s: string) => string } | null>(null)
  useEffect(() => {
    let cancelled = false
    loadSha256().then(
      (fn) => {
        if (!cancelled) setSha({ fn })
      },
      () => {
        // 載入失敗：驗證一直顯示「檢查中」，藏數字時會再試一次並顯示錯誤
      },
    )
    return () => {
      cancelled = true
    }
  }, [])
  return sha?.fn ?? null
}

function OnlineVersus({ modeSwitch, opponentSwitch }: { modeSwitch: ReactNode; opponentSwitch: ReactNode }) {
  const room = useRoom<AbEvent>('ab')
  const { send, connected, code } = room
  const state = useMemo(() => reduceVersus(room.events), [room.events])
  const sha256 = useSha256()
  const [busy, setBusy] = useState(false)
  const [hashError, setHashError] = useState<string | null>(null)

  const me = room.seat
  const round = state.round
  const myCommit = me === null ? null : state.sides[me].commit
  // 自己的 commit 從伺服器回來之後才找得到（存的時候連 commit 一起存）
  const stored = useMemo(
    () => (me === null || !code ? null : loadSecret(code, me, round, myCommit)),
    [code, me, round, myCommit],
  )

  // 對手猜了就自動回報：A／B 由這台瀏覽器用自己的數字算，數字本身不送出去
  const pending = me === null ? null : pendingAnswer(state, me)
  const pendingN = pending?.n ?? -1
  const pendingCode = pending?.code ?? null
  useEffect(() => {
    if (!stored || !connected || pendingCode === null) return
    const { a, b } = score(pendingCode, stored.secret)
    send({ type: 'answer', round, n: pendingN, a, b })
  }, [stored, connected, pendingN, pendingCode, round, send])

  // 分出勝負後公開自己的數字和 salt，讓對方驗證
  const mustReveal = !!state.result && me !== null && myCommit !== null && !state.sides[me].reveal
  useEffect(() => {
    if (!mustReveal || !stored || !connected) return
    send({ type: 'reveal', round, secret: stored.secret, salt: stored.salt })
  }, [mustReveal, stored, connected, round, send])

  const hide = useCallback(
    async (secret: string) => {
      if (me === null || !code) return
      setBusy(true)
      setHashError(null)
      try {
        const sha = await loadSha256()
        const salt = randomSalt()
        const commit = sha(commitInput(secret, salt))
        // 先存再送：送出後馬上斷線重連，也找得回這一局的數字
        storeSecret(code, me, round, { secret, salt, commit })
        send({ type: 'commit', round, hash: commit })
      } catch {
        setHashError('載入加密工具失敗，請檢查網路後再試一次')
      } finally {
        setBusy(false)
      }
    },
    [me, code, round, send],
  )

  const first = state.first
  const seatNames: [string, string] = first === 0 ? ['先手', '後手'] : ['後手', '先手']
  const side = (
    <>
      {opponentSwitch}
      <OnlinePanel room={room} seatNames={seatNames} />
      <p className="muted">
        你藏的數字只存在這台裝置，不會送到伺服器；對局結束後雙方公開數字，網頁會自動檢查對手的每一次回報。
      </p>
      <Rules />
    </>
  )

  if (me === null) {
    let text = '建立或加入房間開始對戰'
    let tone: Tone
    if (room.error) {
      text = room.error
      tone = 'danger'
    } else if (code) text = '連線中…'
    return (
      <GameLayout side={side}>
        {modeSwitch}
        <StatusLine tone={tone}>{text}</StatusLine>
        <div className="card ab-intro">
          <p>建立房間後把邀請連結傳給朋友，雙方各藏一組數字，輪流猜對方的。</p>
          <p className="muted">不用登入也能玩；登入後換分頁或裝置也回得到同一局。</p>
        </div>
      </GameLayout>
    )
  }

  let notice: Match['notice'] = null
  if (room.error) notice = { text: room.error, tone: 'danger' }
  else if (!connected) notice = { text: '連線中…' }
  else if (!room.peerOnline) {
    const seen = room.events.some((e) => e.seat !== me)
    // 對手還沒來也可以先藏好數字
    const hint = myCommit === null && !state.result ? '先藏好你的數字吧' : ''
    notice = { text: (seen ? '對手離線，等待重新連線…' : '等待對手加入…') + hint }
  }
  if (hashError && !notice) notice = { text: hashError, tone: 'danger' }

  const them = other(me)
  const match: Match = {
    state,
    me,
    opponent: '對手',
    mySecret: stored?.secret ?? null,
    opponentSecret: state.result ? (state.sides[them].reveal?.secret ?? null) : null,
    live: connected && room.peerOnline,
    notice,
    thinking: false,
    secretLost: myCommit !== null && !stored,
    busy: busy || !connected,
    checks: state.result ? [verifySide(state, 0, sha256), verifySide(state, 1, sha256)] : null,
    hide: (secret) => void hide(secret),
    guess: (guess) => send({ type: 'guess', round, code: guess }),
    resign() {
      if (window.confirm('確定要認輸嗎？')) send({ type: 'resign', round })
    },
    restart: () => send({ type: 'restart', round }),
  }

  return <VersusView match={match} modeSwitch={modeSwitch} side={side} />
}

// ---- 共用畫面 ----

type Match = {
  state: VersusState
  me: Seat
  /** 「電腦」或「對手」 */
  opponent: string
  mySecret: string | null
  /** 對局結束後才知道 */
  opponentSecret: string | null
  /** 能不能猜（線上要連著而且對手在線） */
  live: boolean
  /** 連線狀態，優先顯示在狀態列 */
  notice: { text: string; tone?: Tone } | null
  thinking: boolean
  /** 藏過數字，但這台裝置找不到（在別的裝置藏的、或清掉了瀏覽器資料） */
  secretLost: boolean
  /** 藏數字的請求還在處理，或還沒連上 */
  busy: boolean
  /** 線上對局結束後的驗證結果（依座位）；對電腦是 null */
  checks: [Check, Check] | null
  hide: (secret: string) => void
  guess: (code: string) => void
  resign: () => void
  restart: () => void
}

function VersusView({ match, modeSwitch, side }: { match: Match; modeSwitch: ReactNode; side: ReactNode }) {
  const { state, me, opponent: opp } = match
  const them = other(me)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<{ round: number; marks: Mark[] }>({ round: -1, marks: NO_MARKS })
  const [masked, setMasked] = useState(false)
  const marks = notes.round === state.round ? notes.marks : NO_MARKS

  const result = state.result
  const final = result ? finalResult(result, match.checks ?? ['ok', 'ok']) : null
  const phase = result ? 'ended' : state.started ? 'playing' : state.sides[me].commit === null ? 'setup' : 'waiting'
  const turn = turnOf(state)
  const mine = state.sides[me].guesses
  const theirs = state.sides[them].guesses
  const myTurn = phase === 'playing' && match.live && canGuess(state, me)
  const cheated = match.checks ? isBad(match.checks[them]) : false
  const steps = useVersusAnalysis(state, me, phase === 'ended' && !cheated)

  function changeInput(value: string) {
    setInput(value)
    setError(null)
  }

  function submit() {
    if (phase === 'setup') {
      match.hide(input)
    } else {
      if (mine.some((g) => g.code === input)) {
        setError(`${input} 已經猜過了`)
        return
      }
      match.guess(input)
    }
    setInput('')
    setError(null)
  }

  function restart() {
    setInput('')
    setError(null)
    match.restart()
  }

  function cycleMark(d: number) {
    const round = state.round
    // 用前一個值算，連點很快時才不會蓋掉剛標的
    setNotes((prev) => {
      const next = (prev.round === round ? prev.marks : NO_MARKS).slice()
      next[d] = next[d] === undefined ? 'out' : next[d] === 'out' ? 'in' : undefined
      return { round, marks: next }
    })
  }

  // ---- 狀態列 ----
  let status: string
  let tone: Tone
  if (match.notice && (!final || match.notice.tone === 'danger')) {
    status = match.notice.text
    tone = match.notice.tone
  } else if (final) {
    const { winner, reason, turns, cheater } = final
    if (cheater === 'both') status = '雙方的回報都和公開的數字對不上，算平手'
    else if (winner === null) status = `平手！雙方都在第 ${turns} 次猜中`
    else if (winner === me) {
      if (cheater === them) status = `${opp}的回報和公開的數字對不上，判你獲勝`
      else if (reason === 'resign') status = `${opp}認輸，你贏了！`
      else status = `你贏了！第 ${turns} 次猜中`
    } else if (cheater === me) status = '你的回報和公開的數字對不上，判你輸'
    else if (reason === 'resign') status = '你認輸了'
    else status = `${opp}在第 ${turns} 次猜中，你輸了`
    tone = winner === null ? undefined : winner === me ? 'ok' : 'danger'
  } else if (error) {
    status = error
    tone = 'danger'
  } else if (phase === 'setup') {
    status = `藏一組四位不重複的數字讓${opp}猜`
  } else if (phase === 'waiting') {
    status = `等待${opp}藏好數字…`
  } else if (mine.some(isWin)) {
    status = `你猜中了！等${opp}的最後一次機會…`
    tone = 'ok'
  } else if (turn === me) {
    if (!canGuess(state, me)) status = `等待${opp}回報…`
    else if (theirs.some(isWin)) {
      status = `${opp}猜中你的數字了！這是你最後一次機會`
      tone = 'danger'
    } else {
      status = `輪到你猜（第 ${mine.length + 1} 次）`
      tone = 'accent'
    }
  } else if (match.thinking) {
    status = '電腦思考中…'
    tone = 'accent'
  } else {
    status = `等待${opp}猜…`
  }

  const secretChip = match.mySecret && (
    <div className="ab-secret">
      <span className="muted">你藏的數字</span>
      <strong className="ab-code">{masked ? '••••' : match.mySecret}</strong>
      <button type="button" className="secondary" onClick={() => setMasked(!masked)} aria-pressed={masked}>
        {masked ? '顯示' : '遮住'}
      </button>
    </div>
  )

  return (
    <GameLayout side={side}>
      {modeSwitch}
      <StatusLine tone={tone}>{status}</StatusLine>

      {phase === 'setup' && (
        <>
          <CodePad
            label="要藏的數字"
            value={input}
            onChange={changeInput}
            onSubmit={submit}
            submitLabel="藏好了"
            disabled={match.busy}
          />
          <Toolbar>
            <button type="button" className="secondary" disabled={match.busy} onClick={() => changeInput(randomCode())}>
              隨機產生
            </button>
          </Toolbar>
        </>
      )}

      {phase === 'waiting' && secretChip}

      {phase === 'playing' && (
        <>
          {secretChip}
          {match.secretLost && (
            <p className="error">
              這台裝置找不到你這局藏的數字（可能是在其他裝置或分頁藏的），沒辦法自動回報對手的猜測。
              回到原本的裝置繼續，或認輸後開始下一局。
            </p>
          )}
          <CodePad
            label="你的猜測"
            value={input}
            onChange={changeInput}
            onSubmit={submit}
            submitLabel="猜"
            disabled={!myTurn}
            marks={marks}
          />
          <DigitNotes marks={marks} onCycle={cycleMark} onClear={() => setNotes({ round: state.round, marks: NO_MARKS })} />
        </>
      )}

      {phase === 'ended' && (
        <div className="card ab-vs-reveal">
          <div>
            <span className="muted">你的數字</span>
            <strong className="ab-code">{match.mySecret ?? '—'}</strong>
          </div>
          <div>
            <span className="muted">{opp}的數字</span>
            <strong className="ab-code">{match.opponentSecret ?? '？'}</strong>
          </div>
          {match.checks && <VerifyLine check={match.checks[them]} />}
        </div>
      )}

      <Toolbar>
        {phase === 'ended' ? (
          <button type="button" onClick={restart} disabled={match.busy}>
            再來一局
          </button>
        ) : (
          (phase === 'playing' || match.secretLost) && (
            <button type="button" className="danger" onClick={match.resign} disabled={match.busy}>
              認輸
            </button>
          )
        )}
      </Toolbar>

      {(phase === 'playing' || phase === 'ended') && (
        <div className="ab-vs-logs">
          <GuessLog
            title={`你猜${opp}`}
            guesses={mine}
            first={state.first === me}
            active={phase === 'playing' && turn === me}
          />
          <GuessLog
            title={`${opp}猜你`}
            guesses={theirs}
            first={state.first === them}
            active={phase === 'playing' && turn === them}
          />
        </div>
      )}

      {phase === 'ended' && mine.some((g) => g.a !== null) && !cheated && (
        <details className="ab-vs-analysis">
          <summary>賽後分析：你的每一步</summary>
          {steps ? (
            <AnalysisView steps={steps} summary={summarize(steps, mine.some(isWin), false, true)} />
          ) : (
            <p className="muted" role="status">
              分析中…
            </p>
          )}
        </details>
      )}
    </GameLayout>
  )
}

/** 結束後分析自己猜對方的每一步（沿用「你猜」模式的分析） */
function useVersusAnalysis(state: VersusState, me: Seat, enabled: boolean): StepAnalysis[] | null {
  const request = useAbWorker()
  const clues = useMemo(() => cluesOf(state, me), [state, me])
  const key = `${state.round}:${clues.map((c) => c.guess).join(',')}`
  const [analysis, setAnalysis] = useState<{ key: string; steps: StepAnalysis[] } | null>(null)
  // clues 每個事件（例如對方公開數字）都會換新的參照，同樣的內容只送一次給 Worker
  const requested = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !clues.length || requested.current === key) return
    requested.current = key
    // Worker 依序處理，舊的結果會先回來；畫面只認 key 對得上的那一份
    request({ type: 'analyze', clues }).then((res) => setAnalysis({ key, steps: res.steps }))
  }, [enabled, clues, key, request])
  return analysis?.key === key ? analysis.steps : null
}

function VerifyLine({ check }: { check: Check }) {
  if (check === 'ok') return <p className="ab-in">✓ 已驗證：對手公開的數字和每一次回報都對得上</p>
  if (check === 'pending') return <p className="muted">等待對手公開數字，驗證回報…</p>
  return (
    <p className="ab-out">
      ✗ {check === 'bad-commit' ? '對手公開的數字和開局時鎖定的不一樣' : '對手有回報和公開的數字對不上'}
      ，對手回報不實
    </p>
  )
}

function GuessLog({
  title,
  guesses,
  first,
  active,
}: {
  title: string
  guesses: Guess[]
  first: boolean
  active: boolean
}) {
  return (
    <section className={`ab-vs-log${active ? ' active' : ''}`} aria-label={title}>
      <h3>
        {title}
        {first && <span className="chip subtle">先手</span>}
        {active && <span className="chip">輪到</span>}
      </h3>
      {guesses.length ? (
        <ol className="ab-vs-list">
          {guesses.map((g, i) => (
            <li key={g.code}>
              <span className="ab-vs-no">{i + 1}</span>
              <span className="ab-code">{g.code}</span>
              <span className={isWin(g) ? 'ab-win' : ''}>{g.a === null ? '…' : `${g.a}A${g.b}B`}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">還沒有猜測</p>
      )}
    </section>
  )
}

const MARK_LABEL = { out: '排除', in: '確定' } as const

/** 推理筆記：點一下數字在「未知 → 排除 → 確定」之間切換，鍵盤上也會跟著標示 */
function DigitNotes({
  marks,
  onCycle,
  onClear,
}: {
  marks: readonly Mark[]
  onCycle: (d: number) => void
  onClear: () => void
}) {
  return (
    <section className="ab-notes" aria-label="推理筆記">
      <div className="ab-notes-head">
        <span className="muted">筆記：點數字切換 未知 → 排除 → 確定</span>
        <button type="button" className="secondary" disabled={!marks.some(Boolean)} onClick={onClear}>
          清除
        </button>
      </div>
      <div className="ab-notes-grid">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => {
          const mark = marks[d]
          return (
            <button
              key={d}
              type="button"
              className={`secondary${mark ? ` mark-${mark}` : ''}`}
              aria-label={`${d}：${mark ? MARK_LABEL[mark] : '未知'}`}
              onClick={() => onCycle(d)}
            >
              {d}
            </button>
          )
        })}
      </div>
    </section>
  )
}
