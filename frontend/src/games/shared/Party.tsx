import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '../../auth'
import { useInLobbyRoom, useLobbyWatch } from '../lobby/useLobby'
import { useInvite } from './share'
import { Segmented } from './ui'
import { loadPartyName, MAX_CHAT, MAX_NAME, type AnyParty } from './useParty'
import './party.css'

/**
 * 派對房間共用的畫面零件（連線見 useParty.ts）：
 * - `PartyEntry`：還沒進房間時的名字、建立／加入
 * - `PartyHeader`：房間代碼、邀請、離開、連線狀態
 * - `PartyLobby`：名單、上場／觀戰、房主的操作（加電腦、請人離開、開始），遊戲自己的選項放 `options`
 * - `ChatBox`：聊天室
 * - `Countdown`、`PartyNotice`：倒數和「動作被拒絕」的提示
 * 遊戲只要畫自己的 view、用 `party.act` 送動作。
 */

/**
 * 剩下的秒數（往上取整），`ms` 是 null 就不顯示。
 * 伺服器送的是「送出當下還剩幾毫秒」，`stamp` 換了（收到新的 view）就從現在重新往下數。
 */
export function Countdown({ ms, stamp }: { ms: number | null; stamp: unknown }) {
  const [version, setVersion] = useState({ stamp, n: 0 })
  // 在 render 裡依 props 更新 state（React 建議的「從 props 推導」寫法），換了就重掛 Ticker 重新起算
  if (version.stamp !== stamp) setVersion({ stamp, n: version.n + 1 })
  if (ms === null) return null
  return <Ticker key={version.n} ms={ms} />
}

function Ticker({ ms }: { ms: number }) {
  const [end] = useState(() => performance.now() + ms)
  const [left, setLeft] = useState(ms)
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, end - performance.now())), 250)
    return () => clearInterval(id)
  }, [end])
  const secs = Math.ceil(left / 1000)
  return <span className={`party-timer${secs <= 5 ? ' urgent' : ''}`}>{secs} 秒</span>
}

/** 訪客的座位只認這個分頁，提醒可以登入 */
function LoginHint() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (user || loading) return null
  return (
    <p className="muted">
      目前是訪客，換分頁或裝置就回不到這個房間。
      <Link to="/login" state={{ from: location.pathname + location.search }}>
        登入
      </Link>
      後會用帳號認人。
    </p>
  )
}

/** 名字欄位：改了就存起來（下次進房間用），在房間裡按「改名」才送給伺服器 */
function NameField({ party, inRoom }: { party: AnyParty; inRoom?: boolean }) {
  const { user } = useAuth()
  const [name, setName] = useState(() => loadPartyName())
  const placeholder = user?.username ?? '訪客'

  function change(value: string) {
    setName([...value].slice(0, MAX_NAME).join(''))
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    party.rename(name.trim())
  }

  if (!inRoom) {
    return (
      <label className="party-name">
        <span>名字</span>
        <input
          value={name}
          onChange={(e) => {
            change(e.target.value)
            party.rename(e.target.value.trim())
          }}
          placeholder={placeholder}
          maxLength={MAX_NAME * 2}
          autoComplete="nickname"
        />
      </label>
    )
  }
  return (
    <form className="inline-form party-rename" onSubmit={submit}>
      <input
        value={name}
        onChange={(e) => change(e.target.value)}
        placeholder={party.me?.name ?? placeholder}
        maxLength={MAX_NAME * 2}
        autoComplete="nickname"
        aria-label="改名字"
      />
      <button type="submit" className="secondary" disabled={!name.trim() || name.trim() === party.me?.name}>
        改名
      </button>
    </form>
  )
}

/** 還沒進房間：名字、建立房間、輸入代碼加入 */
export function PartyEntry({ party, children }: { party: AnyParty; children?: ReactNode }) {
  const [draft, setDraft] = useState('')

  function submit(e: FormEvent) {
    e.preventDefault()
    if (draft.trim()) party.join(draft)
  }

  return (
    <section className="party-entry">
      {children}
      <NameField party={party} />
      <button type="button" onClick={party.create} disabled={party.busy}>
        建立房間
      </button>
      <form className="inline-form" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
          placeholder="房間代碼"
          maxLength={8}
          autoCapitalize="characters"
          autoComplete="off"
          aria-label="房間代碼"
        />
        <button type="submit" className="secondary" disabled={!draft.trim()}>
          加入
        </button>
      </form>
      {party.error && <p className="error">{party.error}</p>}
      <LoginHint />
    </section>
  )
}

/**
 * 房間代碼、邀請、離開，以及連線錯誤；`extra` 是遊戲自己的按鈕。
 * 遊戲室開的房間不顯示代碼、邀請和離開（標題列的遊戲室就有），只留遊戲自己的按鈕和錯誤。
 */
export function PartyHeader({
  party,
  shareTitle,
  extra,
}: {
  party: AnyParty
  shareTitle: string
  extra?: ReactNode
}) {
  const invite = useInvite(party.inviteUrl, shareTitle)
  const inLobby = useInLobbyRoom(party.code)
  const recover = (
    <>
      {party.errorCode === 'replaced' && (
        <button type="button" onClick={party.reconnect}>
          在這裡繼續
        </button>
      )}
      {party.errorCode === 'not_found' && !inLobby && (
        <button type="button" onClick={party.create} disabled={party.busy}>
          建立新房間
        </button>
      )}
    </>
  )

  if (inLobby) {
    if (!extra && !party.error) return null
    return (
      <div className="party-header in-lobby">
        <div className="game-toolbar">
          {recover}
          {extra}
        </div>
        {party.error && <p className="error">{party.error}</p>}
      </div>
    )
  }

  return (
    <div className="party-header">
      <div className="room-code">
        <span className="muted">房間</span>
        <strong>{party.code}</strong>
        {party.code && !party.connected && !party.error && <span className="muted">連線中…</span>}
      </div>
      <div className="game-toolbar">
        {recover}
        {extra}
        <button type="button" className="secondary" onClick={invite.share}>
          {invite.copied ? '已複製連結' : '邀請朋友'}
        </button>
        <button type="button" className="secondary" onClick={party.leave}>
          離開房間
        </button>
      </div>
      {party.error && <p className="error">{party.error}</p>}
    </div>
  )
}

/**
 * 大廳（結算時也用這個開下一局）：名單、房主操作、遊戲的選項。
 * `options` 是遊戲自己的選項表單（不是房主時請畫成唯讀），`hint` 放開局前的說明。
 */
export function PartyLobby({
  party,
  options,
  hint,
}: {
  party: AnyParty
  options?: ReactNode
  hint?: ReactNode
}) {
  const { room, me, isHost } = party
  const syncLobby = useLobbyWatch(party.code)
  if (!room || !me) return null
  const results = room.phase === 'results'
  // 開局時入座的：電腦，和連著線、沒選觀戰的人
  const ready = room.players.filter((p) => p.bot || (p.online && !p.watching))
  const watchers = room.players.filter((p) => !p.bot && p.online && p.watching).length
  const bots = room.players.filter((p) => p.bot).length
  const seats = Math.min(ready.length, room.max)
  const canAddBot = room.maxBots > 0 && bots < room.maxBots && ready.length < room.max
  // 大房間（例如機甲 30 對 30）一台一台加太慢：一次補滿空的座位
  const fill = room.maxBots >= 10 ? Math.max(0, Math.min(room.maxBots - bots, room.max - ready.length)) : 0
  const waiting = room.min - seats

  function watch(on: boolean) {
    party.watch(on)
    syncLobby(on)
  }

  return (
    <section className="party-lobby">
      <h2>{results ? '再來一局？' : '等待開始'}</h2>
      <p>
        <strong>{seats}</strong> 人上場（{room.min === room.max ? `${room.max} 人` : `${room.min}～${room.max} 人`}）
        {watchers > 0 && <span className="muted">，{watchers} 人觀戰</span>}
        {ready.length > room.max && <span className="muted">，坐不下的 {ready.length - room.max} 人也觀戰</span>}
      </p>
      <ul className="party-roster">
        {room.players.map((p) => (
          <li key={p.pid} className={`${p.pid === me.pid ? 'me' : ''}${!p.bot && !p.online ? ' offline' : ''}`}>
            <span className="party-roster-name">{p.name}</span>
            {p.pid === room.host && <span className="chip subtle">房主</span>}
            {p.pid === me.pid && <span className="chip subtle">你</span>}
            {p.bot && <span className="chip subtle">電腦</span>}
            {p.watching && <span className="chip subtle">觀戰</span>}
            {!p.bot && !p.online && <span className="chip subtle">離線</span>}
            {isHost && p.pid !== me.pid && (
              <button
                type="button"
                className="party-kick"
                onClick={() => {
                  if (p.bot || window.confirm(`請 ${p.name} 離開房間？他之後就不能再進來。`)) party.kick(p.pid)
                }}
                aria-label={p.bot ? `移除 ${p.name}` : `請 ${p.name} 離開`}
                title={p.bot ? '移除' : '請他離開'}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {isHost && room.maxBots > 0 && (
        <button type="button" className="secondary" onClick={() => party.addBot()} disabled={!canAddBot}>
          ＋ 加電腦玩家
        </button>
      )}
      {isHost && fill > 1 && (
        <button type="button" className="secondary" onClick={() => party.addBot(fill)}>
          ＋ 補滿電腦（{fill} 台）
        </button>
      )}
      <Segmented
        label="我要"
        value={me.watching ? 'watch' : 'play'}
        options={[
          { value: 'play', label: '上場' },
          { value: 'watch', label: '觀戰' },
        ]}
        onChange={(v) => watch(v === 'watch')}
        disabled={!party.connected}
      />
      {!results && <NameField party={party} inRoom />}
      {options}
      {hint}
      {isHost ? (
        <button type="button" className="party-start" onClick={party.start} disabled={waiting > 0 || !party.connected}>
          {results ? '再來一局' : '開始'}
        </button>
      ) : (
        <p className="muted">等房主開始…</p>
      )}
      {isHost && waiting > 0 && (
        <p className="muted">
          還差 {waiting} 人上場才能開始{room.maxBots > 0 ? '，可以先加電腦玩家' : ''}，或按上面的「邀請朋友」。
        </p>
      )}
      <LoginHint />
    </section>
  )
}

/** 聊天室用到的部分：派對房間和遊戲室（`lobby/useLobby.tsx`）都有 */
type ChatSource = Pick<AnyParty, 'chat' | 'you' | 'say' | 'connected'>

/** 聊天室；`placeholder` 可以提示這個階段能聊什麼，`disabled` 時只能看 */
export function ChatBox({
  party,
  title = '聊天',
  placeholder = '說點什麼…',
  disabled,
}: {
  party: ChatSource
  title?: string
  placeholder?: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const log = useRef<HTMLOListElement>(null)
  const stick = useRef(true)

  // 在最底下時才自動捲到最新，往上翻舊訊息時不打擾
  useEffect(() => {
    const el = log.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [party.chat])

  function submit(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    party.say(text)
    setDraft('')
  }

  return (
    <section className="party-chat" aria-label={title}>
      <h3>{title}</h3>
      <ol
        ref={log}
        className="party-chat-log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {party.chat.length === 0 && <li className="muted">還沒有人說話</li>}
        {party.chat.map((line) => (
          <li
            key={line.id}
            className={[
              line.pid === null ? 'system' : '',
              line.pid === party.you ? 'mine' : '',
              line.tone ? `tone-${line.tone}` : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {line.pid !== null && <strong>{line.name}</strong>}
            <span>{line.text}</span>
            {line.private && <span className="party-chat-private">悄悄話</span>}
          </li>
        ))}
      </ol>
      <form className="inline-form" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          maxLength={MAX_CHAT}
          disabled={disabled || !party.connected}
          enterKeyHint="send"
          aria-label="聊天訊息"
        />
        <button type="submit" disabled={disabled || !draft.trim() || !party.connected}>
          送出
        </button>
      </form>
    </section>
  )
}

/** 自己的動作被拒絕時跳出來的提示，幾秒後自己消失（每則新的提示 id 不同，會重新顯示） */
export function PartyNotice({ party }: { party: Pick<AnyParty, 'notice'> }) {
  if (!party.notice) return null
  return <NoticeText key={party.notice.id} message={party.notice.message} />
}

function NoticeText({ message }: { message: string }) {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const id = setTimeout(() => setVisible(false), 4000)
    return () => clearTimeout(id)
  }, [])
  if (!visible) return null
  return (
    <p className="party-notice" role="alert">
      {message}
    </p>
  )
}
