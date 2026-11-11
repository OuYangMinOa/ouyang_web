// 機甲對戰的聲音全部用 Web Audio 即時合成：機槍、電磁砲、推進器、跳躍噴射、飛彈發射、爆炸、腳步、
// 打中的「叮」、被打中的悶響、鎖定的嗶嗶聲、換彈、偵察機的旋翼和掃描聲。別人的聲音照距離變小聲。
// 瀏覽器要等使用者點過畫面才肯出聲，所以第一次按按鈕時才建立 AudioContext。

export class MechAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private boost: { gain: GainNode; filter: BiquadFilterNode } | null = null
  private rotor: { gain: GainNode; osc: OscillatorNode } | null = null
  private enabled: boolean
  /** 同一種聲音太密時跳過（例如很多台一起開槍） */
  private readonly last = new Map<string, number>()

  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
      return
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = this.enabled ? 0.5 : 0
    const comp = ctx.createDynamicsCompressor()
    this.master.connect(comp).connect(ctx.destination)
    const length = ctx.sampleRate
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1

    // 自己推進器的呼呼聲：一直開著，衝刺時大聲
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 500
    const gain = ctx.createGain()
    gain.gain.value = 0
    src.connect(filter).connect(gain).connect(this.master)
    src.start()
    this.boost = { gain, filter }

    // 自己偵察機的旋翼：一直開著，操控偵察機時才聽得到
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = 140
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 900
    const rotorGain = ctx.createGain()
    rotorGain.gain.value = 0
    osc.connect(lp).connect(rotorGain).connect(this.master)
    osc.start()
    this.rotor = { gain: rotorGain, osc }
  }

  setEnabled(on: boolean) {
    this.enabled = on
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.05)
  }

  dispose() {
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }

  /** 距離 `d` 公尺的音量 */
  private vol(d: number) {
    return 1 / (1 + d / 25)
  }

  private gate(key: string, gap: number): boolean {
    const now = performance.now()
    if (now - (this.last.get(key) ?? 0) < gap) return false
    this.last.set(key, now)
    return true
  }

  private burst(dur: number, freq: number, q: number, type: BiquadFilterType, volume: number, decay: number) {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.noise || !this.enabled) return
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.playbackRate.value = 0.8 + Math.random() * 0.4
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = freq
    filter.Q.value = q
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(volume, t)
    gain.gain.exponentialRampToValueAtTime(0.0008, t + decay)
    src.connect(filter).connect(gain).connect(this.master)
    src.start(t, Math.random() * 0.5, dur)
  }

  private tone(type: OscillatorType, from: number, to: number, dur: number, volume: number, delay = 0) {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.enabled) return
    const t = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(from, t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(volume, t)
    gain.gain.exponentialRampToValueAtTime(0.0008, t + dur)
    osc.connect(gain).connect(this.master)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  /** 機槍一發 */
  gun(d: number) {
    if (!this.gate(d < 1 ? 'gun-me' : 'gun', d < 1 ? 0 : 45)) return
    const v = this.vol(d)
    this.burst(0.09, 1800, 0.8, 'bandpass', 0.55 * v, 0.08)
    this.tone('square', 160, 60, 0.07, 0.22 * v)
  }

  /** 電磁砲一發：尖銳的放電聲加上低沉的轟（傳得比機槍遠） */
  cannon(d: number) {
    if (d >= 1 && !this.gate('cannon', 40)) return
    const v = this.vol(d * 0.5)
    this.burst(0.6, 600, 0.5, 'lowpass', 0.9 * v, 0.5)
    this.burst(0.12, 3200, 1.2, 'bandpass', 0.45 * v, 0.1)
    this.tone('sine', 110, 32, 0.5, 0.7 * v)
    this.tone('sawtooth', 1800, 260, 0.2, 0.1 * v)
  }

  /** 迫擊砲開砲：很低沉的一聲「碰」，傳得很遠 */
  mortar(d: number) {
    if (d >= 1 && !this.gate('mortar', 60)) return
    const v = this.vol(d * 0.35)
    this.burst(0.7, 260, 0.6, 'lowpass', 1.1 * v, 0.6)
    this.tone('sine', 85, 28, 0.6, 0.9 * v)
    this.burst(0.1, 1400, 1, 'bandpass', 0.3 * v, 0.08)
  }

  /** 變身、收回：液壓的嗡嗡聲加上卡榫扣上的一聲 */
  deploy(d: number, out: boolean) {
    if (d >= 1 && !this.gate('deploy', 120)) return
    const v = this.vol(d)
    this.tone('sawtooth', out ? 70 : 150, out ? 150 : 70, 0.7, 0.1 * v)
    this.tone('square', 46, 40, 0.5, 0.08 * v)
    this.burst(0.08, 2600, 1.6, 'bandpass', 0.4 * v, 0.07)
  }

  /** 砲彈從頭上掉下來：往下滑的哨音（落點在自己附近才放） */
  whistle() {
    if (!this.gate('whistle', 900)) return
    this.tone('sine', 1500, 520, 1.4, 0.12)
  }

  /** 推進器：`level` 0～1（自己的），每一格呼叫 */
  thrust(level: number) {
    if (!this.ctx || !this.boost) return
    const t = this.ctx.currentTime
    this.boost.gain.gain.setTargetAtTime(level * 0.35, t, 0.06)
    this.boost.filter.frequency.setTargetAtTime(300 + level * 900, t, 0.08)
  }

  /** 偵察機的旋翼：`level` 0～1（自己操控的），每一格呼叫 */
  buzz(level: number) {
    if (!this.ctx || !this.rotor) return
    const t = this.ctx.currentTime
    this.rotor.gain.gain.setTargetAtTime(level * 0.05, t, 0.08)
    this.rotor.osc.frequency.setTargetAtTime(120 + level * 80, t, 0.1)
  }

  /** 放出偵察機 */
  drone(d: number) {
    const v = this.vol(d)
    this.burst(0.3, 1200, 0.8, 'bandpass', 0.35 * v, 0.25)
    this.tone('triangle', 400, 900, 0.25, 0.1 * v)
  }

  /** 偵察機的掃描波（自己的） */
  ping() {
    this.tone('sine', 1500, 1100, 0.25, 0.06)
  }

  jump(d: number) {
    const v = this.vol(d)
    this.burst(0.35, 700, 0.6, 'lowpass', 0.5 * v, 0.3)
  }

  step(d: number, heavy: number) {
    if (!this.gate(d < 1 ? 'step-me' : 'step', d < 1 ? 0 : 60)) return
    const v = this.vol(d) * (0.4 + heavy * 0.6)
    this.tone('sine', 90, 40, 0.18, 0.45 * v)
    this.burst(0.1, 300, 0.7, 'lowpass', 0.2 * v, 0.1)
  }

  missile(d: number) {
    const v = this.vol(d)
    this.burst(0.8, 900, 0.5, 'bandpass', 0.6 * v, 0.7)
    this.tone('sawtooth', 220, 880, 0.5, 0.08 * v)
  }

  explosion(d: number, big: boolean) {
    if (d >= 1 && !this.gate('boom', 60)) return
    const v = this.vol(d) * (big ? 1.3 : 1)
    this.burst(1.2, big ? 500 : 800, 0.4, 'lowpass', 0.9 * v, big ? 1.4 : 0.9)
    this.tone('sine', 120, 30, big ? 0.9 : 0.6, 0.7 * v)
  }

  /** 打中別人：清脆的一聲 */
  hitMarker() {
    if (!this.gate('hit', 50)) return
    this.tone('triangle', 1800, 1500, 0.06, 0.18)
  }

  kill() {
    this.tone('triangle', 880, 880, 0.12, 0.25)
    this.tone('triangle', 1320, 1320, 0.2, 0.25, 0.1)
  }

  /** 被打中 */
  hurt() {
    if (!this.gate('hurt', 90)) return
    this.tone('sine', 140, 60, 0.15, 0.4)
    this.burst(0.08, 2500, 1, 'highpass', 0.15, 0.06)
  }

  /** 鎖定中（`done` 是鎖定完成） */
  lock(done: boolean) {
    if (!this.gate('lock', done ? 0 : 140)) return
    this.tone('square', done ? 1400 : 1000, done ? 1400 : 1000, done ? 0.12 : 0.04, 0.06)
  }

  /** 被飛彈鎖定的警告 */
  warn() {
    if (!this.gate('warn', 260)) return
    this.tone('square', 700, 700, 0.1, 0.08)
  }

  reload() {
    this.tone('square', 300, 200, 0.05, 0.12)
    this.tone('square', 500, 400, 0.05, 0.12, 0.25)
  }

  empty() {
    if (!this.gate('empty', 200)) return
    this.tone('square', 900, 900, 0.03, 0.08)
  }

  beep(high: boolean) {
    this.tone('sine', high ? 1320 : 660, high ? 1320 : 660, high ? 0.5 : 0.15, 0.25)
  }
}
