// 機甲的數值。五台：速度型「疾風」、狙擊型「長弓」、偵察型「渡鴉」、堡壘型「要塞」和砲擊型「隕星」，選隊時每個人自己挑。
// 耐久、飛彈數、主武器的傷害、射速和射程、偵察機的數量、迫擊砲彈伺服器也有一份（`backend/src/mecha.rs` 的 `MechKind`），改了要一起改。
// 三種一擊擊倒（不管對方是哪一種、剩多少血，伺服器的 `KILL`）：偵察機爆炸炸到、迫擊砲彈炸到、狙擊型的電磁砲打中頭（`MechSpec.head`）。

export type MechKind = 'speed' | 'sniper' | 'recon' | 'fortress' | 'mortar'

export const MECH_KINDS: readonly MechKind[] = ['speed', 'sniper', 'recon', 'fortress', 'mortar']

/** 主武器的數值（變身後換的那一把也是這一組） */
export type Arms = {
  /** 主武器的名稱 */
  weapon: string
  /** 主武器：每秒幾發（幾門輪流）、彈匣、換彈時間、射程 */
  fireRate: number
  magazine: number
  reload: number
  gunRange: number
  /** 散布（弧度）：站著、放大瞄準站著、移動、在空中；迫擊砲是方位偏多少（仰角偏一半） */
  spread: number
  zoomSpread: number
  moveSpread: number
  airSpread: number
  /** 近距離一發的傷害（只是畫面上顯示用，真正的傷害伺服器算；迫擊砲炸到就倒，用不到） */
  gunDamage: number
}

/**
 * 變身（堡壘型、砲擊型，按 E）：變身中、變身後都不能走，只能轉向；變身中、收回中不能用主武器（飛彈可以）。
 * 變身後換一把主武器（`arms`）、打中範圍變矮、鏡頭換位置
 */
export type DeploySpec = {
  /** 變身後身體往下蹲多少（頭跟著低，見 `MechSpec.head`；和模型蹲下去的量一樣） */
  drop: number
  /** 變身、收回要幾秒 */
  time: number
  pack: number
  /** 變身後叫什麼（儀表、按鈕）、變身和收回的按鈕上寫什麼 */
  name: string
  verb: string
  /** 變身後打中範圍的高 */
  hitH: number
  /** 變身後的鏡頭（往後、往右、往上）、放大瞄準時的鏡頭和視角 */
  cam: readonly [number, number, number]
  zoomCam: readonly [number, number, number]
  zoomFov: number
  arms: Arms
  /**
   * 前面的盾牌（堡壘型）：一面立在地上的牆，跟著上半身轉，中心離身體中心多遠、多寬、多高。
   * 擋住從正面打來的敵人的子彈（飛彈、砲彈撞到會爆炸，爆風還是炸得到），自己這隊的子彈穿過去；沒有是 null
   */
  shield: { dist: number; width: number; height: number } | null
  /**
   * 主武器是迫擊砲（砲擊型，見 `SHELL`）：瞄準的仰角換成砲管的仰角（`SHELL.elevMin`～`elevMax`），鏡頭在機甲後面微微抬頭
   * （抬多高照 `SHELL.view`，比砲管低很多），只能調仰角和左右，沒有落點的標示
   */
  mortar: boolean
}

/** 一種機甲的數值 */
export type MechSpec = Arms & {
  name: string
  role: string
  /** 記分板、選隊名單上的短名稱 */
  short: string
  blurb: string
  /** 耐久（伺服器 `MechKind::max_hp`） */
  hp: number
  /** 碰撞用的圓柱：半徑、高 */
  radius: number
  height: number
  /** 打中的範圍（不管朝哪邊都用同一個方塊）：半徑、高 */
  hitR: number
  hitH: number
  /**
   * 頭（駕駛艙、感測器那一截；狙擊型的電磁砲打中這裡一發擊倒）：打中範圍裡面中間的一個小方塊，
   * 半徑、離腳底多高到多高；變身時跟著往下蹲 `deploy.drop`
   */
  head: { r: number; y0: number; y1: number }
  /** 鏡頭繞著轉的中心離腳底多高 */
  eye: number
  /** 鏡頭在中心後面多遠、往右多少、往上多少：平常和放大瞄準時 */
  cam: readonly [number, number, number]
  zoomCam: readonly [number, number, number]
  /** 放大瞄準的視角（度） */
  zoomFov: number
  /** 走路、衝刺（Shift：有推進器是噴火衝刺，沒有就是快跑）的最高速度（公尺／秒） */
  walk: number
  boost: number
  /** 地面加速度、衝刺加速度、空中加速度 */
  accel: number
  boostAccel: number
  airAccel: number
  /** 跳躍初速、按住跳躍時推進器往上推的力（比重力大一點：會慢慢往上飄）、最高飛到幾公尺（沒有推進器的不能飛，用不到） */
  jump: number
  hover: number
  maxHover: number
  /** 衝刺、飛行每秒用掉的能量 */
  boostDrain: number
  hoverDrain: number
  /** 走路的動畫：每走幾公尺，走路的相位前進一弧度 */
  gait: number
  /** 推進器噴火的位置：往右、往後、往上，跟著上半身轉；`null` 是沒有推進器（Shift 只是跑快一點、空白鍵只能跳一下） */
  jets: { side: number; back: number; up: number } | null
  /** 每條命幾架偵察機（只有偵察型有，見 `DRONE`） */
  drones: number
  /** 變身（堡壘型、砲擊型）；不會變身是 null */
  deploy: DeploySpec | null
}

export const MECHS: Record<MechKind, MechSpec> = {
  speed: {
    name: '疾風',
    role: '速度型',
    short: '速度',
    blurb: '輕裝甲的突擊機：兩臂的速射機砲、背後的推進器讓它衝得比誰都快，肩上掛兩發追蹤飛彈。',
    hp: 200,
    radius: 1.7,
    height: 6.2,
    hitR: 1.8,
    hitH: 6.6,
    head: { r: 1, y0: 4.6, y1: 5.9 },
    eye: 5.8,
    cam: [11, 3.1, 1.9],
    zoomCam: [5.5, 1.9, 1],
    zoomFov: 40,
    walk: 15,
    boost: 34,
    accel: 60,
    boostAccel: 75,
    airAccel: 16,
    jump: 12,
    hover: 38,
    maxHover: 12,
    boostDrain: 30,
    hoverDrain: 26,
    gait: 3.4,
    weapon: '機砲',
    fireRate: 10,
    magazine: 60,
    reload: 2.2,
    gunRange: 230,
    spread: 0.01,
    zoomSpread: 0.01,
    moveSpread: 0.02,
    airSpread: 0.035,
    gunDamage: 8,
    jets: { side: 0.78, back: 2.3, up: 4.2 },
    drones: 0,
    deploy: null,
  },
  sniper: {
    name: '長弓',
    role: '狙擊型',
    short: '狙擊',
    blurb:
      '四腳的砲台機：背上兩門長管電磁砲，一發就是一大塊裝甲，打中頭（駕駛艙那一截）不管是哪一種機甲都一發擊倒；放大瞄準時站穩了幾乎百發百中。沒有推進器，Shift 只是跑快一點、也飛不起來，靠距離活下來。肩上一樣掛兩發飛彈。',
    hp: 240,
    radius: 2.1,
    height: 5,
    hitR: 2.4,
    hitH: 4.8,
    head: { r: 1, y0: 3.1, y1: 4.3 },
    eye: 4.6,
    cam: [12.5, 3.4, 2.3],
    zoomCam: [0, 0, 0.4],
    zoomFov: 16,
    walk: 11,
    boost: 19,
    accel: 45,
    boostAccel: 40,
    airAccel: 10,
    jump: 10,
    hover: 0,
    maxHover: 0,
    boostDrain: 20,
    hoverDrain: 0,
    gait: 1.3,
    weapon: '電磁砲',
    fireRate: 0.9,
    magazine: 8,
    reload: 3.2,
    gunRange: 420,
    spread: 0.006,
    zoomSpread: 0.0012,
    moveSpread: 0.03,
    airSpread: 0.06,
    gunDamage: 50,
    jets: null,
    drones: 0,
    deploy: null,
  },
  recon: {
    name: '渡鴉',
    role: '偵察型',
    short: '偵察',
    blurb:
      '兩條反關節長腿的偵察機：拿一把中距離的脈衝步槍，背上掛兩架偵察機。放出去的偵察機鏡頭裡看得到的敵人，隊友的畫面和小地圖上都看得到（飛太遠訊號會變差）；還可以開過去直接引爆，炸到的不管是哪一種機甲都一發擊倒（敵人打得下來）。操控偵察機的時候機甲站著不能動，也可以讓它停在原地繼續偵測、回到機甲開火。',
    hp: 210,
    radius: 1.6,
    height: 5.8,
    hitR: 1.7,
    hitH: 6.2,
    head: { r: 1, y0: 4.5, y1: 5.8 },
    eye: 5.4,
    cam: [10.5, 2.9, 1.8],
    zoomCam: [5, 1.8, 0.9],
    zoomFov: 38,
    walk: 14,
    boost: 21,
    accel: 55,
    boostAccel: 45,
    airAccel: 12,
    jump: 11,
    hover: 0,
    maxHover: 0,
    boostDrain: 20,
    hoverDrain: 0,
    gait: 2.6,
    weapon: '脈衝步槍',
    fireRate: 5,
    magazine: 30,
    reload: 2,
    gunRange: 260,
    spread: 0.008,
    zoomSpread: 0.004,
    moveSpread: 0.016,
    airSpread: 0.03,
    gunDamage: 11,
    jets: null,
    drones: 2,
    deploy: null,
  },
  fortress: {
    name: '要塞',
    role: '堡壘型',
    short: '堡壘',
    blurb:
      '重裝甲的堡壘機：平常右手一挺輕機槍、左手扛著摺起來的大盾，沒有推進器，Shift 只是跑快一點。按 E 變身成堡壘：腳往下蹲、背後的支架撐住地面，背上四門六管重機槍翻到肩上輪流開火，射速是平常的四倍；大盾立在前面張開，擋住正面打來的子彈和飛彈（從旁邊、後面、高處打得到，盾牌上面露出一截；頭縮在盾牌後面，正面打不到）。變身時不能走動，只能轉向。肩上一樣掛兩發飛彈。',
    hp: 320,
    radius: 2.3,
    height: 6,
    hitR: 2.4,
    hitH: 6.2,
    head: { r: 0.9, y0: 4.2, y1: 5.3 },
    eye: 5.4,
    cam: [12.5, 3.4, 2.2],
    zoomCam: [6, 2.2, 1.1],
    zoomFov: 40,
    walk: 9,
    boost: 17,
    accel: 40,
    boostAccel: 36,
    airAccel: 8,
    jump: 9,
    hover: 0,
    maxHover: 0,
    boostDrain: 18,
    hoverDrain: 0,
    gait: 2,
    weapon: '輕機槍',
    fireRate: 6,
    magazine: 48,
    reload: 2.6,
    gunRange: 200,
    spread: 0.012,
    zoomSpread: 0.008,
    moveSpread: 0.022,
    airSpread: 0.04,
    gunDamage: 7,
    jets: null,
    drones: 0,
    deploy: {
      time: 1.1,
      pack: 0.9,
      name: '堡壘模式',
      verb: '變身',
      drop: 0.95,
      hitH: 5.2,
      // 變身後鏡頭在正後方、貼得很近，從四門重機槍中間看出去
      cam: [3.8, 0, 2],
      zoomCam: [1.6, 0, 1.1],
      zoomFov: 34,
      arms: {
        weapon: '重機槍',
        fireRate: 24,
        magazine: 240,
        reload: 4,
        gunRange: 260,
        spread: 0.009,
        zoomSpread: 0.006,
        moveSpread: 0.009,
        airSpread: 0.009,
        gunDamage: 7,
      },
      shield: { dist: 3.2, width: 7.4, height: 4.4 },
      mortar: false,
    },
  },
  mortar: {
    name: '隕星',
    role: '砲擊型',
    short: '砲擊',
    blurb:
      '揹著一門大口徑迫擊砲的砲兵機：平常右手一把卡賓槍，沒有推進器。按 E 架砲：跪下來、背後的支架撐住地面、砲管立起來，鏡頭拉到機甲後面微微抬頭。沒有落點的標示，只能調砲管的仰角（20～85 度）和左右：仰角 45 度打最遠（大約 520 公尺），往上往下都變近（85 度大約 90 公尺、20 度大約 340 公尺）；高角度隔著大樓也打得到，低角度飛得快、但會被大樓擋住，要靠小地圖和隊友的偵察估距離。炸到的不管是哪一種機甲都一發擊倒；對方沒有任何提示，只聽得到很大的砲聲。架砲時不能走動，只能轉向。肩上一樣掛兩發飛彈。',
    hp: 220,
    radius: 1.9,
    height: 5.6,
    hitR: 2,
    hitH: 5.8,
    head: { r: 0.8, y0: 4.2, y1: 5.1 },
    eye: 5.2,
    cam: [11.5, 3.1, 2],
    zoomCam: [5.5, 2, 1],
    zoomFov: 40,
    walk: 12,
    boost: 20,
    accel: 48,
    boostAccel: 42,
    airAccel: 10,
    jump: 10,
    hover: 0,
    maxHover: 0,
    boostDrain: 20,
    hoverDrain: 0,
    gait: 2.4,
    weapon: '卡賓槍',
    fireRate: 4,
    magazine: 20,
    reload: 2.2,
    gunRange: 190,
    spread: 0.008,
    zoomSpread: 0.004,
    moveSpread: 0.018,
    airSpread: 0.035,
    gunDamage: 9,
    jets: null,
    drones: 0,
    deploy: {
      time: 1.4,
      pack: 1,
      name: '砲擊模式',
      verb: '架砲',
      drop: 1.5,
      hitH: 4.2,
      // 架砲後鏡頭拉到機甲的正後方（看得到整台機甲和砲管）；放大瞄準拉近一點、轉得慢，方便微調
      cam: [14, 0, 3],
      zoomCam: [9, 0, 2.2],
      zoomFov: 44,
      arms: {
        weapon: '迫擊砲',
        fireRate: 1 / 2.4,
        magazine: 6,
        reload: 5,
        gunRange: 520,
        spread: 0.008,
        zoomSpread: 0.004,
        moveSpread: 0.008,
        airSpread: 0.008,
        gunDamage: 0,
      },
      shield: null,
      mortar: true,
    },
  },
}

/** 機甲的種類（看不懂的當速度型） */
export function mechKind(v: unknown): MechKind {
  return typeof v === 'string' && (MECH_KINDS as readonly string[]).includes(v) ? (v as MechKind) : 'speed'
}

/** 現在用的主武器：變身好了是變身後的那一把（`ready` 是變身好了） */
export function armsOf(spec: MechSpec, ready: boolean): Arms {
  return ready && spec.deploy ? spec.deploy.arms : spec
}

/** 變身的進度（0～1）照起來平滑一點：慢慢開始、慢慢停 */
export const ease = (k: number) => k * k * (3 - 2 * k)

/**
 * 迫擊砲彈（砲擊型變身後的主武器）：從砲口照砲管的方向用固定的初速 `speed` 射出去，照重力往下掉，撞到東西、機甲或敵人的盾牌就爆炸。
 * 開砲的人沒有落點的標示，只能調砲管的仰角（`elevMin`～`elevMax`：45 度最遠，往上往下都變近；低角度飛得快、容易被大樓擋住）和左右；
 * 平地上打多遠、飛多久照仰角算得出來（`shellRange`、`shellTime`，畫面上只顯示這個）。
 * 對方沒有任何提示（沒有警告圈、警告），只聽得到開砲很大的一聲。爆炸半徑內、看得到爆炸點的敵人一律擊倒。重力、初速伺服器也有一份（`mecha.rs` 的 `SHELL_*`）
 */
export const SHELL = {
  gravity: 36,
  speed: 137,
  /** 砲管的仰角（弧度）：20～85 度 */
  elevMin: (20 * Math.PI) / 180,
  elevMax: (85 * Math.PI) / 180,
  /** 架砲時鏡頭抬頭的角度（弧度）：砲管在最低仰角時抬 `base`，砲管每多抬 1 度鏡頭多抬 `follow` 度（不用跟著砲管看到天頂） */
  view: { base: 0.1, follow: 0.3 },
  /** 自己開砲後鏡頭抬頭看著砲彈飛出去：看幾秒、最多抬到幾度、砲彈放在畫面中間往上多少（鏡頭的位置不動，看完慢慢轉回來） */
  watch: { time: 1.1, max: 1.2, above: 0.2 },
  /** 平地上最遠、最近大約打多遠（`speed`² ÷ `gravity`，和仰角最高時；電腦和說明用） */
  range: 520,
  min: 90,
  blast: 10,
  /** 飛多久就不管了（掉出地圖） */
  life: 12,
} as const

/** 仰角 `elev` 發射、砲口比落點高 `h` 公尺：幾秒後落地 */
export function shellTime(elev: number, h = 0): number {
  const vy = SHELL.speed * Math.sin(elev)
  return (vy + Math.sqrt(Math.max(0, vy * vy + 2 * SHELL.gravity * h))) / SHELL.gravity
}

/** 仰角 `elev` 發射、砲口比落點高 `h` 公尺：落在多遠（水平） */
export function shellRange(elev: number, h = 0): number {
  return SHELL.speed * Math.cos(elev) * shellTime(elev, h)
}

/**
 * 要打到水平 `d` 公尺外、比砲口高 `dy` 公尺的地方，砲管要抬到幾度（高射角的那一個解）；
 * 太遠打不到、太近（要比 `elevMax` 還高）是 null
 */
export function shellElevation(d: number, dy: number): number | null {
  const v2 = SHELL.speed * SHELL.speed
  const g = SHELL.gravity
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2)
  if (disc < 0 || d < 1) return null
  const elev = Math.atan2(v2 + Math.sqrt(disc), g * d)
  return elev > SHELL.elevMax ? null : Math.max(elev, SHELL.elevMin)
}

/**
 * 偵察型的偵察機（`drone.ts`）：放出去後自己操控（機甲站著不能動、不能開火），按引爆才爆炸、沒有時間限制。
 * 也可以讓它停在原地、回到機甲（能動、能開火），之後再回去操控；機甲倒下時偵察機跟著掉下去。
 * 在外面的時候一直掃描：鏡頭畫面裡看得到的敵人（見 `viewH`、`viewV`、`scan`）在隊友的畫面上和小地圖上標記 `mark` 秒。
 * 飛多遠都可以，只是離自己的機甲越遠訊號越差：畫面越來越多雜訊、越來越糊（`clear`、`lost`），看得到的距離也跟著縮短。
 * 敵人的主武器打得下來（累積 `hp`，伺服器的 `DRONE_HP`）。引爆時爆炸半徑內、看得到爆炸點的敵人一律擊倒（伺服器的 `KILL`）
 */
export const DRONE = {
  /** 最高速度、加速度、上升下降的速度（公尺／秒） */
  speed: 26,
  accel: 45,
  climb: 13,
  /** 訊號：離自己的機甲（水平）超過 `clear` 公尺畫面開始有雜訊，到 `lost` 公尺整個畫面都是雜訊、什麼都掃不到（飛回來一點就好） */
  clear: 200,
  lost: 340,
  /** 最高飛到多高 */
  ceiling: 70,
  /** 模型放大幾倍（機身大約 1.8 公尺寬）；碰撞的半徑；被子彈打中的半徑（比機身大一點，不然很難打） */
  scale: 0.72,
  radius: 0.7,
  hitR: 1.15,
  /** 耐久：主武器累積打這麼多就掉下來 */
  hp: 30,
  /**
   * 掃描：鏡頭畫面中間的掃描框裡（往前看，左右各 `viewH` 度、上下各 `viewV` 度，寬螢幕上大約是畫面中間六成）、`scan` 公尺內、
   * 中間沒被擋住的敵人才算掃到；掃到之後標記 `mark` 秒；掃描波多久一次（只是畫面）
   */
  scan: 90,
  viewH: 34,
  viewV: 24,
  mark: 6,
  pulse: 1.4,
  /** 引爆：半徑（炸到的一律擊倒） */
  blast: 9,
  /** 放出去多久後才能引爆（不會一放出去就被按著的開火鍵引爆） */
  arm: 0.5,
} as const

/** 每台機甲都一樣的數值 */
export const MECH = {
  /** 跨得上去的高度（路緣、矮花台） */
  step: 0.7,
  gravity: 30,
  /** 能量：衝刺和飛行共用，用完要等它回滿一點 */
  energy: 100,
  regen: 28,
  /** 停止使用多久後開始回能量（秒） */
  regenDelay: 0.6,
  /** 能量低於這個不能開始衝刺 */
  minBoost: 15,
  /** 飛彈：每條命幾發、最高速度、追鎖定目標的轉向速度（弧度／秒）、壽命、鎖定距離、鎖定角度、鎖定要瞄多久 */
  missiles: 2,
  missileSpeed: 72,
  missileTurn: 2.4,
  missileLife: 5,
  /**
   * 飛彈的彈道（`game.ts` 的 `makeCourse`：先往上飛、再彎下來沿著往準星的線飛）：發射時的速度、加速度；
   * 有鎖定的沿著彈道飛幾秒後改成追目標，剛轉下來那 0.7 秒的轉向速度（之後照 `missileTurn`，衝刺橫移還是躲得掉）
   */
  missileLaunch: 30,
  missileAccel: 120,
  missilePop: 0.35,
  missileDive: 5,
  lockRange: 180,
  lockAngle: 0.2,
  lockTime: 0.55,
  /** 飛彈離機甲的打中範圍多近就算直接命中、爆風半徑 */
  missileHit: 0.8,
  splash: 7,
  /** 復活要等幾秒（伺服器 `RESPAWN`） */
  respawn: 5,
} as const

/** 兩隊的顏色：機甲的裝甲、發光的地方（推進器、駕駛艙）、小地圖和名牌 */
export const TEAMS = [
  { name: '紅隊', short: '紅', armor: 0xa8412c, trim: 0x5a2a20, glow: 0xffa040, beam: 0xff5a3c },
  { name: '藍隊', short: '藍', armor: 0x2d5f9e, trim: 0x223650, glow: 0x6ad8ff, beam: 0x3ca0ff },
] as const

/** 畫面上用的隊伍 class（CSS 照這個上色） */
export const teamClass = (team: 0 | 1) => (team === 0 ? 'red' : 'blue')
