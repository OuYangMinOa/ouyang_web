import type { TakebackEvent, TakebackView } from './takeback'
import type { Seat } from './useRoom'

type Props = {
  takeback: TakebackView
  seat: Seat | null
  /** 連線中、對手在線、對局還沒結束 */
  active: boolean
  send: (event: TakebackEvent) => void
}

/** 線上模式工具列上的「悔棋」按鈕：自己提出請求後要等對手同意 */
export function TakebackButton({ takeback, seat, active, send }: Props) {
  if (seat === null) return null
  const mine = takeback.pending?.by === seat
  if (mine) {
    return (
      <button type="button" className="secondary" onClick={() => send({ type: 'takeback-cancel' })}>
        取消悔棋
      </button>
    )
  }
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => send({ type: 'takeback' })}
      disabled={!active || !takeback.canRequest[seat]}
      title={takeback.last?.by === seat && !takeback.last.accepted ? '對手拒絕了，等下一手之後才能再提' : undefined}
    >
      悔棋
    </button>
  )
}

/** 棋盤上方的悔棋提示：對手提出時在這裡同意或拒絕 */
export function TakebackNotice({ takeback, seat, active, send }: Props) {
  if (seat === null) return null
  const { pending, last } = takeback
  if (pending && active) {
    const steps = pending.plies === 1 ? '一手' : `${pending.plies} 手`
    if (pending.by === seat) {
      return <div className="takeback-notice">已提出悔棋（退回 {steps}），等待對手同意…</div>
    }
    return (
      <div className="takeback-notice ask" role="alert">
        <span>對手想悔棋，退回 {steps}</span>
        <span className="takeback-actions">
          <button type="button" onClick={() => send({ type: 'takeback-accept' })}>
            同意
          </button>
          <button type="button" className="secondary" onClick={() => send({ type: 'takeback-decline' })}>
            拒絕
          </button>
        </span>
      </div>
    )
  }
  if (!last) return null
  let text: string
  if (last.by === seat) text = last.accepted ? '對手同意了，已經悔棋' : '對手拒絕悔棋'
  else text = last.accepted ? '你同意了對手悔棋' : '你拒絕了對手悔棋'
  return <div className={`takeback-notice${last.by === seat && !last.accepted ? ' declined' : ''}`}>{text}</div>
}
