import { api } from '../api'

/**
 * 這個瀏覽器的 Web Push 訂閱（後端是 webpush.rs，service worker 是 public/push-sw.js）。
 * 訂閱是跟著瀏覽器的，不是跟著分頁：同一個瀏覽器開好幾個分頁都是同一個 endpoint。
 */

const SW_URL = '/push-sw.js'

export type PushState =
  /** 瀏覽器不支援（例如 iPhone 沒有把網站加到主畫面） */
  | 'unsupported'
  /** 使用者在瀏覽器裡封鎖了通知，要從網址列旁的設定打開 */
  | 'denied'
  | 'off'
  | 'on'

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey
  if (!current || current.byteLength !== key.length) return false
  const bytes = new Uint8Array(current)
  return bytes.every((b, i) => b === key[i])
}

async function serverKey(): Promise<Uint8Array<ArrayBuffer>> {
  return fromBase64Url((await api<{ key: string }>('/push/key')).key)
}

async function existingRegistration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? null
}

/** 拿到這個瀏覽器的訂閱；伺服器換過金鑰的話舊的訂閱已經失效，重新訂一個 */
async function subscribe(registration: ServiceWorkerRegistration): Promise<PushSubscription> {
  const key = await serverKey()
  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await api('/push/subscriptions', { method: 'POST', body: JSON.stringify(subscription.toJSON()) })
  return subscription
}

export function permissionState(): PushState {
  if (!pushSupported()) return 'unsupported'
  return Notification.permission === 'denied' ? 'denied' : 'off'
}

/** 按「開啟通知」：問使用者要不要允許、註冊 service worker、訂閱並登記給伺服器 */
export async function enablePush(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission === 'denied') throw new Error('通知被瀏覽器封鎖了，請從網址列左邊的圖示把「通知」改成允許')
  if (permission !== 'granted') throw new Error('沒有允許通知')
  await navigator.serviceWorker.register(SW_URL, { scope: '/' })
  try {
    // 要等 service worker 啟用後才能訂閱
    return await subscribe(await navigator.serviceWorker.ready)
  } catch (e) {
    // 瀏覽器的錯誤訊息是英文；Chrome 的無痕視窗會在這裡失敗，而且網站沒辦法事先知道
    if (e instanceof DOMException) {
      throw new Error('這個瀏覽器沒辦法訂閱通知。無痕視窗不支援通知，請用一般視窗再試一次', { cause: e })
    }
    throw e
  }
}

/**
 * 頁面打開時：這個瀏覽器之前開過通知，就重新登記一次。
 * 換了帳號登入、伺服器那邊的訂閱失效被刪掉、伺服器換了金鑰，都會在這裡補回來。
 */
export async function restorePush(): Promise<PushSubscription | null> {
  if (!pushSupported() || Notification.permission !== 'granted') return null
  const registration = await existingRegistration()
  if (!registration || !(await registration.pushManager.getSubscription())) return null
  // 部署後 service worker 可能有新版
  registration.update().catch(() => {})
  return subscribe(registration)
}

export async function disablePush(subscription: PushSubscription): Promise<void> {
  await api('/push/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) })
  await subscription.unsubscribe()
}

export async function testPush(subscription: PushSubscription): Promise<void> {
  await api('/push/test', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) })
}

/** 回到聊天室時把還留在通知中心的聊天通知收掉 */
export async function clearNotifications(tag: string): Promise<void> {
  if (!pushSupported()) return
  const registration = await existingRegistration()
  for (const notification of (await registration?.getNotifications({ tag })) ?? []) notification.close()
}
