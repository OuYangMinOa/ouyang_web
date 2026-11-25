// 地區和版本放在這裡，不要放進 data.ts：apps/registry.ts 會載入這個檔，
// data.ts 帶著整份 restaurants.json，放進主程式的 bundle 每一頁都要多下載一次

export const GUIDE_EDITION = '2026'
export const DATA_UPDATED = '2026 年 11 月'

export type Region = { slug: string; name: string; cities: string[] }

/** 側邊欄的地區（新竹市和新竹縣合在一起） */
export const REGIONS: Region[] = [
  { slug: 'taipei', name: '台北', cities: ['台北市'] },
  { slug: 'new-taipei', name: '新北', cities: ['新北市'] },
  { slug: 'hsinchu', name: '新竹', cities: ['新竹市', '新竹縣'] },
  { slug: 'taichung', name: '台中', cities: ['台中市'] },
  { slug: 'tainan', name: '台南', cities: ['台南市'] },
  { slug: 'kaohsiung', name: '高雄', cities: ['高雄市'] },
]
