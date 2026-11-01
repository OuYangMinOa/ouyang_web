/** 大逃殺的徽章：KO 一個人得到 1 + 對方的點數，點數換成徽章（0～4），每個讓攻擊多 25%；門檻和後端 arena.rs 一樣 */
export function badgeCount(points: number): number {
  return [2, 6, 14, 30].filter((step) => points >= step).length
}

export function withBadges(amount: number, points: number): number {
  return Math.floor((amount * (4 + badgeCount(points))) / 4)
}

export function stars(points: number): string {
  const n = badgeCount(points)
  return '★'.repeat(n) + '☆'.repeat(4 - n)
}
