// 賽車的聲音全部用 Web Audio 即時合成：引擎（跟著車速換檔）、越快越大聲的風切聲、甩尾的輪胎聲、撞牆、倒數和過線的提示音。
// 瀏覽器要等使用者點過畫面才肯出聲，所以第一次按「開始」時才建立 AudioContext。

type Engine = { a: OscillatorNode; b: OscillatorNode; filter: BiquadFilterNode; gain: GainNode }

/** 各檔的換檔速度（km/h） */
const GEARS = [0, 48, 85, 120, 155, 190, 260]

export class RaceAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private engine: Engine | null = null
  private skid: GainNode | null = null
  private wind: { filter: BiquadFilterNode; gain: GainNode } | null = null
  private noise: AudioBuffer | null = null
  private enabled: boolean
  private active = false

  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  /** 在使用者操作（點擊、按鍵）的事件裡呼叫 */
  unlock() {
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      this.ctx = ctx
      this.master = ctx.createGain()
      this.master.gain.value = this.enabled ? 0.55 : 0
      this.master.connect(ctx.destination)

      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.Q.value = 3
      filter.frequency.value = 600
      const gain = ctx.createGain()
      gain.gain.value = 0
      const a = ctx.createOscillator()
      a.type = 'sawtooth'
      const b = ctx.createOscillator()
      b.type = 'square'
      const bGain = ctx.createGain()
      bGain.gain.value = 0.5
      a.connect(filter)
      b.connect(bGain).connect(filter)
      filter.connect(gain).connect(this.master)
      a.start()
      b.start()
      this.engine = { a, b, filter, gain }

      // 白噪音：輪胎摩擦和撞擊共用
      const length = ctx.sampleRate
      this.noise = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = this.noise.getChannelData(0)
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
      const src = ctx.createBufferSource()
      src.buffer = this.noise
      src.loop = true
      const band = ctx.createBiquadFilter()
      band.type = 'bandpass'
      band.frequency.value = 1400
      band.Q.value = 1.2
      this.skid = ctx.createGain()
      this.skid.gain.value = 0
      src.connect(band).connect(this.skid).connect(this.master)
      src.start()

      // 風切聲：同一段噪音，濾成低沉的呼呼聲，速度越快越大聲、越尖
      const windSrc = ctx.createBufferSource()
      windSrc.buffer = this.noise
      windSrc.loop = true
      const windFilter = ctx.createBiquadFilter()
      windFilter.type = 'bandpass'
      windFilter.frequency.value = 500
      windFilter.Q.value = 0.7
      const windGain = ctx.createGain()
      windGain.gain.value = 0
      windSrc.connect(windFilter).connect(windGain).connect(this.master)
      // 從噪音中間開始，免得和輪胎聲完全同步
      windSrc.start(0, 0.5)
      this.wind = { filter: windFilter, gain: windGain }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
  }

  setEnabled(on: boolean) {
    this.enabled = on
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.05)
  }

  /** 比賽中才有引擎聲；選單和暫停時安靜 */
  setActive(on: boolean) {
    this.active = on
    if (!on && this.ctx && this.engine && this.skid) {
      this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
      this.skid.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
      this.wind?.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
    }
  }

  /** 每個畫面更新一次：速度（公尺／秒）、油門、側滑速度 */
  update(speed: number, throttle: number, slip: number, boosting: boolean) {
    const ctx = this.ctx
    if (!ctx || !this.engine || !this.skid || !this.active) return
    const kmh = Math.abs(speed) * 3.6
    let g = 0
    while (g < GEARS.length - 2 && kmh > GEARS[g + 1]) g++
    const t = Math.min(1, (kmh - GEARS[g]) / (GEARS[g + 1] - GEARS[g]))
    const rpm = (g === 0 ? 0.15 : 0.35) + t * 0.65
    const f = 38 + rpm * 120 + g * 6
    const now = ctx.currentTime
    this.engine.a.frequency.setTargetAtTime(f, now, 0.03)
    this.engine.b.frequency.setTargetAtTime(f * 0.5, now, 0.03)
    this.engine.filter.frequency.setTargetAtTime(350 + throttle * 900 + rpm * 900 + (boosting ? 600 : 0), now, 0.05)
    this.engine.gain.gain.setTargetAtTime(0.09 + throttle * 0.07 + (boosting ? 0.04 : 0), now, 0.05)
    this.skid.gain.setTargetAtTime(Math.min(1, Math.max(0, Math.abs(slip) - 2) / 10) * 0.22, now, 0.04)
    if (this.wind) {
      // 時速 60 以下幾乎聽不到，越快越大聲
      const w = Math.min(1.3, Math.max(0, kmh - 60) / 150)
      this.wind.gain.gain.setTargetAtTime(w * w * 0.2 + (boosting ? 0.05 : 0), now, 0.1)
      this.wind.filter.frequency.setTargetAtTime(450 + w * 900 + (boosting ? 300 : 0), now, 0.1)
    }
  }

  private tone(freq: number, length: number, volume: number, type: OscillatorType = 'square', at = 0) {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const t = ctx.currentTime + 0.01 + at
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = type
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(volume, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
    osc.connect(gain).connect(this.master)
    osc.start(t)
    osc.stop(t + length + 0.05)
  }

  /** 倒數：3、2、1 是低音，0（出發）是高音 */
  countdown(n: number) {
    if (n > 0) this.tone(520, 0.18, 0.18)
    else this.tone(1040, 0.5, 0.2)
  }

  lap(final: boolean) {
    const notes = final ? [784, 988, 1175, 1568] : [784, 1175]
    notes.forEach((f, i) => this.tone(f, 0.22, 0.14, 'triangle', i * 0.09))
  }

  finish() {
    ;[523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.35, 0.15, 'triangle', i * 0.1))
  }

  boost() {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(180, t)
    osc.frequency.exponentialRampToValueAtTime(520, t + 0.25)
    gain.gain.setValueAtTime(0.12, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
    osc.connect(gain).connect(this.master)
    osc.start(t)
    osc.stop(t + 0.4)
  }

  /** 撞擊：`strength` 是撞上去的速度（公尺／秒） */
  crash(strength: number) {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.noise) return
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 500 + strength * 60
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(Math.min(0.5, 0.08 + strength * 0.025), t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
    src.connect(filter).connect(gain).connect(this.master)
    src.start(t, Math.random() * 0.5)
    src.stop(t + 0.35)
  }

  dispose() {
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.master = null
    this.engine = null
    this.skid = null
    this.wind = null
  }
}
