/** 狼人殺的 view、動作和選項，和 backend/src/werewolf.rs 對應 */

export type Role = 'wolf' | 'villager' | 'seer' | 'witch' | 'hunter' | 'guard'

export type Stage =
  | 'peek'
  | 'night'
  | 'witch'
  | 'dawn'
  | 'skill'
  | 'lastWords'
  | 'discuss'
  | 'vote'
  | 'verdict'
  | 'end'

export type WwOptions = {
  /** 線下模式：白天當面討論，房主按「開始投票」 */
  offline: boolean
  /** 自訂角色；false 是依人數的預設配置 */
  custom: boolean
  wolves: number
  seer: boolean
  witch: boolean
  hunter: boolean
  guard: boolean
  /** 屠邊（side）或屠城（all） */
  win: 'side' | 'all'
  selfSave: 'never' | 'firstNight' | 'always'
  lastWords: 'never' | 'firstNight' | 'always'
  tie: 'revote' | 'noExile'
  /** 出局時公開身分 */
  reveal: boolean
  nightSecs: number
  discussSecs: number
}

export type Lineup = {
  wolves: number
  villagers: number
  seer: boolean
  witch: boolean
  hunter: boolean
  guard: boolean
}

export type WwSeat = {
  alive: boolean
  online: boolean
  /** 自己、狼隊友、開過槍的獵人、出局公開身分，或結束後才看得到 */
  role: Role | null
  ready: boolean
  voted: boolean
  points: number
}

export type Check = { night: number; seat: number; wolf: boolean }

/** 只有自己看得到的部分 */
export type Me = {
  role: Role
  alive: boolean
  /** 今晚該做的做完了 */
  nightDone: boolean
  suspect: number | null
  /** 狼人：所有狼人的座位 */
  wolves: number[] | null
  /** 狼人：夜裡狼隊友各投誰（target null 是空刀） */
  kills: { seat: number; voted: boolean; target: number | null }[] | null
  /** 狼人：女巫行動時，今晚定案的刀口 */
  decided: { target: number | null } | null
  guard: {
    last: number | null
    decided: boolean
    pick: number | null
    history: { night: number; seat: number | null }[]
  } | null
  checks: Check[] | null
  checked: number | null
  witch: {
    antidote: boolean
    poison: boolean
    /** 這一步開始時還有解藥，看得到刀口 */
    victimKnown: boolean
    victim: number | null
    canSelfSave: boolean
    done: boolean
    history: { night: number; saved: number | null; poisoned: number | null }[]
  } | null
  /** 剛出局、要確認技能 */
  skill: { hunter: boolean; canShoot: boolean } | null
}

export type Death = {
  day: number
  seat: number
  /** 對局中只公開「夜裡」「放逐」「被帶走」 */
  when: 'night' | 'exile' | 'shot'
  /** 結束後才有 */
  cause: 'knife' | 'poison' | 'exile' | 'shot' | null
}

export type Shot = { day: number; hunter: number; target: number }

export type Tally = {
  day: number
  revote: boolean
  voters: number[]
  /** 每個座位投給誰；不能投、棄票或沒投是 null */
  ballots: (number | null)[]
  out: number | null
}

export type NightLog = {
  night: number
  guard: number | null
  kill: number | null
  saved: boolean
  poison: number | null
  check: Check | null
  deaths: number[]
}

export type WwView = {
  stage: Stage
  endsIn: number | null
  /** 第 N 晚之後是第 N 天，看身分時是 0 */
  day: number
  options: WwOptions
  lineup: Lineup
  you: number | null
  me: Me | null
  seats: WwSeat[]
  deaths: Death[]
  shots: Shot[]
  /** 正在處理的這批出局的人 */
  batch: number[]
  skillWait: number[]
  speaker: number | null
  speakers: number[]
  vote: { candidates: number[]; voters: number[]; revote: boolean; voted: boolean; mine: number | null } | null
  tallies: Tally[]
  result: { winner: 'good' | 'wolf'; reason: string | null } | null
  /** 結束後才有：每一晚發生的事 */
  nights: NightLog[] | null
}

export type WwAction =
  | { type: 'ready' }
  | { type: 'guard'; seat: number | null }
  | { type: 'kill'; seat: number | null }
  | { type: 'check'; seat: number }
  | { type: 'save' }
  | { type: 'poison'; seat: number }
  | { type: 'pass' }
  | { type: 'suspect'; seat: number | null }
  | { type: 'shoot'; seat: number | null }
  | { type: 'done' }
  | { type: 'advance' }
  | { type: 'vote'; seat: number | null }

export type WerewolfParty = { view: WwView; action: WwAction; options: WwOptions; event: never }

export const MIN_PLAYERS = 6
export const MAX_PLAYERS = 12

export const ROLE_NAMES: Record<Role, string> = {
  wolf: '狼人',
  villager: '平民',
  seer: '預言家',
  witch: '女巫',
  hunter: '獵人',
  guard: '守衛',
}

export const ROLE_ICONS: Record<Role, string> = {
  wolf: '🐺',
  villager: '🧑‍🌾',
  seer: '🔮',
  witch: '🧪',
  hunter: '🏹',
  guard: '🛡️',
}

export const ROLE_INFO: Record<Role, string> = {
  wolf: '夜裡和狼隊友私下商量，一起選一個人淘汰。白天混在好人裡，別讓大家把你投出去。',
  villager: '沒有特殊能力，靠聽發言、看投票找出狼人。你手上的一票很重要。',
  seer: '每晚查驗一位玩家，知道他是不是狼人。白天要想好什麼時候把結果說出來。',
  witch: '有一瓶解藥和一瓶毒藥，各能用一次，同一晚只能用一瓶。解藥還在時，夜裡會知道誰被狼人選中。',
  hunter: '出局時可以開槍帶走一位玩家；被女巫的毒藥毒倒時就不能開槍。',
  guard: '每晚守護一位玩家（可以是自己），讓他不被狼人淘汰；不能連續兩晚守同一人。守護和解藥落在同一人身上時，他反而會出局。',
}

export type God = 'seer' | 'witch' | 'hunter' | 'guard'
export const GODS: God[] = ['seer', 'witch', 'hunter', 'guard']

export function isGod(role: Role): boolean {
  return role !== 'wolf' && role !== 'villager'
}

/** 依人數的預設配置，和後端 `Lineup::preset` 一樣：6 人 2 狼 2 民＋預言家、女巫；7、8 人再加獵人；9、10 人 3 狼；11 人再加守衛；12 人 4 狼 */
export function preset(n: number): Lineup {
  const wolves = n <= 8 ? 2 : n <= 11 ? 3 : 4
  const hunter = n >= 7
  const guard = n >= 11
  const gods = 2 + (hunter ? 1 : 0) + (guard ? 1 : 0)
  return { wolves, villagers: Math.max(0, n - wolves - gods), seer: true, witch: true, hunter, guard }
}

/** 這些選項配上 n 個人的角色，配不出來回傳原因（和後端 `Options::lineup` 一樣） */
export function lineupOf(o: WwOptions, n: number): Lineup | string {
  if (!o.custom) return preset(n)
  const gods = [o.seer, o.witch, o.hunter, o.guard].filter(Boolean).length
  if (o.wolves < 1) return '至少要 1 個狼人'
  if (o.wolves * 2 >= n) return `${n} 人最多 ${Math.floor((n - 1) / 2)} 個狼人（狼人要比好人少）`
  if (o.wolves + gods > n) return `${n} 人放不下 ${o.wolves} 個狼人和 ${gods} 個神職`
  const villagers = n - o.wolves - gods
  if (o.win === 'side' && (villagers === 0 || gods === 0)) return '屠邊至少要有 1 個平民和 1 個神職，不然一開局就分出勝負'
  return { wolves: o.wolves, villagers, seer: o.seer, witch: o.witch, hunter: o.hunter, guard: o.guard }
}

export function describe(l: Lineup): string {
  const parts = [`${l.wolves} 狼人`, `${l.villagers} 平民`]
  for (const role of GODS) if (l[role]) parts.push(ROLE_NAMES[role])
  return parts.join('、')
}
