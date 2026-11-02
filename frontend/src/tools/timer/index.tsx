import { useCallback, useEffect, useRef, useState } from 'react'
import { askNotify, notify, notifyPermission, playChime, unlockAudio, type Chime, type Permission } from './alert'
import { load, save } from './clock'
import Countdown from './Countdown'
import Pomodoro from './Pomodoro'
import Stopwatch from './Stopwatch'
import './timer.css'

type Tab = 'pomodoro' | 'stopwatch' | 'countdown'

const TABS: { value: Tab; icon: string; label: string }[] = [
  { value: 'pomodoro', icon: '🍅', label: '番茄鐘' },
  { value: 'stopwatch', icon: '⏱️', label: '碼表' },
  { value: 'countdown', icon: '⏳', label: '倒數' },
]

const isTab = (v: unknown) => TABS.some((t) => t.value === v)
const isBool = (v: unknown) => typeof v === 'boolean'

export default function Timer() {
  const [tab, setTab] = useState<Tab>(() => load('tab', 'pomodoro', isTab))
  const [sound, setSound] = useState(() => load('sound', true, isBool))
  const [permission, setPermission] = useState<Permission>(notifyPermission)
  const [titles, setTitles] = useState<Record<Tab, string | null>>({ pomodoro: null, stopwatch: null, countdown: null })
  const soundRef = useRef(sound)
  useEffect(() => {
    soundRef.current = sound
  })

  function changeTab(t: Tab) {
    setTab(t)
    save('tab', t)
  }

  function toggleSound(on: boolean) {
    setSound(on)
    save('sound', on)
    if (on) unlockAudio()
  }

  const prepare = useCallback(() => {
    unlockAudio()
    if (notifyPermission() === 'default') void askNotify().then(setPermission)
  }, [])

  const alarm = useCallback((kind: Chime, title: string, body: string) => {
    if (soundRef.current) playChime(kind)
    notify(title, body)
    navigator.vibrate?.([200, 100, 200])
  }, [])

  // 每個計時器各自回報標題；三個都在背景跑著，切到別的分頁時也要能響
  const [titleSetters] = useState(() =>
    Object.fromEntries(
      TABS.map(({ value }) => [
        value,
        (text: string | null) => setTitles((prev) => (prev[value] === text ? prev : { ...prev, [value]: text })),
      ]),
    ) as Record<Tab, (text: string | null) => void>,
  )

  // 分頁標題：優先顯示正在看的那個，其次是有在倒數的
  const title = titles[tab] ?? titles.pomodoro ?? titles.countdown ?? titles.stopwatch
  const originalTitle = useRef<string | null>(null)
  useEffect(() => {
    originalTitle.current ??= document.title
    const original = originalTitle.current
    document.title = title ? `${title}｜${original}` : original
  }, [title])
  useEffect(
    () => () => {
      if (originalTitle.current !== null) document.title = originalTitle.current
    },
    [],
  )

  const props = { prepare, alarm }

  return (
    <div className="tm">
      <div className="tm-tabs" role="tablist" aria-label="計時方式">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`tm-tab-${t.value}`}
            aria-selected={tab === t.value}
            aria-controls={`tm-panel-${t.value}`}
            className={tab === t.value ? 'active' : ''}
            onClick={() => changeTab(t.value)}
          >
            <span aria-hidden="true">{t.icon}</span> {t.label}
            {titles[t.value] && tab !== t.value && <span className="tm-dot" aria-label="執行中" />}
          </button>
        ))}
      </div>

      {/* 三個都保持掛載，切換時只是藏起來，計時不會中斷 */}
      <section className="card" role="tabpanel" id="tm-panel-pomodoro" aria-labelledby="tm-tab-pomodoro" hidden={tab !== 'pomodoro'}>
        <Pomodoro {...props} onTitle={titleSetters.pomodoro} />
      </section>
      <section className="card" role="tabpanel" id="tm-panel-stopwatch" aria-labelledby="tm-tab-stopwatch" hidden={tab !== 'stopwatch'}>
        <Stopwatch onTitle={titleSetters.stopwatch} />
      </section>
      <section className="card" role="tabpanel" id="tm-panel-countdown" aria-labelledby="tm-tab-countdown" hidden={tab !== 'countdown'}>
        <Countdown {...props} onTitle={titleSetters.countdown} />
      </section>

      <section className="tm-alerts">
        <label className="tm-check">
          <input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.target.checked)} />
          <span>時間到響鈴</span>
        </label>
        <button type="button" className="secondary" onClick={() => playChime('end')}>
          🔔 試聽
        </button>
        {permission === 'default' && (
          <button type="button" className="secondary" onClick={() => void askNotify().then(setPermission)}>
            開啟系統通知
          </button>
        )}
        {permission === 'granted' && <span className="muted">系統通知已開啟</span>}
        {permission === 'denied' && <span className="muted">系統通知被封鎖了，要在瀏覽器的網站設定裡開啟</span>}
      </section>
      <p className="muted">分頁在背景也會準時響，分頁標題會顯示剩下的時間；重新整理也會接著計時。</p>
    </div>
  )
}
