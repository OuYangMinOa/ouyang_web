import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  Euler,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three'
import { TdAudio, type Sound } from './audio'
import { Board } from './board'
import { Effects } from './fx'
import { renderIcons, type Icons } from './icons'
import { routesOf } from './maze'
import { MONSTER_LOOK, monsterGeometry, TOWER_LOOK, towerBase, towerHead } from './models'
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
import { readTheme, rgba } from './palette'
import { Trail, trailTexture } from './trail'

/**
 * 迷宮塔防的畫面（Three.js）。模擬在伺服器，這裡只負責畫和點：
 *
 * - **場地**是一座浮在網頁底色上的小島（`board.ts`；顏色讀 `index.css` 的 `--td-*`，換主題會跟著換）。
 *   一格是 1 個單位，場地中心在原點，x 往右、z 往下（對應格子的 x、y）。
 * - **怪物**：伺服器每 0.1 秒送一次所有怪物的位置（`onTick`），畫面刻意慢 `DELAY` 個 tick，
 *   在前後兩次快照之間內插，網路忽快忽慢時怪物也不會一頓一頓。開火、打倒的特效跟著同一條時間軸播。
 * - **塔**：view 裡有全部的塔，之後的變化走 `tower` 事件；用 `rev` 接起來（見 `sync`、`onTower`）。
 *   每種塔 1～4 級各有自己的模型（`models.ts`），升級看得出來。
 * - 塔和怪物同一種的用 InstancedMesh 一次畫完；血條、賞金跳出來的數字、魔王的血條畫在疊在上面的 2D 畫布上。
 * - **路線**是地上一條往出口流動的帶子（`trail.ts`）。要蓋塔時用和伺服器一樣的算法（`maze.ts`）先算出新的路線畫出來。
 * - **操作**：點一下選塔／選格子（選了塔種就是蓋塔），拖曳平移，滾輪或兩指縮放，右鍵（或兩指轉）旋轉。
 *   點了什麼、要蓋在哪用 `emit` 告訴外面，真正送出動作的是 `index.tsx`。
 */

export type GameEvent =
  /** 每個 tick 的錢、生命、怪物數、打倒幾隻，以及每塊場地這一波還有幾隻沒出來 */
  | { type: 'stats'; gold: number[]; lives: number[]; counts: number[]; kills: number[]; left: number[] }
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
  /** 蓋塔前的預覽：蓋在這一格，路線會多幾格（不是在預覽、或這一格不能蓋就是 null） */
  | { type: 'preview'; cell: number | null; gain: number | null }

export type TowerInfo = { id: number; cell: number; kind: number; level: number; owner: number; mode: number; buff: number }

type Tower = Omit<TowerInfo, 'buff'> & {
  yaw: number
  /** 正在瞄準的怪物 id */
  aim: number
  bornAt: number
  firedAt: number
  boostAt: number
  /** 號角塔：下一次往外擴一圈光是什麼時候 */
  pulseAt: number
}

type FieldState = {
  /** -1 是還沒從 view 拿到 */
  rev: number
  towers: Map<number, Tower>
  byCell: Map<number, number>
  paths: number[][]
  /** 每座塔吃到的號角加成（和伺服器一樣的算法：範圍內最強的那一支） */
  buffs: Map<number, number>
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

type Snap = { n: number; mons: Map<number, MonsterState>; shots: number[][]; leaks: number[]; paid: Map<number, number> }

/** 飄起來的字（打倒怪物拿到的賞金） */
type Popup = { x: number; y: number; z: number; text: string; age: number }

const TICK_MS = 100
/** 畫面比伺服器慢幾個 tick（拿來內插） */
const DELAY = 1.7
const TOWER_CAP = 420
const MONSTER_CAP = 400
const BLOB_CAP = 1200
const DEG = Math.PI / 180
const POPUP_LIFE = 0.9

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** 兩個角度差多少（−π～π） */
function wrap(d: number): number {
  let v = d % (Math.PI * 2)
  if (v > Math.PI) v -= Math.PI * 2
  if (v < -Math.PI) v += Math.PI * 2
  return v
}

/** 轉到 `to` 最短的那一邊，一次最多轉 `step` */
function turnToward(from: number, to: number, step: number): number {
  return from + clamp(wrap(to - from), -step, step)
}

/** 蓋好、升級時「彈」出來的大小：衝過頭再回來 */
function pop(t: number): number {
  if (t >= 1) return 1
  const c = 1.70158
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2
}

/** 中間黑、往外淡掉的圓：塔和怪物腳下那一圈影子 */
function blobTexture(): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(0,0,0,0.42)')
    g.addColorStop(0.55, 'rgba(0,0,0,0.26)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  return new CanvasTexture(canvas)
}

/** 把這一格用到的那一段送給顯示卡（整個緩衝區每一格都送太浪費） */
function commit(mesh: InstancedMesh, count: number, colors: boolean) {
  const changed = count > 0 || mesh.count > 0
  mesh.count = count
  if (!changed) return
  mesh.instanceMatrix.clearUpdateRanges()
  mesh.instanceMatrix.addUpdateRange(0, count * 16)
  mesh.instanceMatrix.needsUpdate = true
  if (colors && mesh.instanceColor) {
    mesh.instanceColor.clearUpdateRanges()
    mesh.instanceColor.addUpdateRange(0, count * 3)
    mesh.instanceColor.needsUpdate = true
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
  /** 系統設定了「減少動態效果」 */
  private readonly calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  private theme = readTheme()
  private font = 'system-ui, sans-serif'
  private raf = 0
  private last = 0
  private time = 0
  private disposed = false
  private pixelRatio: number
  private slowFrames = 0

  // 場地
  private map: MapSpec | null = null
  private board: Board | null = null
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
  /** [塔的種類][等級 − 1] */
  private readonly bases: InstancedMesh[][] = []
  private readonly heads: InstancedMesh[][] = []
  private readonly towerCounts: number[][]
  private readonly bands: InstancedMesh
  private readonly pips: InstancedMesh
  /** 冰晶、電球、號角上的光：疊加上去的光暈 */
  private readonly halos: InstancedMesh
  private readonly bodies: InstancedMesh[] = []
  /** 塔和怪物腳下那一圈影子（手機沒有真的影子，靠它才看得出東西站在地上） */
  private readonly blobs: InstancedMesh
  private readonly chevrons = trailTexture('chevron')
  private readonly dashes = trailTexture('dash')
  private readonly trailPath: Trail
  private readonly trailAir: Trail
  private readonly trailNext: Trail
  private readonly tileMark: Mesh
  private readonly rangeRing: Mesh
  private readonly rangeFill: Mesh
  private readonly rangeNext: Mesh
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
  private left: number[] = []
  private readonly popups: Popup[] = []
  /** 地上的路線現在畫的是哪一份（換了才重做） */
  private shownPaths: number[][] | null = null
  private shownAir: MapSpec | null = null
  /** 路線剛換：亮一下 */
  private pathFlash = 0
  /** 預覽的新路線是替哪一格、哪一版的塔算的 */
  private previewKey = ''
  private previewGain: number | null = null

  // 操作
  private buildKind: TowerId | null = null
  private selectedTower: number | null = null
  private selectedCell: number | null = null
  private hoverCell: number | null = null
  /** 觸控：先點一下預覽、再點同一格才蓋 */
  private armedCell: number | null = null
  /** 介面上指著「升級」：把升級後的射程也畫出來 */
  private peekUpgrade = false
  private readonly pointers = new Map<number, { x: number; y: number; sx: number; sy: number; moved: boolean; button: number; touch: boolean }>()
  private pinch: { dist: number; angle: number; cx: number; cy: number } | null = null
  /** 鏡頭要去的地方，和現在實際在的地方（慢慢跟上，縮放、換場地才不會一下跳過去） */
  private readonly cam = { tx: 0, tz: 0, yaw: 0, pitch: 56 * DEG, dist: 30 }
  private readonly view = { tx: 0, tz: 0, yaw: 0, pitch: 56 * DEG, dist: 30 }
  private snapCamera = true
  private shake = 0
  private fitDist = 30
  /** 太陽跟著場地預設的方向轉（直的螢幕是 90 度） */
  private sunYaw = 0
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
  private readonly tintSlow = new Color(0.62, 0.82, 1.25)
  private readonly tintPoison = new Color(0.7, 1.2, 0.55)

  constructor(host: HTMLElement, spec: Spec, emit: (e: GameEvent) => void, sound: boolean) {
    this.host = host
    this.spec = spec
    this.emit = emit
    // 不支援 WebGL 時這裡會丟錯，由呼叫的人顯示訊息
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.coarse ? 1.75 : 2)
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.shadowMap.enabled = !this.coarse
    this.renderer.shadowMap.type = PCFSoftShadowMap
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
    this.sun.shadow.radius = 3
    this.scene.add(this.sun, this.sun.target, this.sky)

    // 塔：每一種、每一級各一組「底座」和「頭」，再加上顯示主人的色環和等級的小珠子
    for (const t of spec.towers) {
      const look = TOWER_LOOK[t.id]
      const levels = Array.from({ length: spec.maxLevel }, (_, i) => i + 1)
      this.bases.push(levels.map((level) => this.instanced(towerBase(t.id, level), this.solid, TOWER_CAP, true, false)))
      this.heads.push(levels.map((level) => this.instanced(towerHead(t.id, level), look.glow ? this.glow : this.solid, TOWER_CAP, !look.glow, false)))
    }
    this.towerCounts = spec.towers.map(() => new Array<number>(spec.maxLevel).fill(0))
    this.bands = this.instanced(
      new TorusGeometry(0.445, 0.032, 5, 24).rotateX(Math.PI / 2),
      new MeshStandardMaterial({ roughness: 0.5, metalness: 0.1 }),
      TOWER_CAP,
      false,
      true,
    )
    this.pips = this.instanced(new SphereGeometry(0.05, 8, 6), new MeshBasicMaterial({ color: 0xffd23f }), TOWER_CAP * 4, false, false)
    for (const mon of spec.monsters) {
      const look = MONSTER_LOOK[mon.id]
      this.bodies.push(this.instanced(monsterGeometry(mon.id), look.ghost ? this.misty : this.solid, MONSTER_CAP, !look.ghost, true))
    }
    this.blobs = this.instanced(
      new PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
      BLOB_CAP,
      false,
      false,
    )
    this.blobs.renderOrder = 1
    this.halos = this.instanced(
      new PlaneGeometry(2, 2),
      new MeshBasicMaterial({ map: this.fx.glowMap, transparent: true, depthWrite: false, blending: AdditiveBlending }),
      TOWER_CAP,
      false,
      true,
    )
    this.halos.renderOrder = 6

    // 地上的路線：現在的路、飛行怪的路、蓋塔前預覽的新路
    this.trailPath = new Trail(this.chevrons, 2, 0.03)
    this.trailAir = new Trail(this.dashes, 2, 0.034)
    this.trailNext = new Trail(this.chevrons, 3, 0.04)
    this.scene.add(this.trailPath.mesh, this.trailAir.mesh, this.trailNext.mesh)

    const flat = (geometry: BufferGeometry, opacity: number, order: number) => {
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ transparent: true, opacity, depthWrite: false }))
      mesh.visible = false
      mesh.renderOrder = order
      this.scene.add(mesh)
      return mesh
    }
    this.tileMark = flat(new PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2), 0.5, 3)
    this.rangeRing = flat(new RingGeometry(0.975, 1, 96).rotateX(-Math.PI / 2), 0.9, 4)
    this.rangeFill = flat(new RingGeometry(0, 1, 96).rotateX(-Math.PI / 2), 0.1, 3)
    this.rangeNext = flat(new RingGeometry(0.985, 1, 96).rotateX(-Math.PI / 2), 0.55, 4)
    this.selectRing = flat(new RingGeometry(0.5, 0.58, 40).rotateX(-Math.PI / 2), 0.95, 4)
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

  private instanced(geometry: BufferGeometry, material: Material, capacity: number, shadow: boolean, tinted: boolean): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    if (tinted) mesh.setColorAt(0, this.c.setRGB(1, 1, 1))
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.castShadow = shadow
    mesh.receiveShadow = shadow
    this.scene.add(mesh)
    return mesh
  }

  // ---------- 外面呼叫的 ----------

  /** 換地圖：重做整座島 */
  setMap(id: string) {
    const map = this.spec.maps.find((m) => m.id === id) ?? this.spec.maps[0]
    if (!map || map === this.map) return
    this.map = map
    this.buildBoard()
    this.camTouched = false
    this.fit(true)
  }

  /** 選單時場地慢慢轉、放在整個畫面的正中間 */
  setPreview(on: boolean) {
    if (this.preview === on) return
    this.preview = on
    this.camTouched = false
    this.fit(false)
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
    this.left = []
    this.popups.length = 0
    this.fx.clear()
  }

  /** 收到 view：新的一局就整個重來，不然把比較新的塔接上去 */
  sync(view: TdView) {
    if (view.game !== this.game) {
      this.game = view.game
      this.reset()
      this.fields = view.fields.map(() => ({ rev: -1, towers: new Map(), byCell: new Map(), paths: [], buffs: new Map() }))
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
      this.rebuff(field)
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
      pulseAt: old?.pulseAt ?? now + 400 + (id % 7) * 300,
    })
    field.byCell.set(cell, id)
  }

  /** 每座塔吃到多少號角的加成：範圍內（塔的中心在號角的範圍裡）最強的那一支，和伺服器的算法一樣 */
  private rebuff(field: FieldState) {
    field.buffs.clear()
    const beacons: [number, number, number, number][] = []
    for (const t of field.towers.values()) {
      const spec = this.spec.towers[t.kind]
      if (spec?.id !== 'beacon') continue
      const level = spec.levels[t.level - 1]
      const [x, z] = this.cellCenter(t.cell)
      if (level) beacons.push([x, z, level.range, level.buff])
    }
    if (!beacons.length) return
    for (const t of field.towers.values()) {
      if (this.spec.towers[t.kind]?.id === 'beacon') continue
      const [x, z] = this.cellCenter(t.cell)
      let best = 0
      for (const [bx, bz, range, buff] of beacons) if (Math.hypot(bx - x, bz - z) <= range) best = Math.max(best, buff)
      if (best > 0) field.buffs.set(t.id, best)
    }
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
        this.fx.smoke([x, 0.3, z], 0xb0aa9e, 5, 0.24, 0.8)
        this.fx.coin([x, 0.6, z])
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
          this.fx.smoke([x, 0.12, z], 0xcfc6b4, 6, 0.2, 1.3)
          this.audio.play('build')
        }
      } else if (e.op === 'up') {
        tower.boostAt = now
        if (shown) {
          this.fx.rise(x, z, 0xffd23f, 10)
          this.fx.ring(x, z, 0.9, 0xffd23f, 0.45)
          this.fx.glow([x, 0.7, z], 1.5, 0xffd23f, 0.45, 0.9)
          this.audio.play('upgrade')
        }
      }
    }
    if (e.paths) field.paths = e.paths
    this.rebuff(field)
    if (shown) this.emit({ type: 'towers' })
  }

  onTick(e: TickEvent) {
    this.left[e.f] = e.r ?? 0
    this.emit({ type: 'stats', gold: e.g, lives: e.l, counts: e.c, kills: e.k, left: this.left })
    if (e.f !== this.look) return
    const at = performance.now()
    const sample = at - e.n * TICK_MS
    // 取最早到的那一次當基準（最接近真正的時間），再慢慢跟上時鐘的飄移；伺服器停住過（沒人在線）就重來
    if (this.clock === null || sample < this.clock || sample > this.clock + 1500) this.clock = sample
    else this.clock += Math.min(sample - this.clock, 0.5)
    const mons = new Map<number, MonsterState>()
    for (const m of decodeMonsters(e.m)) mons.set(m.id, m)
    const paid = new Map<number, number>()
    for (const [id, bounty] of e.d ?? []) paid.set(id, bounty)
    this.queue.push({ n: e.n, mons, shots: e.s ?? [], leaks: e.x ?? [], paid })
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
    this.popups.length = 0
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
      this.ghostBase.geometry = this.bases[index][0].geometry
      this.ghostHead.geometry = this.heads[index][0].geometry
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
    const field = this.fields[this.look]
    const t = this.selectedTower !== null ? field?.towers.get(this.selectedTower) : undefined
    if (!t || !field) return null
    return { id: t.id, cell: t.cell, kind: t.kind, level: t.level, owner: t.owner, mode: t.mode, buff: field.buffs.get(t.id) ?? 0 }
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
    if (!this.camTouched) this.fit(false)
  }

  setAirHint(on: boolean) {
    this.showAir = on
  }

  /** 介面上指著「升級」：把升級後的射程也畫出來 */
  setPeekUpgrade(on: boolean) {
    this.peekUpgrade = on
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

  /** 介面上用的小圖：塔（每一級）和怪物的模型各拍一張；瀏覽器不讓拍就是 null */
  icons(): Icons | null {
    return renderIcons(this.spec, {
      bases: this.bases.map((levels) => levels.map((mesh) => mesh.geometry)),
      heads: this.heads.map((levels) => levels.map((mesh) => mesh.geometry)),
      bodies: this.bodies.map((mesh) => mesh.geometry),
      solid: this.solid,
      glow: this.glow,
      misty: this.misty,
      ghosts: this.spec.monsters.map((m) => MONSTER_LOOK[m.id].ghost === true),
    })
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
    this.fit(false)
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
    this.clearBoard()
    for (const trail of [this.trailPath, this.trailAir, this.trailNext]) {
      this.scene.remove(trail.mesh)
      trail.dispose()
    }
    this.chevrons.dispose()
    this.dashes.dispose()
    ;(this.blobs.material as MeshBasicMaterial).map?.dispose()
    // 光暈的貼圖是特效的，留給它自己收
    this.scene.remove(this.halos)
    ;(this.halos.material as Material).dispose()
    this.halos.geometry.dispose()
    this.fx.dispose()
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
    this.scene.remove(this.board.group)
    this.board.dispose()
    this.board = null
  }

  /** 做出場地（換地圖、換主題時重做）：小島、周圍的擺設、岩石、入口和出口都在 `board.ts` */
  private buildBoard() {
    const map = this.map
    if (!map) return
    this.clearBoard()
    this.board = new Board(map, this.theme, {
      anisotropy: this.renderer.capabilities.getMaxAnisotropy(),
      coarse: this.coarse,
      calm: this.calm,
    })
    this.scene.add(this.board.group)
    const reach = Math.max(this.board.hw, this.board.hh) * 1.25 + 2
    const cam = this.sun.shadow.camera
    cam.left = cam.bottom = -reach
    cam.right = cam.top = reach
    cam.near = 1
    cam.far = reach * 5
    cam.updateProjectionMatrix()
    this.placeSun()
  }

  /** 太陽斜斜地從鏡頭的左前方照過來：影子往右後方拉，才看得出立體（直的螢幕場地轉了 90 度，太陽跟著轉） */
  private placeSun() {
    if (!this.board) return
    const reach = Math.max(this.board.hw, this.board.hh) * 1.25 + 2
    const [x, y, z] = [-1.15 * reach, 1.2 * reach, 0.5 * reach]
    const [sin, cos] = [Math.sin(this.sunYaw), Math.cos(this.sunYaw)]
    this.sun.position.set(x * cos + z * sin, y, -x * sin + z * cos)
    this.sun.target.position.set(0, 0, 0)
  }

  private applyTheme() {
    const t = (this.theme = readTheme())
    this.font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'
    this.scene.background = t.bg
    // 深色主題是月光：冷一點、暗一點，但塔和怪物還是要看得清楚
    this.sun.intensity = t.dark ? 2.5 : 3.1
    this.sun.color.set(t.dark ? 0xc9d6ff : 0xfff1dc)
    this.sky.intensity = t.dark ? 1.1 : 1.15
    this.sky.color.set(t.dark ? 0xa9b8dc : 0xf2f6ff)
    this.sky.groundColor.set(t.dark ? 0x3a3630 : 0x8f8672)
    // 亮色主題的底色已經很亮，光暈疊太多會變成一團白
    this.fx.glowScale = t.dark ? 1 : 0.55
    this.buildBoard()
    this.shownPaths = null
    this.shownAir = null
    this.previewKey = ''
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
    if (!this.camTouched) this.fit(true)
  }

  private placeCamera(tx: number, tz: number, yaw: number, pitch: number, dist: number) {
    const flat = Math.cos(pitch) * dist
    this.camera.position.set(tx + Math.sin(yaw) * flat, Math.sin(pitch) * dist, tz + Math.cos(yaw) * flat)
    this.camera.lookAt(tx, 0, tz)
    this.camera.updateMatrixWorld()
  }

  /**
   * 把整座島放進畫面裡（上下留給按鈕的位置不算）：直的螢幕把場地轉成直的。
   * `snap` 是直接跳過去（改視窗大小、換地圖）；不然鏡頭慢慢移過去（從選單進對戰、按了「回到原位」）
   */
  private fit(snap: boolean) {
    const map = this.map
    if (!map) return
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    const wide = w / h >= 1
    const yaw = map.w >= map.h === wide ? 0 : Math.PI / 2
    if (yaw !== this.sunYaw) {
      this.sunYaw = yaw
      this.placeSun()
    }
    const pitch = this.preview ? 48 * DEG : 58 * DEG
    const top = this.preview ? 1 : 1 - (2 * this.insets.top) / h
    const bottom = this.preview ? -1 : -1 + (2 * this.insets.bottom) / h
    const side = 1 - 12 / w
    const [hx, hz] = [this.board?.hw ?? map.w / 2 + 0.6, this.board?.hh ?? map.h / 2 + 0.6]
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
    // 轉過好幾圈之後回到原位：走最短的那一邊，不要一圈一圈轉回來
    this.view.yaw = this.cam.yaw + wrap(this.view.yaw - this.cam.yaw)
    if (snap) this.snapCamera = true
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

  /** 鏡頭慢慢跟到要去的地方；漏怪、魔王倒下時晃一下 */
  private moveCamera(dt: number) {
    if (this.preview) this.cam.yaw += dt * 0.12
    const k = this.snapCamera ? 1 : 1 - Math.exp(-dt * 16)
    this.snapCamera = false
    const v = this.view
    v.tx = lerp(v.tx, this.cam.tx, k)
    v.tz = lerp(v.tz, this.cam.tz, k)
    v.yaw = lerp(v.yaw, this.cam.yaw, k)
    v.pitch = lerp(v.pitch, this.cam.pitch, k)
    v.dist = lerp(v.dist, this.cam.dist, k)
    this.shake = Math.max(0, this.shake - dt * 3.2)
    const wobble = this.calm ? 0 : this.shake * this.shake * 0.16
    this.placeCamera(
      v.tx + Math.sin(this.time * 71) * wobble,
      v.tz + Math.cos(this.time * 57) * wobble,
      v.yaw,
      v.pitch,
      v.dist,
    )
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
    this.cam.yaw -= wrap(now.angle - prev.angle)
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
    this.moveCamera(dt)
    let blobs = this.drawTowers(dt)
    blobs = this.drawMonsters(dt, blobs)
    commit(this.blobs, blobs, false)
    this.drawTrails(dt)
    this.drawMarks()
    this.fx.update(dt, this.camera)
    this.board?.update(dt, this.time)
    if (this.disposed) return
    this.renderer.render(this.scene, this.camera)
    this.drawOverlay(dt)
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
      this.popups.length = 0
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
        this.arrive(e)
      } else if (m.hp < e.hp) e.hurtAt = now
      e.x = m.x
      e.y = m.y
      e.hp = m.hp
      e.slowed = m.slowed
      e.poisoned = m.poisoned
    }
    const paid: { x: number; y: number; z: number; amount: number }[] = []
    for (const e of this.ents.values()) {
      if (snap.mons.has(e.id)) continue
      this.ents.delete(e.id)
      const id = this.spec.monsters[e.kind]?.id
      const look = id ? MONSTER_LOOK[id] : null
      if (snap.leaks.includes(e.id)) {
        this.fx.ring(e.wx, e.wz, 1.1, 0xff4d6d, 0.5)
        this.fx.glow([e.wx, 0.6, e.wz], 2.2, 0xff4d6d, 0.5, 1)
        this.board?.hit(e.wx, e.wz)
        this.shake = Math.max(this.shake, 0.7)
        this.audio.play('leak')
      } else if (look) {
        const big = id === 'boss' || id === 'wyvern'
        const at: [number, number, number] = [e.wx, look.fly + 0.3, e.wz]
        this.fx.burst(at, look.color, big ? 26 : 7, big ? 3.8 : 2.4, big ? 0.16 : 0.09)
        this.fx.flash(at, big ? 0.9 : 0.35, 0xffffff, 0.16)
        this.fx.smoke(at, look.color, big ? 10 : 2, big ? 0.4 : 0.16, big ? 1.4 : 0.5)
        if (big) {
          this.fx.ring(e.wx, e.wz, 2.2, 0xffe9a8, 0.6)
          this.fx.glow(at, 3.2, 0xffd9a0, 0.5, 1)
          this.shake = Math.max(this.shake, 1)
        }
        this.audio.play(big ? 'boom' : 'pop')
        const bounty = snap.paid.get(e.id)
        if (bounty) {
          this.fx.coin([e.wx, look.fly + look.top * 0.6, e.wz])
          paid.push({ x: e.wx, y: look.fly + look.top + 0.15, z: e.wz, amount: bounty })
        }
      }
    }
    // 同一下打倒一群（火砲、閃電）：靠在一起的賞金加成一個數字，不要一堆字疊在一起
    while (paid.length) {
      const first = paid.pop()!
      let total = first.amount
      for (let i = paid.length - 1; i >= 0; i--) {
        if (Math.hypot(paid[i].x - first.x, paid[i].z - first.z) < 1.1) {
          total += paid[i].amount
          paid.splice(i, 1)
        }
      }
      if (this.popups.length < 40) this.popups.push({ x: first.x, y: first.y, z: first.z, text: `+${total}`, age: 0 })
    }
  }

  /** 剛出現的怪：在入口旁邊的話，傳送門閃一下 */
  private arrive(e: Ent) {
    const board = this.board
    if (!board) return
    for (const [x, z] of board.spawns) {
      if (Math.hypot(e.wx - x, e.wz - z) > 0.9) continue
      const color = this.theme.spawn.getHex()
      this.fx.ring(x, z, 0.62, color, 0.4, 0.05, 0.7)
      this.fx.glow([x, 0.45, z], 1.3, color, 0.3, 0.8)
      return
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
    const { fx } = this
    this.audio.shot(spec.id)
    if (spec.id === 'tesla') {
      const points: [number, number, number][] = [from]
      for (const id of shot.slice(1)) {
        const e = this.ents.get(id)
        if (e) points.push([e.wx, e.wy + 0.25, e.wz])
      }
      fx.lightning(points, look.shot)
      fx.glow(from, 0.9, look.shot, 0.2, 1)
      return
    }
    if (!first) return
    const target = this.aimPoint(first.id, [first.wx, first.wy + 0.25, first.wz])
    const distance = Math.hypot(first.wx - x, first.wz - z)
    // 砲彈飛的時間照伺服器的算法（距離 ÷ 速度），遊戲加速時跟著變快
    const flight = clamp(spec.shotSpeed > 0 ? distance / spec.shotSpeed / this.speed : 0, 0.05, 0.9)
    switch (spec.id) {
      case 'sniper':
        fx.beam(from, target(), look.shot, 0.07, 0.16)
        fx.glow(from, 0.7, 0xffe9a8, 0.12, 0.9)
        fx.flash(target(), 0.3, look.shot, 0.14)
        fx.sparks(target(), 0xfff2c8, 5, 2.4)
        break
      case 'cannon':
        fx.glow(from, 1, 0xffb347, 0.14, 1)
        fx.smoke(from, 0x8a8478, 3, 0.16, 0.5)
        fx.shot(
          from,
          target,
          flight,
          look.shot,
          0.11,
          true,
          0.5 + distance * 0.18,
          () => {
            const [tx, , tz] = target()
            fx.ring(tx, tz, level.splash, 0xffa040, 0.36)
            fx.flash([tx, 0.25, tz], level.splash * 0.7, 0xffd9a0, 0.2)
            fx.glow([tx, 0.3, tz], level.splash * 1.6, 0xff9a3c, 0.3, 1)
            fx.burst([tx, 0.2, tz], 0x6b5a48, 6, 2.6, 0.08)
            fx.smoke([tx, 0.2, tz], 0x6f6a62, 4, 0.22, 0.9)
            this.audio.play('boom')
          },
          0x8a8478,
        )
        break
      case 'frost':
        fx.glow(from, 0.6, look.shot, 0.16, 0.8)
        fx.shot(
          from,
          target,
          flight,
          look.shot,
          0.09,
          true,
          0.15,
          () => {
            const [tx, ty, tz] = target()
            fx.ring(tx, tz, level.splash, 0x9fe3ff, 0.45)
            fx.glow([tx, ty, tz], level.splash * 1.3, 0x9fe3ff, 0.3, 0.7)
            fx.sparks([tx, ty, tz], 0xe8f8ff, 5, 1.6)
          },
          0xcdeeff,
        )
        break
      case 'poison':
        fx.shot(
          from,
          target,
          flight,
          look.shot,
          0.09,
          true,
          0.35,
          () => {
            const [tx, ty, tz] = target()
            fx.ring(tx, tz, 0.45, 0x9be564, 0.35)
            fx.smoke([tx, ty, tz], 0x7ccf52, 2, 0.14, 0.4)
          },
          0x9be564,
        )
        break
      default:
        fx.shot(from, target, flight, look.shot, 0.07, false, 0, () => fx.sparks(target(), 0xf2e6c8, 3, 1.8))
    }
  }

  /** 畫塔；回傳用掉幾個腳下的影子（接著給怪物用） */
  private drawTowers(dt: number): number {
    const field = this.fields[this.look]
    const now = performance.now()
    const counts = this.towerCounts
    for (const row of counts) row.fill(0)
    let bands = 0
    let pips = 0
    let halos = 0
    let blobs = 0
    const { m, m2, p, s, q, e, c } = this
    const dark = this.theme.dark
    for (const t of field?.towers.values() ?? []) {
      const spec = this.spec.towers[t.kind]
      const tier = clamp(t.level, 1, this.spec.maxLevel) - 1
      if (!spec || counts[t.kind][tier] >= TOWER_CAP) continue
      const look = TOWER_LOOK[spec.id]
      const [x, z] = this.cellCenter(t.cell)
      const grown = pop(clamp((now - t.bornAt) / 320, 0, 1))
      const boost = 1 + 0.25 * Math.max(0, 1 - (now - t.boostAt) / 380)
      const size = (1 + 0.07 * (t.level - 1)) * grown * boost
      const i = counts[t.kind][tier]++
      this.bases[t.kind][tier].setMatrixAt(i, m.compose(p.set(x, 0, z), q.identity(), s.set(size, size, size)))
      // 頭：會瞄準的轉向目標，不會的自己慢慢轉；剛開火往後縮一下
      if (look.aims) {
        const target = this.ents.get(t.aim)
        if (target) t.yaw = turnToward(t.yaw, Math.atan2(target.wx - x, target.wz - z), 0.3)
      } else if (look.spin) t.yaw = this.time * look.spin * Math.PI * 2 + t.id
      const kick = Math.max(0, 1 - (now - t.firedAt) / 160)
      const hover = look.glow ? Math.sin(this.time * 2 + t.id) * 0.04 : 0
      const swell = look.aims ? 1 : 1 + kick * 0.25
      q.setFromEuler(e.set(0, t.yaw, 0))
      const back = look.aims ? kick * (spec.id === 'cannon' ? 0.17 : 0.12) * size : 0
      const headY = (look.headY + hover) * size
      this.heads[t.kind][tier].setMatrixAt(
        i,
        m.compose(p.set(x - Math.sin(t.yaw) * back, headY, z - Math.cos(t.yaw) * back), q, s.set(size * swell, size * swell, size * swell)),
      )
      // 會發光的頭（冰晶、電球、號角）：疊一團光暈，晚上特別明顯
      if (look.glow && halos < TOWER_CAP) {
        const r = (0.62 + t.level * 0.07 + kick * 0.5 + Math.sin(this.time * 3 + t.id) * 0.04) * size
        this.halos.setMatrixAt(halos, m2.compose(p.set(x, headY, z), this.camera.quaternion, s.set(r, r, 1)))
        this.halos.setColorAt(halos, c.set(look.shot).multiplyScalar((dark ? 0.5 : 0.24) + kick * 0.5))
        halos++
      }
      // 底座上的色環是誰蓋的
      this.bands.setMatrixAt(bands, m2.compose(p.set(x, 0.045 * size, z), q.identity(), s.set(size, size, size)))
      this.bands.setColorAt(bands, this.theme.owners[t.owner % this.theme.owners.length] ?? c.setRGB(1, 1, 1))
      bands++
      // 等級：色環前面一排小珠子（一級不畫）
      if (t.level > 1) {
        for (let k = 0; k < t.level - 1; k++) {
          const angle = (k - (t.level - 2) / 2) * 0.36
          this.pips.setMatrixAt(
            pips++,
            m2.compose(p.set(x + Math.sin(angle) * 0.455 * size, 0.1 * size, z + Math.cos(angle) * 0.455 * size), q.identity(), s.set(size, size, size)),
          )
        }
      }
      if (blobs < BLOB_CAP) this.blobs.setMatrixAt(blobs++, m2.compose(p.set(x, 0.014, z), q.identity(), s.set(0.66 * size, 1, 0.66 * size)))
      if (spec.id === 'beacon' && now >= t.pulseAt) {
        // 號角：每隔一陣子往外擴一圈光，看得出它罩著哪些塔
        t.pulseAt = now + 2600
        this.fx.ring(x, z, spec.levels[t.level - 1].range, 0xffd23f, 0.9, 0.05, 0.4)
      } else if (field?.buffs.has(t.id) && Math.random() < dt * 1.3) {
        // 吃到號角加成的塔：身邊飄一點金光
        this.fx.rise(x, z, 0xffd23f, 1, 0.34, 0.25, 0.9, 0.045)
      }
    }
    this.spec.towers.forEach((_, k) => {
      for (let tier = 0; tier < this.spec.maxLevel; tier++) {
        commit(this.bases[k][tier], counts[k][tier], false)
        commit(this.heads[k][tier], counts[k][tier], false)
      }
    })
    commit(this.bands, bands, true)
    commit(this.pips, pips, false)
    commit(this.halos, halos, true)
    return blobs
  }

  private drawMonsters(dt: number, blobs: number): number {
    const now = performance.now()
    const counts = this.spec.monsters.map(() => 0)
    const { m, p, s, q, e, c } = this
    // 怪很多的時候，中毒冒的泡、變慢飄的雪就少一點
    const sprinkle = dt * Math.min(1, 36 / Math.max(1, this.ents.size))
    for (const ent of this.ents.values()) {
      const spec = this.spec.monsters[ent.kind]
      if (!spec || counts[ent.kind] >= MONSTER_CAP) continue
      const look = MONSTER_LOOK[spec.id]
      const phase = this.time * look.hop * Math.PI + ent.id * 1.7
      const hop = Math.abs(Math.sin(phase)) * look.bob
      const grown = pop(clamp((now - ent.bornAt) / 260, 0, 1))
      const hurt = Math.max(0, 1 - (now - ent.hurtAt) / 130)
      const squash = 1 + Math.sin(phase * 2) * 0.06 - hurt * 0.12
      // 同一群怪往左右錯開一點點，才不會全部疊在同一條線上
      const side = (((ent.id * 0.618034) % 1) - 0.5) * 0.3 * (1 - Math.min(0.8, spec.size))
      const x = ent.wx + Math.cos(ent.yaw) * side
      const z = ent.wz - Math.sin(ent.yaw) * side
      ent.wy = look.fly + hop
      const i = counts[ent.kind]++
      q.setFromEuler(e.set(look.fly ? Math.sin(phase) * 0.12 : 0, ent.yaw, look.fly ? Math.sin(phase * 0.5) * 0.18 : 0))
      this.bodies[ent.kind].setMatrixAt(i, m.compose(p.set(x, ent.wy, z), q, s.set(grown / Math.sqrt(squash), grown * squash, grown / Math.sqrt(squash))))
      // 顏色：剛被打到閃一下白，變慢偏藍、中毒偏綠，別人派來的偏紅
      c.setRGB(1, 1, 1)
      if (ent.sent) c.setRGB(1.25, 0.72, 0.72)
      if (ent.slowed) c.multiply(this.tintSlow)
      if (ent.poisoned) c.multiply(this.tintPoison)
      if (hurt > 0) c.multiplyScalar(1 + hurt * 1.4)
      this.bodies[ent.kind].setColorAt(i, c)
      if (blobs < BLOB_CAP) {
        const r = spec.size * (look.fly ? 1.15 : 1.5)
        this.blobs.setMatrixAt(blobs++, m.compose(p.set(x, 0.013, z), q.identity(), s.set(r, 1, r)))
      }
      if (ent.poisoned && Math.random() < sprinkle * 2.4) this.fx.rise(x, z, 0x9be564, 1, spec.size * 0.5, ent.wy + look.top * 0.5, 0.7, 0.04)
      if (ent.slowed && Math.random() < sprinkle * 1.8) this.fx.rise(x, z, 0xe8f8ff, 1, spec.size * 0.7, ent.wy + look.top + 0.1, -0.45, 0.035)
    }
    this.spec.monsters.forEach((_, k) => commit(this.bodies[k], counts[k], true))
    return blobs
  }

  /** 地上的路線：怪物現在會走的路往出口流動；這一波或下一波有飛行怪時，另外畫出牠們直飛的線 */
  private drawTrails(dt: number) {
    const field = this.fields[this.look]
    const map = this.map
    const paths = field && map && !this.preview ? field.paths : null
    if (paths !== this.shownPaths) {
      // 第一次畫不用閃；之後路線變了（蓋了塔、拆了塔）亮一下，眼睛才跟得上
      if (this.shownPaths && paths) this.pathFlash = 1
      this.shownPaths = paths
      this.trailPath.set(paths ? paths.map((path) => path.map((cell) => this.cellCenter(cell))) : [], 0.46)
    }
    const air = this.showAir && map && !this.preview ? map : null
    if (air !== this.shownAir) {
      this.shownAir = air
      this.trailAir.set(air ? air.routes.map(([spawn, exit]) => [this.cellCenter(spawn), this.cellCenter(exit)]) : [], 0.4)
    }
    this.pathFlash = Math.max(0, this.pathFlash - dt * 2.2)
    this.chevrons.offset.x = -((this.time * 1.4) % 1)
    this.dashes.offset.x = -((this.time * 2) % 1)
    // 正在預覽新路線時，現在的路淡一點
    const previewing = this.trailNext.mesh.visible
    this.trailPath.look(this.theme.path, (previewing ? 0.3 : 0.82) + this.pathFlash * 0.18)
    this.trailAir.look(this.theme.air, 0.85)
  }

  /** 游標、選取、射程，以及蓋塔前預覽的新路線 */
  private drawMarks() {
    const field = this.fields[this.look]
    const t = this.theme
    const mine = this.myField === this.look && !this.preview
    // 要蓋塔時預覽的那一格：滑鼠是游標底下，觸控是點過一下的
    const previewCell = this.buildKind && mine ? (this.armedCell ?? this.hoverCell) : null
    const ghost = previewCell !== null && field && !field.byCell.has(previewCell) ? previewCell : null
    let range = 0
    let nextRange = 0
    let at: [number, number] | null = null
    let ok = true
    let faint = false
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
        if (this.peekUpgrade) nextRange = spec.levels[tower.level]?.range ?? 0
        this.selectRing.visible = true
        this.selectRing.position.set(at[0], 0.035, at[1])
        const pulse = 1 + Math.sin(this.time * 5) * 0.05
        this.selectRing.scale.set(pulse, 1, pulse)
        ;(this.selectRing.material as MeshBasicMaterial).color.copy(t.path)
      }
    } else if (this.selectedCell !== null && mine) at = this.cellCenter(this.selectedCell)
    else if (this.hoverCell !== null && field && !this.preview) {
      const tower = field.towers.get(field.byCell.get(this.hoverCell) ?? -1)
      const spec = tower && this.spec.towers[tower.kind]
      if (tower && spec) {
        // 滑鼠停在蓋好的塔上：淡淡地畫出它的射程
        at = this.cellCenter(tower.cell)
        range = spec.levels[tower.level - 1].range
        faint = true
      } else if (mine && this.map && tileAt(this.map, this.hoverCell) === 'ground') at = this.cellCenter(this.hoverCell)
    }
    const marking = at !== null && !faint && (ghost !== null || this.selectedCell !== null || (this.selectedTower === null && this.hoverCell !== null))
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
        const material = mesh.material as MeshBasicMaterial
        material.color.copy(ok ? t.path : t.bad)
        material.opacity = (mesh === this.rangeRing ? 0.9 : 0.1) * (faint ? 0.5 : 1)
      }
    }
    this.rangeNext.visible = at !== null && nextRange > range
    if (at && this.rangeNext.visible) {
      this.rangeNext.position.set(at[0], 0.047, at[1])
      this.rangeNext.scale.set(nextRange, 1, nextRange)
      ;(this.rangeNext.material as MeshBasicMaterial).color.copy(t.ok)
    }

    // 蓋在這一格的話路線會變成怎樣：和伺服器一樣的算法先算一次
    const candidate = mine && field && this.map ? (ghost ?? (this.buildKind ? null : this.selectedCell)) : null
    const key = candidate === null || !field ? '' : `${this.look}:${candidate}:${field.rev}`
    if (key === this.previewKey) return
    this.previewKey = key
    let gain: number | null = null
    let lines: [number, number][][] = []
    if (candidate !== null && field && this.map && tileAt(this.map, candidate) === 'ground' && !field.byCell.has(candidate)) {
      const has = (cell: number) => field.byCell.has(cell)
      const before = routesOf(this.map, has)
      const after = routesOf(this.map, has, candidate)
      if (before && after) {
        gain = Math.round((after.length - before.length) * 10) / 10
        // 路線沒變就不用再畫一條蓋在上面
        if (after.paths.some((path, i) => path.length !== before.paths[i].length || path.some((cell, k) => cell !== before.paths[i][k]))) {
          lines = after.paths.map((path) => path.map((cell) => this.cellCenter(cell)))
        }
      }
    }
    this.trailNext.set(lines, 0.46)
    this.trailNext.look(t.ok, 0.95)
    if (gain !== this.previewGain || candidate === null) {
      this.previewGain = gain
      this.emit({ type: 'preview', cell: candidate, gain })
    }
  }

  /** 疊在上面的 2D 畫布：血條（受過傷的怪和魔王才畫）、賞金跳出來的數字、魔王的大血條 */
  private drawOverlay(dt: number) {
    const pen = this.pen
    if (!pen) return
    const { width, height } = this.overlay
    pen.clearRect(0, 0, width, height)
    if (this.preview) return
    const ratio = width / Math.max(1, this.host.clientWidth)
    const t = this.theme
    // 一格在畫面上多寬：血條跟著縮放（手機上怪很小，血條太大會疊成一片）
    const v = this.view
    this.p.set(v.tx, 0, v.tz).project(this.camera)
    const middle = this.p.x
    this.p.set(v.tx + Math.cos(v.yaw), 0, v.tz - Math.sin(v.yaw)).project(this.camera)
    const tile = (Math.abs(this.p.x - middle) / 2) * this.host.clientWidth
    const barWidth = clamp(tile * 0.42, 11, 24)
    const barHeight = barWidth > 16 ? 4 : 3
    const bosses: Ent[] = []
    for (const ent of this.ents.values()) {
      const spec = this.spec.monsters[ent.kind]
      if (!spec) continue
      const big = spec.lives > 1
      if (big) bosses.push(ent)
      if (ent.hp >= 63 && !big) continue
      const look = MONSTER_LOOK[spec.id]
      this.p.set(ent.wx, ent.wy + look.top, ent.wz).project(this.camera)
      if (this.p.z > 1 || Math.abs(this.p.x) > 1.05 || Math.abs(this.p.y) > 1.05) continue
      const w = barWidth * (big ? 2 : 1) * ratio
      const h = (barHeight + (big ? 2 : 0)) * ratio
      const x = ((this.p.x + 1) / 2) * width - w / 2
      const y = ((1 - this.p.y) / 2) * height - h
      const fill = ent.hp / 63
      pen.fillStyle = 'rgba(0,0,0,0.6)'
      pen.fillRect(x - ratio, y - ratio, w + 2 * ratio, h + 2 * ratio)
      pen.fillStyle = fill > 0.5 ? t.okCss : fill > 0.25 ? t.warnCss : t.badCss
      pen.fillRect(x, y, w * fill, h)
    }

    // 賞金：從怪物倒下的地方往上飄、淡掉
    if (this.popups.length) {
      pen.font = `700 ${Math.round(13 * ratio)}px ${this.font}`
      pen.textAlign = 'center'
      pen.textBaseline = 'middle'
      pen.lineJoin = 'round'
      pen.lineWidth = 3 * ratio
      let kept = 0
      for (const popup of this.popups) {
        popup.age += dt
        if (popup.age >= POPUP_LIFE) continue
        this.popups[kept++] = popup
        const k = popup.age / POPUP_LIFE
        this.p.set(popup.x, popup.y, popup.z).project(this.camera)
        if (this.p.z > 1) continue
        const x = ((this.p.x + 1) / 2) * width
        const y = ((1 - this.p.y) / 2) * height - (1 - (1 - k) ** 2) * 26 * ratio
        pen.globalAlpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4
        pen.strokeStyle = rgba(t.surface, 0.9)
        pen.strokeText(popup.text, x, y)
        pen.fillStyle = t.goldCss
        pen.fillText(popup.text, x, y)
      }
      this.popups.length = kept
      pen.globalAlpha = 1
    }

    // 魔王上場：上面多一條大血條（最多兩條）
    bosses.sort((a, b) => a.id - b.id)
    bosses.slice(0, 2).forEach((ent, i) => {
      const spec = this.spec.monsters[ent.kind]
      const w = Math.min(280, this.host.clientWidth * 0.56) * ratio
      const h = 9 * ratio
      const x = (width - w) / 2
      const y = (this.insets.top + 20 + i * 34) * ratio
      pen.font = `700 ${Math.round(12.5 * ratio)}px ${this.font}`
      pen.textAlign = 'center'
      pen.textBaseline = 'alphabetic'
      pen.lineJoin = 'round'
      pen.lineWidth = 3 * ratio
      pen.strokeStyle = rgba(t.surface, 0.9)
      pen.strokeText(spec.name, width / 2, y - 5 * ratio)
      pen.fillStyle = t.text
      pen.fillText(spec.name, width / 2, y - 5 * ratio)
      const pill = (px: number, py: number, pw: number, ph: number) => {
        const r = ph / 2
        pen.beginPath()
        pen.moveTo(px + r, py)
        pen.arcTo(px + pw, py, px + pw, py + ph, r)
        pen.arcTo(px + pw, py + ph, px, py + ph, r)
        pen.arcTo(px, py + ph, px, py, r)
        pen.arcTo(px, py, px + pw, py, r)
        pen.closePath()
      }
      pen.fillStyle = 'rgba(0,0,0,0.62)'
      pill(x - 2 * ratio, y - 2 * ratio, w + 4 * ratio, h + 4 * ratio)
      pen.fill()
      pen.fillStyle = t.badCss
      pill(x, y, Math.max(h, (w * ent.hp) / 63), h)
      pen.fill()
    })
  }
}
