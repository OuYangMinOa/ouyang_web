// 從 OpenStreetMap 產生 3D 賽車「台北信義」賽道的資料 src/games/racing/osm/xinyi.json：
// 賽道的控制點（照真實的路口）、周圍的建築輪廓和高度、街道、公園綠地、行道樹。
//
// 只在要更新地圖資料時手動跑：node scripts/osm-xinyi.mjs [--refresh]
// 原始資料存在 node_modules/.cache/osm-xinyi.json，加 --refresh 才重新向 Overpass 下載。
// 地圖資料 © OpenStreetMap 貢獻者，以 ODbL 授權；產生的 JSON 是衍生資料庫，同樣以 ODbL 提供。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CatmullRomCurve3, Vector3 } from 'three'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cacheFile = resolve(root, 'node_modules/.cache/osm-xinyi.json')
const outFile = resolve(root, 'src/games/racing/osm/xinyi.json')

/** 下載範圍（南、西、北、東）：101 周圍大約東西 3 公里、南北 2.4 公里 */
const BBOX = [25.024, 121.55, 25.046, 121.58]
/** 座標原點：台北 101。x 往東、z 往南，單位公尺 */
const ORIGIN = [25.034, 121.5645]
const KX = 111320 * Math.cos((ORIGIN[0] * Math.PI) / 180)
const KZ = 110574

/**
 * 賽道：照開的順序列出每個彎道是哪兩條路的路口。起跑線在最後一個路口和第一個路口之間的直線上。
 * 市府路往北 → 松壽路往東 → 松仁路往南 → 松廉路往西 → 松智路往南 → 信義路往西 → 回到市府路
 */
const ROUTE = [
  ['市府路', '松壽路'],
  ['松仁路', '松壽路'],
  ['松仁路', '松廉路'],
  ['松智路', '松廉路'],
  ['松智路', '信義路五段'],
  ['市府路', '信義路五段'],
]
/**
 * 每個直角彎在路口前後各多少公尺切角（tracks.ts 的夜城也是這樣做）。前後再各多放一點（兩倍遠），
 * 長直線兩頭的四個控制點才會在同一直線上；不然 Catmull-Rom 在長直線中間會往外彎十幾公尺，偏離真實的路
 */
const CHAMFER = 24
/** 起跑線離上一個路口多遠，以及起跑線後面再多放一個控制點，讓前兩個控制點之間是直線 */
const START_FROM = 90
const START_STRAIGHT = 60
/** 中心線到護欄的距離（tracks.ts 的 halfWidth + runoff），建築至少要離中心線這麼遠再加 1.5 公尺（路燈立在護欄外 1.2 公尺） */
const WALL = 11
const CLEAR = WALL + 1.5
/** 帶多遠以內的東西；高樓（60 公尺以上）遠一點也帶，當天際線 */
const NEAR = 650
const SKYLINE = 1500
const SKYLINE_HEIGHT = 60
/** 一層樓幾公尺（只有樓層數、沒標高度的建築） */
const LEVEL = 3.3

const QUERY = `[out:json][timeout:180];
(
  way["building"](${BBOX});
  way["building:part"](${BBOX});
  relation["building"]["type"="multipolygon"](${BBOX});
  relation["building:part"]["type"="multipolygon"](${BBOX});
  way["highway"](${BBOX});
  way["leisure"~"^(park|garden|playground|pitch)$"](${BBOX});
  way["landuse"~"^(grass|recreation_ground|village_green|forest|meadow)$"](${BBOX});
  way["natural"~"^(wood|scrub|grassland)$"](${BBOX});
  node["natural"="tree"](${BBOX});
);
out body;
>;
out skel qt;`

async function load() {
  if (!process.argv.includes('--refresh')) {
    try {
      return JSON.parse(await readFile(cacheFile, 'utf8'))
    } catch {
      // 沒有快取就下載
    }
  }
  console.log('向 Overpass 下載…')
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ouyang-web-racing-track-builder/1.0' },
    body: new URLSearchParams({ data: QUERY }),
  })
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${await res.text()}`)
  const text = await res.text()
  await mkdir(dirname(cacheFile), { recursive: true })
  await writeFile(cacheFile, text)
  return JSON.parse(text)
}

const osm = await load()
const nodes = new Map()
const ways = new Map()
const relations = []
const trees = []
for (const e of osm.elements) {
  if (e.type === 'node') {
    nodes.set(e.id, [(e.lon - ORIGIN[1]) * KX, -(e.lat - ORIGIN[0]) * KZ])
    if (e.tags?.natural === 'tree') trees.push(e.id)
  } else if (e.type === 'way') ways.set(e.id, e)
  else if (e.type === 'relation') relations.push(e)
}

// ---------- 幾何小工具 ----------

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

function segDist(p, a, b) {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len = dx * dx + dz * dz
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz)
}

/** 兩條線段的最短距離（相交就是 0） */
function segSegDist(a, b, c, d) {
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const d1 = cross(a, b, c)
  const d2 = cross(a, b, d)
  const d3 = cross(c, d, a)
  const d4 = cross(c, d, b)
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b))
}

/** 有號面積：x 往東、z 往南時，正的代表從上面看是逆時針 */
function signedArea(ring) {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

function centroid(ring) {
  let x = 0
  let z = 0
  for (const p of ring) {
    x += p[0]
    z += p[1]
  }
  return [x / ring.length, z / ring.length]
}

function inside(p, ring) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit
  }
  return hit
}

/** Douglas-Peucker 簡化折線 */
function simplify(pts, eps) {
  if (pts.length < 3) return pts
  let best = 0
  let at = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1])
    if (d > best) {
      best = d
      at = i
    }
  }
  if (best <= eps) return [pts[0], pts[pts.length - 1]]
  return [...simplify(pts.slice(0, at + 1), eps).slice(0, -1), ...simplify(pts.slice(at), eps)]
}

/** 封閉的環：去掉重複的最後一點、簡化、統一成逆時針 */
function cleanRing(pts, eps) {
  let ring = pts.slice()
  if (ring.length > 1 && dist2(ring[0], ring[ring.length - 1]) < 1e-6) ring.pop()
  if (ring.length < 3) return null
  ring = simplify([...ring, ring[0]], eps).slice(0, -1)
  if (ring.length < 3) return null
  if (signedArea(ring) < 0) ring.reverse()
  return ring
}

const wayPoints = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean)

/** multipolygon 的外環：把 outer 成員的 way 頭尾接起來 */
function outerRings(rel) {
  const parts = rel.members
    .filter((m) => m.type === 'way' && m.role !== 'inner' && ways.has(m.ref))
    .map((m) => ways.get(m.ref).nodes.slice())
  const rings = []
  while (parts.length) {
    let ring = parts.shift()
    let grew = true
    while (ring[0] !== ring[ring.length - 1] && grew) {
      grew = false
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        const tail = ring[ring.length - 1]
        if (p[0] === tail) ring = ring.concat(p.slice(1))
        else if (p[p.length - 1] === tail) ring = ring.concat(p.slice(0, -1).reverse())
        else continue
        parts.splice(i, 1)
        grew = true
        break
      }
    }
    if (ring[0] === ring[ring.length - 1]) rings.push(ring.map((id) => nodes.get(id)).filter(Boolean))
  }
  return rings
}

// ---------- 賽道 ----------

const roadNodes = new Map()
for (const w of ways.values()) {
  const name = w.tags?.name
  if (!w.tags?.highway || !name) continue
  if (!roadNodes.has(name)) roadNodes.set(name, new Set())
  for (const id of w.nodes) roadNodes.get(name).add(id)
}

/** 兩條路的路口：共用的節點取平均（雙向分隔的大路會有好幾個） */
function junction(a, b) {
  const na = roadNodes.get(a)
  const nb = roadNodes.get(b)
  if (!na || !nb) throw new Error(`找不到路：${!na ? a : b}`)
  const shared = [...na].filter((id) => nb.has(id) && nodes.has(id))
  if (!shared.length) throw new Error(`${a} 和 ${b} 沒有共用的節點`)
  return centroid(shared.map((id) => nodes.get(id)))
}

const corners = ROUTE.map(([a, b]) => junction(a, b))
const toward = (from, to, d) => {
  const len = Math.sqrt(dist2(from, to))
  return [from[0] + ((to[0] - from[0]) / len) * d, from[1] + ((to[1] - from[1]) / len) * d]
}
const last = corners[corners.length - 1]
const start = toward(last, corners[0], START_FROM)
const control = [start, toward(start, corners[0], START_STRAIGHT)]
corners.forEach((c, i) => {
  const prev = i === 0 ? last : corners[i - 1]
  const next = corners[(i + 1) % corners.length]
  control.push(toward(c, prev, CHAMFER * 2), toward(c, prev, CHAMFER), toward(c, next, CHAMFER), toward(c, next, CHAMFER * 2))
})
// 實際的中心線：和 track.ts 一樣用 centripetal Catmull-Rom 連起來（彎道會比切角的直線更往外凸）
const curve = new CatmullRomCurve3(
  control.map(([x, z]) => new Vector3(x, 0, z)),
  true,
  'centripetal',
)
const samples = curve.getSpacedPoints(Math.round(curve.getLength() / 2)).map((v) => [v.x, v.z])
const centerline = samples.slice(0, -1).map((p, i) => [p, samples[i + 1]])
const trackDist = (p) => Math.min(...centerline.map(([a, b]) => segDist(p, a, b)))
const ringClear = (ring) => {
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    for (const [c, d] of centerline) best = Math.min(best, segSegDist(a, b, c, d))
  }
  return best
}

// ---------- 建築 ----------

const num = (v) => {
  if (v === undefined) return null
  const f = parseFloat(String(v).replace(',', '.'))
  return Number.isFinite(f) ? f : null
}

/** 用 OSM id 當種子的 0～1 亂數：每次產生的結果一樣 */
const hash = (id) => {
  let x = (id * 2654435761) % 4294967296
  x = ((x ^ (x >>> 15)) * 2246822519) % 4294967296
  return ((x ^ (x >>> 13)) >>> 0) / 4294967296
}

/** 沒標高度也沒標樓層的建築：照面積估樓層（台北的老公寓多半四、五樓，大塊的多半是大樓） */
function guessLevels(area, id) {
  const r = hash(id)
  if (area < 60) return 1 + Math.floor(r * 3)
  if (area < 250) return 3 + Math.floor(r * 3)
  if (area < 800) return 4 + Math.floor(r * 5)
  return 5 + Math.floor(r * 8)
}

const raw = []
const addBuilding = (id, tags, rings) => {
  if (tags.building === 'no' || tags.building === 'roof' || tags['building:part'] === 'no') return
  if (tags.location === 'underground' || (num(tags.layer) ?? 0) < 0) return
  // 室內的房間、地下的車站：不是地面上的建築
  if (tags.indoor || (tags.level && String(tags.level).split(';').every((l) => (num(l) ?? 0) < 0))) return
  if (num(tags['building:levels']) === 0) return
  const part = tags['building:part'] !== undefined
  for (const pts of rings) {
    const ring = cleanRing(pts, 0.4)
    if (!ring) continue
    const area = signedArea(ring)
    // 101 的塔尖只有 2 公尺見方，part 不限大小
    if (area < (part ? 1 : 15)) continue
    const levels = num(tags['building:levels'])
    let minH = num(tags.min_height) ?? (num(tags['building:min_level']) ?? 0) * LEVEL
    if (tags['building:part'] === 'roof' && minH === 0) continue
    let h = num(tags.height) ?? (levels !== null ? levels * LEVEL : null)
    let guessed = false
    if (h === null) {
      h = guessLevels(area, id) * LEVEL
      guessed = true
    }
    if (h <= minH) h = minH + LEVEL
    if (minH < 0) minH = 0
    raw.push({ id, part, ring, area, h, minH, guessed, c: centroid(ring) })
  }
}
for (const w of ways.values()) {
  const t = w.tags
  if (!t || (t.building === undefined && t['building:part'] === undefined)) continue
  addBuilding(w.id, t, [wayPoints(w)])
}
for (const r of relations) {
  const t = r.tags
  if (!t || (t.building === undefined && t['building:part'] === undefined)) continue
  addBuilding(r.id, t, outerRings(r))
}

// 有 building:part 的建築只畫 part（Simple 3D Buildings 的規則）：外框裡面有 part 的，外框不畫
const parts = raw.filter((b) => b.part)
const buildings = raw.filter((b) => {
  if (b.part) return true
  return !parts.some((p) => p.area <= b.area * 1.05 && inside(p.c, b.ring))
})

let tooClose = 0
const kept = buildings.filter((b) => {
  const d = trackDist(b.c)
  if (d > SKYLINE || (d > NEAR && b.h < SKYLINE_HEIGHT)) return false
  if (d < 200) {
    const clear = ringClear(b.ring)
    if (clear < CLEAR) {
      tooClose++
      if (process.argv.includes('--verbose')) console.log(`離賽道 ${clear.toFixed(1)} 公尺，拿掉 ${b.id}（高 ${b.h.toFixed(0)}）`)
      return false
    }
  }
  return true
})

// ---------- 街道、綠地、行道樹 ----------

/** 每種路的半寬（公尺）；單行道（雙向分隔的一邊）用一半 */
const STREET = { trunk: 12, primary: 13, secondary: 11, tertiary: 8, unclassified: 5, residential: 4.5, living_street: 4 }
const LINK = 4
const streets = []
for (const w of ways.values()) {
  const t = w.tags
  const hw = t?.highway
  if (!hw) continue
  if (t.tunnel || t.bridge || t.area === 'yes' || (num(t.layer) ?? 0) !== 0) continue
  let half = STREET[hw] ?? (hw.endsWith('_link') ? LINK : null)
  if (half === null) continue
  const lanes = num(t.lanes)
  if (lanes) half = Math.max(3, lanes * 1.65 + 0.6)
  else if (t.oneway === 'yes' && !hw.endsWith('_link')) half = Math.max(3, half * 0.55)
  const pts = simplify(wayPoints(w), 0.5)
  if (pts.length < 2 || !pts.some((p) => trackDist(p) < NEAR)) continue
  streets.push({ half, pts })
}

const GREEN_TAGS = ['leisure', 'landuse', 'natural']
const parks = []
for (const w of ways.values()) {
  const t = w.tags
  if (!t || !GREEN_TAGS.some((k) => t[k]) || t.building) continue
  if (w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue
  const ring = cleanRing(wayPoints(w), 1)
  if (!ring || signedArea(ring) < 40 || trackDist(centroid(ring)) > NEAR) continue
  parks.push(ring)
}

const treePts = trees
  .map((id) => nodes.get(id))
  .filter((p) => {
    const d = trackDist(p)
    return d < NEAR && d > WALL + 1.5
  })

// ---------- 輸出 ----------

const dm = (v) => Math.round(v * 10)
/** 一串點：第一點是絕對座標，後面是和前一點的差，單位公寸 */
const pack = (pts) => {
  const out = []
  let px = 0
  let pz = 0
  for (const [x, z] of pts) {
    const ix = dm(x)
    const iz = dm(z)
    out.push(ix - px, iz - pz)
    px = ix
    pz = iz
  }
  return out
}
const line = (v) => JSON.stringify(v)
const list = (rows) => `[\n${rows.map(line).join(',\n')}\n]`
const body = [
  `"credit":${line('© OpenStreetMap 貢獻者（ODbL）')}`,
  `"date":${line(osm.osm3s?.timestamp_osm_base?.slice(0, 10) ?? '')}`,
  `"origin":${line(ORIGIN)}`,
  `"track":${line(control.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]))}`,
  // [高度, 離地高度, ...輪廓]，高度單位公寸
  `"buildings":${list(kept.sort((a, b) => a.c[0] - b.c[0]).map((b) => [dm(b.h), dm(b.minH), ...pack(b.ring)]))}`,
  // [半寬, ...中心線]
  `"streets":${list(streets.map((s) => [dm(s.half), ...pack(s.pts)]))}`,
  `"parks":${list(parks.map(pack))}`,
  `"trees":${line(pack(treePts))}`,
]
await mkdir(dirname(outFile), { recursive: true })
const text = `{\n${body.join(',\n')}\n}\n`
await writeFile(outFile, text)

const guessed = kept.filter((b) => b.guessed).length
const verts = kept.reduce((s, b) => s + b.ring.length, 0)
console.log(
  `賽道 ${control.length} 個控制點；建築 ${kept.length} 棟（${verts} 個頂點，估高度的 ${guessed} 棟，離賽道太近拿掉 ${tooClose} 棟）；` +
    `街道 ${streets.length} 條；綠地 ${parks.length} 塊；行道樹 ${treePts.length} 棵；${(text.length / 1024).toFixed(0)} KB → ${outFile}`,
)
