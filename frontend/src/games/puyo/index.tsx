import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { errorMessage } from '../../api'
import { useAuth } from '../../auth'
import { ArenaIdentity, ArenaScreen, JoinForm } from '../shared/Arena'
import { useFlash } from '../shared/flash'
import { KeyEditor } from '../shared/KeyEditor'
import { keyNames } from '../shared/keys'
import { CHECKPOINT_MS, formatScore } from '../shared/Leaderboard'
import { load, save } from '../shared/storage'
import { GameLayout, MusicButton, Overlay, Segmented, StatusLine, Toolbar } from '../shared/ui'
import { useArena } from '../shared/useArena'
import { useArenaMatch, type ArenaEngine } from '../shared/useArenaMatch'
import { Cpu, type Difficulty } from './cpu'
import { readPalette } from './draw'
import { COLS, HIDDEN, describeLink, Puyo, type GameEvent } from './engine'
import { useKeys, type Action, type KeySettings } from './keys'
import { Leaderboard, RunReporter, useLeaderboard, type RunState } from './Leaderboard'
import { useMusic } from './music'
import { BoardView, Playfield, type PlayfieldHooks } from './Playfield'
import './puyo.css'

/** 單人模式每放這麼多組、或每玩這麼久就升一級（後端檢查分數時用一樣的規則） */
const PIECES_PER_LEVEL = 30
const MS_PER_LEVEL = 60_000
/** 對戰時每玩這麼久兩邊一起變快，最多到這一級 */
const VERSUS_MS_PER_LEVEL = 60_000
const VERSUS_MAX_LEVEL = 8
/** 大逃殺的速度等級最高 15（和俄羅斯方塊共用），魔法氣泡太快會來不及轉，最多到這一級 */
const ARENA_MAX_LEVEL = 10
/** 對戰開始前倒數幾下、每下多久 */
const COUNTDOWN = 3
const COUNTDOWN_MS = 700

const DIFFICULTIES: { value: Difficulty; label: string }[] = [
  { value: 'easy', label: '簡單' },
  { value: 'normal', label: '普通' },
  { value: 'hard', label: '困難' },
]

type Mode = { kind: 'menu' } | { kind: 'solo' } | { kind: 'versus'; difficulty: Difficulty }

type WinLoss = { win: number; lose: number }
type Records = Partial<{ [D in Difficulty]: WinLoss }>

function difficultyLabel(d: Difficulty): string {
  return DIFFICULTIES.find((o) => o.value === d)!.label
}

export default function PuyoGame() {
  const [params] = useSearchParams()
  const [mode, setMode] = useState<Mode>({ kind: 'menu' })
  const menu = () => setMode({ kind: 'menu' })
  if (params.get('room')) return <Online />
  if (mode.kind === 'solo') return <Solo onExit={menu} />
  if (mode.kind === 'versus') return <Versus key={mode.difficulty} difficulty={mode.difficulty} onExit={menu} />
  return <Menu onSolo={() => setMode({ kind: 'solo' })} onVersus={(difficulty) => setMode({ kind: 'versus', difficulty })} />
}

/** 操作說明和自訂快捷鍵；`onEdit` 在開始改快捷鍵時呼叫（用來暫停） */
function Help({ settings, onEdit }: { settings: KeySettings; onEdit?: () => void }) {
  const [editing, setEditing] = useState(false)
  const k = (action: Action) => keyNames(settings.keys, action)
  return (
    <>
      <div className="game-help">
        <strong>操作</strong>
        {editing ? (
          <KeyEditor settings={settings} onDone={() => setEditing(false)} />
        ) : (
          <>
            <ul>
              <li>
                {k('left')}、{k('right')}：左右移動（按住連續移動）
              </li>
              <li>
                {k('soft')}：加速下落；{k('hard')}：直接落下
              </li>
              <li>
                {k('cw')}：順時針轉；{k('ccw')}：逆時針轉（夾在縫裡轉不過去時會上下對調）
              </li>
              <li>
                {k('pause')}：暫停；{k('music')}：背景音樂開關
              </li>
            </ul>
            <p className="muted">手機用盤面下方的按鈕，左右和下可以按住不放。</p>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setEditing(true)
                onEdit?.()
              }}
            >
              ⌨ 自訂快捷鍵
            </button>
          </>
        )}
      </div>
      <div className="game-help">
        <strong>規則</strong>
        <ul>
          <li>同色 4 顆以上上下左右相連就會消掉。消掉之後上面的掉下來又湊成 4 顆，就是連鎖，連鎖越多分數越高。</li>
          <li>分數 = 10 × 消掉的顆數 × (連鎖倍率 + 一次連很多顆的加成 + 同時消好幾色的加成)。</li>
          <li>
            對戰時每 70 分變成一顆干擾泡送給對手。收到的干擾泡先排在盤面上方，你這一組放完就會落下，在那之前打出連鎖可以抵銷。
            干擾泡旁邊的氣泡消掉時，它也會跟著消掉。
          </li>
          <li>對戰開打 96 秒後進入加時，換算的分數越來越低，攻擊越來越兇。</li>
          <li>全部消光（全消）：單人模式加 2,100 分；對戰時下一次連鎖多送 30 顆干擾泡。</li>
          <li>
            大逃殺：干擾泡送給目前的攻擊目標（數字鍵 1～4 切換選目標的方式，或點小盤面指定）。KO 別人可以拿到徽章，每個徽章讓送出的干擾泡多 25%。
          </li>
          <li>第 3 欄最上面那格（× 的位置）被堵住就輸了。</li>
        </ul>
      </div>
    </>
  )
}

function Menu({ onSolo, onVersus }: { onSolo: () => void; onVersus: (d: Difficulty) => void }) {
  const leaderboard = useLeaderboard()
  const keys = useKeys()
  const arena = useArena('puyo', {})
  const { loading } = useAuth()
  const [difficulty, setDifficulty] = useState<Difficulty>(() => load<Difficulty>('puyo:difficulty', 'normal'))
  const [records] = useState(() => load<Records>('puyo:records', {}))
  const record = records[difficulty]

  function pick(d: Difficulty) {
    setDifficulty(d)
    save('puyo:difficulty', d)
  }

  return (
    <GameLayout
      side={
        <>
          <Leaderboard board={leaderboard.board} error={leaderboard.error} />
          <Help settings={keys} />
        </>
      }
    >
      <div className="puyo-menu">
        <p className="puyo-intro">
          兩顆一組的氣泡從上面掉下來，同色 4 顆連在一起就會消掉。把氣泡疊成「消掉一組、上面掉下來又能再消」的樣子，一口氣打出大連鎖！
        </p>
        <section className="puyo-mode">
          <h2>單人模式</h2>
          <p className="muted">越來越快，看你能撐多久、打出多少分。登入後成績會登上排行榜。</p>
          <button type="button" onClick={onSolo}>
            開始
          </button>
        </section>
        <section className="puyo-mode">
          <h2>對戰電腦</h2>
          <p className="muted">一對一，連鎖變成干擾泡丟給對方，先被堵住的人輸。</p>
          <Segmented label="難度" value={difficulty} options={DIFFICULTIES} onChange={pick} />
          {record && (
            <p className="muted">
              {difficultyLabel(difficulty)}：{record.win} 勝 {record.lose} 敗
            </p>
          )}
          <button type="button" onClick={() => onVersus(difficulty)}>
            開始對戰
          </button>
        </section>
        <section className="puyo-mode">
          <h2>大逃殺</h2>
          <p className="muted">
            最多 99 人同場，連鎖變成干擾泡丟給你瞄準的對手，活到最後的人獲勝。把房間代碼或邀請連結給朋友就能一起玩，人不夠由電腦補位。
          </p>
          <ArenaIdentity game="puyo" />
          <button type="button" onClick={() => arena.create(false)} disabled={arena.busy || loading}>
            建立房間
          </button>
          <JoinForm arena={arena} />
          {arena.error && <p className="error">{arena.error}</p>}
        </section>
      </div>
    </GameLayout>
  )
}

type SoloPhase = 'running' | 'paused' | 'over'

/** 回報給排行榜伺服器的中間態 */
function runState(g: Puyo): RunState {
  return {
    score: g.score,
    level: g.level,
    pieces: g.pieces,
    popped: g.popped,
    lost: g.lost,
    max_chain: g.maxChain,
    // 無條件進位：等級是用沒取整的時間算的，送出去的時間不能比它短
    duration_ms: Math.max(1, Math.ceil(g.clock)),
    board: g.cells(),
  }
}

/** 暫停：切到別的分頁時自動暫停 */
function usePauseWhenHidden(pause: () => void) {
  const ref = useRef(pause)
  useEffect(() => {
    ref.current = pause
  })
  useEffect(() => {
    const hide = () => document.hidden && ref.current()
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [])
}

function Solo({ onExit }: { onExit: () => void }) {
  const { user } = useAuth()
  const [initial] = useState(() => new Puyo())
  const game = useRef<Puyo | null>(initial)
  /** 已經結算過的那一局，避免結束時連續幾個畫面重複上傳 */
  const ended = useRef<Puyo | null>(null)
  const [phase, setPhase] = useState<SoloPhase>('running')
  const [hud, setHud] = useState({ score: 0, maxChain: 0, level: 1 })
  const [best, setBest] = useState(() => load<number>('puyo:best-score', 0))
  /** 這局上傳後的結果：null 是還沒（或不用）上傳 */
  const [result, setResult] = useState<{ rank: number; best: boolean } | { error: string } | 'sending' | null>(null)
  /** 這局的成績上傳（有登入才有），以及下一次要回報進度的遊戲時間 */
  const run = useRef<{ game: Puyo; reporter: RunReporter; next: number } | null>(null)
  const leaderboard = useLeaderboard()
  const [flash, showFlash] = useFlash()
  const music = useMusic(phase === 'running', hud.level)
  const keys = useKeys()

  function restart() {
    game.current = new Puyo()
    setHud({ score: 0, maxChain: 0, level: 1 })
    setResult(null)
    setPhase('running')
  }

  function finish(g: Puyo) {
    ended.current = g
    setPhase('over')
    if (g.score > best) {
      setBest(g.score)
      save('puyo:best-score', g.score)
    }
    if (run.current?.game !== g || g.score <= 0) return
    setResult('sending')
    run.current.reporter
      .finish(runState(g))
      .then((b) => {
        leaderboard.update(b)
        setResult(b.me ? { rank: b.me.rank, best: !!b.best } : null)
      })
      .catch((e) => setResult({ error: errorMessage(e) }))
  }

  function frame() {
    const g = game.current
    if (!g) return
    for (const e of g.events.splice(0)) {
      if (e.kind === 'link' && e.chain >= 2) showFlash(describeLink(e), `+${formatScore(e.points)}`)
      else if (e.kind === 'turn' && e.allClear) showFlash('全消！', '+2,100')
    }
    // 每放 30 組或每玩 1 分鐘升一級（看哪個先到），沒有上限
    const level = 1 + Math.max(Math.floor(g.pieces / PIECES_PER_LEVEL), Math.floor(g.clock / MS_PER_LEVEL))
    if (level > g.level) {
      g.level = level
      showFlash(`LEVEL ${level}`)
    }
    if (g.score !== hud.score || g.maxChain !== hud.maxChain || g.level !== hud.level)
      setHud({ score: g.score, maxChain: g.maxChain, level: g.level })
    // 登入的人開局就跟伺服器登記，之後定期回報進度
    if (user && run.current?.game !== g && g.clock < 1000) {
      run.current = { game: g, reporter: new RunReporter(), next: CHECKPOINT_MS }
    }
    // 連鎖進行中的盤面還有沒消掉的組、數字也還沒對齊，等下一組出來再回報
    if (run.current?.game === g && !g.over && g.piece && g.clock >= run.current.next) {
      run.current.reporter.report(runState(g))
      run.current.next += CHECKPOINT_MS
    }
    if (g.over && ended.current !== g) finish(g)
  }

  function onKey(_code: string, action: Action | undefined): boolean {
    if (action === 'music') {
      music.toggle()
      return true
    }
    if (action === 'pause') {
      if (phase === 'running') setPhase('paused')
      else if (phase === 'paused') setPhase('running')
      return phase !== 'over'
    }
    return false
  }

  const hooks = useRef<PlayfieldHooks>({})
  useEffect(() => {
    hooks.current = { onFrame: frame, onKey }
  })
  usePauseWhenHidden(() => setPhase((p) => (p === 'running' ? 'paused' : p)))

  const record = phase === 'over' && hud.score > 0 && hud.score >= best
  const overlay =
    phase === 'paused' ? (
      <Overlay>
        <strong className="puyo-overlay-title">⏸ 已暫停</strong>
        <button type="button" onClick={() => setPhase('running')}>
          繼續
        </button>
      </Overlay>
    ) : phase === 'over' ? (
      <Overlay>
        <strong className="puyo-overlay-title">遊戲結束</strong>
        <span>
          {formatScore(hud.score)} 分 · 最大 {hud.maxChain} 連鎖 · 等級 {hud.level}
        </span>
        <span>{record ? '新紀錄！' : `最高 ${formatScore(best)} 分`}</span>
        {result === 'sending' ? (
          <span className="muted">上傳成績中…</span>
        ) : result && 'error' in result ? (
          <span className="error">{result.error}</span>
        ) : result ? (
          <span>
            {result.best ? '刷新個人紀錄，' : ''}排行榜第 {result.rank} 名
          </span>
        ) : (
          !user && hud.score > 0 && <span className="muted">登入後成績會登上排行榜</span>
        )}
        <button type="button" onClick={restart}>
          再玩一次
        </button>
      </Overlay>
    ) : null

  return (
    <GameLayout
      side={
        <>
          <Leaderboard board={leaderboard.board} error={leaderboard.error} />
          <Help settings={keys} onEdit={() => setPhase((p) => (p === 'running' ? 'paused' : p))} />
        </>
      }
    >
      <StatusLine tone={phase === 'over' ? 'danger' : undefined}>
        {formatScore(hud.score)} 分 · 最大 {hud.maxChain} 連鎖 · 等級 {hud.level}
        <span className="puyo-muted"> · 最高 {formatScore(Math.max(best, hud.score))}</span>
      </StatusLine>
      <Playfield
        game={game}
        running={phase === 'running'}
        keys={keys.keys}
        hooks={hooks}
        overlay={overlay}
        flash={flash}
      />
      <Toolbar>
        <button
          type="button"
          className="secondary"
          onClick={() => setPhase(phase === 'paused' ? 'running' : 'paused')}
          disabled={phase === 'over'}
        >
          {phase === 'paused' ? '▶ 繼續' : '⏸ 暫停'}
        </button>
        <button type="button" className="secondary" onClick={restart}>
          重新開始
        </button>
        <MusicButton music={music} />
        <button type="button" className="secondary" onClick={onExit}>
          回到選單
        </button>
      </Toolbar>
    </GameLayout>
  )
}

type VersusPhase = 'countdown' | 'running' | 'paused' | 'over'

/** 一局對戰：兩邊用同一個種子，拿到一樣順序的氣泡 */
function newMatch(difficulty: Difficulty) {
  const seed = Math.floor(Math.random() * 2 ** 32)
  const you = new Puyo({ seed, versus: true })
  const cpu = new Puyo({ seed, versus: true })
  return { you, cpu, ai: new Cpu(cpu, difficulty) }
}

/** 一次連鎖或送出攻擊要閃的字 */
function announce(e: GameEvent, show: (text: string | null, sub?: string | null) => void) {
  if (e.kind === 'link') {
    if (e.chain >= 2) show(describeLink(e))
  } else if (e.allClear) {
    show('全消！', e.sent > 0 ? `+${e.sent} 干擾泡` : null)
  } else if (e.sent > 0) {
    show(e.chain >= 2 ? `${e.chain} 連鎖` : null, `+${e.sent} 干擾泡`)
  }
}

function Versus({ difficulty, onExit }: { difficulty: Difficulty; onExit: () => void }) {
  const [initial] = useState(() => newMatch(difficulty))
  const you = useRef<Puyo | null>(initial.you)
  const cpu = useRef<Puyo | null>(initial.cpu)
  const ai = useRef<Cpu>(initial.ai)
  const [phase, setPhase] = useState<VersusPhase>('countdown')
  const [count, setCount] = useState(COUNTDOWN)
  const [winner, setWinner] = useState<'you' | 'cpu' | null>(null)
  const [tally, setTally] = useState({ you: 0, cpu: 0 })
  const [hud, setHud] = useState({ maxChain: 0, sent: 0, level: 1 })
  const [flash, showFlash] = useFlash()
  const [cpuFlash, showCpuFlash] = useFlash()
  const music = useMusic(phase === 'running', hud.level)
  const keys = useKeys()

  /** 已經分出勝負的那一局，避免連續幾個畫面重複結算 */
  const decided = useRef<Puyo | null>(null)

  useEffect(() => {
    if (phase !== 'countdown') return
    const id = setTimeout(() => (count <= 1 ? setPhase('running') : setCount(count - 1)), COUNTDOWN_MS)
    return () => clearTimeout(id)
  }, [phase, count])

  function rematch() {
    const m = newMatch(difficulty)
    you.current = m.you
    cpu.current = m.cpu
    ai.current = m.ai
    setHud({ maxChain: 0, sent: 0, level: 1 })
    setWinner(null)
    setCount(COUNTDOWN)
    setPhase('countdown')
  }

  function end(w: 'you' | 'cpu') {
    setWinner(w)
    setPhase('over')
    setTally((t) => ({ ...t, [w]: t[w] + 1 }))
    const records = load<Records>('puyo:records', {})
    const r = records[difficulty] ?? { win: 0, lose: 0 }
    records[difficulty] = w === 'you' ? { ...r, win: r.win + 1 } : { ...r, lose: r.lose + 1 }
    save('puyo:records', records)
  }

  function frame(dt: number) {
    const g = you.current
    const o = cpu.current
    if (!g || !o) return
    if (phase === 'running') {
      ai.current.update(dt)
      o.update(dt)
      const level = Math.min(1 + Math.floor(g.clock / VERSUS_MS_PER_LEVEL), VERSUS_MAX_LEVEL)
      g.level = level
      o.level = level
    }
    for (const e of g.events.splice(0)) {
      if (e.kind === 'turn') o.receive(e.sent)
      announce(e, showFlash)
    }
    for (const e of o.events.splice(0)) {
      if (e.kind === 'turn') g.receive(e.sent)
      announce(e, showCpuFlash)
    }
    if (g.maxChain !== hud.maxChain || g.sent !== hud.sent || g.level !== hud.level)
      setHud({ maxChain: g.maxChain, sent: g.sent, level: g.level })
    if (phase === 'running' && (g.over || o.over) && decided.current !== g) {
      decided.current = g
      end(g.over ? 'cpu' : 'you')
    }
  }

  function onKey(_code: string, action: Action | undefined): boolean {
    if (action === 'music') {
      music.toggle()
      return true
    }
    if (action === 'pause') {
      if (phase === 'running') setPhase('paused')
      else if (phase === 'paused') setPhase('running')
      return phase === 'running' || phase === 'paused'
    }
    return false
  }

  const hooks = useRef<PlayfieldHooks>({})
  useEffect(() => {
    hooks.current = { onFrame: frame, onKey }
  })
  usePauseWhenHidden(() => setPhase((p) => (p === 'running' ? 'paused' : p)))

  let overlay = null
  if (phase === 'countdown') {
    overlay = (
      <Overlay>
        <strong className="puyo-countdown">{count}</strong>
        <span>對手：電腦（{difficultyLabel(difficulty)}）</span>
      </Overlay>
    )
  } else if (phase === 'paused') {
    overlay = (
      <Overlay>
        <strong className="puyo-overlay-title">⏸ 已暫停</strong>
        <button type="button" onClick={() => setPhase('running')}>
          繼續
        </button>
      </Overlay>
    )
  } else if (phase === 'over') {
    overlay = (
      <Overlay>
        <strong className="puyo-overlay-title">{winner === 'you' ? '🏆 你贏了！' : '你輸了'}</strong>
        <span>
          最大 {hud.maxChain} 連鎖 · 送出 {hud.sent} 顆干擾泡
        </span>
        <span>
          這次比數 {tally.you} : {tally.cpu}
        </span>
        <button type="button" onClick={rematch}>
          再來一局
        </button>
      </Overlay>
    )
  }

  const opponent = (
    <div className="puyo-side">
      <span className="puyo-label">CPU · {difficultyLabel(difficulty)}</span>
      <BoardView game={cpu} label="電腦的盤面" flash={cpuFlash} />
    </div>
  )

  return (
    <GameLayout side={<Help settings={keys} onEdit={() => setPhase((p) => (p === 'running' ? 'paused' : p))} />}>
      <StatusLine tone={winner === 'you' ? 'ok' : winner === 'cpu' ? 'danger' : undefined}>
        你 {tally.you} : {tally.cpu} 電腦
        <span className="puyo-muted">
          {' '}
          · 最大 {hud.maxChain} 連鎖 · 速度 {hud.level}
        </span>
      </StatusLine>
      <Playfield
        game={you}
        running={phase === 'running'}
        keys={keys.keys}
        hooks={hooks}
        overlay={overlay}
        flash={flash}
        opponent={opponent}
      />
      <Toolbar>
        <button
          type="button"
          className="secondary"
          onClick={() => setPhase(phase === 'paused' ? 'running' : 'paused')}
          disabled={phase !== 'running' && phase !== 'paused'}
        >
          {phase === 'paused' ? '▶ 繼續' : '⏸ 暫停'}
        </button>
        <button type="button" className="secondary" onClick={rematch}>
          重新開始
        </button>
        <MusicButton music={music} />
        <button type="button" className="secondary" onClick={onExit}>
          回到選單
        </button>
      </Toolbar>
    </GameLayout>
  )
}

const ENGINE: ArenaEngine<Puyo> = {
  game: 'puyo',
  unit: '顆干擾泡',
  shareTitle: '一起來玩魔法氣泡',
  shape: { cols: COLS, hidden: HIDDEN, round: true },
  readPalette,
  create: () => new Puyo({ versus: true }),
  over: (g) => g.over,
  sent: (g) => g.sent,
  receive: (g, n) => g.receive(n),
  sync: (g, level, badges) => {
    g.level = Math.min(level, ARENA_MAX_LEVEL)
    g.badges = badges
  },
  drain: (g, flash) => {
    const events = g.events.splice(0)
    if (events.length === 0) return null
    return events.map((e) => {
      announce(e, flash)
      return e.kind === 'turn' ? e.sent : 0
    })
  },
  snapshot: (g) => ({ rows: g.cells(), pending: g.pending }),
}

function Online() {
  const match = useArenaMatch(ENGINE)
  const music = useMusic(match.running, Math.min(match.state?.level ?? 1, ARENA_MAX_LEVEL))
  const { keys } = useKeys()

  const hooks = useRef<PlayfieldHooks>({})
  useEffect(() => {
    hooks.current = {
      onFrame: match.frame,
      onKey: (code, action) => {
        if (action === 'music') {
          music.toggle()
          return true
        }
        return match.onKey(code, !!action)
      },
    }
  })

  return (
    <ArenaScreen
      match={match}
      extra={<MusicButton music={music} />}
      playfield={({ overlay, info, flash }) => (
        <Playfield
          game={match.game}
          running={match.running}
          keys={keys}
          hooks={hooks}
          overlay={overlay}
          flash={flash}
          info={info}
        />
      )}
    />
  )
}
