/**
 * 時間到的提醒：Web Audio 即時合成的鈴聲（跟小遊戲的配樂一樣不用音檔，見 games/shared/music.ts），以及系統通知。
 * 鈴聲像敲鐘琴：三角波敲下去就慢慢變小，兩個音一組「叮咚」，響三次。
 */

let ctx: AudioContext | null = null

/** 要在使用者按按鈕的當下呼叫一次，之後在背景分頁時間到才放得出聲音 */
export function unlockAudio() {
  if (!ctx) {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    ctx = new Ctx()
  }
  void ctx.resume().catch(() => {})
}

function tone(c: AudioContext, freq: number, at: number, duration: number, volume: number) {
  const osc = c.createOscillator()
  const overtone = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'triangle'
  osc.frequency.value = freq
  // 高八度的泛音小聲一點，聽起來比較像鈴
  overtone.type = 'sine'
  overtone.frequency.value = freq * 2
  const overGain = c.createGain()
  overGain.gain.value = 0.3
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(volume, at + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, at + duration)
  osc.connect(gain)
  overtone.connect(overGain).connect(gain)
  gain.connect(c.destination)
  osc.start(at)
  overtone.start(at)
  osc.stop(at + duration + 0.05)
  overtone.stop(at + duration + 0.05)
}

export type Chime = 'end' | 'break'

/** end：倒數或工作時間結束（叮咚 ×3）；break：休息結束、回去工作（升三音 ×2） */
export function playChime(kind: Chime = 'end') {
  unlockAudio()
  const c = ctx
  if (!c) return
  const t = c.currentTime + 0.05
  if (kind === 'end') {
    for (let i = 0; i < 3; i++) {
      tone(c, 1046.5, t + i * 0.9, 0.9, 0.35) // C6
      tone(c, 784, t + i * 0.9 + 0.3, 1.2, 0.3) // G5
    }
  } else {
    for (let i = 0; i < 2; i++) {
      const at = t + i * 0.8
      tone(c, 659.3, at, 0.6, 0.3) // E5
      tone(c, 784, at + 0.15, 0.6, 0.3) // G5
      tone(c, 1046.5, at + 0.3, 1, 0.35) // C6
    }
  }
}

export type Permission = NotificationPermission | 'unsupported'

export const notifyPermission = (): Permission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)

/** 要在使用者操作時呼叫；已經決定過（允許或封鎖）就不再問 */
export async function askNotify(): Promise<Permission> {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

export function notify(title: string, body: string) {
  if (notifyPermission() !== 'granted') return
  try {
    const n = new Notification(title, { body, tag: 'tools-timer', icon: '/favicon.svg' })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    // Android Chrome 只能透過 Service Worker 發通知，這裡就只有聲音
  }
}
