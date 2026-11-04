/** 古董局中局的 view、動作和選項，和 backend/src/antique.rs 對應 */

export type Role =
  | 'xuYuan'
  | 'fangZhen'
  | 'huangYanyan'
  | 'kidoKana'
  | 'laoChaofeng'
  | 'yaoBuran'
  | 'zhengGuoqu'
  | 'jiYunfu'

export type Stage = 'peek' | 'act' | 'discuss' | 'vote' | 'reveal' | 'ident' | 'end'
export type Step = 'identify' | 'skill' | 'pass'
export type Outcome = 'genuine' | 'fake' | 'sealed' | 'blocked' | 'good' | 'bad' | 'ambushed' | 'crippled'

export type AqOptions = {
  /** 線下模式：當面討論，討論沒有倒數 */
  offline: boolean
  /** 每個人行動的秒數，0 是不限時 */
  turnSecs: number
  /** 線上模式的討論秒數 */
  discussSecs: number
}

export type Head = {
  /** 0～11：鼠牛虎兔… */
  zodiac: number
  round: number
  /** 這回合的第幾件 */
  slot: number
  /** 投票結果：first 入選不公開、second 入選並公開 */
  pick: 'first' | 'second' | null
  /** 公開了才有（第二名，或遊戲結束） */
  genuine: boolean | null
  votes: number | null
}

export type AqSeat = {
  online: boolean
  ready: boolean
  /** 投票或鑑人時已經投了 */
  voted: boolean
  /** 這回合行動過了 */
  acted: boolean
  /** 自己、認識的隊友，或遊戲結束後才看得到 */
  role: Role | null
  points: number
}

export type AqRecord = {
  round: number
  slot: number | null
  /** 方震查驗的人 */
  seat: number | null
  outcome: Outcome
  /** 看到的結果被老朝奉調換過（結束後才會是 true） */
  swapped: boolean
}

export type SkillUse = {
  round: number
  seat: number
  kind: 'swap' | 'ambush' | 'block'
  target: number | null
  slot: number | null
  on: boolean | null
}

export type Me = {
  role: Role
  records: AqRecord[]
  skills: SkillUse[]
  /** 方震查驗過的人 */
  checked: number[]
  chips: number
  alloc: number[] | null
  /** 鑑人要找的角色；鄭國渠是 null */
  goal: Role | null
  accused: number | null
  /** 不能指認的人（自己、認識的隊友） */
  forbidden: number[]
}

export type RoundResult = {
  round: number
  votes: number[]
  allocs: (number[] | null)[]
  first: number
  second: number
  secondGenuine: boolean
}

export type Final = {
  genuine: number
  direct: boolean
  bossVotes: number[]
  bossRequired: number
  bossTarget: number | null
  bossFound: boolean
  xuFound: boolean
  fangFound: boolean
  score: number
  winner: 'good' | 'bad'
}

export type AqView = {
  stage: Stage
  endsIn: number | null
  /** 0 起算 */
  round: number
  options: AqOptions
  /** 這局有哪些角色 */
  lineup: Role[]
  you: number | null
  me: Me | null
  heads: Head[]
  seats: AqSeat[]
  /** 行動中的人；step、left、ambushed 只有本人看得到 */
  turn: { seat: number; step: Step | null; left: number | null; ambushed: boolean | null } | null
  /** 這回合的行動順序 */
  order: number[]
  results: RoundResult[]
  end: {
    result: Final
    roles: Role[]
    accusations: (number | null)[]
    skills: SkillUse[]
    fails: { huangYanyan: number; kidoKana: number }
  } | null
}

export type AqAction =
  | { type: 'ready' }
  | { type: 'identify'; slot: number }
  | { type: 'check'; seat: number }
  | { type: 'swap'; on: boolean }
  | { type: 'ambush'; seat: number }
  | { type: 'block'; slot: number }
  | { type: 'skip' }
  | { type: 'pass'; seat: number | null }
  | { type: 'chips'; alloc: number[] }
  | { type: 'accuse'; seat: number }

export type AntiqueParty = { view: AqView; action: AqAction; options: AqOptions; event: never }

export const ROUNDS = 3
export const WIN_SCORE = 6
export const ZODIAC = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬']
export const ZODIAC_EMOJI = ['🐭', '🐮', '🐯', '🐰', '🐲', '🐍', '🐴', '🐑', '🐵', '🐔', '🐶', '🐷']

export function headName(zodiac: number): string {
  return `${ZODIAC[zodiac]}首`
}

export const ROLE_NAMES: Record<Role, string> = {
  xuYuan: '許愿',
  fangZhen: '方震',
  huangYanyan: '黃煙煙',
  kidoKana: '木戶加奈',
  laoChaofeng: '老朝奉',
  yaoBuran: '藥不然',
  zhengGuoqu: '鄭國渠',
  jiYunfu: '姬雲浮',
}

export function isGood(role: Role): boolean {
  return role !== 'laoChaofeng' && role !== 'yaoBuran' && role !== 'zhengGuoqu'
}

export const ROLE_INFO: Record<Role, string> = {
  xuYuan: '每回合鑑定 2 件獸首，會被老朝奉調換。鑑人時沒被老朝奉找到，許愿陣營 +2 分。',
  fangZhen: '不鑑定獸首，改成每回合查驗一個人是哪個陣營（同一人不能查兩次）。你被偷襲時許愿也會一起被偷襲。鑑人時沒被藥不然找到，許愿陣營 +1 分。',
  huangYanyan: '每回合鑑定 1 件獸首，但有一個隨機的回合看不出真假。會被老朝奉調換。',
  kidoKana: '每回合鑑定 1 件獸首，但有一個隨機的回合看不出真假。會被老朝奉調換。',
  laoChaofeng: '每回合鑑定 1 件，並決定要不要讓「在你之後」鑑定的許愿、黃煙煙、木戶加奈看到相反的結果。認識藥不然。鑑人時要找出許愿。',
  yaoBuran: '每回合鑑定 1 件，並偷襲一個人：他下一次行動不能鑑定、也不能用技能。認識老朝奉。鑑人時要找出方震。',
  zhengGuoqu: '每回合鑑定 1 件，並封鎖一件本回合的獸首：之後鑑定它的人都看不出真假。不和隊友相認，鑑人時不用投。',
  jiYunfu: '每回合鑑定 1 件獸首，不受老朝奉影響；但只要被偷襲一次，之後就再也不能鑑定。',
}

export function goalText(goal: Role): string {
  return `找出${ROLE_NAMES[goal]}`
}
