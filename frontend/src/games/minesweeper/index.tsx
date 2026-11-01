import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { load, save } from '../shared/storage'
import { Segmented } from '../shared/ui'
import { Race } from './Race'
import { Solo } from './Solo'
import './minesweeper.css'

type Mode = 'solo' | 'race'

const MODES: { value: Mode; label: string }[] = [
  { value: 'solo', label: '單人' },
  { value: 'race', label: '線上競速' },
]

export default function Minesweeper() {
  const [params, setParams] = useSearchParams()
  // 網址帶 ?room=（邀請連結）就直接進線上競速
  const [mode, setMode] = useState<Mode>(() =>
    params.has('room') ? 'race' : load<Mode>('minesweeper:mode', 'solo') === 'race' ? 'race' : 'solo',
  )

  function changeMode(next: Mode) {
    setMode(next)
    save('minesweeper:mode', next)
    // 回到單人就離開房間，免得重新整理又被帶回去
    if (next === 'solo' && params.has('room')) {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          p.delete('room')
          return p
        },
        { replace: true },
      )
    }
  }

  const modeSwitch = <Segmented value={mode} options={MODES} onChange={changeMode} />
  return mode === 'solo' ? <Solo modeSwitch={modeSwitch} /> : <Race modeSwitch={modeSwitch} />
}
