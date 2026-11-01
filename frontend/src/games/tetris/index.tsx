import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { errorMessage } from '../../api'
import { useAuth } from '../../auth'
import { ArenaIdentity, ArenaScreen, JoinForm, MAX_PLAYERS } from '../shared/Arena'
import { useFlash } from '../shared/flash'
import { KeyEditor } from '../shared/KeyEditor'
import { keyNames } from '../shared/keys'
import { load, save } from '../shared/storage'
import { GameLayout, MusicButton, Overlay, StatusLine, Toolbar } from '../shared/ui'
import { useArena } from '../shared/useArena'
import { useArenaMatch, type ArenaEngine } from '../shared/useArenaMatch'
import { readPalette } from './draw'
import { COLS, describe, Tetris } from './engine'
import { useKeys, type Action, type KeySettings } from './keys'
import { CHECKPOINT_MS, formatScore, Leaderboard, RunReporter, useLeaderboard, type RunState } from './Leaderboard'
import { useMusic } from './music'
import { Playfield, type PlayfieldHooks } from './Playfield'
import './tetris.css'

/** 單人模式每消這麼多行、或每玩這麼久就升一級（後端檢查分數時用一樣的規則） */
const LINES_PER_LEVEL = 10
const MS_PER_LEVEL = 60_000

export default function TetrisGame() {
  const [params] = useSearchParams()
  const [practice, setPractice] = useState(false)
  if (params.get('room')) return <Online />
  if (practice) return <Practice onExit={() => setPractice(false)} />
  return <Menu onPractice={() => setPractice(true)} />
}

/** 操作說明和自訂快捷鍵；`onEdit` 在開始改快捷鍵時呼叫（單人模式用來暫停） */
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
                {k('cw')}：順時針轉；{k('ccw')}：逆時針轉
              </li>
              <li>{k('hold')}：保留（Hold）</li>
              <li>
                {k('pause')}：暫停（單人模式）；{k('music')}：背景音樂開關
              </li>
              <li>1～4：切換攻擊目標（線上對戰）</li>
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
          <li>一次消 2 / 3 / 4 行送出 1 / 2 / 4 行垃圾；連擊、連續高難度消行（B2B）和全消都有加成。</li>
          <li>
            用旋轉把方塊卡進去再消行就是 spin：T 以外的方塊（O 除外）只要轉進去後左、右、上都動不了就算，攻擊和 T-Spin 一樣，單消 2、雙消 4、三消 6 行。
          </li>
          <li>收到的垃圾行先在左邊量表等 2 秒（黃→紅），這段時間消行可以抵銷；之後放下沒消行的方塊就會升上來。</li>
          <li>把對手頂到出局就是 KO，拿到徽章點數；徽章越多攻擊越強，最多 +100%。</li>
          <li>剩下的人越少，方塊掉得越快。活到最後的人獲勝。</li>
        </ul>
      </div>
    </>
  )
}

function Menu({ onPractice }: { onPractice: () => void }) {
  const arena = useArena('tetris', {})
  const { loading } = useAuth()
  const leaderboard = useLeaderboard()
  const keys = useKeys()

  return (
    <GameLayout
      side={
        <>
          <Leaderboard board={leaderboard.board} error={leaderboard.error} />
          <Help settings={keys} />
        </>
      }
    >
      <div className="tetris-menu">
        <p className="tetris-intro">
          最多 {MAX_PLAYERS} 人同場的俄羅斯方塊大逃殺。消行會變成垃圾行送給你瞄準的對手，把別人頂到出局就能拿徽章、讓攻擊更強，
          活到最後的人獲勝。人不夠時由電腦補位，一個人也能玩。
        </p>
        <ArenaIdentity game="tetris" />
        <div className="tetris-menu-actions">
          <button type="button" onClick={() => arena.create(true)} disabled={arena.busy || loading}>
            快速配對
          </button>
          <button type="button" className="secondary" onClick={() => arena.create(false)} disabled={arena.busy || loading}>
            建立私人房間
          </button>
          <button type="button" className="secondary" onClick={onPractice}>
            單人模式
          </button>
        </div>
        <JoinForm arena={arena} />
        {arena.error && <p className="error">{arena.error}</p>}
        <p className="muted">
          快速配對會加入正在等人的公開房間，兩個人以上就開始 20 秒倒數；私人房間把代碼或邀請連結給朋友，由房主決定電腦人數和開始時間。
        </p>
      </div>
    </GameLayout>
  )
}

type PracticePhase = 'running' | 'paused' | 'over'

/** 回報給排行榜伺服器的中間態 */
function runState(g: Tetris): RunState {
  return {
    score: g.score,
    lines: g.lines,
    level: g.level,
    pieces: g.pieces,
    // 無條件進位：等級是用沒取整的時間算的，送出去的時間不能比它短
    duration_ms: Math.max(1, Math.ceil(g.clock)),
    board: g.cells(),
  }
}

function Practice({ onExit }: { onExit: () => void }) {
  const { user } = useAuth()
  const [initial] = useState(() => new Tetris())
  const game = useRef<Tetris | null>(initial)
  /** 已經結算過的那一局，避免結束時連續幾個畫面重複上傳 */
  const ended = useRef<Tetris | null>(null)
  const [phase, setPhase] = useState<PracticePhase>('running')
  const [hud, setHud] = useState({ score: 0, lines: 0, level: 1 })
  const [best, setBest] = useState(() => load<number>('tetris:best-score', 0))
  /** 這局上傳後的結果：null 是還沒（或不用）上傳 */
  const [result, setResult] = useState<
    { rank: number; best: boolean } | { error: string } | 'sending' | null
  >(null)
  /** 這局的成績上傳（有登入才有），以及下一次要回報進度的遊戲時間 */
  const run = useRef<{ game: Tetris; reporter: RunReporter; next: number } | null>(null)
  const leaderboard = useLeaderboard()
  const [flash, showFlash] = useFlash()
  const music = useMusic(phase === 'running', hud.level)
  const keys = useKeys()

  function restart() {
    game.current = new Tetris()
    setHud({ score: 0, lines: 0, level: 1 })
    setResult(null)
    setPhase('running')
  }

  function finish(g: Tetris) {
    ended.current = g
    setPhase('over')
    if (g.score > best) {
      setBest(g.score)
      save('tetris:best-score', g.score)
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
    for (const r of g.events.splice(0)) {
      const label = describe(r)
      if (label) showFlash(label)
    }
    // 每消 10 行或每玩 1 分鐘升一級（看哪個先到），沒有上限，一直快到撐不住為止
    const level = 1 + Math.max(Math.floor(g.lines / LINES_PER_LEVEL), Math.floor(g.clock / MS_PER_LEVEL))
    if (level > g.level) {
      g.level = level
      showFlash(`LEVEL ${level}`)
    }
    if (g.score !== hud.score || g.lines !== hud.lines || g.level !== hud.level)
      setHud({ score: g.score, lines: g.lines, level: g.level })
    // 登入的人開局就跟伺服器登記，之後定期回報進度（伺服器會比對開局到現在實際經過的時間，所以只在剛開局時登記）
    if (user && run.current?.game !== g && g.clock < 1000) {
      run.current = { game: g, reporter: new RunReporter(), next: CHECKPOINT_MS }
    }
    if (run.current?.game === g && !g.over && g.clock >= run.current.next) {
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

  useEffect(() => {
    const hide = () => {
      if (document.hidden) setPhase((p) => (p === 'running' ? 'paused' : p))
    }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [])

  const record = phase === 'over' && hud.score > 0 && hud.score >= best
  const overlay =
    phase === 'paused' ? (
      <Overlay>
        <strong className="tetris-overlay-title">⏸ 已暫停</strong>
        <button type="button" onClick={() => setPhase('running')}>
          繼續
        </button>
      </Overlay>
    ) : phase === 'over' ? (
      <Overlay>
        <strong className="tetris-overlay-title">遊戲結束</strong>
        <span>
          {formatScore(hud.score)} 分 · {hud.lines} 行 · 等級 {hud.level}
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
        {formatScore(hud.score)} 分 · {hud.lines} 行 · 等級 {hud.level}
        <span className="tetris-muted"> · 最高 {formatScore(Math.max(best, hud.score))}</span>
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

const ENGINE: ArenaEngine<Tetris> = {
  game: 'tetris',
  unit: '行',
  shareTitle: '一起來玩俄羅斯方塊',
  shape: { cols: COLS, hidden: 0 },
  readPalette,
  create: () => new Tetris(),
  over: (g) => g.over,
  sent: (g) => g.sent,
  receive: (g, lines) => g.receive(lines),
  sync: (g, level, badges) => {
    g.level = level
    g.badges = badges
  },
  drain: (g, flash) => {
    const events = g.events.splice(0)
    if (events.length === 0) return null
    return events.map((r) => {
      const label = describe(r)
      if (label || r.sent > 0) flash(label, r.sent > 0 ? `+${r.sent} 行攻擊` : null)
      return r.sent
    })
  },
  snapshot: (g) => ({ rows: g.snapshot(), pending: g.pending() }),
}

function Online() {
  const match = useArenaMatch(ENGINE)
  const music = useMusic(match.running, match.state?.level ?? 1)
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
