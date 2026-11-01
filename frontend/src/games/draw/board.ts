import type { CanvasSnapshot, DrawOp, OpEvent, Stroke } from './types'

/** 最多留幾則還接不上的事件（照理只會有幾則：新的 view 還沒套用前就到的筆畫） */
const MAX_PENDING = 500

/**
 * 這一棒的畫布（放在 React 外面，筆畫每秒幾十則，不經過 state）。
 *
 * 伺服器的畫布每個動作版本加一。收到的東西有兩種：
 * - view 裡的整張畫布（`adopt`）：「到第 v 版為止」的樣子，重連、換下一棒時用。
 * - 即時事件（`receive`）：第 v 版的那一個動作。
 * WebSocket 是照順序到的，但 view 要等 React 重畫後才套用，事件則是馬上處理，
 * 所以可能先收到新畫布的事件、才套用那張畫布的 view。因此：
 * - 事件剛好是下一版就套上去，其他的先放著（`pending`），套用 view 之後再接著處理；
 * - view 的版本沒有比手上的新（事件已經先套上去了）就不用它。
 * 畫的人自己畫的直接套在本地（`local`），伺服器不會把他的筆畫再傳回來。
 */
export class Board {
  id = -1
  v = 0
  strokes: Stroke[] = []
  points = 0
  private pending: OpEvent[] = []
  private listeners = new Set<() => void>()

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }

  adopt(snapshot: CanvasSnapshot) {
    if (snapshot.id === this.id && snapshot.v <= this.v) return
    this.id = snapshot.id
    this.v = snapshot.v
    this.strokes = snapshot.strokes.map((s) => ({ ...s, p: [...s.p] }))
    this.points = this.strokes.reduce((sum, s) => sum + s.p.length / 2, 0)
    this.pending = this.pending.filter((e) => e.id === snapshot.id)
    this.drain()
    this.notify()
  }

  receive(event: OpEvent) {
    if (!event || event.type !== 'op') return
    this.pending.push(event)
    if (this.pending.length > MAX_PENDING) this.pending.shift()
    if (this.drain()) this.notify()
  }

  /** 把接得上的事件依序套上去，回傳有沒有變 */
  private drain(): boolean {
    let changed = false
    for (;;) {
      this.pending = this.pending.filter((e) => e.id !== this.id || e.v > this.v)
      const next = this.pending.find((e) => e.id === this.id && e.v === this.v + 1)
      if (!next) return changed
      this.apply(next.op)
      this.v = next.v
      changed = true
    }
  }

  private apply(op: DrawOp) {
    switch (op.kind) {
      case 'begin':
        this.strokes.push({ c: op.c, w: op.w, p: [...op.p] })
        this.points += op.p.length / 2
        break
      case 'more': {
        const last = this.strokes.at(-1)
        if (last) {
          last.p.push(...op.p)
          this.points += op.p.length / 2
        }
        break
      }
      case 'undo': {
        const last = this.strokes.pop()
        if (last) this.points -= last.p.length / 2
        break
      }
      case 'clear':
        this.strokes = []
        this.points = 0
        break
    }
  }

  /** 畫的人自己的動作：馬上套用、版本加一（送出去之後伺服器也會加一） */
  local(op: DrawOp) {
    this.apply(op)
    this.v++
    this.notify()
  }

  /** 畫的人正在畫的那一筆多了幾個點（還沒送出，送出時才 `sent` 加版本） */
  extend(points: number[]) {
    const last = this.strokes.at(-1)
    if (!last) return
    last.p.push(...points)
    this.points += points.length / 2
    this.notify()
  }

  /** 送出一批 `more`：點已經在 `extend` 時加上去了，只要加版本 */
  sent() {
    this.v++
  }
}
