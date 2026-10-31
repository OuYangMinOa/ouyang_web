// 資料來自 lolesports.com 網站自己用的 API，都開放跨網域呼叫，所以瀏覽器直接抓，後端不參與
const API = 'https://esports-api.lolesports.com/persisted/gw'
const FEED = 'https://feed.lolesports.com/livestats/v1'
// lolesports.com 前端內建的公開金鑰，不是機密
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'
const DDRAGON = 'https://ddragon.leagueoflegends.com/cdn'

export const WORLDS_LEAGUE_ID = '98767975604431411'

export type MatchState = 'unstarted' | 'inProgress' | 'completed'
export type GameState = MatchState | 'unneeded'

export type Team = {
  id?: string
  name: string
  code: string
  image: string
  result: { outcome: 'win' | 'loss' | 'tie' | null; gameWins: number } | null
}

/** 賽程裡的一場系列賽（BO1／BO3／BO5） */
export type Match = {
  id: string
  startTime: string
  state: MatchState
  /** 階段名稱，例如「瑞士制循環賽」「八強賽」 */
  blockName: string
  teams: Team[]
  bestOf: number
  hasVod: boolean
}

export type Tournament = { id: string; slug: string; startDate: string; endDate: string }

export type Stage = { slug: string; name: string; matchIds: string[] }

/** 直播或 VOD 的來源 */
export type Stream = {
  provider: string
  parameter: string
  locale: string
  label: string
  /** VOD 從第幾秒開始是比賽 */
  start?: number
}

export type LiveEvent = { match: Match; streams: Stream[] }

export type Game = {
  number: number
  id: string
  state: GameState
  /** 隊伍 id → 藍方或紅方 */
  sides: Record<string, 'blue' | 'red'>
  vods: Stream[]
}

export type EventDetails = { match: Match; games: Game[]; streams: Stream[] }

/* ---- 即時數據（livestats） ---- */

export type Participant = {
  participantId: number
  summonerName: string
  championId: string
  role: string
}
export type TeamMetadata = { esportsTeamId: string; participantMetadata: Participant[] }
export type GameMetadata = { patchVersion: string; blueTeamMetadata: TeamMetadata; redTeamMetadata: TeamMetadata }

export type PlayerFrame = {
  participantId: number
  totalGold: number
  level: number
  kills: number
  deaths: number
  assists: number
  creepScore: number
  currentHealth: number
  maxHealth: number
}
export type TeamFrame = {
  totalGold: number
  inhibitors: number
  towers: number
  barons: number
  totalKills: number
  dragons: string[]
  participants: PlayerFrame[]
}
export type Frame = {
  rfc460Timestamp: string
  gameState: 'in_game' | 'paused' | 'finished'
  blueTeam: TeamFrame
  redTeam: TeamFrame
}
type StatsWindow = { gameMetadata: GameMetadata; frames: Frame[] }

/** 畫面用的一份數據：選手名單、最新的 frame、開場時間（算比賽時間用） */
export type GameStats = { metadata: GameMetadata; frame: Frame; start: number }

/* ---- 原始回應的型別（只列用得到的欄位） ---- */

type RawTeam = {
  id?: string
  name: string
  code: string
  image: string
  result: { outcome?: 'win' | 'loss' | 'tie' | null; gameWins?: number } | null
}
type RawStream = {
  provider: string
  parameter: string
  locale: string
  mediaLocale?: { translatedName?: string } | null
  startMillis?: number | null
}
type RawEvent = {
  startTime: string
  state: MatchState
  type: string
  blockName: string
  league?: { id?: string; slug?: string }
  match?: { id: string; flags?: string[] | null; teams: RawTeam[]; strategy?: { count?: number } }
  streams?: RawStream[] | null
}

async function gw<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const url = new URL(`${API}/${path}`)
  url.searchParams.set('hl', 'zh-TW')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { headers: { 'x-api-key': API_KEY }, signal })
  if (!res.ok) throw new Error(`LoL Esports 回應 ${res.status}`)
  const body = (await res.json()) as { data: T }
  return body.data
}

/** 隊徽有些是 http，網站接上 HTTPS 後會被瀏覽器擋 */
function secure(url: string) {
  return url.replace(/^http:\/\//, 'https://')
}

function toTeam(t: RawTeam): Team {
  return {
    id: t.id,
    name: t.name,
    code: t.code,
    image: secure(t.image),
    result: t.result ? { outcome: t.result.outcome ?? null, gameWins: t.result.gameWins ?? 0 } : null,
  }
}

function toMatch(e: RawEvent): Match | null {
  if (e.type !== 'match' || !e.match) return null
  return {
    id: e.match.id,
    startTime: e.startTime,
    state: e.state,
    blockName: e.blockName,
    teams: e.match.teams.map(toTeam),
    bestOf: e.match.strategy?.count ?? 1,
    hasVod: e.match.flags?.includes('hasVod') ?? false,
  }
}

function toStream(s: RawStream): Stream {
  return {
    provider: s.provider,
    parameter: s.parameter,
    locale: s.locale,
    label: s.mediaLocale?.translatedName || s.locale,
    start: s.startMillis ? Math.floor(s.startMillis / 1000) : undefined,
  }
}

/** 最新一屆（startDate 最晚的那個） */
export async function getCurrentTournament(signal?: AbortSignal): Promise<Tournament | null> {
  const data = await gw<{ leagues: { tournaments: Tournament[] }[] }>(
    'getTournamentsForLeague',
    { leagueId: WORLDS_LEAGUE_ID },
    signal,
  )
  const all = data.leagues[0]?.tournaments ?? []
  return [...all].sort((a, b) => b.startDate.localeCompare(a.startDate))[0] ?? null
}

/** 各階段有哪些比賽；賽程本身沒有階段代碼，只有翻譯過的 blockName */
export async function getStages(tournamentId: string, signal?: AbortSignal): Promise<Stage[]> {
  const data = await gw<{
    standings: { stages: { name: string; slug: string; sections: { matches: { id: string }[] }[] }[] }[]
  }>('getStandings', { tournamentId }, signal)
  return (data.standings[0]?.stages ?? []).map((s) => ({
    slug: s.slug,
    name: s.name,
    matchIds: s.sections.flatMap((sec) => sec.matches.map((m) => m.id)),
  }))
}

type SchedulePage = { schedule: { pages: { older: string | null; newer: string | null }; events: RawEvent[] } }

/**
 * 整屆的賽程。API 一次給一頁（以現在為中心），往前、往後翻到超出這屆的日期為止。
 * 每個方向最多翻幾頁，避免 API 行為改變時一直翻下去。
 */
export async function getSchedule(tournament: Tournament, signal?: AbortSignal): Promise<Match[]> {
  const day = 86_400_000
  const start = Date.parse(`${tournament.startDate}T00:00:00Z`) - day
  const end = Date.parse(`${tournament.endDate}T00:00:00Z`) + 2 * day
  const leagueId = WORLDS_LEAGUE_ID
  const time = (e: RawEvent) => Date.parse(e.startTime)

  const first = await gw<SchedulePage>('getSchedule', { leagueId }, signal)
  const events = [...first.schedule.events]
  let older = first.schedule.pages.older
  for (let i = 0; i < 4 && older && events.length > 0 && time(events[0]) > start; i++) {
    const page = await gw<SchedulePage>('getSchedule', { leagueId, pageToken: older }, signal)
    events.unshift(...page.schedule.events)
    older = page.schedule.pages.older
  }
  let newer = first.schedule.pages.newer
  for (let i = 0; i < 4 && newer && events.length > 0 && time(events[events.length - 1]) < end; i++) {
    const page = await gw<SchedulePage>('getSchedule', { leagueId, pageToken: newer }, signal)
    events.push(...page.schedule.events)
    newer = page.schedule.pages.newer
  }

  const byId = new Map<string, Match>()
  for (const e of events) {
    if (time(e) < start || time(e) > end) continue
    const match = toMatch(e)
    if (match) byId.set(match.id, match)
  }
  return [...byId.values()].sort((a, b) => a.startTime.localeCompare(b.startTime))
}

/** 正在進行的世界賽比賽（getLive 會回傳所有聯賽，這裡只留世界賽） */
export async function getLive(signal?: AbortSignal): Promise<LiveEvent[]> {
  const data = await gw<{ schedule: { events: RawEvent[] | null } }>('getLive', {}, signal)
  return (data.schedule.events ?? [])
    .filter((e) => e.league?.slug === 'worlds' || e.league?.id === WORLDS_LEAGUE_ID)
    .flatMap((e) => {
      const match = toMatch(e)
      return match ? [{ match, streams: (e.streams ?? []).map(toStream) }] : []
    })
}

export async function getEventDetails(id: string, signal?: AbortSignal): Promise<EventDetails | null> {
  type RawGame = {
    number: number
    id: string
    state: GameState
    teams: { id: string; side: 'blue' | 'red' | null }[]
    vods: RawStream[]
  }
  const data = await gw<{
    event: {
      blockName?: string
      match?: { strategy?: { count?: number }; teams: RawTeam[]; games: RawGame[] }
      streams?: RawStream[] | null
    } | null
  }>('getEventDetails', { id }, signal)
  const e = data.event
  if (!e?.match) return null
  const games: Game[] = e.match.games.map((g) => ({
    number: g.number,
    id: g.id,
    state: g.state,
    sides: Object.fromEntries(g.teams.flatMap((t) => (t.side ? [[t.id, t.side]] : []))),
    vods: g.vods.map(toStream),
  }))
  const done = (g: Game) => g.state === 'completed' || g.state === 'unneeded'
  let state: MatchState = 'unstarted'
  if (games.length > 0 && games.every(done)) state = 'completed'
  else if (games.some((g) => g.state !== 'unstarted')) state = 'inProgress'
  return {
    match: {
      id,
      // 詳細資料沒有開始時間，由呼叫的人用賽程補上
      startTime: '',
      state,
      blockName: e.blockName ?? '',
      teams: e.match.teams.map(toTeam),
      bestOf: e.match.strategy?.count ?? games.length,
      hasVod: games.some((g) => g.vods.length > 0),
    },
    games,
    streams: (e.streams ?? []).map(toStream),
  }
}

/* ---- 即時數據 ---- */

/** livestats 的起始時間要對齊 10 秒，而且不能帶毫秒 */
function feedTime(ms: number) {
  return new Date(Math.floor(ms / 10_000) * 10_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 從某個時間點開始的 10 秒數據；不給時間就是開場那段。沒有資料（還沒開打、時間超出範圍）回傳 null */
async function getWindow(gameId: string, at?: number, signal?: AbortSignal): Promise<StatsWindow | null> {
  const query = at === undefined ? '' : `?startingTime=${feedTime(at)}`
  const res = await fetch(`${FEED}/window/${gameId}${query}`, { signal })
  if (res.status === 204 || res.status === 400 || res.status === 404) return null
  if (!res.ok) throw new Error(`即時數據回應 ${res.status}`)
  const body = (await res.json()) as Partial<StatsWindow>
  if (!body.gameMetadata || !body.frames?.length) return null
  return { gameMetadata: body.gameMetadata, frames: body.frames }
}

const startCache = new Map<string, number>()

/** 比賽開場的時間（第一個 frame） */
async function getGameStart(gameId: string, signal?: AbortSignal): Promise<number | null> {
  const cached = startCache.get(gameId)
  if (cached !== undefined) return cached
  const w = await getWindow(gameId, undefined, signal)
  if (!w) return null
  const start = Date.parse(w.frames[0].rfc460Timestamp)
  startCache.set(gameId, start)
  return start
}

/** 進行中的比賽：抓一兩分鐘前的數據（太接近現在的時間 API 還沒有，會回 400） */
export async function getLiveStats(gameId: string, signal?: AbortSignal): Promise<GameStats | null> {
  const start = await getGameStart(gameId, signal)
  if (start === null) return null
  for (const delay of [60_000, 120_000]) {
    const w = await getWindow(gameId, Date.now() - delay, signal)
    if (w) return { metadata: w.gameMetadata, frame: w.frames[w.frames.length - 1], start }
  }
  // 剛開打還沒有一分鐘前的資料，先給開場那段
  const w = await getWindow(gameId, undefined, signal)
  return w ? { metadata: w.gameMetadata, frame: w.frames[w.frames.length - 1], start } : null
}

const FINAL_KEY = 'lol:final'
const FINAL_KEEP = 40

function loadFinals(): Record<string, GameStats> {
  try {
    const saved = JSON.parse(localStorage.getItem(FINAL_KEY) ?? '{}') as unknown
    return saved && typeof saved === 'object' ? (saved as Record<string, GameStats>) : {}
  } catch {
    return {}
  }
}

function saveFinal(gameId: string, stats: GameStats) {
  try {
    const all = loadFinals()
    delete all[gameId]
    all[gameId] = stats
    // 物件的鍵照加入順序排，只留最後加的幾場
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - FINAL_KEEP))) delete all[k]
    localStorage.setItem(FINAL_KEY, JSON.stringify(all))
  } catch {
    // 存不了就下次重抓
  }
}

/**
 * 已結束比賽的最終數據。API 只能用時間查，比賽結束一陣子之後的時間會回 400，
 * 所以從開場往後二分搜尋「還查得到」的最後一段，那段的最後一個 frame 就是終局（約 10 次請求）。
 * 結果不會再變，存在 localStorage。
 */
export async function getFinalStats(gameId: string, signal?: AbortSignal): Promise<GameStats | null> {
  const saved = loadFinals()[gameId]
  if (saved?.frame && saved.metadata) return saved

  const first = await getWindow(gameId, undefined, signal)
  if (!first) return null
  const start = Date.parse(first.frames[0].rfc460Timestamp)
  let best = first
  let lo = start
  let hi = start + 3 * 3_600_000
  while (hi - lo > 10_000) {
    const mid = lo + Math.max(10_000, Math.floor((hi - lo) / 20_000) * 10_000)
    if (mid >= hi) break
    const w = await getWindow(gameId, mid, signal)
    if (w) {
      lo = mid
      best = w
    } else {
      hi = mid
    }
  }
  const frame = best.frames[best.frames.length - 1]
  const stats = { metadata: best.gameMetadata, frame, start }
  if (frame.gameState === 'finished') saveFinal(gameId, stats)
  return stats
}

/* ---- Data Dragon：英雄頭像與中文名稱 ---- */

/** 「16.20.826.3891」→ Data Dragon 的版本「16.20.1」 */
export function ddragonVersion(patch: string) {
  const [major, minor] = patch.split('.')
  return `${major}.${minor}.1`
}

export function championIcon(version: string, championId: string) {
  return `${DDRAGON}/${version}/img/champion/${championId}.png`
}

const championNames = new Map<string, Promise<Record<string, string>>>()

/** 英雄的中文名稱，檔案約 200 KB，同一版本只抓一次 */
export function getChampionNames(version: string): Promise<Record<string, string>> {
  let names = championNames.get(version)
  if (!names) {
    names = fetch(`${DDRAGON}/${version}/data/zh_TW/champion.json`)
      .then(async (res) => {
        if (!res.ok) return {}
        const body = (await res.json()) as { data: Record<string, { name: string }> }
        return Object.fromEntries(Object.entries(body.data).map(([id, c]) => [id, c.name]))
      })
      .catch(() => {
        championNames.delete(version)
        return {}
      })
    championNames.set(version, names)
  }
  return names
}
