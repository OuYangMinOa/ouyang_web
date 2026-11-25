// 米其林指南台灣（2026 年版）的星級與必比登餐廳。
// restaurants.json 是從米其林官網各餐廳頁面整理的靜態資料（名稱、地址、電話、座標、料理類型、價位），
// 每年 7～8 月新版公布後要重新整理一次；官網沒有公開 API，所以不在執行時去抓。

import RESTAURANTS_JSON from './restaurants.json'

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
