// 米其林指南台灣（2026 年版）的星級與必比登餐廳。
// restaurants.json 是從米其林官網各餐廳頁面整理的靜態資料（名稱、地址、電話、座標、料理類型、價位），
// 每年 7～8 月新版公布後要重新整理一次；官網沒有公開 API，所以不在執行時去抓。

import RESTAURANTS_JSON from './restaurants.json'
import { GUIDE_EDITION, REGIONS } from './regions'

/** 1～3 是星等，bib 是必比登推薦 */
export type Award = 1 | 2 | 3 | 'bib'

export type Restaurant = {
  /** 米其林網址最後一段 */
  id: string
  name: string
  award: Award
  /** 米其林綠星（永續美食） */
  green?: boolean
  city: string
  district: string
  address: string
  /** 官網上的寫法，例如 +886 2 2181 9985；有些店沒有公開電話 */
  phone?: string
  lat: number
  lng: number
  /** 官網沒有座標，依地址估的約略位置 */
  approx?: boolean
  cuisine: string
  /** 1～4，對應官網的 $～$$$$ */
  price: number
  /** guide.michelin.com/tw/zh_TW/ 後面的路徑 */
  path: string
  /** 上一版的獎項，跟今年一樣就不寫：none 是上一版不在指南裡，selected 是上一版只是「入選」 */
  last?: 'none' | 'selected' | Award
}

export const RESTAURANTS = RESTAURANTS_JSON as Restaurant[]

export { DATA_UPDATED, GUIDE_EDITION, REGIONS, type Region } from './regions'

export const AWARDS: { value: Award; label: string }[] = [
  { value: 3, label: '三星' },
  { value: 2, label: '二星' },
  { value: 1, label: '一星' },
  { value: 'bib', label: '必比登' },
]

export function awardLabel(award: Award) {
  return award === 'bib' ? '必比登推薦' : `米其林${AWARDS.find((a) => a.value === award)!.label}`
}

/** 排序用：三星最前面，必比登最後 */
export function awardRank(award: Award) {
  return award === 'bib' ? 0 : award
}

/** CSS class 的後綴：star1～star3、bib */
export function awardClass(award: Award) {
  return award === 'bib' ? 'bib' : `star${award}`
}

export function guideUrl(r: Restaurant) {
  return `https://guide.michelin.com/tw/zh_TW/${r.path}`
}

/** 用店名加地址搜尋，比座標準，也能直接導航 */
export function googleMapsUrl(r: Restaurant) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name} ${r.address}`)}`
}

/** +886 2 2181 9985 → 02 2181 9985；+886 937 857 869 → 0937 857 869 */
export function displayPhone(phone: string) {
  return phone.replace(/^\+886\s*/, '0')
}

export function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, '')}`
}

const STAR_NAMES = ['', '一星', '二星', '三星']

export type Change = { kind: 'new' | 'up' | 'down'; label: string }

/** 今年的變動：新入選、升星（含入選→摘星）、降級；跟上一版一樣是 null */
export function changeOf(r: Restaurant): Change | null {
  const last = r.last
  if (last === undefined) return null
  if (last === 'none') return { kind: 'new', label: `${GUIDE_EDITION} 新入選` }
  const before = last === 'selected' ? -1 : awardRank(last)
  const lastName = last === 'selected' ? '入選' : last === 'bib' ? '必比登' : STAR_NAMES[last]
  if (awardRank(r.award) > before) {
    return { kind: 'up', label: `${GUIDE_EDITION} ${last === 'selected' ? '新摘星' : '升星'}（上一版${lastName}）` }
  }
  return { kind: 'down', label: `${GUIDE_EDITION} 降級（上一版${lastName}）` }
}

/**
 * 上一版有星、今年掉出星級的店。今年只是「入選」，不在這張地圖上（只收星級和必比登），所以另外列出來。
 * 對照官網 2025、2026 兩版的星級名單整理。
 */
export const DROPPED: { name: string; city: string; last: string; now: string }[] = [
  { name: '巴黎廳1930 x 高山英紀', city: '台北', last: '一星', now: '入選' },
  { name: '鹽之華', city: '台中', last: '一星', now: '入選' },
]

/** 這家在哪個地區（側邊欄的那幾個） */
export function regionOf(r: Restaurant) {
  return REGIONS.find((region) => region.cities.includes(r.city))
}

/**
 * 篩選用的料理分類。官網的料理有四十幾種寫法（「時尚臺灣菜」「日式天婦羅」…），合成幾大類；
 * 一家店可以屬於好幾類（例如「新加坡菜, 時尚菜」）。新版資料多了新的寫法時，沒分到類的會歸到「其他」。
 */
export const CUISINE_GROUPS: { key: string; label: string; match: string[] }[] = [
  { key: 'snack', label: '小吃', match: ['小吃', '街頭小吃', '點心', '粥品', '餃子'] },
  { key: 'noodle', label: '麵食', match: ['麵食'] },
  { key: 'taiwanese', label: '台菜', match: ['臺灣菜', '時尚臺灣菜', '客家菜'] },
  { key: 'chinese', label: '中菜', match: ['粵菜', '江浙菜', '川菜', '杭州菜', '淮揚菜', '湘菜', '滇菜', '滬菜', '中菜'] },
  { key: 'japanese', label: '日本料理', match: ['日本菜', '時尚日本菜', '壽司', '日式天婦羅', '燒烤'] },
  {
    key: 'western',
    label: '西式・創新',
    match: ['創新菜', '現代菜', '時尚菜', '時尚法國菜', '時尚歐陸菜', '時尚義大利菜', '時尚西班牙菜', '牛排屋', '拉丁美洲菜', '墨西哥菜'],
  },
  { key: 'asian', label: '亞洲料理', match: ['時尚亞洲菜', '亞洲菜', '新加坡菜', '泰國菜', '印度菜', '咖哩'] },
  { key: 'veg', label: '素食', match: ['素食'] },
  { key: 'other', label: '其他', match: [] },
]

const groupCache = new Map<string, string[]>()

/** 這家屬於哪些料理分類 */
export function cuisineGroupsOf(r: Restaurant): string[] {
  let groups = groupCache.get(r.id)
  if (!groups) {
    const parts = r.cuisine.split(/[,，、]\s*/)
    groups = CUISINE_GROUPS.filter((g) => g.match.some((m) => parts.includes(m))).map((g) => g.key)
    if (groups.length === 0) groups = ['other']
    groupCache.set(r.id, groups)
  }
  return groups
}

export type LatLng = { lat: number; lng: number }

/** 兩點的直線距離（公尺） */
export function distanceMeters(a: LatLng, b: LatLng) {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h))
}

/** 350 m、1.2 km、28 km */
export function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`
  return `${Math.round(meters / 1000)} km`
}
