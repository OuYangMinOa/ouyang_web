import { useState } from 'react'
import { Toolbar } from '../shared/ui'
import { Grid, type Ghost } from './Grid'
import {
  canPlace,
  CELLS,
  fitPlacement,
  FLEET,
  occupancy,
  randomLayout,
  shipCells,
  validLayout,
  type Layout,
  type Options,
  type Placement,
} from './rules'

const NO_MARKS = Array.from({ length: CELLS }, () => null)

/**
 * 擺船：點選一艘船，再點格子放下（船頭在點的那一格，超出邊界會自動往回移）；
 * 點已經選起來的船會原地旋轉。手機上不用拖曳，點兩下就能完成。
 */
export function Setup({
  layout,
  options,
  onChange,
  onReady,
  readyLabel,
  busy,
}: {
  layout: Layout
  options: Options
  onChange: (layout: Layout) => void
  onReady: () => void
  readyLabel: string
  busy?: boolean
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [vertical, setVertical] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const placed = new Set(layout.map((p) => p.id))
  const occ = occupancy(layout)
  const complete = validLayout(layout, options) !== null
  const unplaced = FLEET.filter((s) => !placed.has(s.id))

  function put(p: Placement): boolean {
    if (!canPlace(layout, p, options)) {
      setMessage(options.noTouch ? '這裡放不下（船和船之間要隔一格）' : '這裡放不下')
      return false
    }
    const next = [...layout.filter((q) => q.id !== p.id), p].sort((a, b) => a.id - b.id)
    onChange(next)
    setMessage(null)
    return true
  }

  function selectNextUnplaced(after: Layout) {
    const ids = new Set(after.map((p) => p.id))
    setSelected(FLEET.find((s) => !ids.has(s.id))?.id ?? null)
  }

  function rotate(id: number) {
    const ship = layout.find((p) => p.id === id)
    if (!ship) {
      setVertical((v) => !v)
      return
    }
    const turned = fitPlacement(id, ship.cell, !ship.vertical)
    if (put(turned)) setVertical(turned.vertical)
    else setMessage('這裡轉不過來，換個位置再轉')
  }

  function pick(cell: number) {
    const id = occ[cell]
    if (id >= 0) {
      if (selected === id) rotate(id)
      else {
        setSelected(id)
        setVertical(layout.find((p) => p.id === id)!.vertical)
        setMessage(null)
      }
      return
    }
    const ship = selected ?? unplaced[0]?.id
    if (ship === undefined) return
    const p = fitPlacement(ship, cell, vertical)
    if (put(p)) {
      const after = [...layout.filter((q) => q.id !== ship), p]
      // 剛放下的是新船就自動換下一艘；移動已經放好的船則維持選取，方便接著旋轉
      if (!placed.has(ship)) selectNextUnplaced(after)
    }
  }

  let ghost: Ghost | null = null
  const ghostShip = selected ?? unplaced[0]?.id
  if (hover !== null && ghostShip !== undefined && occ[hover] < 0) {
    const p = fitPlacement(ghostShip, hover, vertical)
    ghost = { cells: shipCells(p) ?? [], ok: canPlace(layout, p, options) }
  }

  const ships = layout.map((p) => ({ ...p, state: p.id === selected ? ('selected' as const) : undefined }))

  let hint: string
  if (message) hint = message
  else if (selected !== null && placed.has(selected)) hint = `點格子把${FLEET[selected].name}移過去，再點一次船可以旋轉`
  else if (selected !== null) hint = `點格子放下${FLEET[selected].name}（${vertical ? '直' : '橫'}放）`
  else if (unplaced.length) hint = '點選一艘船，再點格子放下'
  else if (!complete) hint = '有船的位置不符合規則，請調整'
  else hint = '擺好了！點船可以再調整'

  return (
    <div className="bs-setup">
      <div className="bs-fleet-pick" role="radiogroup" aria-label="選擇要擺的船">
        {FLEET.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={selected === s.id}
            className={`bs-ship-chip${selected === s.id ? ' active' : ''}${placed.has(s.id) ? ' placed' : ''}`}
            onClick={() => {
              setSelected(selected === s.id ? null : s.id)
              const p = layout.find((q) => q.id === s.id)
              if (p) setVertical(p.vertical)
              setMessage(null)
            }}
          >
            <span>{s.name}</span>
            <span className="bs-ship-size" aria-label={`${s.len} 格`}>
              {'■'.repeat(s.len)}
            </span>
          </button>
        ))}
      </div>
      <p className={`bs-hint${message ? ' bad' : ''}`} role="status" aria-live="polite">
        {hint}
      </p>
      <Grid
        label="我方海域（擺船）"
        ships={ships}
        marks={NO_MARKS}
        fresh={null}
        ghost={ghost}
        canPick={() => true}
        onPick={pick}
        onHover={setHover}
      />
      <Toolbar>
        <button
          type="button"
          className="secondary"
          onClick={() => (selected !== null ? rotate(selected) : setVertical((v) => !v))}
        >
          ⟳ 旋轉（{vertical ? '直' : '橫'}）
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            onChange(randomLayout(options))
            setSelected(null)
            setMessage(null)
          }}
        >
          🎲 隨機擺放
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            onChange([])
            setSelected(FLEET[0].id)
            setVertical(false)
            setMessage(null)
          }}
        >
          清空
        </button>
      </Toolbar>
      <Toolbar>
        <button type="button" onClick={onReady} disabled={!complete || busy}>
          {readyLabel}
        </button>
      </Toolbar>
    </div>
  )
}
