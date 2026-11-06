// Web Push 的 service worker（後端是 backend/src/webpush.rs）：在背景收推播、跳系統通知（Windows 的通知中心），
// 點通知就回到對應的頁面。沒有 fetch handler、不攔任何請求，所以範圍是整站也不會影響其他頁面。
//
// 推播內容是 JSON：{title, body, from?, tag?, url?}。同一個 tag 的通知合成一則，
// 聊天室連續好幾則時顯示「聊天室（3 則新訊息）」和最後幾則的內容。

const MAX_LINES = 4

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(show(data))
})

async function show(data) {
  const tag = data.tag || 'default'
  const line = data.from ? `${data.from}：${data.body ?? ''}` : (data.body ?? '')
  let lines = [line]
  let count = 1
  for (const previous of await self.registration.getNotifications({ tag })) {
    const old = previous.data ?? {}
    if (Array.isArray(old.lines)) lines = [...old.lines, line]
    count = (old.count ?? 1) + 1
    previous.close()
  }
  lines = lines.slice(-MAX_LINES)
  const title = data.title || '歐陽天地'
  await self.registration.showNotification(count > 1 ? `${title}（${count} 則新訊息）` : title, {
    body: count > 1 ? lines.join('\n') : line,
    tag,
    // 同一個 tag 換成新內容時也要再跳一次（不然只會默默更新通知中心裡那一則）
    renotify: true,
    data: { url: data.url || '/', lines, count },
  })
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((client) => new URL(client.url).pathname.startsWith(target.pathname))
      if (open) return open.focus()
      return self.clients.openWindow(target.href)
    })(),
  )
})

// 瀏覽器自己換掉訂閱時（很少見）：用同一把公鑰重新訂閱，再登記給伺服器
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const options = event.oldSubscription?.options
      const subscription =
        event.newSubscription ?? (options ? await self.registration.pushManager.subscribe(options) : null)
      if (!subscription) return
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })
    })(),
  )
})
