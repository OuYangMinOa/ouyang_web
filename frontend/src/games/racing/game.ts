// 一場比賽：three.js 的畫面、固定步長的物理、電腦對手、圈數名次、鏡頭、音效。
// React 那邊只負責選單和儀表（index.tsx）：離散的事情（倒數、過線、完賽）用 `emit` 通知，
// 每個畫面的速度、時間、小地圖用 `onFrame` 給，直接改 DOM，不經過 React 重繪。
import { Color, PerspectiveCamera, Vector2, Vector3, WebGLRenderer } from 'three'
import { cruiseAi, driveAi, newAi, type AiDriver, type Difficulty } from './ai'
import { RaceAudio } from './audio'
import { CarModel, createCarParts, disposeCarParts, type CarParts } from './car'
import { Particles } from './effects'
import { Input, type PadAction, type TouchState } from './input'
import { clamp, smoothstep, wrapAngle } from './noise'
import { collideCars, driftLevel, newCar, placeCar, stepCar, type Car, type Controls } from './physics'
import { CAR } from './spec'
import { SpeedBlur, WindLines } from './speedfx'
import { TrackPath } from './track'
import type { TrackDef } from './tracks'
import { buildWorld, type World } from './world'

export const CAR_COLORS = [
  { name: '紅', hex: 0xe0393e },
  { name: '藍', hex: 0x2f6fe0 },
  { name: '黃', hex: 0xf2b705 },
  { name: '綠', hex: 0x1f9d55 },
  { name: '紫', hex: 0x8b46d8 },
  { name: '橘', hex: 0xf26b1d },
  { name: '白', hex: 0xe8e8e8 },
  { name: '黑', hex: 0x2b2b30 },
]

const AI_NAMES = ['疾風', '雷霆', '閃電', '旋風', '流星', '烈焰', '追風']

export const CAMERA_NAMES = ['追尾', '近距離', '車頂']

/**
 * 追尾鏡頭：離車多遠、多高，看向車前方多遠、多高。
 * `dolly`：視角變廣時鏡頭往前推多少（1 是車子在畫面上完全一樣大）；近距離鏡頭推太多車尾會變很大，所以少推一點
 */
const CAMS = [
  { dist: 8.4, height: 3.2, ahead: 6, look: 1.2, dolly: 0.75 },
  { dist: 5.6, height: 2.0, ahead: 8, look: 1.0, dolly: 0.35 },
]

const STEP = 1 / 120

/** 高速效果：從極速的幾成開始（風線比模糊早一點出現，集中線最晚），到極速最強 */
const WIND_FROM = 0.5
const BLUR_FROM = 0.55
const LINES_FROM = 0.72
const FX_FULL = 1.0

/** 停著時的視角（度）；開到極速再廣 `FOV_SPEED` 度，噴射時再加 `FOV_BOOST` 度 */
const BASE_FOV = 58
const FOV_SPEED = 16
const FOV_BOOST = 9

export type Phase = 'preview' | 'countdown' | 'racing' | 'finished'

export type Hint = 'wrongWay' | 'stuck' | null

export type RaceSetup = {
  track: TrackDef
  laps: number
  opponents: number
  difficulty: Difficulty
  color: number
}

export type RacerInfo = { name: string; color: number; player: boolean }

export type Standing = RacerInfo & {
  position: number
  /** 完賽時間（毫秒），還沒跑完是 null */
  time: number | null
  bestLap: number | null
  lapsDone: number
}

export type MiniMap = { d: string; viewBox: string; size: number }

export type HudFrame = {
  speedKmh: number
  raceMs: number
  lapMs: number
  lap: number
  laps: number
  position: number
  total: number
  /** 甩尾集氣到第幾段，沒在甩尾是 -1 */
  drift: number
  boost: boolean
  /** 每台車在小地圖上的位置：x0, z0, x1, z1… */
  cars: Float32Array
}

export type FinishResult = {
  track: string
  laps: number
  time: number
  bestLap: number
  lapTimes: number[]
  standings: Standing[]
}

export type RaceEvent =
  | { type: 'map'; map: MiniMap }
  | { type: 'racers'; racers: RacerInfo[] }
  | { type: 'phase'; phase: Phase }
  | { type: 'countdown'; n: number }
  | { type: 'lap'; lap: number; ms: number; best: boolean; final: boolean }
  /** 開反了，或卡在牆邊動不了：提示可以回到賽道 */
  | { type: 'hint'; hint: Hint }
  | { type: 'finish'; result: FinishResult }
  | { type: 'standings'; standings: Standing[] }
  | { type: 'pad'; action: PadAction }

type Racer = {
  car: Car
  model: CarModel
  info: RacerInfo
  ai: AiDriver | null
  ctl: Controls
  lapStart: number
  lapsDone: number
  lapTimes: number[]
  bestLap: number | null
  finish: number | null
  /** 這個畫面裡最大的撞擊力道（物理一個畫面跑好幾步） */
  impact: number
  boosting: boolean
}

const SMOKE = new Color(0xe4e4e4)
const SMOKE_NIGHT = new Color(0x8c8aa2)
const SPARK = [new Color(0xfff1b0), new Color(0x4cc9ff), new Color(0xff9a2e)]
const FLAME = new Color(0xff7a1a)
const CRASH = new Color(0xffd27a)

export class RaceGame {
  private readonly host: HTMLElement
  private readonly emit: (e: RaceEvent) => void
  private readonly onFrame: (f: HudFrame) => void
  private readonly renderer: WebGLRenderer
  private readonly camera = new PerspectiveCamera(60, 1, 0.1, 2600)
  private readonly parts: CarParts
  private readonly input = new Input()
  private readonly audio: RaceAudio
  private readonly smoke = new Particles(600, false)
  private readonly glow = new Particles(500, true)
  private readonly resize: ResizeObserver
  private readonly playerCtl: Controls = { throttle: 0, brake: 0, steer: 0, drift: false }
  private readonly frame: HudFrame
  private readonly camPos = new Vector3()
  private readonly look = new Vector3()
  private readonly dust = new Color()
  private world: World | null = null
  private track: TrackPath | null = null
  private def: TrackDef | null = null
  private racers: Racer[] = []
  private cars: Car[] = []
  private player: Racer | null = null
  private setup: RaceSetup | null = null
  private phase: Phase = 'preview'
  private countdown = 0
  private lastCount = 4
  private raceTime = 0
  private acc = 0
  private paused = false
  private raf = 0
  private last = 0
  private time = 0
  private camMode = 0
  private camH = 0
  private camReady = false
  private fov = 60
  private shake = 0
  private orbit = 0
  private focus = 0
  private wrongTime = 0
  private stuckTime = 0
  private hint: Hint = null
  private pixelRatio: number
  private slowFrames = 0
  private disposed = false
  private readonly speedBlur: SpeedBlur
  private readonly bufferSize = new Vector2()
  private readonly wind = new WindLines()
  /** 目前的模糊強度（慢慢跟上目標，不會一下子跳） */
  private blur = 0
  /** 目前的集中線強度，和讓線往外跑的時間 */
  private lines = 0
  private linesTime = 0
  /** 平滑過的前後加速度：加速時鏡頭落後一點（車子往前竄），煞車時追上來一點 */
  private surge = 0
  private prevSpeed = 0
  /** 系統設定了「減少動態效果」就不畫風線 */
  private readonly calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(host: HTMLElement, emit: (e: RaceEvent) => void, onFrame: (f: HudFrame) => void, sound: boolean) {
    this.host = host
    this.emit = emit
    this.onFrame = onFrame
    // 不支援 WebGL 時這裡會丟錯，由呼叫的人顯示訊息
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    const coarse = window.matchMedia('(pointer: coarse)').matches
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, coarse ? 1.75 : 2)
    this.renderer.setPixelRatio(this.pixelRatio)
    host.appendChild(this.renderer.domElement)
    this.speedBlur = new SpeedBlur(Math.min(4, this.renderer.capabilities.maxSamples))
    this.parts = createCarParts()
    this.audio = new RaceAudio(sound)
    this.frame = {
      speedKmh: 0,
      raceMs: 0,
      lapMs: 0,
      lap: 1,
      laps: 1,
      position: 1,
      total: 1,
      drift: -1,
      boost: false,
      cars: new Float32Array(0),
    }
    this.input.attach()
    this.resize = new ResizeObserver(() => this.fit())
    this.resize.observe(host)
    this.fit()
    this.raf = requestAnimationFrame(this.loop)
  }

  /** 手機上的觸控按鈕 */
  setTouch(patch: Partial<TouchState>) {
    Object.assign(this.input.touch, patch)
  }

  /** 選單畫面：只有電腦在跑，鏡頭繞著車轉 */
  preview(def: TrackDef) {
    this.loadTrack(def)
    this.setup = null
    this.spawn(null, 5, 'normal')
    this.paused = false
    this.input.capture = false
    this.audio.setActive(false)
    this.setPhase('preview')
    this.resume()
  }

  startRace(setup: RaceSetup) {
    this.loadTrack(setup.track)
    this.setup = setup
    this.spawn(setup.color, setup.opponents, setup.difficulty)
    this.countdown = 3
    this.lastCount = 4
    this.raceTime = 0
    this.wrongTime = 0
    this.stuckTime = 0
    this.hint = null
    this.paused = false
    this.input.reset()
    this.input.capture = true
    this.smoke.clear()
    this.glow.clear()
    this.wind.clear()
    this.audio.setActive(true)
    this.setPhase('countdown')
    this.resume()
  }

  restart() {
    if (this.setup) this.startRace(this.setup)
  }

  /** 第一次按開始時呼叫（要在使用者操作的事件裡），之後才有聲音 */
  unlockAudio() {
    this.audio.unlock()
  }

  setSound(on: boolean) {
    this.audio.setEnabled(on)
  }

  setAutoGas(on: boolean) {
    this.input.autoGas = on
  }

  setPaused(paused: boolean) {
    if (this.paused === paused || this.disposed) return
    this.paused = paused
    this.input.reset()
    this.audio.setActive(!paused && this.phase !== 'preview')
    if (paused) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
      this.render()
    } else this.resume()
  }

  cycleCamera(): number {
    this.camMode = (this.camMode + 1) % CAMERA_NAMES.length
    this.camReady = false
    return this.camMode
  }

  setCamera(mode: number) {
    this.camMode = clamp(mode, 0, CAMERA_NAMES.length - 1)
    this.camReady = false
  }

  /** 卡住或開反了：放回賽道中間 */
  respawn() {
    if (this.player && this.phase === 'racing') {
      this.reset(this.player)
      this.stuckTime = this.wrongTime = 0
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resize.disconnect()
    this.input.detach()
    this.audio.dispose()
    this.clearRacers()
    if (this.world) {
      this.world.scene.remove(this.smoke.points, this.glow.points, this.wind.mesh)
      this.world.dispose()
    }
    this.smoke.dispose()
    this.glow.dispose()
    this.wind.dispose()
    disposeCarParts(this.parts)
    this.speedBlur.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  private fit() {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    this.renderer.getDrawingBufferSize(this.bufferSize)
    this.speedBlur.setSize(this.bufferSize.x, this.bufferSize.y)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (this.paused) this.render()
  }

  private resume() {
    if (this.raf || this.disposed) return
    this.last = 0
    this.raf = requestAnimationFrame(this.loop)
  }

  private setPhase(phase: Phase) {
    this.phase = phase
    this.emit({ type: 'phase', phase })
  }

  private loadTrack(def: TrackDef) {
    if (this.world && this.def?.id === def.id) return
    this.clearRacers()
    if (this.world) {
      this.world.scene.remove(this.smoke.points, this.glow.points, this.wind.mesh)
      this.world.dispose()
    }
    this.def = def
    this.track = new TrackPath(def)
    this.world = buildWorld(this.track, def, this.renderer.capabilities.getMaxAnisotropy())
    this.world.scene.add(this.smoke.points, this.glow.points, this.wind.mesh)
    this.dust.setHex(def.theme.dust)
    this.smoke.clear()
    this.glow.clear()
    this.camReady = false
    this.emit({ type: 'map', map: this.minimap() })
  }

  private minimap(): MiniMap {
    const t = this.track!
    const pad = t.wall + 10
    const x = t.minX - pad
    const z = t.minZ - pad
    const w = t.maxX - t.minX + pad * 2
    const h = t.maxZ - t.minZ + pad * 2
    let d = ''
    for (let i = 0; i < t.n; i += 3) d += `${i ? 'L' : 'M'}${t.px[i].toFixed(1)} ${t.pz[i].toFixed(1)}`
    return { d: `${d}Z`, viewBox: `${x.toFixed(1)} ${z.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`, size: Math.max(w, h) }
  }

  private clearRacers() {
    for (const r of this.racers) {
      this.world?.scene.remove(r.model.root)
      r.model.dispose()
    }
    this.racers = []
    this.cars = []
    this.player = null
  }

  /** 排起跑格：電腦在前面（越前面越弱），玩家在最後一排 */
  private spawn(playerColor: number | null, opponents: number, difficulty: Difficulty) {
    this.clearRacers()
    const track = this.track!
    const palette = CAR_COLORS.map((c) => c.hex).filter((hex) => hex !== playerColor)
    for (let i = palette.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[palette[i], palette[j]] = [palette[j], palette[i]]
    }
    const infos: RacerInfo[] = []
    for (let i = 0; i < opponents; i++) infos.push({ name: AI_NAMES[i], color: palette[i % palette.length], player: false })
    if (playerColor !== null) infos.push({ name: '你', color: playerColor, player: true })

    infos.forEach((info, slot) => {
      const car = newCar()
      const back = 9 + Math.floor(slot / 2) * 10 + (slot % 2) * 5
      placeCar(car, track, track.length - back, slot % 2 === 0 ? 3.4 : -3.4)
      car.progress = -back
      const ai = info.player ? null : newAi(difficulty, opponents > 1 ? 1 - slot / (opponents - 1) : 0.5)
      if (ai) car.power = ai.power
      const model = new CarModel(this.parts, info.color)
      this.world!.scene.add(model.root)
      const racer: Racer = {
        car,
        model,
        info,
        ai,
        ctl: { throttle: 0, brake: 0, steer: 0, drift: false },
        lapStart: 0,
        lapsDone: 0,
        lapTimes: [],
        bestLap: null,
        finish: null,
        impact: 0,
        boosting: false,
      }
      this.racers.push(racer)
      if (info.player) this.player = racer
    })
    this.cars = this.racers.map((r) => r.car)
    this.focus = this.player ? this.racers.indexOf(this.player) : 0
    this.frame.cars = new Float32Array(this.racers.length * 2)
    this.camReady = false
    this.emit({ type: 'racers', racers: infos })
  }

  private reset(r: Racer) {
    const track = this.track!
    const lat = clamp(r.car.loc.lat, -(track.halfWidth - 2), track.halfWidth - 2)
    const progress = r.car.progress
    placeCar(r.car, track, r.car.loc.s, lat)
    r.car.progress = progress
    if (r.ai) r.ai.stuck = 0
  }

  private readonly loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0
    this.last = now
    this.watchPerformance(dt)
    this.update(dt)
    this.render()
  }

  /** 一直掉幀就降低解析度（手機、內顯） */
  private watchPerformance(dt: number) {
    if (dt > 0.026) this.slowFrames++
    else this.slowFrames = Math.max(0, this.slowFrames - 2)
    if (this.slowFrames > 90 && this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25)
      this.renderer.setPixelRatio(this.pixelRatio)
      this.fit()
      this.slowFrames = 0
    }
  }

  private render() {
    if (!this.world) return
    this.world.follow(this.camera.position)
    if (this.blur > 0.02 || this.lines > 0.02) {
      this.speedBlur.render(this.renderer, this.world.scene, this.camera, this.blur, this.lines, this.linesTime)
    } else this.renderer.render(this.world.scene, this.camera)
  }

  private update(dt: number) {
    if (!this.track || this.racers.length === 0) return
    this.time += dt
    if (this.phase === 'countdown' || this.phase === 'racing') {
      const actions: PadAction[] = []
      this.input.read(this.playerCtl, actions)
      for (const action of actions) this.emit({ type: 'pad', action })
    }
    this.acc += dt
    let steps = 0
    while (this.acc >= STEP && steps < 10) {
      this.tick(STEP)
      this.acc -= STEP
      steps++
    }
    if (steps === 10) this.acc = 0
    this.updateVisuals(dt)
    this.updateCamera(dt)
    this.updateAudio()
    if (this.phase !== 'preview') this.emitFrame()
  }

  private tick(h: number) {
    const track = this.track!
    if (this.phase === 'countdown') {
      this.countdown -= h
      const n = Math.max(0, Math.ceil(this.countdown))
      if (n !== this.lastCount) {
        this.lastCount = n
        this.audio.countdown(n)
        this.emit({ type: 'countdown', n })
        if (n === 0) this.setPhase('racing')
      }
    }
    const moving = this.phase !== 'countdown'
    const player = this.player
    for (const r of this.racers) {
      if (!moving) {
        r.ctl.throttle = r.ctl.brake = r.ctl.steer = 0
        r.ctl.drift = false
      } else if (r.ai) {
        driveAi(r.car, r.ai, track, this.cars, h, r.ctl)
        // 領先太多就放慢一點、落後太多就加把勁，比賽才不會一下子就拉開
        if (player && this.phase === 'racing' && r !== player) {
          const gap = r.car.progress - player.car.progress
          r.car.power = r.ai.power * (1 + clamp(-gap / 600, -0.05, 0.06))
        }
      } else Object.assign(r.ctl, this.playerCtl)
      stepCar(r.car, r.ctl, track, h)
    }
    if (moving) collideCars(this.cars)
    for (const r of this.racers) r.impact = Math.max(r.impact, r.car.impact)
    if (this.phase === 'racing' || this.phase === 'finished') {
      this.raceTime += h
      this.countLaps()
    }
    if (moving) this.checkStuck(h)
  }

  private countLaps() {
    const L = this.track!.length
    const laps = this.setup?.laps ?? 1
    for (const r of this.racers) {
      if (r.finish !== null) continue
      const done = Math.floor(r.car.progress / L)
      if (done <= r.lapsDone) continue
      r.lapsDone = done
      const ms = (this.raceTime - r.lapStart) * 1000
      r.lapStart = this.raceTime
      r.lapTimes.push(ms)
      const best = r.bestLap === null || ms < r.bestLap
      if (best) r.bestLap = ms
      if (done >= laps) r.finish = this.raceTime * 1000
      if (r === this.player) {
        if (r.finish !== null) this.playerFinished()
        else {
          const final = done === laps - 1
          this.audio.lap(final)
          this.emit({ type: 'lap', lap: done, ms, best: best && done > 1, final })
        }
      } else if (this.phase === 'finished' && r.finish !== null) {
        this.emit({ type: 'standings', standings: this.standings() })
      }
    }
  }

  private playerFinished() {
    const p = this.player!
    this.setPhase('finished')
    // 過線後交給電腦開，鏡頭繞著車轉
    p.ai = cruiseAi()
    p.car.power = p.ai.power
    p.car.drift = 0
    this.input.capture = false
    this.audio.finish()
    if (this.hint) {
      this.hint = null
      this.emit({ type: 'hint', hint: null })
    }
    this.emit({
      type: 'finish',
      result: {
        track: this.def!.id,
        laps: this.setup!.laps,
        time: p.finish!,
        bestLap: p.bestLap!,
        lapTimes: [...p.lapTimes],
        standings: this.standings(),
      },
    })
  }

  /** 跑完的照完賽時間排，還在跑的照進度排 */
  private standings(): Standing[] {
    const list = [...this.racers].sort((a, b) => {
      if (a.finish !== null || b.finish !== null) {
        if (a.finish === null) return 1
        if (b.finish === null) return -1
        return a.finish - b.finish
      }
      return b.car.progress - a.car.progress
    })
    return list.map((r, i) => ({
      ...r.info,
      position: i + 1,
      time: r.finish,
      bestLap: r.bestLap,
      lapsDone: Math.max(0, r.lapsDone),
    }))
  }

  private rank(r: Racer): number {
    let ahead = 0
    for (const o of this.racers) {
      if (o === r) continue
      if (o.finish !== null) {
        if (r.finish === null || o.finish < r.finish) ahead++
      } else if (r.finish === null && o.car.progress > r.car.progress) ahead++
    }
    return ahead + 1
  }

  private checkStuck(h: number) {
    for (const r of this.racers) {
      if (!r.ai) continue
      if (Math.abs(r.car.speed) < 1.5) r.ai.stuck += h
      else r.ai.stuck = 0
      if (r.ai.stuck > 2.5) this.reset(r)
    }
    const p = this.player
    if (!p || this.phase !== 'racing') return
    // 逆向：車頭和賽道方向相反而且在往前開；卡住：好幾秒都開不動（頂著牆）
    const c = p.car
    const facing = Math.sin(c.heading) * c.loc.tx + Math.cos(c.heading) * c.loc.tz
    if (facing < -0.3 && c.speed > 3) this.wrongTime += h
    else this.wrongTime = 0
    if (Math.abs(c.speed) < 2.5) this.stuckTime += h
    else this.stuckTime = 0
    const hint: Hint = this.wrongTime > 1.2 ? 'wrongWay' : this.stuckTime > 3 ? 'stuck' : null
    if (hint !== this.hint) {
      this.hint = hint
      this.emit({ type: 'hint', hint })
    }
  }

  private updateVisuals(dt: number) {
    const track = this.track!
    const night = this.def!.theme.night === true
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i]
      const c = r.car
      const rel = c.heading - Math.atan2(c.loc.tx, c.loc.tz)
      const slope = (track.heightAt(c.loc.s + 2) - track.heightAt(c.loc.s - 2)) / 4
      r.model.sync(c, slope * Math.cos(rel), dt, this.time)
      this.spawnParticles(r, dt, night, i === this.focus)
    }
    const scale = this.renderer.domElement.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360))
    this.smoke.update(dt, scale)
    this.glow.update(dt, scale)

    const light = this.world!.headlight
    const f = this.racers[this.focus]?.car
    if (light && f) {
      const sx = Math.sin(f.heading)
      const cz = Math.cos(f.heading)
      light.position.set(f.x + sx * 1.8, f.y + 1.1, f.z + cz * 1.8)
      light.target.position.set(f.x + sx * 30, f.y, f.z + cz * 30)
    }
  }

  private spawnParticles(r: Racer, dt: number, night: boolean, focus: boolean) {
    const c = r.car
    const sx = Math.sin(c.heading)
    const cz = Math.cos(c.heading)
    const chance = (rate: number) => Math.random() < rate * dt
    const sliding = c.drift !== 0 || Math.abs(c.slip) > 4
    const dusty = c.offroad && Math.abs(c.speed) > 6
    for (const side of [-1, 1]) {
      const wx = c.x - sx * 1.3 + cz * 0.88 * side
      const wz = c.z - cz * 1.3 - sx * 0.88 * side
      if ((sliding || dusty) && chance(dusty ? 40 : 30)) {
        this.smoke.emit(
          wx,
          c.y + 0.3,
          wz,
          -c.vx * 0.08 + (Math.random() - 0.5) * 2,
          0.6 + Math.random() * 0.8,
          -c.vz * 0.08 + (Math.random() - 0.5) * 2,
          dusty ? this.dust : night ? SMOKE_NIGHT : SMOKE,
          1.1,
          2.8,
          0.9,
          dusty ? 0.5 : 0.32,
        )
      }
      if (c.drift !== 0 && chance(45)) {
        const level = driftLevel(c)
        this.glow.emit(
          wx,
          c.y + 0.15,
          wz,
          (Math.random() - 0.5) * 4 - c.vx * 0.15,
          1 + Math.random() * 2.5,
          (Math.random() - 0.5) * 4 - c.vz * 0.15,
          SPARK[level],
          level === 0 ? 0.18 : 0.32,
          -0.2,
          0.22,
          1,
        )
      }
    }
    if (c.boost > 0 && chance(70)) {
      this.glow.emit(
        c.x - sx * 2.4 + (Math.random() - 0.5) * 0.6,
        c.y + 0.45,
        c.z - cz * 2.4 + (Math.random() - 0.5) * 0.6,
        c.vx * 0.6 - sx * 6,
        0.5,
        c.vz * 0.6 - cz * 6,
        FLAME,
        0.7,
        1.6,
        0.18,
        0.9,
      )
    }
    if (c.boost > 0 && !r.boosting && focus) this.audio.boost()
    r.boosting = c.boost > 0

    if (r.impact > 3) {
      const side = Math.abs(c.loc.lat) > this.track!.wall - 2 ? Math.sign(c.loc.lat) : 0
      const px = c.x + c.loc.tz * side
      const pz = c.z - c.loc.tx * side
      const n = Math.min(24, Math.round(r.impact * 1.5))
      for (let k = 0; k < n; k++) {
        this.glow.emit(
          px,
          c.y + 0.6,
          pz,
          (Math.random() - 0.5) * 9,
          Math.random() * 5,
          (Math.random() - 0.5) * 9,
          CRASH,
          0.22,
          0,
          0.25 + Math.random() * 0.3,
          1,
        )
      }
      if (focus) {
        this.shake = Math.min(0.5, this.shake + r.impact * 0.03)
        this.audio.crash(r.impact)
      }
    }
    r.impact = 0
  }

  private updateCamera(dt: number) {
    const r = this.racers[this.focus]
    if (!r) return
    const c = r.car
    const cam = this.camera
    const orbiting = this.phase === 'preview' || this.phase === 'finished'
    const live = this.phase === 'countdown' || this.phase === 'racing'
    const k = (rate: number) => (this.camReady ? 1 - Math.exp(-rate * dt) : 1)
    const speedT = clamp(Math.abs(c.speed) / CAR.maxSpeed, 0, 1.3)
    const boosting = c.boost > 0

    // 視角：越快越廣、噴射時再拉開（拉開得快、收回得慢，噴射一開就像被往後扯）
    const fovTarget = orbiting ? 50 : BASE_FOV + speedT * FOV_SPEED + (boosting ? FOV_BOOST : 0)
    this.fov += (fovTarget - this.fov) * k(fovTarget > this.fov ? 6 : 2.5)
    const shown = this.screenFov(this.fov)
    // 推軌變焦：視角變廣的同時鏡頭往車子推近，車子在畫面上差不多一樣大，只有四周的景物被拉開、往後衝
    const zoom = orbiting ? 1 : Math.tan((this.screenFov(BASE_FOV) * Math.PI) / 360) / Math.tan((shown * Math.PI) / 360)
    const accel = this.camReady && dt > 0 ? (c.speed - this.prevSpeed) / dt : 0
    this.prevSpeed = c.speed
    this.surge += (clamp(accel, -10, 24) - this.surge) * k(3)

    if (orbiting) {
      this.orbit += dt * 0.2
      const a = c.heading + Math.PI + Math.sin(this.orbit) * 1.25
      const dist = 11 + Math.sin(this.orbit * 0.7) * 2
      this.look.set(c.x + Math.sin(a) * dist, c.y + 3.4, c.z + Math.cos(a) * dist)
      this.camPos.lerp(this.look, k(3))
      cam.position.copy(this.camPos)
      cam.lookAt(c.x, c.y + 1, c.z)
    } else if (this.camMode === 2) {
      // 車頂視角：鏡頭幾乎固定在車上
      this.camH = c.heading
      const sx = Math.sin(c.heading)
      const cz = Math.cos(c.heading)
      this.camPos.set(c.x + sx * 0.1, c.y + 1.5, c.z + cz * 0.1)
      cam.position.copy(this.camPos)
      cam.lookAt(c.x + sx * 22, this.track!.heightAt(c.loc.s + 22) + 0.9, c.z + cz * 22)
    } else {
      const cfg = CAMS[this.camMode]
      let want = c.heading
      // 甩尾時鏡頭看向車子滑行的方向，畫面才看得到車身打橫
      if (c.speed > 4) want += wrapAngle(Math.atan2(c.vx, c.vz) - c.heading) * 0.5
      if (!this.camReady) this.camH = want
      this.camH = wrapAngle(this.camH + wrapAngle(want - this.camH) * k(6))
      const fx = Math.sin(this.camH)
      const fz = Math.cos(this.camH)
      const push = zoom ** cfg.dolly
      const dist = cfg.dist * push + this.surge * 0.07
      const height = cfg.look + (cfg.height - cfg.look) * push
      this.look.set(c.x - fx * dist, c.y + height, c.z - fz * dist)
      // 位置平滑會讓鏡頭落後「速度 ÷ 平滑係數」那麼遠（極速時多 4 公尺，車子變很小、反而不覺得快），往前補回去
      const a = k(14)
      // 暫停後繼續的第一格 dt 是 0（a 也是 0）：不補，不然 0 ÷ 0 會讓鏡頭位置變成 NaN、畫面全黑
      const lead = a > 0 && a < 1 ? ((1 - a) / a) * dt : 0
      this.look.x += c.vx * lead
      this.look.z += c.vz * lead
      this.camPos.lerp(this.look, a)
      cam.position.copy(this.camPos)
      cam.lookAt(c.x + fx * cfg.ahead, c.y + cfg.look, c.z + fz * cfg.ahead)
    }
    this.camReady = true

    if (this.shake > 0.005) {
      cam.position.x += (Math.random() - 0.5) * this.shake
      cam.position.y += (Math.random() - 0.5) * this.shake
      this.shake *= Math.exp(-8 * dt)
    } else this.shake = 0

    // 高速效果（只在比賽中，選單和跑完後的繞車鏡頭不要）：左右糊掉、車頭的風線、畫面外圍的集中線
    const blurT = live ? smoothstep(BLUR_FROM, FX_FULL, speedT) : 0
    const blurTarget = Math.min(1.3, blurT + (boosting && blurT > 0 ? 0.35 : 0))
    this.blur += (blurTarget - this.blur) * k(5)
    const windT = live && !this.calm ? smoothstep(WIND_FROM, FX_FULL, speedT) : 0
    // 風線流到鏡頭前一點就要消失，不然會從鏡頭旁邊整條刷過去
    const behind = (c.x - cam.position.x) * Math.sin(c.heading) + (c.z - cam.position.z) * Math.cos(c.heading)
    this.wind.update(dt, c, windT, boosting, this.camMode === 2, this.camMode === 2 ? Infinity : behind - 1.6)
    const linesTarget =
      live && !this.calm
        ? Math.min(1, smoothstep(LINES_FROM, FX_FULL, speedT) * 0.45 + (boosting ? 0.75 * smoothstep(0.2, 0.45, speedT) : 0))
        : 0
    this.lines += (linesTarget - this.lines) * k(linesTarget > this.lines ? 8 : 3)
    this.linesTime += dt * (0.5 + speedT)

    cam.fov = shown
    cam.updateProjectionMatrix()
  }

  /** 直式螢幕放寬視角，左右才看得到路 */
  private screenFov(fov: number) {
    const aspect = this.camera.aspect
    if (aspect >= 1.3) return fov
    const t = Math.tan((fov * Math.PI) / 360) * (1.3 / aspect) ** 0.6
    return Math.min(100, (Math.atan(t) * 360) / Math.PI)
  }

  private updateAudio() {
    if (this.paused || this.phase === 'preview') return
    const r = this.racers[this.focus]
    if (!r) return
    const c = r.car
    // 倒數時踩油門會空催
    if (this.phase === 'countdown') this.audio.update(this.playerCtl.throttle * 22, this.playerCtl.throttle, 0, false)
    else this.audio.update(c.speed, c.throttle, c.slip, c.boost > 0)
  }

  private emitFrame() {
    const r = this.player ?? this.racers[this.focus]
    const c = r.car
    const f = this.frame
    f.speedKmh = Math.abs(c.speed) * 3.6
    f.raceMs = this.raceTime * 1000
    f.lapMs = r.finish !== null ? (r.lapTimes.at(-1) ?? 0) : (this.raceTime - r.lapStart) * 1000
    f.laps = this.setup?.laps ?? 1
    f.lap = Math.min(f.laps, r.lapsDone + 1)
    f.position = this.rank(r)
    f.total = this.racers.length
    f.drift = c.drift !== 0 ? driftLevel(c) : -1
    f.boost = c.boost > 0
    for (let i = 0; i < this.racers.length; i++) {
      f.cars[i * 2] = this.racers[i].car.x
      f.cars[i * 2 + 1] = this.racers[i].car.z
    }
    this.onFrame(f)
  }
}
