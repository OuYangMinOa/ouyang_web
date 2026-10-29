import { useEffect, useRef, useState } from 'react'
import type { SunScene } from '../scene/sun'

/** 首頁的 3D 太陽。three.js 只在這裡動態載入，其他頁面不用下載；不支援 WebGL 時改顯示靜態的「陽」字。 */
export default function SunStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SunScene | null>(null)
  const [glyph, setGlyph] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>('loading')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    import('../scene/sun')
      .then(({ createSunScene }) => createSunScene({ container, reducedMotion, onShapeChange: setGlyph }))
      .then((scene) => {
        // StrictMode 或快速換頁時，元件可能在場景建好前就卸載了
        if (cancelled) return scene.dispose()
        sceneRef.current = scene
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('fallback')
      })

    return () => {
      cancelled = true
      sceneRef.current?.dispose()
      sceneRef.current = null
    }
  }, [])

  return (
    <div className={`sun-stage is-${status}`}>
      <div ref={containerRef} className="sun-canvas" />
      {status === 'fallback' && (
        <div className="sun-fallback" aria-hidden="true">
          陽
        </div>
      )}
      <div className="sun-caption">
        <span>{glyph ? 'YANG · 陽' : 'SUN · 太陽'}</span>
        <button
          type="button"
          className="sun-toggle"
          onClick={() => sceneRef.current?.toggle()}
          disabled={status !== 'ready'}
        >
          {glyph ? '散開成太陽' : '凝聚成「陽」'}
        </button>
      </div>
    </div>
  )
}
