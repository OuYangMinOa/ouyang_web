import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { load, save } from '../shared/storage'
import { Segmented, type Option } from '../shared/ui'
import { ComputerGuess } from './ComputerGuess'
import { PlayerGuess } from './PlayerGuess'
import { Versus } from './Versus'
import './ab.css'

type Mode = 'player' | 'computer' | 'versus'

const MODES: Option<Mode>[] = [
  { value: 'player', label: '你猜' },
  { value: 'computer', label: '電腦猜' },
  { value: 'versus', label: '對戰' },
]

export default function AbGame() {
  const [params, setParams] = useSearchParams()
  const [picked, setPicked] = useState<Mode>(() => {
    const saved = load<unknown>('ab:mode', 'player')
    return MODES.some((m) => m.value === saved) ? (saved as Mode) : 'player'
  })
  // 打開邀請連結（?room=）就直接進線上對戰
  const mode: Mode = params.has('room') ? 'versus' : picked

  function changeMode(next: Mode) {
    if (next === mode) return
    // 離開對戰時也離開房間，不然網址上的 ?room= 會把人拉回來
    if (params.has('room')) {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          p.delete('room')
          return p
        },
        { replace: true },
      )
    }
    setPicked(next)
    save('ab:mode', next)
  }

  const modeSwitch = <Segmented value={mode} options={MODES} onChange={changeMode} />

  if (mode === 'versus') return <Versus modeSwitch={modeSwitch} />
  return mode === 'player' ? <PlayerGuess modeSwitch={modeSwitch} /> : <ComputerGuess modeSwitch={modeSwitch} />
}
