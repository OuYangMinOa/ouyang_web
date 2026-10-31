// Leaflet 地圖：底圖跟著亮色／深色主題切換（Esri 的淺灰／深灰底圖，免金鑰），線條與圓點的顏色交給 weather.css 的 class
// （SVG 的 stroke／fill 屬性不吃 CSS 變數，所以不用 Leaflet 的 color 選項）

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useState, type DependencyList, type RefObject } from 'react'

function resolvedTheme(): 'light' | 'dark' {
  const forced = document.documentElement.dataset.theme
  if (forced === 'light' || forced === 'dark') return forced
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 目前實際套用的主題（使用者切換或系統改變都會更新） */
export function useResolvedTheme() {
  const [theme, setTheme] = useState(resolvedTheme)
  useEffect(() => {
    const update = () => setTheme(resolvedTheme())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', update)
    }
  }, [])
  return theme
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'
const ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors'

/** 在 container 裡建立地圖，回傳 map（建立好之前是 null） */
export function useLeafletMap(container: RefObject<HTMLDivElement | null>, center: L.LatLngExpression, zoom: number) {
  const [map, setMap] = useState<L.Map | null>(null)
  const theme = useResolvedTheme()

  useEffect(() => {
    const el = container.current
    if (!el) return
    // 手機上用單指捲動頁面，不要一碰就拖到地圖；兩指才縮放與拖曳
    const instance = L.map(el, { center, zoom, worldCopyJump: false, scrollWheelZoom: false, zoomSnap: 0.5 })
    instance.on('focus', () => instance.scrollWheelZoom.enable())
    instance.on('blur', () => instance.scrollWheelZoom.disable())
    setMap(instance)
    // 外框大小改變（例如側邊欄收合）時重新計算
    const resize = new ResizeObserver(() => instance.invalidateSize())
    resize.observe(el)
    return () => {
      resize.disconnect()
      instance.remove()
      setMap(null)
    }
    // 中心與縮放只在建立時用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container])

  useEffect(() => {
    if (!map) return
    const style = theme === 'dark' ? 'Dark_Gray' : 'Light_Gray'
    // 底圖和地名分兩層，地名疊在路徑上面才不會被蓋住
    const base = L.tileLayer(`${ESRI}/World_${style}_Base/MapServer/tile/{z}/{y}/{x}`, {
      attribution: ATTRIBUTION,
      maxZoom: 16,
    })
    const labels = L.tileLayer(`${ESRI}/World_${style}_Reference/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 16,
      pane: 'shadowPane',
    })
    base.addTo(map)
    labels.addTo(map)
    return () => {
      base.remove()
      labels.remove()
    }
  }, [map, theme])

  return map
}

/** 依 deps 重畫一組圖層；build 回傳的東西都放進同一個 layerGroup，下次重畫前整組移除 */
export function useLayers(map: L.Map | null, build: (group: L.LayerGroup) => void, deps: DependencyList) {
  useEffect(() => {
    if (!map) return
    const group = L.layerGroup().addTo(map)
    build(group)
    return () => {
      group.remove()
    }
    // build 每次 render 都是新的函式，由呼叫端的 deps 決定何時重畫
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ...deps])
}

/** 經度跨過換日線時，讓整條路徑連續（例如 179° → -179° 改成 181°） */
export function unwrapLongitudes(points: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const [lat, lon] of points) {
    const prev = out[out.length - 1]
    let next = lon
    if (prev) {
      while (next - prev[1] > 180) next -= 360
      while (next - prev[1] < -180) next += 360
    }
    out.push([lat, next])
  }
  return out
}

export const TAIWAN_CENTER: L.LatLngTuple = [23.7, 121]

export { L }
