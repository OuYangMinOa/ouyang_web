import { useEffect, useRef, useState } from 'react'
import { useFlash } from './flash'
import type { MiniPalette, MiniShape } from './minis'
import { useArena, type ArenaState, type Strategy } from './useArena'

/** 大逃殺手上這局的同步（俄羅斯方塊、魔法氣泡共用），畫面見 Arena.tsx */

/** 盤面送給伺服器的最短間隔 */
const BOARD_EVERY_MS = 150

export const STRATEGIES: { value: Strategy; label: string; hint: string }[] = [
  { value: 'random', label: '隨機', hint: '每隔幾秒隨機換一個目標' },
  { value: 'ko', label: '快輸的', hint: '瞄準盤面最高、快被堵住的人，搶 KO' },
  { value: 'badges', label: '徽章', hint: '瞄準徽章最多的人，KO 他可以拿走他的徽章' },
  { value: 'attackers', label: '反擊', hint: '同時反擊所有正在打你的人' },
]

/** 每個遊戲怎麼接上大逃殺 */
export type ArenaEngine<G> = {
  /** 網址上的遊戲 id：`/api/games/<game>/rooms` */
  game: string
  /** 攻擊的單位：「行」「顆干擾泡」 */
  unit: string
  /** 邀請連結分享時的標題 */
  shareTitle: string
  shape: MiniShape
  readPalette: () => MiniPalette
  create: () => G
  over: (g: G) => boolean
  /** 這局送出的攻擊總數 */
  sent: (g: G) => number
  receive: (g: G, amount: number) => void
  /** 每一幀把伺服器的速度等級和自己的徽章點數套進遊戲 */
  sync: (g: G, level: number, badges: number) => void
  /** 取走這一幀的事件，要閃的字用 `flash` 顯示；回傳要送出的攻擊（每一筆一則訊息），盤面有變就要回傳至少一筆（可以是 0） */
  drain: (g: G, flash: (text: string | null, sub?: string | null) => void) => number[] | null
  /** 送給伺服器的盤面和待落下的攻擊 */
  snapshot: (g: G) => { rows: string; pending: number }
}

type Feed = { id: number; text: string; mine: boolean }

/**
 * 手上這局：伺服器開新的一局時開新盤面，收到攻擊交給遊戲，遊戲打出攻擊或盤面變了就告訴伺服器，輸了就回報。
 * `frame` 要在主盤面的每一幀呼叫，`onKey` 處理數字鍵切換攻擊目標。
 */
export function useArenaMatch<G>(engine: ArenaEngine<G>) {
  const game = useRef<G | null>(null)
  /** 手上這局是伺服器的第幾局 */
  const round = useRef(0)
  const topoutSent = useRef(0)
  const board = useRef({ last: 0, dirty: false })
  const stateRef = useRef<ArenaState | null>(null)
  const youRef = useRef<number | null>(null)
  const [flash, showFlash] = useFlash()
  const [feed, setFeed] = useState<Feed[]>([])
  /** 畫面用：手上這局的局數和送出的攻擊 */
  const [local, setLocal] = useState({ round: 0, sent: 0 })

  const arena = useArena(engine.game, {
    onGarbage: (amount) => {
      const g = game.current
      if (g && !engine.over(g) && round.current === stateRef.current?.round) {
        engine.receive(g, amount)
        board.current.dirty = true
      }
    },
    onKo: ({ victim, killer, place }) => {
      const players = stateRef.current?.players ?? []
      const name = (pid: number | null) => players.find((p) => p.pid === pid)?.name ?? '?'
      const you = youRef.current
      const text =
        killer === null
          ? `${name(victim)} 出局（第 ${place} 名）`
          : `${killer === you ? '你' : name(killer)} KO 了 ${victim === you ? '你' : name(victim)}`
      const mine = killer === you || victim === you
      if (killer === you) showFlash('K.O.')
      setFeed((prev) => [{ id: Date.now() + Math.random(), text, mine }, ...prev].slice(0, 6))
    },
  })
  const { state, you, send } = arena
  const me = state?.players.find((p) => p.pid === you) ?? null
  useEffect(() => {
    stateRef.current = state
    youRef.current = you
  })

  const roundNo = state?.round ?? 0
  const phase = state?.phase
  const playing = !!me?.inRound && !!me.alive
  const mine = local.round === roundNo
  const running = phase === 'playing' && playing && mine

  function sendBoard() {
    const g = game.current
    if (!g) return
    board.current = { last: performance.now(), dirty: false }
    send({ type: 'board', ...engine.snapshot(g) })
  }

  function frame() {
    if (!state || !me) return
    // 新的一局開始倒數時開新盤面；重連回來發現手上沒有這局的盤面（重新整理過），就只能認輸
    if (playing && round.current !== roundNo) {
      if (phase === 'countdown') {
        game.current = engine.create()
        round.current = roundNo
        topoutSent.current = 0
        setLocal({ round: roundNo, sent: 0 })
      } else if (phase === 'playing' && topoutSent.current !== roundNo) {
        topoutSent.current = roundNo
        send({ type: 'topout' })
      }
      return
    }
    const g = game.current
    if (!g || !mine) return
    const sent = engine.sent(g)
    if (sent !== local.sent) setLocal({ round: roundNo, sent })
    engine.sync(g, state.level, me.badges)
    const attacks = engine.drain(g, showFlash)
    if (attacks) {
      for (const lines of attacks) if (lines > 0) send({ type: 'attack', lines })
      board.current.dirty = true
    }
    if (engine.over(g) && running && topoutSent.current !== roundNo) {
      sendBoard()
      topoutSent.current = roundNo
      send({ type: 'topout' })
      return
    }
    if (running && board.current.dirty && performance.now() - board.current.last >= BOARD_EVERY_MS) sendBoard()
  }

  function strategy(value: Strategy) {
    send({ type: 'strategy', strategy: value })
  }

  /** 數字鍵 1～4 切換攻擊目標；鍵被設成別的動作（`bound`）的話，以那個動作為準 */
  function onKey(code: string, bound: boolean): boolean {
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(code)
    if (bound || n < 0 || !running) return false
    strategy(STRATEGIES[n].value)
    return true
  }

  return { engine, game, arena, state, me, you, running, mine, local, flash, feed, frame, onKey, strategy }
}

export type ArenaMatch<G> = ReturnType<typeof useArenaMatch<G>>
