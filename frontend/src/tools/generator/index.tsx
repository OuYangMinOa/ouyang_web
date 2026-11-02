import { useState } from 'react'
import { Segmented } from '../encoding/ui'
import PasswordPanel from './Password'
import { store } from './store'
import TimestampPanel from './Timestamp'
import UuidPanel from './Uuid'
import '../encoding/encoding.css'
import './generator.css'

type Tab = 'time' | 'uuid' | 'password'

const TABS: { value: Tab; label: string }[] = [
  { value: 'time', label: '時間戳' },
  { value: 'uuid', label: 'UUID' },
  { value: 'password', label: '密碼' },
]

export default function GeneratorTool() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = store.load<string>('tab', 'time')
    return TABS.some((x) => x.value === t) ? (t as Tab) : 'time'
  })

  return (
    <div className="enc">
      <Segmented
        className="gen-tabs"
        value={tab}
        options={TABS}
        onChange={(t) => {
          setTab(t)
          store.save('tab', t)
        }}
      />
      {tab === 'time' && <TimestampPanel />}
      {tab === 'uuid' && <UuidPanel />}
      {tab === 'password' && <PasswordPanel />}
    </div>
  )
}
