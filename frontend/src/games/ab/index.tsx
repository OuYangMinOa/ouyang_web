import { useState } from 'react'
import { load, save } from '../shared/storage'
import { Segmented } from '../shared/ui'
import { ComputerGuess } from './ComputerGuess'
import { PlayerGuess } from './PlayerGuess'
import './ab.css'

type Mode = 'player' | 'computer'

export default function AbGame() {
  const [mode, setMode] = useState<Mode>(() => load<Mode>('ab:mode', 'player'))

  function changeMode(next: Mode) {
    setMode(next)
    save('ab:mode', next)
  }

  const modeSwitch = (
    <Segmented
      value={mode}
      options={[
        { value: 'player', label: '你猜' },
        { value: 'computer', label: '電腦猜' },
      ]}
      onChange={changeMode}
    />
  )

  return mode === 'player' ? <PlayerGuess modeSwitch={modeSwitch} /> : <ComputerGuess modeSwitch={modeSwitch} />
}
