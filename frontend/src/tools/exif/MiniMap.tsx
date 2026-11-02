// 拍攝位置的小地圖，沿用天氣頁的 Leaflet 設定（底圖跟著亮色／深色主題）
import { useRef } from 'react'
import { L, useLayers, useLeafletMap } from '../../weather/map'

export default function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const container = useRef<HTMLDivElement>(null)
  const map = useLeafletMap(container, [lat, lon], 14)
  useLayers(
    map,
    (group) => {
      L.circleMarker([lat, lon], { radius: 8, className: 'exif-dot' }).addTo(group)
      map?.setView([lat, lon], map.getZoom())
    },
    [lat, lon],
  )
  return <div ref={container} className="exif-map" role="img" aria-label={`拍攝位置地圖：${lat.toFixed(5)}, ${lon.toFixed(5)}`} />
}
