// 機甲對戰的聲音全部用 Web Audio 即時合成：機槍、電磁砲、推進器、跳躍噴射、飛彈發射、爆炸、腳步、
// 打中的「叮」、被打中的悶響、鎖定的嗶嗶聲、換彈、偵察機的旋翼和掃描聲。別人的聲音照距離變小聲。
// 瀏覽器要等使用者點過畫面才肯出聲，所以第一次按按鈕時才建立 AudioContext。

/** 大聲的那一路的音量（一般的聲音是 0.5，還會再被壓小） */
const LOUD = 0.9

export class MechAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  /** 特別大聲的（迫擊砲、電磁砲、砲彈爆炸）走這一路：不跟其他聲音一起被壓小 */
  private loud: GainNode | null = null
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
    this.loud = ctx.createGain()
    this.loud.gain.value = this.enabled ? LOUD : 0
    const limit = ctx.createDynamicsCompressor()
    limit.threshold.value = -6
    limit.knee.value = 4
    limit.ratio.value = 16
    limit.attack.value = 0.002
    limit.release.value = 0.2
    this.loud.connect(limit).connect(ctx.destination)
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
    if (this.loud && this.ctx) this.loud.gain.setTargetAtTime(on ? LOUD : 0, this.ctx.currentTime, 0.05)
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

  /** 一陣雜訊：`delay` 秒後才出聲（回音用），`loud` 走大聲的那一路 */
  private burst(dur: number, freq: number, q: number, type: BiquadFilterType, volume: number, decay: number, delay = 0, loud = false) {
    const ctx = this.ctx
    const out = loud ? this.loud : this.master
    if (!ctx || !out || !this.noise || !this.enabled || volume <= 0.001) return
    const t = ctx.currentTime + delay
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
    src.connect(filter).connect(gain).connect(out)
    src.start(t, Math.random() * 0.5, dur)
  }

  private tone(type: OscillatorType, from: number, to: number, dur: number, volume: number, delay = 0, loud = false) {
    const ctx = this.ctx
    const out = loud ? this.loud : this.master
    if (!ctx || !out || !this.enabled || volume <= 0.001) return
    const t = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(from, t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(volume, t)
    gain.gain.exponentialRampToValueAtTime(0.0008, t + dur)
    osc.connect(gain).connect(out)
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

  /** 電磁砲一發：很響的一聲爆裂、尖銳的放電聲、低沉的轟，後面拖一段回音（傳得比機槍遠） */
  cannon(d: number) {
    if (d >= 1 && !this.gate('cannon', 40)) return
    const v = this.vol(d * 0.4)
    this.burst(0.07, 3000, 0.7, 'highpass', 0.9 * this.vol(d), 0.05, 0, true)
    this.burst(0.16, 3200, 1.2, 'bandpass', 0.6 * v, 0.13, 0, true)
    this.tone('sawtooth', 2400, 180, 0.28, 0.22 * v, 0, true)
    this.burst(0.9, 520, 0.5, 'lowpass', 1.1 * v, 0.75, 0, true)
    this.tone('sine', 130, 28, 0.7, 1.0 * v, 0, true)
    this.burst(1.0, 260, 0.5, 'lowpass', 0.4 * v, 0.9, 0.2, true)
  }

  /** 電磁砲打到東西：一聲悶重的撞擊加上碎裂聲 */
  slam(d: number) {
    if (!this.gate('slam', 40)) return
    const v = this.vol(d * 0.6)
    this.burst(0.06, 2600, 0.8, 'highpass', 0.5 * v, 0.05, 0, true)
    this.burst(0.5, 700, 0.5, 'lowpass', 0.9 * v, 0.4, 0, true)
    this.tone('sine', 150, 36, 0.35, 0.8 * v, 0, true)
    this.burst(0.5, 1800, 0.8, 'bandpass', 0.2 * v, 0.45, 0.08, true)
  }

  /**
   * 迫擊砲開砲：砲口一聲爆裂，接著很大、很低沉的一聲「碰」，後面拖著隆隆的回音。整張地圖都聽得到（再遠也有四成五的音量）。
   * 砲彈落在哪裡對方沒有任何提示，只有這一聲
   */
  mortar(d: number) {
    if (d >= 1 && !this.gate('mortar', 60)) return
    const v = Math.max(0.45, this.vol(d * 0.2))
    this.burst(0.08, 2400, 0.7, 'highpass', 1.1 * this.vol(d), 0.06, 0, true)
    this.burst(1.4, 320, 0.5, 'lowpass', 1.5 * v, 1.2, 0, true)
    this.tone('sine', 95, 24, 1.1, 1.4 * v, 0, true)
    this.tone('triangle', 170, 40, 0.35, 0.8 * v, 0, true)
    this.burst(1.2, 180, 0.5, 'lowpass', 0.7 * v, 1.1, 0.22, true)
    this.burst(1.6, 120, 0.5, 'lowpass', 0.45 * v, 1.5, 0.55, true)
  }

  /** 迫擊砲彈爆炸：比其他爆炸大很多、傳得遠，後面是隆隆的餘響和碎塊落下來的沙沙聲 */
  blast(d: number) {
    if (d >= 1 && !this.gate('blast', 60)) return
    const v = this.vol(d * 0.35)
    this.burst(0.1, 2000, 0.7, 'highpass', 1.0 * this.vol(d), 0.08, 0, true)
    this.burst(1.8, 420, 0.4, 'lowpass', 1.6 * v, 1.6, 0, true)
    this.tone('sine', 110, 22, 1.3, 1.5 * v, 0, true)
    this.tone('triangle', 200, 45, 0.4, 0.7 * v, 0, true)
    this.burst(1.6, 160, 0.5, 'lowpass', 0.8 * v, 1.5, 0.25, true)
    this.burst(1.2, 3000, 0.6, 'highpass', 0.14 * this.vol(d), 1.1, 0.5, true)
  }

  /** 變身、收回：液壓的嗡嗡聲加上卡榫扣上的一聲 */
  deploy(d: number, out: boolean) {
    if (d >= 1 && !this.gate('deploy', 120)) return
    const v = this.vol(d)
    this.tone('sawtooth', out ? 70 : 150, out ? 150 : 70, 0.7, 0.1 * v)
    this.tone('square', 46, 40, 0.5, 0.08 * v)
    this.burst(0.08, 2600, 1.6, 'bandpass', 0.4 * v, 0.07)
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
