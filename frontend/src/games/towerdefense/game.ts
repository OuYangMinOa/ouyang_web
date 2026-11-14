import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DynamicDrawUsage,
  Euler,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three'
import { TdAudio, type Sound } from './audio'
import { Effects } from './fx'
import { MONSTER_LOOK, monsterGeometry, rockGeometry, TOWER_LOOK, towerBase, towerHead } from './models'
import {
  decodeMonsters,
  tileAt,
  wouldSeal,
  type MapSpec,
  type MonsterState,
  type Spec,
  type TdView,
  type TickEvent,
  type TowerEvent,
  type TowerId,
  type TowerRow,
} from './online'

/**
 * 迷宮塔防的畫面（Three.js）。模擬在伺服器，這裡只負責畫和點：
 *
 * - **場地**是一塊浮在網頁底色上的棋盤（顏色讀 `index.css` 的 `--td-*`，換主題會跟著換）。
 *   一格是 1 個單位，場地中心在原點，x 往右、z 往下（對應格子的 x、y）。
 * - **怪物**：伺服器每 0.1 秒送一次所有怪物的位置（`onTick`），畫面刻意慢 `DELAY` 個 tick，
 *   在前後兩次快照之間內插，網路忽快忽慢時怪物也不會一頓一頓。開火、打倒的特效跟著同一條時間軸播。
 * - **塔**：view 裡有全部的塔，之後的變化走 `tower` 事件；用 `rev` 接起來（見 `sync`、`onTower`）。
 * - 塔和怪物同一種的用 InstancedMesh 一次畫完，血條另外畫在疊在上面的 2D 畫布上。
 * - **操作**：點一下選塔／選格子（選了塔種就是蓋塔），拖曳平移，滾輪或兩指縮放，右鍵（或兩指轉）旋轉。
 *   點了什麼、要蓋在哪用 `emit` 告訴外面，真正送出動作的是 `index.tsx`。
 */

export type GameEvent =
  /** 每個 tick 的錢、生命、怪物數、打倒幾隻 */
  | { type: 'stats'; gold: number[]; lives: number[]; counts: number[]; kills: number[] }
  /** 選到一座塔、一個空格，或都沒選 */
  | { type: 'pick'; tower: number | null; cell: number | null }
  /** 想在這一格蓋現在選的那種塔 */
  | { type: 'build'; cell: number }
  /** 按了右鍵：取消蓋塔、取消選取 */
  | { type: 'cancel' }
  /** 這一格不能蓋 */
  | { type: 'deny'; reason: string }
  /** 正在看的場地的塔變了（選取的那座可能升級了、被拆了） */
  | { type: 'towers' }
  /** 正在看的場地漏了怪 */
  | { type: 'leak' }

export type TowerInfo = { id: number; cell: number; kind: number; level: number; owner: number; mode: number }

type Tower = TowerInfo & {
  yaw: number
  /** 正在瞄準的怪物 id */
  aim: number
  bornAt: number
  firedAt: number
  boostAt: number
}

type FieldState = {
  /** -1 是還沒從 view 拿到 */
  rev: number
  towers: Map<number, Tower>
  byCell: Map<number, number>
  paths: number[][]
}

type Ent = {
  id: number
  kind: number
  /** 目前所在的快照裡的位置（格子座標） */
  x: number
  y: number
  hp: number
  slowed: boolean
  poisoned: boolean
  sent: boolean
  /** 畫出來的位置（世界座標）和朝向 */
  wx: number
  wy: number
  wz: number
  yaw: number
  bornAt: number
  hurtAt: number
}

type Snap = { n: number; mons: Map<number, MonsterState>; shots: number[][]; leaks: number[] }

type Theme = {
  dark: boolean
  bg: Color
  board: Color
  tileA: string
  tileB: string
  line: string
  walk: string
  rockTile: string
  path: Color
  air: Color
  spawn: Color
  exit: Color
  ok: Color
  bad: Color
  text: string
  surface: string
  okCss: string
  badCss: string
  warnCss: string
  owners: Color[]
}

const TICK_MS = 100
/** 畫面比伺服器慢幾個 tick（拿來內插） */
const DELAY = 1.7
const TOWER_CAP = 420
const MONSTER_CAP = 400
const SHADOW_CAP = 700
const ARROW_CAP = 900
const TILE_PX = 48
const DEG = Math.PI / 180

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** 轉到 `to` 最短的那一邊，一次最多轉 `step` */
function turnToward(from: number, to: number, step: number): number {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return from + clamp(d, -step, step)
}

/** 蓋好、升級時「彈」出來的大小：衝過頭再回來 */
function pop(t: number): number {
  if (t >= 1) return 1
  const c = 1.70158
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2
}

/** 讓瀏覽器把任何 CSS 顏色（包含 `rgb(1 2 3 / 0.5)`）換成 Three.js 看得懂的寫法 */
function normalize(css: string, fallback: string): string {
  const ctx = (normalize.ctx ??= document.createElement('canvas').getContext('2d'))
  if (!ctx) return fallback
  ctx.fillStyle = fallback
  ctx.fillStyle = css.trim() || fallback
  return ctx.fillStyle
}
normalize.ctx = null as CanvasRenderingContext2D | null

function readTheme(): Theme {
  const style = getComputedStyle(document.documentElement)
  const css = (name: string, fallback: string) => normalize(style.getPropertyValue(name), fallback)
  const color = (name: string, fallback: string) => new Color().setStyle(css(name, fallback))
  const bg = color('--bg', '#f4f0e8')
  return {
    dark: bg.r * 0.3 + bg.g * 0.6 + bg.b * 0.1 < 0.2,
    bg,
    board: color('--td-board', '#bfae8c'),
    tileA: css('--td-tile-a', '#b9c98a'),
    tileB: css('--td-tile-b', '#aebf7f'),
    line: css('--td-tile-line', '#8fa268'),
    walk: css('--td-walk', '#d9c8a0'),
    rockTile: css('--td-rock-tile', '#a39f96'),
    path: color('--accent', '#c2410c'),
    air: color('--td-air', '#6b7fd6'),
    spawn: color('--td-spawn', '#7c3aed'),
    exit: color('--td-exit', '#0f766e'),
    ok: color('--ok', '#2f7d4f'),
    bad: color('--danger', '#be123c'),
    text: css('--text-h', '#1c1a17'),
    surface: css('--surface', '#fbf8f2'),
    okCss: css('--ok', '#2f7d4f'),
    badCss: css('--danger', '#be123c'),
    warnCss: css('--accent', '#c2410c'),
    owners: Array.from({ length: 8 }, (_, i) => color(`--td-p${i}`, '#888888')),
  }
}

export class TdGame {
  private readonly host: HTMLElement
  private readonly spec: Spec
  private readonly emit: (e: GameEvent) => void
  private readonly renderer: WebGLRenderer
  private readonly overlay: HTMLCanvasElement
  private readonly pen: CanvasRenderingContext2D | null
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(38, 1, 0.5, 400)
  private readonly sun = new DirectionalLight(0xffffff, 2.4)
  private readonly sky = new HemisphereLight(0xffffff, 0x8a8478, 1.1)
  private readonly fx: Effects
  private readonly audio: TdAudio
  private readonly resizer: ResizeObserver
  private readonly themeWatch: MutationObserver
  private readonly schemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
  private readonly coarse = window.matchMedia('(pointer: coarse)').matches
  private theme = readTheme()
  private raf = 0
  private last = 0
  private time = 0
  private disposed = false
  private pixelRatio: number
  private slowFrames = 0

  // 場地
  private map: MapSpec | null = null
  private board: Group | null = null
  private boardTexture: CanvasTexture | null = null
  /** 會動的擺設：入口的光環、出口的水晶（每秒轉幾弧度、上下飄多少） */
  private readonly decor: { mesh: Mesh; spin: number; bob: number; y: number; phase: number }[] = []
  private readonly solid = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0.05 })
  private readonly glow = new MeshBasicMaterial({ vertexColors: true })
  private readonly misty = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.6,
    transparent: true,
    opacity: 0.8,
  })
  private readonly ghostly = new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false })
  private readonly bases: InstancedMesh[] = []
  private readonly heads: InstancedMesh[] = []
  private readonly bands: InstancedMesh
  private readonly pips: InstancedMesh
  private readonly bodies: InstancedMesh[] = []
  private readonly shadows: InstancedMesh
  private readonly arrows: InstancedMesh
  private readonly tileMark: Mesh
  private readonly rangeRing: Mesh
  private readonly rangeFill: Mesh
  private readonly selectRing: Mesh
  private readonly ghostBase: Mesh
  private readonly ghostHead: Mesh

  // 狀態
  private fields: FieldState[] = []
  private pendingTowers: TowerEvent[] = []
  private look = 0
  private myField: number | null = null
  private game = -1
  private speed = 1
  private showAir = false
  private preview = true
  private readonly ents = new Map<number, Ent>()
  private queue: Snap[] = []
  private base: Snap | null = null
  /** `performance.now()` 減掉「tick 數 × 100 毫秒」：照它把現在換算成伺服器的 tick */
  private clock: number | null = null
  private lives = -1

  // 操作
  private buildKind: TowerId | null = null
  private selectedTower: number | null = null
  private selectedCell: number | null = null
  private hoverCell: number | null = null
  /** 觸控：先點一下預覽、再點同一格才蓋 */
  private armedCell: number | null = null
  private readonly pointers = new Map<number, { x: number; y: number; sx: number; sy: number; moved: boolean; button: number; touch: boolean }>()
  private pinch: { dist: number; angle: number; cx: number; cy: number } | null = null
  private readonly cam = { tx: 0, tz: 0, yaw: 0, pitch: 56 * DEG, dist: 30 }
  private fitDist = 30
  private camTouched = false
  /** 對戰時畫面上面、下面被介面蓋住多少（像素）：場地要放在中間剩下的那一塊 */
  private insets = { top: 70, bottom: 150 }

  // 算東西用的暫存
  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly plane = new Plane(new Vector3(0, 1, 0), 0)
  private readonly hit = new Vector3()
  private readonly hit2 = new Vector3()
  private readonly m = new Matrix4()
  private readonly m2 = new Matrix4()
  private readonly p = new Vector3()
  private readonly s = new Vector3()
  private readonly q = new Quaternion()
  private readonly e = new Euler()
  private readonly c = new Color()

  constructor(host: HTMLElement, spec: Spec, emit: (e: GameEvent) => void, sound: boolean) {
    this.host = host
    this.spec = spec
    this.emit = emit
    // 不支援 WebGL 時這裡會丟錯，由呼叫的人顯示訊息
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.coarse ? 1.75 : 2)
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.shadowMap.enabled = !this.coarse
    host.appendChild(this.renderer.domElement)
    this.overlay = document.createElement('canvas')
    this.overlay.className = 'td-overlay'
    host.appendChild(this.overlay)
    this.pen = this.overlay.getContext('2d')
    this.audio = new TdAudio(sound)
    this.fx = new Effects(this.scene)

    this.sun.castShadow = !this.coarse
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.03
    this.scene.add(this.sun, this.sun.target, this.sky)

    // 塔：每一種一組「底座」和「頭」，再加上顯示主人的色環和等級的小珠子
    for (const t of spec.towers) {
      const look = TOWER_LOOK[t.id]
      this.bases.push(this.instanced(towerBase(t.id), this.solid, TOWER_CAP, true))
      this.heads.push(this.instanced(towerHead(t.id), look.glow ? this.glow : this.solid, TOWER_CAP, !look.glow))
    }
    this.bands = this.instanced(
      new TorusGeometry(0.43, 0.05, 6, 20).rotateX(Math.PI / 2),
      new MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 }),
      TOWER_CAP,
      false,
    )
    this.pips = this.instanced(new SphereGeometry(0.06, 8, 6), new MeshBasicMaterial({ color: 0xffd23f }), TOWER_CAP * 4, false)
    for (const mon of spec.monsters) {
      const look = MONSTER_LOOK[mon.id]
      this.bodies.push(this.instanced(monsterGeometry(mon.id), look.ghost ? this.misty : this.solid, MONSTER_CAP, !look.ghost))
    }
    this.shadows = this.instanced(
      new CircleGeometry(1, 16).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.2, depthWrite: false }),
      SHADOW_CAP,
      false,
    )
    this.shadows.renderOrder = 1
    const arrow = new BufferGeometry()
    arrow.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0.15, 0.12, 0, -0.1, -0.12, 0, -0.1]), 3))
    arrow.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3))
    this.arrows = this.instanced(arrow, new MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false }), ARROW_CAP, false)
    this.arrows.renderOrder = 2

    const flat = (geometry: BufferGeometry, opacity: number, order: number) => {
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ transparent: true, opacity, depthWrite: false }))
      mesh.visible = false
      mesh.renderOrder = order
      this.scene.add(mesh)
      return mesh
    }
    this.tileMark = flat(new PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2), 0.5, 3)
    this.rangeRing = flat(new RingGeometry(0.975, 1, 72).rotateX(-Math.PI / 2), 0.9, 4)
    this.rangeFill = flat(new CircleGeometry(1, 72).rotateX(-Math.PI / 2), 0.1, 3)
    this.selectRing = flat(new RingGeometry(0.5, 0.58, 32).rotateX(-Math.PI / 2), 0.95, 4)
    this.ghostBase = new Mesh(new BufferGeometry(), this.ghostly)
    this.ghostHead = new Mesh(new BufferGeometry(), this.ghostly)
    this.ghostBase.visible = this.ghostHead.visible = false
    this.scene.add(this.ghostBase, this.ghostHead)

    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', this.onDown)
    canvas.addEventListener('pointermove', this.onMove)
    canvas.addEventListener('pointerup', this.onUp)
    canvas.addEventListener('pointercancel', this.onCancel)
    canvas.addEventListener('pointerleave', this.onLeave)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onMenu)

    this.themeWatch = new MutationObserver(() => this.applyTheme())
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-style'] })
    this.schemeQuery.addEventListener('change', this.onScheme)
    this.resizer = new ResizeObserver(() => this.resize())
    this.resizer.observe(host)
    this.applyTheme()
    this.resize()
    this.raf = requestAnimationFrame(this.loop)
  }

  private instanced(geometry: BufferGeometry, material: Material, capacity: number, shadow: boolean): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.setColorAt(0, this.c.setRGB(1, 1, 1))
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.castShadow = shadow
    mesh.receiveShadow = shadow
    this.scene.add(mesh)
    return mesh
  }

  // ---------- 外面呼叫的 ----------

  /** 換地圖：重做棋盤、岩石、入口和出口 */
  setMap(id: string) {
    const map = this.spec.maps.find((m) => m.id === id) ?? this.spec.maps[0]
    if (!map || map === this.map) return
    this.map = map
    this.buildBoard()
    this.camTouched = false
    this.fit()
  }

  /** 選單時棋盤慢慢轉、放在整個畫面的正中間 */
  setPreview(on: boolean) {
    if (this.preview === on) return
    this.preview = on
    this.camTouched = false
    this.fit()
    if (on) {
      this.reset()
      this.buildKind = null
      this.selectedTower = this.selectedCell = this.armedCell = this.hoverCell = null
    }
  }

  private reset() {
    this.fields = []
    this.pendingTowers = []
    this.ents.clear()
    this.queue = []
    this.base = null
    this.clock = null
    this.lives = -1
    this.fx.clear()
  }

  /** 收到 view：新的一局就整個重來，不然把比較新的塔接上去 */
  sync(view: TdView) {
    if (view.game !== this.game) {
      this.game = view.game
      this.reset()
      this.fields = view.fields.map(() => ({ rev: -1, towers: new Map(), byCell: new Map(), paths: [] }))
      this.selectedTower = this.selectedCell = this.armedCell = null
      // 之後要看哪一塊由外面決定（`setLook`）；view 是經過 React 才到的，可能比剛按的那一下舊
      this.look = view.look !== null && view.look < view.fields.length ? view.look : 0
    }
    this.setMap(view.map)
    this.myField = view.you !== null ? (view.players[view.you]?.field ?? null) : null
    this.speed = view.speed
    view.fields.forEach((fv, fi) => {
      const field = this.fields[fi]
      // view 是經過 React 才到這裡的，可能比已經處理過的事件舊
      if (!field || fv.rev < field.rev) return
      const before = field.towers
      field.towers = new Map()
      field.byCell = new Map()
      for (const row of fv.towers) this.putTower(field, row, before.get(row[0]))
      field.paths = fv.paths
      field.rev = fv.rev
    })
    const waiting = this.pendingTowers
    this.pendingTowers = []
    for (const e of waiting) this.onTower(e)
    this.emit({ type: 'towers' })
  }

  private putTower(field: FieldState, row: TowerRow, old: Tower | undefined) {
    const [id, cell, kind, level, owner, mode] = row
    const now = performance.now()
    field.towers.set(id, {
      id,
      cell,
      kind,
      level,
      owner,
      mode,
      yaw: old?.yaw ?? 0,
      aim: old?.aim ?? -1,
      bornAt: old?.bornAt ?? now - 1000,
      firedAt: old?.firedAt ?? -1e9,
      boostAt: old?.boostAt ?? -1e9,
    })
    field.byCell.set(cell, id)
  }

  onTower(e: TowerEvent) {
    const field = this.fields[e.f]
    if (!field || field.rev < 0) {
      // 這一局的 view 還沒到：先留著
      this.pendingTowers.push(e)
      return
    }
    if (e.rev <= field.rev) return
    field.rev = e.rev
    const [id, cell] = e.t
    const shown = e.f === this.look
    const [x, z] = this.cellCenter(cell)
    if (e.op === 'sell') {
      field.towers.delete(id)
      field.byCell.delete(cell)
      if (shown) {
        this.fx.ring(x, z, 0.7, 0xf2e6c8, 0.35)
        this.fx.burst([x, 0.4, z], 0x9a948a, 8, 2.2, 0.1)
        this.audio.play('sell')
        if (this.selectedTower === id) this.select(null, null)
      }
    } else {
      const old = field.towers.get(id)
      this.putTower(field, e.t, old)
      const tower = field.towers.get(id)!
      const now = performance.now()
      if (e.op === 'add') {
        tower.bornAt = now
        if (shown) {
          this.fx.ring(x, z, 0.8, 0xffffff, 0.4)
          this.audio.play('build')
        }
      } else if (e.op === 'up') {
        tower.boostAt = now
        if (shown) {
          this.fx.rise(x, z, 0xffd23f, 8)
          this.fx.ring(x, z, 0.9, 0xffd23f, 0.45)
          this.audio.play('upgrade')
        }
      }
    }
    if (e.paths) field.paths = e.paths
    if (shown) this.emit({ type: 'towers' })
  }

  onTick(e: TickEvent) {
    this.emit({ type: 'stats', gold: e.g, lives: e.l, counts: e.c, kills: e.k })
    if (e.f !== this.look) return
    const at = performance.now()
    const sample = at - e.n * TICK_MS
    // 取最早到的那一次當基準（最接近真正的時間），再慢慢跟上時鐘的飄移；伺服器停住過（沒人在線）就重來
    if (this.clock === null || sample < this.clock || sample > this.clock + 1500) this.clock = sample
    else this.clock += Math.min(sample - this.clock, 0.5)
    const mons = new Map<number, MonsterState>()
    for (const m of decodeMonsters(e.m)) mons.set(m.id, m)
    this.queue.push({ n: e.n, mons, shots: e.s ?? [], leaks: e.x ?? [] })
    const lives = e.l[this.look] ?? 0
    if (this.lives >= 0 && lives < this.lives) this.emit({ type: 'leak' })
    this.lives = lives
  }

  /** 換一塊場地看（對抗模式）：怪物從下一個 tick 重新收 */
  setLook(field: number) {
    if (field === this.look) return
    this.look = field
    this.ents.clear()
    this.queue = []
    this.base = null
    this.lives = -1
    this.fx.clear()
    this.select(null, null)
    this.emit({ type: 'towers' })
  }

  setBuild(kind: TowerId | null) {
    this.buildKind = kind
    this.armedCell = null
    if (kind) {
      this.selectedTower = null
      const index = this.spec.towers.findIndex((t) => t.id === kind)
      this.ghostBase.geometry = this.bases[index].geometry
      this.ghostHead.geometry = this.heads[index].geometry
    }
  }

  select(tower: number | null, cell: number | null) {
    const changed = tower !== this.selectedTower || cell !== this.selectedCell
    this.selectedTower = tower
    this.selectedCell = cell
    if (changed) this.emit({ type: 'pick', tower, cell })
  }

  /** 現在選到的那座塔（每次給一份新的，升級了外面才看得出來） */
  picked(): TowerInfo | null {
    const t = this.selectedTower !== null ? this.fields[this.look]?.towers.get(this.selectedTower) : undefined
    return t ? { id: t.id, cell: t.cell, kind: t.kind, level: t.level, owner: t.owner, mode: t.mode } : null
  }

  /** 這一格現在能不能蓋（只是先擋一下，伺服器會再檢查）：回傳不能蓋的原因 */
  blockedReason(cell: number): string | null {
    const field = this.fields[this.look]
    if (!this.map || !field) return '還沒準備好'
    if (this.myField !== this.look) return '這不是你的場地'
    if (tileAt(this.map, cell) !== 'ground') return '這一格不能蓋塔'
    if (field.byCell.has(cell)) return '這一格已經有塔了'
    if (wouldSeal(this.map, (c) => field.byCell.has(c), cell)) return '不能把路完全堵死'
    return null
  }

  /** 上面的資源列、下面的商店各佔多高（外面量好告訴這裡）；還沒動過鏡頭就重新擺一次 */
  setInsets(top: number, bottom: number) {
    if (Math.abs(top - this.insets.top) < 4 && Math.abs(bottom - this.insets.bottom) < 4) return
    this.insets = { top, bottom }
    if (!this.camTouched) this.fit()
  }

  setAirHint(on: boolean) {
    this.showAir = on
  }

  setSound(on: boolean) {
    this.audio.setEnabled(on)
  }

  unlockAudio() {
    this.audio.unlock()
  }

  play(sound: Sound) {
    this.audio.play(sound)
  }

  /** 鍵盤操作鏡頭：平移（格）、旋轉（弧度）、縮放（倍率） */
  nudge(right: number, forward: number) {
    const { yaw } = this.cam
    this.cam.tx += Math.cos(yaw) * right - Math.sin(yaw) * forward
    this.cam.tz += -Math.sin(yaw) * right - Math.cos(yaw) * forward
    this.camTouched = true
    this.clampCamera()
  }

  turn(by: number) {
    this.cam.yaw += by
    this.camTouched = true
  }

  zoom(factor: number) {
    this.cam.dist *= factor
    this.camTouched = true
    this.clampCamera()
  }

  resetView() {
    this.camTouched = false
    this.fit()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resizer.disconnect()
    this.themeWatch.disconnect()
    this.schemeQuery.removeEventListener('change', this.onScheme)
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onDown)
    canvas.removeEventListener('pointermove', this.onMove)
    canvas.removeEventListener('pointerup', this.onUp)
    canvas.removeEventListener('pointercancel', this.onCancel)
    canvas.removeEventListener('pointerleave', this.onLeave)
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('contextmenu', this.onMenu)
    this.audio.dispose()
    this.fx.dispose()
    this.clearBoard()
    this.scene.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose()
        const material = o.material as Material | Material[]
        for (const m of Array.isArray(material) ? material : [material]) m.dispose()
      }
    })
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    canvas.remove()
    this.overlay.remove()
  }

  // ---------- 場地 ----------

  private cellCenter(cell: number): [number, number] {
    const map = this.map
    if (!map) return [0, 0]
    return [(cell % map.w) + 0.5 - map.w / 2, Math.floor(cell / map.w) + 0.5 - map.h / 2]
  }

  private clearBoard() {
    if (!this.board) return
    this.scene.remove(this.board)
    this.board.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose()
        const material = o.material as Material | Material[]
        for (const m of Array.isArray(material) ? material : [material]) if (m !== this.solid) m.dispose()
      }
    })
    this.boardTexture?.dispose()
    this.board = null
    this.boardTexture = null
    this.decor.length = 0
  }

  private buildBoard() {
    const map = this.map
    if (!map) return
    this.clearBoard()
    const t = this.theme
    const group = new Group()
    const { w, h } = map

    // 棋盤面：一張畫布貼圖
    const canvas = document.createElement('canvas')
    canvas.width = w * TILE_PX
    canvas.height = h * TILE_PX
    this.boardTexture = new CanvasTexture(canvas)
    this.boardTexture.colorSpace = SRGBColorSpace
    this.boardTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    this.paintBoard()
    const top = new Mesh(
      new PlaneGeometry(w, h).rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ map: this.boardTexture, roughness: 1 }),
    )
    top.receiveShadow = true
    group.add(top)
    const slab = new Mesh(new BoxGeometry(w + 0.7, 0.7, h + 0.7), new MeshStandardMaterial({ color: t.board, roughness: 0.9 }))
    slab.position.y = -0.352
    slab.receiveShadow = true
    slab.name = 'slab'
    group.add(slab)

    // 棋盤底下那一圈淡淡的影子：看起來是擺在桌上，不是飄在半空
    const shade = document.createElement('canvas')
    shade.width = shade.height = 128
    const sctx = shade.getContext('2d')
    if (sctx) {
      const gradient = sctx.createRadialGradient(64, 64, 20, 64, 64, 64)
      gradient.addColorStop(0, 'rgba(0,0,0,0.5)')
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      sctx.fillStyle = gradient
      sctx.fillRect(0, 0, 128, 128)
    }
    const under = new Mesh(
      new PlaneGeometry(w * 1.7, h * 1.9).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: new CanvasTexture(shade), transparent: true, depthWrite: false, opacity: t.dark ? 0.7 : 0.4 }),
    )
    under.position.y = -0.72
    under.name = 'under'
    group.add(under)

    // 岩石
    const rocks: number[] = []
    for (let c = 0; c < w * h; c++) if (tileAt(map, c) === 'rock') rocks.push(c)
    if (rocks.length) {
      const mesh = new InstancedMesh(rockGeometry(), this.solid, rocks.length)
      rocks.forEach((cell, i) => {
        const [x, z] = this.cellCenter(cell)
        const seed = Math.sin(cell * 12.9898) * 43758.5453
        const r = seed - Math.floor(seed)
        this.q.setFromEuler(this.e.set(0, r * Math.PI * 2, 0))
        const size = 0.95 + r * 0.3
        mesh.setMatrixAt(i, this.m.compose(this.p.set(x, 0, z), this.q, this.s.set(size, size * (0.9 + r * 0.4), size)))
      })
      mesh.castShadow = mesh.receiveShadow = true
      group.add(mesh)
    }

    // 入口（紫色的傳送門）和出口（要守住的水晶）
    const spawns = [...new Set(map.routes.map((r) => r[0]))]
    const exits = [...new Set(map.routes.map((r) => r[1]))]
    for (const cell of spawns) {
      const [x, z] = this.cellCenter(cell)
      const disc = new Mesh(
        new CircleGeometry(0.46, 24).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({ color: t.spawn, transparent: true, opacity: 0.55, depthWrite: false }),
      )
      disc.position.set(x, 0.02, z)
      disc.name = 'spawn'
      group.add(disc)
      for (let k = 0; k < 3; k++) {
        const ring = new Mesh(new TorusGeometry(0.4 - k * 0.09, 0.035, 6, 24).rotateX(Math.PI / 2), new MeshBasicMaterial({ color: t.spawn }))
        ring.position.set(x, 0.25 + k * 0.3, z)
        ring.name = 'spawn'
        group.add(ring)
        this.decor.push({ mesh: ring, spin: 0, bob: 0.07, y: ring.position.y, phase: k * 1.3 })
      }
    }
    for (const cell of exits) {
      const [x, z] = this.cellCenter(cell)
      const stand = new Mesh(new CylinderGeometry(0.3, 0.4, 0.22, 8), new MeshStandardMaterial({ color: 0x9a948a, roughness: 0.9, flatShading: true }))
      stand.position.set(x, 0.11, z)
      stand.castShadow = true
      group.add(stand)
      const core = new Mesh(
        new OctahedronGeometry(0.3, 0).scale(0.8, 1.3, 0.8),
        new MeshStandardMaterial({ color: t.exit, emissive: t.exit, emissiveIntensity: 0.7, roughness: 0.3, flatShading: true }),
      )
      core.position.set(x, 0.85, z)
      core.castShadow = true
      core.name = 'exit'
      group.add(core)
      this.decor.push({ mesh: core, spin: 0.9, bob: 0.08, y: 0.85, phase: 0 })
      const halo = new Mesh(
        new RingGeometry(0.42, 0.5, 28).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({ color: t.exit, transparent: true, opacity: 0.7, depthWrite: false }),
      )
      halo.position.set(x, 0.02, z)
      halo.name = 'exit'
      group.add(halo)
    }
    this.board = group
    this.scene.add(group)

    const reach = Math.max(w, h) * 0.75 + 3
    const cam = this.sun.shadow.camera
    cam.left = cam.bottom = -reach
    cam.right = cam.top = reach
    cam.near = 1
    cam.far = reach * 5
    cam.updateProjectionMatrix()
    // 太陽斜斜地從左後方照過來：塔和怪物的影子拉得出來，才看得出立體
    this.sun.position.set(-reach * 0.9, reach * 1.25, reach * 0.55)
    this.sun.target.position.set(0, 0, 0)
  }

  /** 把棋盤面畫到貼圖上（換主題時重畫） */
  private paintBoard() {
    const map = this.map
    const texture = this.boardTexture
    const ctx = (texture?.image as HTMLCanvasElement | undefined)?.getContext('2d')
    if (!map || !texture || !ctx) return
    const t = this.theme
    const px = TILE_PX
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const tile = tileAt(map, y * map.w + x)
        ctx.fillStyle = tile === 'rock' ? t.rockTile : tile === 'walk' ? t.walk : (x + y) % 2 ? t.tileA : t.tileB
        ctx.fillRect(x * px, y * px, px, px)
      }
    }
    ctx.strokeStyle = t.line
    ctx.globalAlpha = 0.55
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let x = 0; x <= map.w; x++) {
      ctx.moveTo(x * px, 0)
      ctx.lineTo(x * px, map.h * px)
    }
    for (let y = 0; y <= map.h; y++) {
      ctx.moveTo(0, y * px)
      ctx.lineTo(map.w * px, y * px)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
    texture.needsUpdate = true
  }

  private applyTheme() {
    const t = (this.theme = readTheme())
    this.scene.background = t.bg
    // 深色主題是月光：冷一點、暗一點，但塔和怪物還是要看得清楚
    this.sun.intensity = t.dark ? 2.1 : 2.6
    this.sun.color.set(t.dark ? 0xc9d6ff : 0xfff4e0)
    this.sky.intensity = t.dark ? 1.15 : 1.25
    this.sky.color.set(t.dark ? 0xa9b8dc : 0xffffff)
    this.sky.groundColor.set(t.dark ? 0x3a3630 : 0x8a8478)
    this.paintBoard()
    this.board?.traverse((o) => {
      if (!(o instanceof Mesh)) return
      const material = o.material as MeshStandardMaterial | MeshBasicMaterial
      if (o.name === 'slab') material.color.copy(t.board)
      else if (o.name === 'under') material.opacity = t.dark ? 0.7 : 0.4
      else if (o.name === 'spawn') material.color.copy(t.spawn)
      else if (o.name === 'exit') {
        material.color.copy(t.exit)
        if (material instanceof MeshStandardMaterial) material.emissive.copy(t.exit)
      }
    })
  }

  private readonly onScheme = () => this.applyTheme()

  // ---------- 鏡頭 ----------

  private resize() {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h, false)
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    this.overlay.width = Math.round(w * ratio)
    this.overlay.height = Math.round(h * ratio)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    if (!this.camTouched) this.fit()
  }

  private placeCamera(tx: number, tz: number, yaw: number, pitch: number, dist: number) {
    const flat = Math.cos(pitch) * dist
    this.camera.position.set(tx + Math.sin(yaw) * flat, Math.sin(pitch) * dist, tz + Math.cos(yaw) * flat)
    this.camera.lookAt(tx, 0, tz)
    this.camera.updateMatrixWorld()
  }

  /** 把整塊場地放進畫面裡（上下留給按鈕的位置不算）：直的螢幕把場地轉成直的 */
  private fit() {
    const map = this.map
    if (!map) return
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    const wide = w / h >= 1
    const yaw = map.w >= map.h === wide ? 0 : Math.PI / 2
    const pitch = this.preview ? 48 * DEG : 58 * DEG
    const top = this.preview ? 1 : 1 - (2 * this.insets.top) / h
    const bottom = this.preview ? -1 : -1 + (2 * this.insets.bottom) / h
    const side = 1 - 24 / w
    const [hx, hz] = [map.w / 2 + 0.6, map.h / 2 + 0.6]
    const corners: [number, number][] = [
      [-hx, -hz],
      [hx, -hz],
      [-hx, hz],
      [hx, hz],
    ]
    // 往鏡頭看過去的方向移 `shift` 格之後，四個角在畫面上的範圍
    const measure = (dist: number, shift: number) => {
      this.placeCamera(-Math.sin(yaw) * shift, -Math.cos(yaw) * shift, yaw, pitch, dist)
      let [x0, x1, y0, y1] = [9, -9, 9, -9]
      for (const [x, z] of corners) {
        this.p.set(x, 0, z).project(this.camera)
        x0 = Math.min(x0, this.p.x)
        x1 = Math.max(x1, this.p.x)
        y0 = Math.min(y0, this.p.y)
        y1 = Math.max(y1, this.p.y)
      }
      return { x0, x1, y0, y1 }
    }
    const middle = (top + bottom) / 2
    const reach = Math.max(map.w, map.h)
    // 先把場地上下置中在按鈕之間，再看塞不塞得下
    const centered = (dist: number) => {
      let [a, b] = [-reach, reach]
      const rising = (() => {
        const ra = measure(dist, a)
        const rb = measure(dist, b)
        return (rb.y0 + rb.y1) / 2 > (ra.y0 + ra.y1) / 2
      })()
      for (let i = 0; i < 18; i++) {
        const mid = (a + b) / 2
        const r = measure(dist, mid)
        if ((r.y0 + r.y1) / 2 < middle === rising) a = mid
        else b = mid
      }
      return (a + b) / 2
    }
    let [near, far] = [3, 260]
    for (let i = 0; i < 22; i++) {
      const dist = (near + far) / 2
      const r = measure(dist, centered(dist))
      if (r.x0 >= -side && r.x1 <= side && r.y0 >= bottom && r.y1 <= top) far = dist
      else near = dist
    }
    const shift = centered(far)
    this.fitDist = far
    Object.assign(this.cam, { tx: -Math.sin(yaw) * shift, tz: -Math.cos(yaw) * shift, yaw, pitch, dist: far })
  }

  private clampCamera() {
    const map = this.map
    if (!map) return
    this.cam.dist = clamp(this.cam.dist, 5, this.fitDist * 1.3)
    this.cam.pitch = clamp(this.cam.pitch, 24 * DEG, 86 * DEG)
    const reach = Math.max(map.w, map.h) / 2 + 2
    this.cam.tx = clamp(this.cam.tx, -reach, reach)
    this.cam.tz = clamp(this.cam.tz, -reach, reach)
  }

  // ---------- 滑鼠、觸控 ----------

  /** 畫面上的一點對到地面的哪裡（寫進 `out`）；沒對到是 false */
  private ground(clientX: number, clientY: number, out: Vector3): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
    return this.raycaster.ray.intersectPlane(this.plane, out) !== null
  }

  private cellAt(clientX: number, clientY: number): number | null {
    const map = this.map
    if (!map || !this.ground(clientX, clientY, this.hit)) return null
    const x = Math.floor(this.hit.x + map.w / 2)
    const y = Math.floor(this.hit.z + map.h / 2)
    return x >= 0 && y >= 0 && x < map.w && y < map.h ? y * map.w + x : null
  }

  private readonly onDown = (e: PointerEvent) => {
    if (this.preview) return
    this.audio.unlock()
    this.renderer.domElement.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      button: e.button,
      touch: e.pointerType !== 'mouse',
    })
    this.pinch = null
    if (this.pointers.size > 1) for (const p of this.pointers.values()) p.moved = true
  }

  private readonly onMove = (e: PointerEvent) => {
    if (this.preview) return
    const p = this.pointers.get(e.pointerId)
    if (!p) {
      // 沒按著的滑鼠：預覽游標底下那一格
      if (e.pointerType === 'mouse') this.hoverCell = this.cellAt(e.clientX, e.clientY)
      return
    }
    const [px, py] = [p.x, p.y]
    p.x = e.clientX
    p.y = e.clientY
    if (!p.moved && Math.hypot(p.x - p.sx, p.y - p.sy) > (p.touch ? 10 : 5)) p.moved = true
    if (this.pointers.size === 1) {
      if (!p.moved) return
      this.camTouched = true
      if (p.button === 2 || p.button === 1 || e.shiftKey) {
        this.cam.yaw -= (p.x - px) * 0.006
        this.cam.pitch += (p.y - py) * 0.005
      } else if (this.ground(px, py, this.hit) && this.ground(p.x, p.y, this.hit2)) {
        // 抓著地面拖：游標底下那一點跟著游標走
        this.cam.tx += this.hit.x - this.hit2.x
        this.cam.tz += this.hit.z - this.hit2.z
      }
      this.clampCamera()
      return
    }
    // 兩指：捏合縮放、扭轉旋轉、一起拖是平移
    const [a, b] = [...this.pointers.values()]
    const now = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      angle: Math.atan2(a.y - b.y, a.x - b.x),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    }
    const prev = this.pinch
    this.pinch = now
    if (!prev || prev.dist < 1 || now.dist < 1) return
    this.camTouched = true
    this.cam.dist *= prev.dist / now.dist
    this.cam.yaw -= now.angle - prev.angle
    if (this.ground(prev.cx, prev.cy, this.hit) && this.ground(now.cx, now.cy, this.hit2)) {
      this.cam.tx += this.hit.x - this.hit2.x
      this.cam.tz += this.hit.z - this.hit2.z
    }
    this.clampCamera()
  }

  private readonly onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId)
    this.pointers.delete(e.pointerId)
    this.pinch = null
    if (!p || p.moved || this.preview) return
    if (p.button === 2) {
      this.emit({ type: 'cancel' })
      return
    }
    if (p.button === 0) this.tap(this.cellAt(e.clientX, e.clientY), p.touch)
  }

  private readonly onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId)
    this.pinch = null
  }

  private readonly onLeave = () => {
    this.hoverCell = null
  }

  private readonly onWheel = (e: WheelEvent) => {
    if (this.preview) return
    e.preventDefault()
    this.cam.dist *= Math.exp(clamp(e.deltaY, -200, 200) * 0.0012)
    this.camTouched = true
    this.clampCamera()
  }

  private readonly onMenu = (e: Event) => e.preventDefault()

  /** 點了一格 */
  private tap(cell: number | null, touch: boolean) {
    const field = this.fields[this.look]
    if (cell === null || !field) {
      this.armedCell = null
      this.select(null, null)
      return
    }
    const tower = field.byCell.get(cell)
    if (tower !== undefined) {
      // 點到塔：選它（正在蓋塔的話順便取消）
      if (this.buildKind) this.emit({ type: 'cancel' })
      this.audio.play('click')
      this.select(tower, null)
      return
    }
    const reason = this.blockedReason(cell)
    if (this.buildKind) {
      if (reason) {
        this.armedCell = null
        this.audio.play('deny')
        this.emit({ type: 'deny', reason })
      } else if (touch && this.armedCell !== cell) {
        // 手指沒有游標：第一下先看範圍，再點同一格才蓋
        this.armedCell = cell
        this.audio.play('click')
      } else {
        this.armedCell = null
        this.emit({ type: 'build', cell })
      }
      return
    }
    // 沒選塔種：選這個空格，接著在下面的列按哪一種就蓋哪一種
    if (reason) this.select(null, null)
    else {
      this.audio.play('click')
      this.select(null, cell)
    }
  }

  // ---------- 每一格 ----------

  private readonly loop = (t: number) => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 1 / 60
    this.last = t
    this.time += dt
    this.watchPerformance(dt)
    this.advance()
    this.drawTowers()
    this.drawMonsters()
    this.drawArrows()
    this.drawMarks()
    this.fx.update(dt)
    for (const d of this.decor) {
      d.mesh.rotation.y += d.spin * dt
      d.mesh.position.y = d.y + Math.sin(this.time * 1.8 + d.phase) * d.bob
    }
    if (this.preview) this.cam.yaw += dt * 0.12
    const { tx, tz, yaw, pitch, dist } = this.cam
    this.placeCamera(tx, tz, yaw, pitch, dist)
    if (this.disposed) return
    this.renderer.render(this.scene, this.camera)
    this.drawBars()
  }

  private watchPerformance(dt: number) {
    if (dt > 0.03) this.slowFrames++
    else this.slowFrames = Math.max(0, this.slowFrames - 2)
    if (this.slowFrames <= 90) return
    this.slowFrames = 0
    if (this.renderer.shadowMap.enabled) {
      // 先關影子，還是跟不上再降解析度
      this.renderer.shadowMap.enabled = false
      this.sun.castShadow = false
      this.scene.traverse((o) => {
        if (o instanceof Mesh) (o.material as Material).needsUpdate = true
      })
    } else if (this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25)
      this.renderer.setPixelRatio(this.pixelRatio)
      this.resize()
    }
  }

  /** 照伺服器的時間軸往前走：跨過一次快照就處理那一次的開火、出生和消失 */
  private advance() {
    if (this.clock === null) return
    const rt = (performance.now() - this.clock) / TICK_MS - DELAY
    // 分頁放到背景再回來：中間那一大串不用一個一個播
    if (this.queue.length > 25) {
      const keep = this.queue.slice(-3)
      this.queue = keep
      this.ents.clear()
      this.fx.clear()
    }
    while (this.queue.length && this.queue[0].n <= rt) {
      this.base = this.queue.shift()!
      this.enter(this.base)
    }
    const base = this.base
    const next = this.queue[0]
    const map = this.map
    if (!base || !map) return
    const t = next ? clamp((rt - base.n) / Math.max(1, next.n - base.n), 0, 1) : 0
    for (const e of this.ents.values()) {
      const to = next?.mons.get(e.id)
      const x = to ? lerp(e.x, to.x, t) : e.x
      const y = to ? lerp(e.y, to.y, t) : e.y
      const wx = x - map.w / 2
      const wz = y - map.h / 2
      if (to && (Math.abs(to.x - e.x) > 0.003 || Math.abs(to.y - e.y) > 0.003)) {
        e.yaw = turnToward(e.yaw, Math.atan2(to.x - e.x, to.y - e.y), 0.25)
      }
      e.wx = wx
      e.wz = wz
    }
  }

  private enter(snap: Snap) {
    const now = performance.now()
    const map = this.map
    if (!map) return
    for (const shot of snap.shots) this.fire(shot)
    for (const m of snap.mons.values()) {
      let e = this.ents.get(m.id)
      if (!e) {
        e = {
          id: m.id,
          kind: m.kind,
          x: m.x,
          y: m.y,
          hp: m.hp,
          slowed: false,
          poisoned: false,
          sent: m.sent,
          wx: m.x - map.w / 2,
          wy: 0,
          wz: m.y - map.h / 2,
          yaw: 0,
          bornAt: now,
          hurtAt: -1e9,
        }
        this.ents.set(m.id, e)
      } else if (m.hp < e.hp) e.hurtAt = now
      e.x = m.x
      e.y = m.y
      e.hp = m.hp
      e.slowed = m.slowed
      e.poisoned = m.poisoned
    }
    for (const e of this.ents.values()) {
      if (snap.mons.has(e.id)) continue
      this.ents.delete(e.id)
      const id = this.spec.monsters[e.kind]?.id
      const look = id ? MONSTER_LOOK[id] : null
      if (snap.leaks.includes(e.id)) {
        this.fx.ring(e.wx, e.wz, 1.1, 0xff4d6d, 0.5)
        this.audio.play('leak')
      } else if (look) {
        const big = id === 'boss' || id === 'wyvern'
        this.fx.burst([e.wx, look.fly + 0.3, e.wz], look.color, big ? 22 : 7, big ? 3.6 : 2.4, big ? 0.16 : 0.09)
        this.fx.flash([e.wx, look.fly + 0.3, e.wz], big ? 0.9 : 0.35, 0xffffff, 0.16)
        this.audio.play(big ? 'boom' : 'pop')
      }
    }
  }

  /** 怪物現在畫在哪（打牠的砲彈往這裡飛）；已經不在了就用最後的位置 */
  private aimPoint(id: number, fallback: [number, number, number]): () => [number, number, number] {
    let last = fallback
    return () => {
      const e = this.ents.get(id)
      if (e) last = [e.wx, e.wy + 0.25, e.wz]
      return last
    }
  }

  /** 一座塔開火：[塔的 id, 打到的怪物…] */
  private fire(shot: number[]) {
    const tower = this.fields[this.look]?.towers.get(shot[0])
    const spec = tower && this.spec.towers[tower.kind]
    if (!tower || !spec) return
    const look = TOWER_LOOK[spec.id]
    const [x, z] = this.cellCenter(tower.cell)
    const scale = 1 + 0.07 * (tower.level - 1)
    tower.firedAt = performance.now()
    tower.aim = shot[1] ?? -1
    const first = this.ents.get(tower.aim)
    if (first && look.aims) tower.yaw = Math.atan2(first.wx - x, first.wz - z)
    const from: [number, number, number] = [
      x + Math.sin(tower.yaw) * look.muzzle * scale,
      (look.headY + 0.06) * scale,
      z + Math.cos(tower.yaw) * look.muzzle * scale,
    ]
    const level = spec.levels[tower.level - 1]
    this.audio.shot(spec.id)
    if (spec.id === 'tesla') {
      const points: [number, number, number][] = [from]
      for (const id of shot.slice(1)) {
        const e = this.ents.get(id)
        if (e) points.push([e.wx, e.wy + 0.25, e.wz])
      }
      this.fx.lightning(points, look.shot)
      return
    }
    if (!first) return
    const target = this.aimPoint(first.id, [first.wx, first.wy + 0.25, first.wz])
    const distance = Math.hypot(first.wx - x, first.wz - z)
    // 砲彈飛的時間照伺服器的算法（距離 ÷ 速度），遊戲加速時跟著變快
    const flight = clamp(spec.shotSpeed > 0 ? distance / spec.shotSpeed / this.speed : 0, 0.05, 0.9)
    switch (spec.id) {
      case 'sniper':
        this.fx.beam(from, target(), look.shot, 0.07, 0.16)
        this.fx.flash(target(), 0.3, look.shot, 0.14)
        break
      case 'cannon':
        this.fx.shot(from, target, flight, look.shot, 0.11, true, 0.5 + distance * 0.18, () => {
          const [tx, , tz] = target()
          this.fx.ring(tx, tz, level.splash, 0xffa040, 0.36)
          this.fx.flash([tx, 0.25, tz], level.splash * 0.7, 0xffd9a0, 0.2)
          this.fx.burst([tx, 0.2, tz], 0x6b5a48, 6, 2.6, 0.08)
          this.audio.play('boom')
        })
        break
      case 'frost':
        this.fx.shot(from, target, flight, look.shot, 0.09, true, 0.15, () => {
          const [tx, , tz] = target()
          this.fx.ring(tx, tz, level.splash, 0x9fe3ff, 0.45)
        })
        break
      case 'poison':
        this.fx.shot(from, target, flight, look.shot, 0.09, true, 0.35, () => {
          const [tx, , tz] = target()
          this.fx.ring(tx, tz, 0.45, 0x9be564, 0.35)
        })
        break
      default:
        this.fx.shot(from, target, flight, look.shot, 0.07, false, 0, () => {})
    }
  }

  private drawTowers() {
    const field = this.fields[this.look]
    const now = performance.now()
    const counts = this.spec.towers.map(() => 0)
    let bands = 0
    let pips = 0
    const { m, m2, p, s, q, e, c } = this
    for (const t of field?.towers.values() ?? []) {
      const spec = this.spec.towers[t.kind]
      if (!spec || counts[t.kind] >= TOWER_CAP) continue
      const look = TOWER_LOOK[spec.id]
      const [x, z] = this.cellCenter(t.cell)
      const grown = pop(clamp((now - t.bornAt) / 320, 0, 1))
      const boost = 1 + 0.25 * Math.max(0, 1 - (now - t.boostAt) / 380)
      const size = (1 + 0.07 * (t.level - 1)) * grown * boost
      const i = counts[t.kind]++
      this.bases[t.kind].setMatrixAt(i, m.compose(p.set(x, 0, z), q.identity(), s.set(size, size, size)))
      // 頭：會瞄準的轉向目標，不會的自己慢慢轉；剛開火往後縮一下
      if (look.aims) {
        const target = this.ents.get(t.aim)
        if (target) t.yaw = turnToward(t.yaw, Math.atan2(target.wx - x, target.wz - z), 0.3)
      } else if (look.spin) t.yaw = this.time * look.spin * Math.PI * 2 + t.id
      const kick = Math.max(0, 1 - (now - t.firedAt) / 160)
      const hover = look.glow ? Math.sin(this.time * 2 + t.id) * 0.04 : 0
      const swell = look.aims ? 1 : 1 + kick * 0.25
      q.setFromEuler(e.set(0, t.yaw, 0))
      const back = look.aims ? kick * 0.12 * size : 0
      this.heads[t.kind].setMatrixAt(
        i,
        m.compose(
          p.set(x - Math.sin(t.yaw) * back, (look.headY + hover) * size, z - Math.cos(t.yaw) * back),
          q,
          s.set(size * swell, size * swell, size * swell),
        ),
      )
      // 底座上的色環是誰蓋的
      this.bands.setMatrixAt(bands, m2.compose(p.set(x, 0.09 * size, z), q.identity(), s.set(size, size, size)))
      this.bands.setColorAt(bands, this.theme.owners[t.owner % this.theme.owners.length] ?? c.setRGB(1, 1, 1))
      bands++
      // 等級：色環前面一排小珠子（一級不畫）
      if (t.level > 1) {
        for (let k = 0; k < t.level - 1; k++) {
          const angle = (k - (t.level - 2) / 2) * 0.42
          this.pips.setMatrixAt(
            pips++,
            m2.compose(p.set(x + Math.sin(angle) * 0.46 * size, 0.13 * size, z + Math.cos(angle) * 0.46 * size), q.identity(), s.set(size, size, size)),
          )
        }
      }
    }
    this.spec.towers.forEach((_, k) => {
      this.bases[k].count = this.heads[k].count = counts[k]
      this.bases[k].instanceMatrix.needsUpdate = this.heads[k].instanceMatrix.needsUpdate = true
    })
    this.bands.count = bands
    this.bands.instanceMatrix.needsUpdate = true
    if (this.bands.instanceColor) this.bands.instanceColor.needsUpdate = true
    this.pips.count = pips
    this.pips.instanceMatrix.needsUpdate = true
  }

  private drawMonsters() {
    const now = performance.now()
    const counts = this.spec.monsters.map(() => 0)
    let shadows = 0
    const { m, p, s, q, e, c } = this
    for (const ent of this.ents.values()) {
      const spec = this.spec.monsters[ent.kind]
      if (!spec || counts[ent.kind] >= MONSTER_CAP) continue
      const look = MONSTER_LOOK[spec.id]
      const phase = this.time * look.hop * Math.PI + ent.id * 1.7
      const hop = Math.abs(Math.sin(phase)) * look.bob
      const grown = pop(clamp((now - ent.bornAt) / 260, 0, 1))
      const squash = 1 + Math.sin(phase * 2) * 0.06
      // 同一群怪往左右錯開一點點，才不會全部疊在同一條線上
      const side = (((ent.id * 0.618034) % 1) - 0.5) * 0.3 * (1 - Math.min(0.8, spec.size))
      const x = ent.wx + Math.cos(ent.yaw) * side
      const z = ent.wz - Math.sin(ent.yaw) * side
      ent.wy = look.fly + hop
      const i = counts[ent.kind]++
      q.setFromEuler(e.set(look.fly ? Math.sin(phase) * 0.12 : 0, ent.yaw, look.fly ? Math.sin(phase * 0.5) * 0.18 : 0))
      this.bodies[ent.kind].setMatrixAt(i, m.compose(p.set(x, ent.wy, z), q, s.set(grown / Math.sqrt(squash), grown * squash, grown / Math.sqrt(squash))))
      // 顏色：剛被打到閃一下白，變慢偏藍、中毒偏綠，別人派來的偏紅
      const hurt = Math.max(0, 1 - (now - ent.hurtAt) / 130)
      c.setRGB(1, 1, 1)
      if (ent.sent) c.setRGB(1.25, 0.72, 0.72)
      if (ent.slowed) c.multiply(this.tintSlow)
      if (ent.poisoned) c.multiply(this.tintPoison)
      if (hurt > 0) c.multiplyScalar(1 + hurt * 1.4)
      this.bodies[ent.kind].setColorAt(i, c)
      if (shadows < SHADOW_CAP) {
        const r = spec.size * (look.fly ? 0.9 : 1.15)
        this.shadows.setMatrixAt(shadows++, m.compose(p.set(x, 0.012, z), q.identity(), s.set(r, 1, r)))
      }
    }
    this.spec.monsters.forEach((_, k) => {
      const mesh = this.bodies[k]
      mesh.count = counts[k]
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    })
    this.shadows.count = shadows
    this.shadows.instanceMatrix.needsUpdate = true
  }

  private readonly tintSlow = new Color(0.62, 0.82, 1.25)
  private readonly tintPoison = new Color(0.7, 1.2, 0.55)

  /** 路線上往出口流動的小箭頭：迷宮怎麼繞一看就知道 */
  private drawArrows() {
    const field = this.fields[this.look]
    const map = this.map
    let n = 0
    const { m, p, s, q, e } = this
    const put = (x: number, z: number, yaw: number, color: Color, size: number) => {
      if (n >= ARROW_CAP) return
      q.setFromEuler(e.set(0, yaw, 0))
      this.arrows.setMatrixAt(n, m.compose(p.set(x, 0.03, z), q, s.set(size, 1, size)))
      this.arrows.setColorAt(n, color)
      n++
    }
    if (field && map && !this.preview) {
      const gap = 0.62
      const offset = (this.time * 0.9) % gap
      for (const path of field.paths) {
        let carry = offset
        for (let i = 0; i + 1 < path.length; i++) {
          const [ax, az] = this.cellCenter(path[i])
          const [bx, bz] = this.cellCenter(path[i + 1])
          const length = Math.hypot(bx - ax, bz - az)
          const yaw = Math.atan2(bx - ax, bz - az)
          let d = carry
          for (; d < length; d += gap) put(lerp(ax, bx, d / length), lerp(az, bz, d / length), yaw, this.theme.path, 1)
          carry = d - length
        }
      }
      // 飛行的怪走直線：這一波或下一波有飛行怪時才畫
      if (this.showAir) {
        const gapAir = 0.9
        for (const [spawn, exit] of map.routes) {
          const [ax, az] = this.cellCenter(spawn)
          const [bx, bz] = this.cellCenter(exit)
          const length = Math.hypot(bx - ax, bz - az)
          const yaw = Math.atan2(bx - ax, bz - az)
          for (let d = (this.time * 1.2) % gapAir; d < length; d += gapAir) {
            put(lerp(ax, bx, d / length), lerp(az, bz, d / length), yaw, this.theme.air, 0.8)
          }
        }
      }
    }
    this.arrows.count = n
    this.arrows.instanceMatrix.needsUpdate = true
    if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true
  }

  /** 游標、選取、射程 */
  private drawMarks() {
    const field = this.fields[this.look]
    const t = this.theme
    const mine = this.myField === this.look && !this.preview
    // 要蓋塔時預覽的那一格：滑鼠是游標底下，觸控是點過一下的
    const previewCell = this.buildKind && mine ? (this.armedCell ?? this.hoverCell) : null
    const ghost = previewCell !== null && field && !field.byCell.has(previewCell) ? previewCell : null
    let range = 0
    let at: [number, number] | null = null
    let ok = true
    this.ghostBase.visible = this.ghostHead.visible = false
    this.selectRing.visible = false
    if (ghost !== null && this.buildKind) {
      const spec = this.spec.towers.find((s) => s.id === this.buildKind)!
      ok = this.blockedReason(ghost) === null
      at = this.cellCenter(ghost)
      range = spec.levels[0].range
      const look = TOWER_LOOK[spec.id]
      this.ghostBase.visible = this.ghostHead.visible = ok
      this.ghostBase.position.set(at[0], 0, at[1])
      this.ghostHead.position.set(at[0], look.headY, at[1])
    } else if (this.selectedTower !== null && field) {
      const tower = field.towers.get(this.selectedTower)
      const spec = tower && this.spec.towers[tower.kind]
      if (tower && spec) {
        at = this.cellCenter(tower.cell)
        range = spec.levels[tower.level - 1].range
        this.selectRing.visible = true
        this.selectRing.position.set(at[0], 0.035, at[1])
        const pulse = 1 + Math.sin(this.time * 5) * 0.05
        this.selectRing.scale.set(pulse, 1, pulse)
        ;(this.selectRing.material as MeshBasicMaterial).color.copy(t.path)
      }
    } else if (this.selectedCell !== null && mine) at = this.cellCenter(this.selectedCell)
    else if (this.hoverCell !== null && mine && field && !field.byCell.has(this.hoverCell) && this.map && tileAt(this.map, this.hoverCell) === 'ground') {
      at = this.cellCenter(this.hoverCell)
    }
    const marking = at !== null && (ghost !== null || this.selectedCell !== null || (this.selectedTower === null && this.hoverCell !== null))
    this.tileMark.visible = marking
    if (at && marking) {
      this.tileMark.position.set(at[0], 0.02, at[1])
      const material = this.tileMark.material as MeshBasicMaterial
      material.color.copy(ok ? (ghost !== null || this.selectedCell !== null ? t.ok : t.path) : t.bad)
      material.opacity = ghost !== null || this.selectedCell !== null ? 0.55 : 0.28
    }
    const ranged = at !== null && range > 0
    this.rangeRing.visible = this.rangeFill.visible = ranged
    if (at && ranged) {
      for (const mesh of [this.rangeRing, this.rangeFill]) {
        mesh.position.set(at[0], mesh === this.rangeRing ? 0.045 : 0.04, at[1])
        mesh.scale.set(range, 1, range)
        ;(mesh.material as MeshBasicMaterial).color.copy(ok ? t.path : t.bad)
      }
    }
  }

  /** 血條畫在疊在上面的 2D 畫布：受過傷的怪和魔王才畫 */
  private drawBars() {
    const pen = this.pen
    if (!pen) return
    const { width, height } = this.overlay
    pen.clearRect(0, 0, width, height)
    if (this.preview) return
    const ratio = width / Math.max(1, this.host.clientWidth)
    const t = this.theme
    for (const ent of this.ents.values()) {
      const spec = this.spec.monsters[ent.kind]
      if (!spec) continue
      const big = spec.lives > 1
      if (ent.hp >= 63 && !big) continue
      const look = MONSTER_LOOK[spec.id]
      this.p.set(ent.wx, ent.wy + look.top, ent.wz).project(this.camera)
      if (this.p.z > 1 || Math.abs(this.p.x) > 1.05 || Math.abs(this.p.y) > 1.05) continue
      const w = (big ? 46 : 22) * ratio
      const h = (big ? 6 : 4) * ratio
      const x = ((this.p.x + 1) / 2) * width - w / 2
      const y = ((1 - this.p.y) / 2) * height - h
      const fill = ent.hp / 63
      pen.fillStyle = 'rgba(0,0,0,0.55)'
      pen.fillRect(x - ratio, y - ratio, w + 2 * ratio, h + 2 * ratio)
      pen.fillStyle = fill > 0.5 ? t.okCss : fill > 0.25 ? t.warnCss : t.badCss
      pen.fillRect(x, y, w * fill, h)
    }
  }
}
