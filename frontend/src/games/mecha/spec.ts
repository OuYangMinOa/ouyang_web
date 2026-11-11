// 機甲的數值。五台：速度型「疾風」、狙擊型「長弓」、偵察型「渡鴉」、堡壘型「要塞」和砲擊型「隕星」，選隊時每個人自己挑。
// 耐久、飛彈數、主武器的傷害、射速和射程、偵察機的數量和爆炸、迫擊砲彈伺服器也有一份（`backend/src/mecha.rs` 的 `MechKind`），改了要一起改。

export type MechKind = 'speed' | 'sniper' | 'recon' | 'fortress' | 'mortar'

export const MECH_KINDS: readonly MechKind[] = ['speed', 'sniper', 'recon', 'fortress', 'mortar']

/** 主武器的數值（變身後換的那一把也是這一組） */
export type Arms = {
  /** 主武器的名稱 */
  weapon: string
  /** 主武器：每秒幾發（兩門輪流）、彈匣、換彈時間、射程 */
  fireRate: number
  magazine: number
  reload: number
  gunRange: number
  /** 散布（弧度）：站著、放大瞄準站著、移動、在空中；迫擊砲是落點偏多遠（距離的幾成） */
  spread: number
  zoomSpread: number
  moveSpread: number
  airSpread: number
  /** 近距離一發的傷害（只是畫面上顯示用，真正的傷害伺服器算） */
  gunDamage: number
}

/**
 * 變身（堡壘型、砲擊型，按 E）：變身中、變身後都不能走，只能轉向；變身中、收回中不能用主武器（飛彈可以）。
 * 變身後換一把主武器（`arms`）、打中範圍變矮、鏡頭換位置
 */
export type DeploySpec = {
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
  /** 主武器是迫擊砲（砲擊型，見 `SHELL`）：準星對到的地方就是落點 */
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
    blurb: '四腳的砲台機：背上兩門長管電磁砲，一發就是一大塊裝甲，放大瞄準時站穩了幾乎百發百中；沒有推進器，Shift 只是跑快一點、也飛不起來，靠距離活下來。肩上一樣掛兩發飛彈。',
    hp: 240,
    radius: 2.1,
    height: 5,
    hitR: 2.4,
    hitH: 4.8,
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
      '兩條反關節長腿的偵察機：拿一把中距離的脈衝步槍，背上掛兩架偵察機。放出去的偵察機鏡頭裡看得到的敵人，隊友的畫面和小地圖上都看得到（飛太遠訊號會變差）；還可以開過去直接引爆（敵人打得下來）。操控偵察機的時候機甲站著不能動，也可以讓它停在原地繼續偵測、回到機甲開火。',
    hp: 210,
    radius: 1.6,
    height: 5.8,
    hitR: 1.7,
    hitH: 6.2,
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
      '重裝甲的堡壘機：平常右手一挺輕機槍、左手扛著摺起來的大盾，沒有推進器，Shift 只是跑快一點。按 E 變身成堡壘：腳往下蹲、背後的支架撐住地面，背上兩門六管重機槍翻到肩上，射速是平常的三倍；大盾立在前面張開，擋住正面打來的子彈和飛彈（從旁邊、後面、高處打得到，盾牌上面露出一截）。變身時不能走動，只能轉向。肩上一樣掛兩發飛彈。',
    hp: 320,
    radius: 2.3,
    height: 6,
    hitR: 2.4,
    hitH: 6.2,
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
      hitH: 5.2,
      cam: [13, 3.6, 2.8],
      zoomCam: [6.5, 2.4, 1.6],
      zoomFov: 34,
      arms: {
        weapon: '重機槍',
        fireRate: 18,
        magazine: 200,
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
      '揹著一門大口徑迫擊砲的砲兵機：平常右手一把卡賓槍，沒有推進器。按 E 架砲：跪下來、背後的支架撐住地面、砲管立起來，鏡頭升到高處；準星對到哪裡，砲彈就從天上掉到那裡（最遠 520 公尺，越遠飛越久），隔著大樓也打得到。砲彈落下前，落點附近的人看得到地上的警告圈，跑得掉。架砲時不能走動，只能轉向。肩上一樣掛兩發飛彈。',
    hp: 220,
    radius: 1.9,
    height: 5.6,
    hitR: 2,
    hitH: 5.8,
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
      hitH: 4.2,
      cam: [17, 2, 15],
      zoomCam: [10, 1.5, 18],
      zoomFov: 22,
      arms: {
        weapon: '迫擊砲',
        fireRate: 1 / 2.4,
        magazine: 6,
        reload: 5,
        gunRange: 520,
        spread: 0.012,
        zoomSpread: 0.006,
        moveSpread: 0.012,
        airSpread: 0.012,
        gunDamage: 80,
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
 * 迫擊砲彈（砲擊型變身後的主武器）：從砲口照算好的初速射出去，照重力往下掉，撞到東西、機甲或敵人的盾牌就爆炸。
 * 飛多久照距離算（越遠飛越久，最遠大約 6.3 秒），落下前 `warn` 秒落點會出現警告圈（大家都看得到）。
 * 爆炸半徑內、看得到爆炸點的敵人受傷：離打中範圍 `core` 公尺內算直接命中。傷害、重力伺服器也有一份（`mecha.rs` 的 `SHELL_*`）
 */
export const SHELL = {
  gravity: 24,
  /** 飛多久：`time0` 秒加上每 `timePer` 公尺 1 秒 */
  time0: 1.6,
  timePer: 110,
  /** 最遠、最近（水平距離） */
  range: 520,
  min: 35,
  blast: 10,
  core: 3,
  damage: 80,
  splash: 40,
  warn: 3,
  /** 飛多久就不管了（掉出地圖） */
  life: 12,
} as const

/**
 * 偵察型的偵察機（`drone.ts`）：放出去後自己操控（機甲站著不能動、不能開火），按引爆才爆炸、沒有時間限制。
 * 也可以讓它停在原地、回到機甲（能動、能開火），之後再回去操控；機甲倒下時偵察機跟著掉下去。
 * 在外面的時候一直掃描：鏡頭畫面裡看得到的敵人（見 `viewH`、`viewV`、`scan`）在隊友的畫面上和小地圖上標記 `mark` 秒。
 * 飛多遠都可以，只是離自己的機甲越遠訊號越差：畫面越來越多雜訊、越來越糊（`clear`、`lost`），看得到的距離也跟著縮短。
 * 敵人的主武器打得下來（累積 `hp`，伺服器的 `DRONE_HP`）。爆炸的傷害、半徑伺服器也有一份（`mecha.rs` 的 `DRONE_*`）
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
  /** 引爆：半徑、傷害 */
  blast: 9,
  damage: 60,
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
